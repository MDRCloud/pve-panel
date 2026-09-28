import { db, audit } from './db.js';
import { config } from './config.js';
import {
  pve, clusterGuests, locateTemplate, waitTask, bootDiskKey, diskSizeGb, serial,
  invalidateGuestCache, guestPath,
} from './pve.js';
import { ensureNetwork, isolateGuest, nicModel } from './network.js';
import { setupWindows, windowsPasswordProblem } from './windows.js';

const MB = 1024 ** 2;
const GB = 1024 ** 3;

// ---- Limits & usage -------------------------------------------------------

export function limitsOf(account) {
  return {
    servers: account.max_servers,
    cores: account.max_cores,
    memoryMb: account.max_memory_mb,
    diskGb: account.max_disk_gb,
  };
}

/**
 * Resources a customer currently uses, over ALL their servers (also the ones
 * an admin assigned). Servers still being created count with what was
 * requested, since Proxmox doesn't show their final size yet.
 */
export async function usageOf(userId) {
  const rows = db.prepare('SELECT vmid, state, spec FROM vms WHERE user_id = ?').all(userId);
  const guests = await clusterGuests();
  const usage = { servers: 0, cores: 0, memoryMb: 0, diskGb: 0 };
  for (const row of rows) {
    usage.servers += 1;
    const spec = row.spec ? JSON.parse(row.spec) : null;
    const guest = guests.get(row.vmid);
    if (row.state === 'creating' && spec) {
      usage.cores += spec.cores;
      usage.memoryMb += spec.memoryMb;
      usage.diskGb += spec.diskGb;
    } else if (guest) {
      usage.cores += guest.maxcpu ?? 0;
      usage.memoryMb += Math.round((guest.maxmem ?? 0) / MB);
      usage.diskGb += Math.round((guest.maxdisk ?? 0) / GB);
    }
  }
  return usage;
}

// ---- Templates --------------------------------------------------------------

/** Templates offered to customers, with the minimum disk size of each. */
export async function offeredTemplates() {
  const rows = db.prepare('SELECT * FROM templates ORDER BY label').all();
  const guests = await clusterGuests();
  const result = await Promise.all(rows.map(async (t) => {
    const guest = guests.get(t.vmid);
    if (!guest?.template) return null; // template was removed in Proxmox
    try {
      const cfg = await pve.get(`/nodes/${encodeURIComponent(guest.node)}/qemu/${t.vmid}/config`);
      const disk = bootDiskKey(cfg);
      const windows = t.setup === 'windows';
      return {
        id: t.vmid,
        name: t.label,
        setup: windows ? 'windows' : 'cloudinit',
        minDiskGb: Math.ceil(diskSizeGb(cfg[disk])) || 1,
        defaultUser: windows ? (t.ci_user || 'Administrator') : (t.ci_user || cfg.ciuser || ''),
        os: cfg.ostype ?? null,
      };
    } catch {
      return null;
    }
  }));
  return result.filter(Boolean);
}

// ---- Create -----------------------------------------------------------------

const creatingFor = new Set(); // one creation per customer at a time

export class ProvisionError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
  }
}

/** Sign-in rules per setup method (shared by create and reinstall). Mutates spec. */
function applySetupRules(spec, offered) {
  if (offered.setup === 'windows') {
    if (spec.hostname.length > 15) {
      throw new ProvisionError(400, 'Windows computer names can be at most 15 characters');
    }
    if (!spec.password) throw new ProvisionError(400, 'Set a password for the Administrator account');
    spec.username = offered.defaultUser; // fixed admin account of the template
    spec.sshKeys = undefined;
    const problem = windowsPasswordProblem(spec.password, spec.username);
    if (problem) throw new ProvisionError(400, problem);
  } else {
    if (!spec.username) throw new ProvisionError(400, 'Choose a user name');
    if (!spec.password && !spec.sshKeys?.trim()) {
      throw new ProvisionError(400, 'Set a password or add an SSH key so you can sign in to the server');
    }
  }
  spec.setup = offered.setup;
}

/**
 * Validates quota, reserves a VMID and starts the clone. Returns the new VMID
 * right away; configuration, disk resize and first start continue in the
 * background, tracked through the `state` column.
 */
