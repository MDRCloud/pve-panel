import { db, audit } from '../db.js';
import { config } from '../config.js';
import { pve, clusterGuests, locateGuest, guestPath, invalidateGuestCache } from '../pve.js';
import {
  limitsOf, usageOf, offeredTemplates, createServer, deleteServer,
} from '../provision.js';
import { networkOf } from '../network.js';
import { vpnInfoFor } from '../vpn.js';
import { tailscaleStatus, connectTailscale, disconnectTailscale } from '../tailscale.js';
import { versionInfo } from '../version.js';

const ownedByUser = db.prepare('SELECT * FROM vms WHERE vmid = ? AND user_id = ?');
const listForUser = db.prepare('SELECT * FROM vms WHERE user_id = ? ORDER BY vmid');
const insertTask = db.prepare(
  'INSERT INTO tasks (upid, user_id, vmid, node, action) VALUES (?, ?, ?, ?, ?)'
);
const findTask = db.prepare('SELECT * FROM tasks WHERE upid = ? AND user_id = ?');

const POWER_ACTIONS = {
  qemu: ['start', 'shutdown', 'reboot', 'stop'],
  lxc: ['start', 'shutdown', 'reboot', 'stop'],
};
const TIMEFRAMES = ['hour', 'day', 'week', 'month'];
const SNAPSHOT_NAME = /^[A-Za-z][A-Za-z0-9_-]{1,39}$/;

function notFound() {
  const err = new Error('Server not found');
  err.statusCode = 404;
  return err;
}

/**
 * The single gate for every per-VM route: the VMID must be a positive
 * integer, belong to the signed-in user in OUR database, and exist in
 * the cluster. Unknown and not-owned both return 404 so customers can't
 * probe for other people's VMIDs.
 */
async function ownedGuest(req) {
  const vmid = Number(req.params.vmid);
  if (!Number.isInteger(vmid) || vmid < 100) throw notFound();
  const row = ownedByUser.get(vmid, req.account.id);
  if (!row) throw notFound();
  if (row.state !== 'ready') {
    const err = new Error(row.state === 'creating'
      ? 'This server is still being set up'
      : row.state === 'deleting' ? 'This server is being deleted' : 'This server could not be set up');
    err.statusCode = 409;
    throw err;
  }
  const guest = await locateGuest(vmid);
  return { row, guest, path: guestPath(guest) };
}

function recordTask(req, guest, upid, action) {
  const isTask = typeof upid === 'string' && upid.startsWith('UPID:');
  if (isTask) insertTask.run(upid, req.account.id, guest.vmid, guest.node, action);
  audit(req, guest.vmid, action);
  invalidateGuestCache();
  // Only real Proxmox task IDs go back to the browser (it polls them).
  return { task: isTask ? upid : null };
}

const templateSetup = db.prepare('SELECT setup FROM templates WHERE vmid = ?');

/** 'windows' | 'linux' | null — for the OS glyph in the interface. */
const saveOstype = db.prepare('UPDATE vms SET ostype = ? WHERE vmid = ?');

/** 'windows' | 'linux' | null. Proxmox ostypes: win* = Windows, l24/l26 = Linux, others unknown. */
function familyOf(ostype) {
  if (!ostype) return null;
  if (/^w/.test(ostype)) return 'windows';
  if (/^l2/.test(ostype)) return 'linux';
  return null;
}

function osOf(row, ostype) {
  const known = familyOf(ostype ?? row.ostype);
  if (known) return known;
  const tpl = row.spec ? JSON.parse(row.spec).template : null;
  const setup = tpl ? templateSetup.get(tpl)?.setup : null;
  if (setup) return setup === 'windows' ? 'windows' : 'linux';
  return row.type === 'lxc' ? 'linux' : null;
}