export async function createServer(req, spec) {
  const account = req.account;
  if (!account.can_create) throw new ProvisionError(403, 'Creating servers is not enabled for your account');
  if (creatingFor.has(account.id)) {
    throw new ProvisionError(409, 'Another server is being created. Wait until it has finished.');
  }
  creatingFor.add(account.id);

  let background = false;
  try {
    const tplRow = db.prepare('SELECT * FROM templates WHERE vmid = ?').get(spec.templateId);
    if (!tplRow) throw new ProvisionError(400, 'That image is not available');
    const tpl = await locateTemplate(spec.templateId);
    const offered = (await offeredTemplates()).find((t) => t.id === spec.templateId);
    if (!offered) throw new ProvisionError(400, 'That image is not available');
    if (spec.diskGb < offered.minDiskGb) {
      throw new ProvisionError(400, `This image needs a disk of at least ${offered.minDiskGb} GB`);
    }

    applySetupRules(spec, offered);

    // Quota
    const limits = limitsOf(account);
    const usage = await usageOf(account.id);
    const over = [];
    if (usage.servers + 1 > limits.servers) over.push(`servers (${limits.servers} allowed)`);
    if (usage.cores + spec.cores > limits.cores) over.push(`CPU cores (${limits.cores - usage.cores} left)`);
    if (usage.memoryMb + spec.memoryMb > limits.memoryMb) {
      over.push(`memory (${((limits.memoryMb - usage.memoryMb) / 1024).toFixed(1)} GB left)`);
    }
    if (usage.diskGb + spec.diskGb > limits.diskGb) over.push(`disk (${limits.diskGb - usage.diskGb} GB left)`);
    if (over.length) throw new ProvisionError(409, `This exceeds your plan: ${over.join(', ')}`);

    // The customer's private network (created with their first server)
    const net = config.network.enabled ? await ensureNetwork(account.id) : null;

    // Reserve ID + start clone, serialised against other creations
    const { vmid, upid } = await serial(async () => {
      // Proxmox's next free ID, skipping IDs the panel still has records for
      // (e.g. a VM that was deleted directly in Proxmox but is still assigned here).
      const known = db.prepare('SELECT 1 FROM vms WHERE vmid = ?');
      let id = Number(await pve.get('/cluster/nextid'));
      for (let tries = 0; ; tries += 1, id += 1) {
        if (tries > 1000) throw new Error('No free VM ID found');
        if (known.get(id)) continue;
        try {
          await pve.get('/cluster/nextid', { vmid: id }); // errors if the ID is taken in Proxmox
          break;
        } catch {
          // taken in Proxmox, try the next one
        }
      }
      const task = await pve.post(`/nodes/${encodeURIComponent(tpl.node)}/qemu/${tpl.vmid}/clone`, {
        newid: id,
        name: spec.hostname,
        full: 1,
        storage: tplRow.storage || undefined,
        pool: config.pve.pool,
      });
      return { vmid: id, upid: task };
    });

    db.prepare(`
      INSERT INTO vms (vmid, user_id, type, label, state, created_by_customer, spec, progress)
      VALUES (?, ?, 'qemu', NULL, 'creating', 1, ?, 'Copying the image')
    `).run(vmid, account.id, JSON.stringify({
      cores: spec.cores, memoryMb: spec.memoryMb, diskGb: spec.diskGb, template: tpl.vmid,
      hostname: spec.hostname,
    }));
    audit(req, vmid, 'server_create_started', { template: tpl.vmid, hostname: spec.hostname });

    background = true;
    const actor = { account: { id: account.id }, ip: req.ip };
    finishCreate(actor, tpl.node, vmid, upid, spec, tplRow, net)
      .finally(() => creatingFor.delete(account.id));

    return vmid;
  } finally {
    if (!background) creatingFor.delete(account.id);
  }
}

const setProgress = db.prepare('UPDATE vms SET progress = ? WHERE vmid = ?');

async function finishCreate(actor, node, vmid, cloneUpid, spec, tplRow, net, {
  mac = null, done = 'server_created', failed = 'server_create_failed',
} = {}) {
  const path = `/nodes/${encodeURIComponent(node)}/qemu/${vmid}`;
  const progress = (text) => setProgress.run(text, vmid);
  const windows = spec.setup === 'windows';
  try {
    await waitTask(node, cloneUpid);

    progress('Configuring');
    const cfg = await pve.get(`${path}/config`);
    const params = { cores: spec.cores, sockets: 1, memory: spec.memoryMb };
    if (net) {
      // Customer's VNet, firewall on for isolation. A kept MAC (reinstall) gets
      // the same DHCP address again; otherwise Proxmox assigns a new one.
      params.net0 = `${nicModel(cfg.net0)}${mac ? `=${mac}` : ''},bridge=${net.vnet},firewall=1`;
    } else if (mac && cfg.net0) {
      params.net0 = cfg.net0.replace(/^(\w+)=([0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5})/, `$1=${mac}`);
    }
    if (!windows) {
      params.ciuser = spec.username;
      params.ipconfig0 = tplRow.ipconfig || 'ip=dhcp';
      if (spec.password) params.cipassword = spec.password;
      // Proxmox expects the key list URL-encoded (in addition to form encoding).
      if (spec.sshKeys) params.sshkeys = encodeURIComponent(`${spec.sshKeys.trim()}\n`);
    }
    await pve.put(`${path}/config`, params);
    if (net) await isolateGuest(path, net);

    const disk = bootDiskKey(cfg);
    if (disk && spec.diskGb > diskSizeGb(cfg[disk])) {
      progress('Resizing the disk');
      const resize = await pve.put(`${path}/resize`, { disk, size: `${spec.diskGb}G` });
      await waitTask(node, resize); // async in newer PVE versions, sync in older
    }

    progress('Starting');
    await waitTask(node, await pve.post(`${path}/status/start`));

    if (windows) {
      await setupWindows({
        path, node,
        hostname: spec.hostname,
        adminUser: spec.username,
        password: spec.password,
        net,
        progress,
      });
    }

    db.prepare("UPDATE vms SET state = 'ready', error = NULL, progress = NULL WHERE vmid = ?").run(vmid);
    audit(actor, vmid, done);
  } catch (err) {
    db.prepare("UPDATE vms SET state = 'failed', error = ?, progress = NULL WHERE vmid = ?")
      .run(String(err.message).slice(0, 500), vmid);
    audit(actor, vmid, failed, { error: err.message });
  } finally {
    invalidateGuestCache();
  }
}

// ---- Reinstall --------------------------------------------------------------

/**
 * Replaces a server's installation with a fresh copy of an image: stops and
 * deletes the VM, clones the image again under the SAME ID, keeps name, size and
 * MAC address (so DHCP gives the same IP), re-applies network isolation and runs
 * the image's setup with new sign-in details. Disk content and snapshots are
 * erased. Only for servers the customer created. Returns right away; progress is
 * tracked through the `state` column like a creation.
 */