function summarize(row, guest) {
  return {
    os: osOf(row, guest?.ostype),
    vmid: row.vmid,
    type: row.type,
    state: row.state,
    error: row.state === 'failed' ? row.error : null,
    progress: row.state === 'creating' ? row.progress : null,
    deletable: !!row.created_by_customer,
    name: row.label || guest?.name || (row.spec && JSON.parse(row.spec).hostname) || `Server ${row.vmid}`,
    hostname: guest?.name ?? null,
    status: guest?.status ?? 'unknown',
    cpu: guest?.cpu ?? 0,
    cores: guest?.maxcpu ?? null,
    mem: guest?.mem ?? 0,
    maxmem: guest?.maxmem ?? null,
    maxdisk: guest?.maxdisk ?? null,
    uptime: guest?.uptime ?? 0,
    locked: guest?.lock ?? null,
  };
}

async function guestIps(path) {
  try {
    const data = await pve.get(`${path}/agent/network-get-interfaces`);
    const ips = [];
    for (const iface of data?.result ?? []) {
      if (iface.name === 'lo') continue;
      for (const a of iface['ip-addresses'] ?? []) {
        const ip = a['ip-address'];
        if (!ip || ip.startsWith('127.') || ip === '::1' || ip.toLowerCase().startsWith('fe80')) continue;
        ips.push(ip);
      }
    }
    return ips;
  } catch {
    return null; // guest agent not installed or not running
  }
}