export async function reinstallServer(req, row, input) {
  const account = req.account;
  if (!row.created_by_customer) {
    throw new ProvisionError(403, 'Only servers you created yourself can be reinstalled');
  }
  if (!account.can_create) throw new ProvisionError(403, 'Reinstalling is not enabled for your account');
  if (!['ready', 'failed'].includes(row.state)) {
    throw new ProvisionError(409, 'Wait until the current operation on this server has finished');
  }
  if (creatingFor.has(account.id)) {
    throw new ProvisionError(409, 'Another server is being set up. Wait until it has finished.');
  }
  creatingFor.add(account.id);

  let background = false;
  try {
    const vmid = row.vmid;
    const old = row.spec ? JSON.parse(row.spec) : {};
    const guest = (await clusterGuests(true)).get(vmid) ?? null; // may be gone after a failed attempt
    const oldCfg = guest ? await pve.get(`${guestPath(guest)}/config`) : {};
    const oldDisk = bootDiskKey(oldCfg);
    const mac = /=([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})/.exec(oldCfg.net0 ?? '')?.[1] ?? old.mac ?? null;

    // Same size as before
    const spec = {
      ...input,
      hostname: old.hostname ?? guest?.name ?? `server-${vmid}`,
      cores: old.cores ?? (Number(oldCfg.cores) || 1),
      memoryMb: old.memoryMb ?? (Number(oldCfg.memory) || 1024),
      diskGb: old.diskGb ?? (oldDisk ? Math.ceil(diskSizeGb(oldCfg[oldDisk])) : 0),
    };

    const tplRow = db.prepare('SELECT * FROM templates WHERE vmid = ?').get(spec.templateId);
    const offered = (await offeredTemplates()).find((t) => t.id === spec.templateId);
    if (!tplRow || !offered) throw new ProvisionError(400, 'That image is not available');
    if (spec.diskGb < offered.minDiskGb) {
      throw new ProvisionError(400, `This image needs a disk of at least ${offered.minDiskGb} GB; this server has ${spec.diskGb} GB`);
    }
    applySetupRules(spec, offered);
    const tpl = await locateTemplate(spec.templateId);
    const net = config.network.enabled ? await ensureNetwork(account.id) : null;

    // The row keeps the ID reserved: new creations skip IDs the panel knows.
    db.prepare(`
      UPDATE vms SET state = 'creating', error = NULL, progress = 'Removing the old installation', spec = ?, ostype = NULL
      WHERE vmid = ?`).run(JSON.stringify({
      cores: spec.cores, memoryMb: spec.memoryMb, diskGb: spec.diskGb, template: tpl.vmid,
      hostname: spec.hostname, mac, reinstalledAt: new Date().toISOString(),
    }), vmid);
    // Things that belonged to the old installation
    db.prepare('DELETE FROM tasks WHERE vmid = ?').run(vmid);
    db.prepare('DELETE FROM tailscale WHERE vmid = ?').run(vmid);
    audit(req, vmid, 'server_reinstall_started', { template: tpl.vmid, previousTemplate: old.template ?? null });

    background = true;
    const actor = { account: { id: account.id }, ip: req.ip };
    (async () => {
      try {
        if (guest) {
          const path = guestPath(guest);
          if (guest.status !== 'stopped') await waitTask(guest.node, await pve.post(`${path}/status/stop`));
          await waitTask(guest.node, await pve.del(path, { purge: 1, 'destroy-unreferenced-disks': 1 }));
          invalidateGuestCache();
        }
        setProgress.run('Copying the image', vmid);
        const upid = await serial(() => pve.post(`/nodes/${encodeURIComponent(tpl.node)}/qemu/${tpl.vmid}/clone`, {
          newid: vmid,
          name: spec.hostname,
          full: 1,
          storage: tplRow.storage || undefined,
          pool: config.pve.pool,
        }));
        await finishCreate(actor, tpl.node, vmid, upid, spec, tplRow, net, {
          mac, done: 'server_reinstalled', failed: 'server_reinstall_failed',
        });
      } catch (err) {
        db.prepare("UPDATE vms SET state = 'failed', error = ?, progress = NULL WHERE vmid = ?")
          .run(`Reinstalling failed: ${err.message}`.slice(0, 500), vmid);
        audit(actor, vmid, 'server_reinstall_failed', { error: err.message });
        invalidateGuestCache();
      } finally {
        creatingFor.delete(account.id);
      }
    })();
  } finally {
    if (!background) creatingFor.delete(account.id);
  }
}

// ---- Delete -----------------------------------------------------------------

/** Destroys a customer-created server (must be stopped) and removes its record. */
export async function deleteServer(req, row) {
  const guests = await clusterGuests(true);
  const guest = guests.get(row.vmid);

  if (!guest) {
    // Clone never happened or VM already gone: just drop the record.
    db.prepare('DELETE FROM vms WHERE vmid = ?').run(row.vmid);
    audit(req, row.vmid, 'server_deleted');
    return { removed: true };
  }
  if (guest.status !== 'stopped') {
    throw new ProvisionError(409, 'Shut down the server before deleting it');
  }

  const path = `/nodes/${encodeURIComponent(guest.node)}/qemu/${row.vmid}`;
  const upid = await pve.del(path, { purge: 1, 'destroy-unreferenced-disks': 1 });
  db.prepare("UPDATE vms SET state = 'deleting' WHERE vmid = ?").run(row.vmid);
  audit(req, row.vmid, 'server_delete_started');

  const actor = { account: { id: req.account.id }, ip: req.ip };
  waitTask(guest.node, upid)
    .then(() => {
      db.prepare('DELETE FROM vms WHERE vmid = ?').run(row.vmid);
      audit(actor, row.vmid, 'server_deleted');
    })
    .catch((err) => {
      db.prepare("UPDATE vms SET state = 'failed', error = ? WHERE vmid = ?")
        .run(`Deleting failed: ${err.message}`.slice(0, 500), row.vmid);
    })
    .finally(invalidateGuestCache);

  return { removed: false };
}