export default async function vmRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // All servers of the signed-in customer
  app.get('/api/vms', async (req) => {
    const rows = listForUser.all(req.account.id);
    const guests = await clusterGuests();
    // First time a server shows up: read its OS type once (e.g. assigned Windows VMs).
    const unknown = rows.filter((r) => !r.ostype && r.state === 'ready' && guests.has(r.vmid));
    await Promise.allSettled(unknown.map(async (r) => {
      const cfg = await pve.get(`${guestPath(guests.get(r.vmid))}/config`);
      r.ostype = cfg.ostype ?? (r.type === 'lxc' ? 'l26' : 'other');
      saveOstype.run(r.ostype, r.vmid);
    }));
    return rows.map((row) => summarize(row, guests.get(row.vmid)));
  });

  // ---- Self-service creation ---------------------------------------------

  app.get('/api/account', async (req) => {
    const a = req.account;
    const network = networkOf(a.id);
    const vpn = vpnInfoFor(a.id);
    const tailscale = config.tailscale.enabled;
    // Version number only; commit, build date and update status stay admin-only.
    const panelVersion = config.showVersionToCustomers ? versionInfo.version : null;
    if (!a.can_create) return { canCreate: false, network, vpn, tailscale, panelVersion };
    return {
      canCreate: true,
      limits: limitsOf(a),
      usage: await usageOf(a.id),
      network,
      networksEnabled: config.network.enabled,
      vpn,
      tailscale,
      panelVersion,
    };
  });

  app.get('/api/templates', async (req, reply) => {
    if (!req.account.can_create) return reply.code(403).send({ error: 'Creating servers is not enabled for your account' });
    return offeredTemplates();
  });

  app.post('/api/vms', {
    config: { rateLimit: { max: 15, timeWindow: '10 minutes' } },
    schema: {
      body: {
        type: 'object',
        required: ['hostname', 'templateId', 'cores', 'memoryMb', 'diskGb'],
        additionalProperties: false,
        properties: {
          hostname: { type: 'string', pattern: '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' },
          templateId: { type: 'integer', minimum: 100 },
          cores: { type: 'integer', minimum: 1, maximum: 128 },
          memoryMb: { type: 'integer', minimum: 512, maximum: 1048576 },
          diskGb: { type: 'integer', minimum: 1, maximum: 65536 },
          username: { type: 'string', pattern: '^[a-z_][a-z0-9_-]{0,31}$' },
          password: { type: 'string', minLength: 12, maxLength: 200 },
          sshKeys: { type: 'string', maxLength: 16000 },
        },
      },
    },
  }, async (req, reply) => {
    const spec = { ...req.body };
    if (spec.sshKeys?.trim()) {
      const bad = spec.sshKeys.trim().split(/\r?\n/)
        .filter((l) => l.trim() && !/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-|sk-)\S*\s+\S+/.test(l.trim()));
      if (bad.length) return reply.code(400).send({ error: 'One of the SSH keys is not in OpenSSH format (ssh-ed25519 AAAA… or ssh-rsa AAAA…)' });
    }
    const vmid = await createServer(req, spec);
    return reply.code(202).send({ vmid });
  });

  app.delete('/api/vms/:vmid', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (req, reply) => {
    const vmid = Number(req.params.vmid);
    const row = Number.isInteger(vmid) ? ownedByUser.get(vmid, req.account.id) : null;
    if (!row) throw notFound();
    if (!row.created_by_customer) {
      return reply.code(403).send({ error: 'This server was set up for you by your provider. Contact support to cancel it.' });
    }
    if (row.state === 'creating' || row.state === 'deleting') {
      return reply.code(409).send({ error: 'Wait until the current operation has finished' });
    }
    const result = await deleteServer(req, row);
    return reply.code(202).send(result);
  });

  // ---- Tailscale (the customer's own tailnet) --------------------------------
  app.get('/api/vms/:vmid/tailscale', async (req) => tailscaleStatus(req, Number(req.params.vmid)));

  app.post('/api/vms/:vmid/tailscale', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    schema: {
      body: {
        type: 'object',
        required: ['authKey', 'mode', 'hostname'],
        additionalProperties: false,
        properties: {
          authKey: { type: 'string', maxLength: 220 },
          mode: { type: 'string', enum: ['server', 'gateway'] },
          hostname: { type: 'string', maxLength: 63 },
        },
      },
    },
  }, async (req, reply) => {
    await connectTailscale(req, Number(req.params.vmid), req.body);
    return reply.code(202).send({ started: true });
  });

  app.delete('/api/vms/:vmid/tailscale', async (req) => disconnectTailscale(req, Number(req.params.vmid)));

  // Detail view
  app.get('/api/vms/:vmid', async (req) => {
    const { row, guest, path } = await ownedGuest(req);
    const [status, cfg] = await Promise.all([
      pve.get(`${path}/status/current`),
      pve.get(`${path}/config`),
    ]);
    if (cfg.ostype && cfg.ostype !== row.ostype) saveOstype.run(cfg.ostype, row.vmid);

    const ips = guest.type === 'qemu' && status.status === 'running' && status.agent
      ? await guestIps(path)
      : null;

    return {
      ...summarize(row, { ...guest, ...status, maxcpu: status.cpus ?? guest.maxcpu }),
      os: cfg.ostype ?? null,          // raw Proxmox ostype, e.g. "win11", "l26"
      osFamily: osOf(row, cfg.ostype),  // 'windows' | 'linux' | null
      memoryMb: Number(cfg.memory) || null,
      cores: (Number(cfg.cores) || 1) * (Number(cfg.sockets) || 1),
      ipconfig: cfg.ipconfig0 ?? cfg.net0 ?? null,
      ips,
      netin: status.netin ?? 0,
      netout: status.netout ?? 0,
    };
  });

  // Power actions
  app.post('/api/vms/:vmid/power/:action', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { guest, path } = await ownedGuest(req);
    const { action } = req.params;
    if (!POWER_ACTIONS[guest.type].includes(action)) {
      return reply.code(400).send({ error: `Unsupported action "${action}"` });
    }
    const upid = await pve.post(`${path}/status/${action}`);
    return recordTask(req, guest, upid, `power_${action}`);
  });

  // Usage graphs
  app.get('/api/vms/:vmid/rrd', async (req, reply) => {
    const { path } = await ownedGuest(req);
    const timeframe = req.query.timeframe ?? 'hour';
    if (!TIMEFRAMES.includes(timeframe)) {
      return reply.code(400).send({ error: 'timeframe must be hour, day, week or month' });
    }
    const data = await pve.get(`${path}/rrddata`, { timeframe, cf: 'AVERAGE' });
    return data.map((p) => ({
      time: p.time,
      cpu: p.cpu ?? null,
      mem: p.mem ?? null,
      maxmem: p.maxmem ?? null,
      netin: p.netin ?? null,
      netout: p.netout ?? null,
      diskread: p.diskread ?? null,
      diskwrite: p.diskwrite ?? null,
    }));
  });

  // Snapshots
  app.get('/api/vms/:vmid/snapshots', async (req) => {
    const { path } = await ownedGuest(req);
    const list = await pve.get(`${path}/snapshot`);
    return list
      .filter((s) => s.name !== 'current')
      .map((s) => ({
        name: s.name,
        description: s.description ?? '',
        time: s.snaptime ?? null,
        includesRam: !!s.vmstate,
      }))
      .sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  });

  app.post('/api/vms/:vmid/snapshots', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', maxLength: 40 },
          description: { type: 'string', maxLength: 200 },
          includeRam: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const { guest, path } = await ownedGuest(req);
    const { name, description = '', includeRam = false } = req.body;
    if (!SNAPSHOT_NAME.test(name)) {
      return reply.code(400).send({
        error: 'Snapshot names start with a letter and use only letters, numbers, - and _ (2–40 characters)',
      });
    }
    const existing = (await pve.get(`${path}/snapshot`)).filter((s) => s.name !== 'current');
    if (existing.length >= config.limits.maxSnapshots) {
      return reply.code(409).send({
        error: `Your plan allows ${config.limits.maxSnapshots} snapshots. Delete one to create another.`,
      });
    }
    // Saving RAM (vmstate) only exists for VMs and needs a running VM. It also
    // skips the guest-agent filesystem freeze, which can hang on some guests
    // (e.g. Windows VSS). The state file uses disk space equal to the used RAM.
    const params = { snapname: name, description };
    if (includeRam) {
      // Live status, not the few-seconds cache: the server may have just been started.
      const live = guest.type === 'qemu' ? (await pve.get(`${path}/status/current`)).status : null;
      if (live !== 'running') {
        return reply.code(400).send({ error: 'RAM can only be included for a running VM' });
      }
      params.vmstate = 1;
    }
    const upid = await pve.post(`${path}/snapshot`, params);
    return recordTask(req, guest, upid, 'snapshot_create');
  });

  app.post('/api/vms/:vmid/snapshots/:name/rollback', async (req, reply) => {
    const { guest, path } = await ownedGuest(req);
    if (!SNAPSHOT_NAME.test(req.params.name)) return reply.code(400).send({ error: 'Invalid snapshot name' });
    const upid = await pve.post(`${path}/snapshot/${req.params.name}/rollback`);
    return recordTask(req, guest, upid, 'snapshot_rollback');
  });

  app.delete('/api/vms/:vmid/snapshots/:name', async (req, reply) => {
    const { guest, path } = await ownedGuest(req);
    if (!SNAPSHOT_NAME.test(req.params.name)) return reply.code(400).send({ error: 'Invalid snapshot name' });
    const upid = await pve.del(`${path}/snapshot/${req.params.name}`);
    return recordTask(req, guest, upid, 'snapshot_delete');
  });

  // Task progress — only for tasks this user started through the panel
  app.get('/api/tasks/:upid', async (req) => {
    const task = findTask.get(req.params.upid, req.account.id);
    if (!task) throw notFound();
    const status = await pve.get(
      `/nodes/${encodeURIComponent(task.node)}/tasks/${encodeURIComponent(task.upid)}/status`
    );
    return {
      done: status.status === 'stopped',
      ok: status.status === 'stopped' ? status.exitstatus === 'OK' : null,
      message: status.exitstatus ?? null,
      action: task.action,
    };
  });
}
