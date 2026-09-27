import bcrypt from 'bcryptjs';
import { db, audit } from '../db.js';
import { pve, clusterGuests, locateGuest, locateTemplate, invalidateGuestCache, guestPath } from '../pve.js';
import { startCustomerDeletion, deletionPlan, destroyServer, isProtected } from '../cleanup.js';
import { tailscaleOverview } from '../tailscale.js';
import * as totp from '../totp.js';
import { usageOf } from '../provision.js';
import { networkOf, allNetworks } from '../network.js';
import { adminOverview, removeDevice, syncGateway } from '../vpn.js';
import { config } from '../config.js';

const PASSWORD = { type: 'string', minLength: 12, maxLength: 200 };

function badRequest(reply, error) {
  return reply.code(400).send({ error });
}

export default async function adminRoutes(app) {
  app.addHook('preHandler', app.requireAdmin);

  // ---- Users ------------------------------------------------------------

  app.get('/api/admin/users', async () => {
    const users = db.prepare(`
      SELECT u.id, u.email, u.is_admin AS isAdmin, u.created_at AS createdAt,
             u.can_create AS canCreate, u.max_servers AS maxServers, u.max_cores AS maxCores,
             u.max_memory_mb AS maxMemoryMb, u.max_disk_gb AS maxDiskGb,
             u.deleting, u.deletion_error AS deletionError,
             u.totp_enabled AS totpEnabled, u.totp_required AS totpRequired,
             u.oidc_issuer AS ssoIssuer, u.oidc_subject IS NOT NULL AS ssoLinked,
             COUNT(v.vmid) AS servers
      FROM users u LEFT JOIN vms v ON v.user_id = u.id
      GROUP BY u.id ORDER BY u.email
    `).all();
    return Promise.all(users.map(async (u) => ({
      ...u,
      isAdmin: !!u.isAdmin,
      canCreate: !!u.canCreate,
      deleting: !!u.deleting,
      totpEnabled: !!u.totpEnabled,
      totpRequired: !!u.totpRequired,
      ssoLinked: !!u.ssoLinked,
      usage: u.canCreate ? await usageOf(u.id).catch(() => null) : null,
      network: networkOf(u.id),
    })));
  });

  app.post('/api/admin/users', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email', maxLength: 254 },
          password: PASSWORD,
          isAdmin: { type: 'boolean' },
          requireTotp: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const { email, password, isAdmin = false, requireTotp = false } = req.body;
    const clean = email.trim();
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(clean)) {
      return reply.code(409).send({ error: 'A user with this email already exists' });
    }
    const hash = await bcrypt.hash(password, 12);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (email, password_hash, is_admin, totp_required) VALUES (?, ?, ?, ?)')
      .run(clean, hash, isAdmin ? 1 : 0, requireTotp ? 1 : 0);
    audit(req, null, 'admin_user_create', { email: clean, isAdmin, requireTotp });
    return reply.code(201).send({ id: Number(lastInsertRowid), email: clean, isAdmin });
  });

  // Reset password and/or change admin rights
  app.patch('/api/admin/users/:id', {
    schema: {
      body: {
        type: 'object',
        minProperties: 1,
        additionalProperties: false,
        properties: {
          password: PASSWORD,
          isAdmin: { type: 'boolean' },
          canCreate: { type: 'boolean' },
          maxServers: { type: 'integer', minimum: 0, maximum: 1000 },
          maxCores: { type: 'integer', minimum: 0, maximum: 10000 },
          maxMemoryMb: { type: 'integer', minimum: 0, maximum: 100 * 1024 * 1024 },
          maxDiskGb: { type: 'integer', minimum: 0, maximum: 1000 * 1024 },
          totpRequired: { type: 'boolean' },
          resetTotp: { type: 'boolean', const: true },
          unlinkSso: { type: 'boolean', const: true },
        },
      },
    },
  }, async (req, reply) => {
    const id = Number(req.params.id);
    const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(id);
    if (!user) return reply.code(404).send({ error: 'User not found' });

    const { password, isAdmin } = req.body;
    if (isAdmin === false && id === req.account.id) {
      return badRequest(reply, "You can't remove your own admin rights");
    }
    if (password) {
      const hash = await bcrypt.hash(password, 12);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
      audit(req, null, 'admin_password_reset', { email: user.email });
    }
    if (typeof isAdmin === 'boolean') {
      db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
      audit(req, null, isAdmin ? 'admin_grant' : 'admin_revoke', { email: user.email });
    }
    if (typeof req.body.totpRequired === 'boolean') {
      db.prepare('UPDATE users SET totp_required = ? WHERE id = ?').run(req.body.totpRequired ? 1 : 0, id);
      audit(req, null, req.body.totpRequired ? 'admin_twofa_require' : 'admin_twofa_unrequire', { email: user.email });
    }
    if (req.body.unlinkSso) {
      // The next single sign-on links again by verified email (or is refused).
      db.prepare('UPDATE users SET oidc_issuer = NULL, oidc_subject = NULL WHERE id = ?').run(id);
      audit(req, null, 'admin_sso_unlink', { email: user.email });
    }
    if (req.body.resetTotp) {
      // Lost phone and recovery codes: 2FA is removed; if required, the user
      // sets it up again at the next sign-in.
      totp.reset(id);
      audit(req, null, 'admin_twofa_reset', { email: user.email });
    }

    const limitFields = {
      canCreate: 'can_create', maxServers: 'max_servers', maxCores: 'max_cores',
      maxMemoryMb: 'max_memory_mb', maxDiskGb: 'max_disk_gb',
    };
    const changed = Object.keys(limitFields).filter((k) => k in req.body);
    if (changed.length) {
      const sets = changed.map((k) => `${limitFields[k]} = ?`).join(', ');
      const values = changed.map((k) => (typeof req.body[k] === 'boolean' ? (req.body[k] ? 1 : 0) : req.body[k]));
      db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...values, id);
      audit(req, null, 'admin_limits', { email: user.email, ...Object.fromEntries(changed.map((k) => [k, req.body[k]])) });
    }
    return { id, email: user.email };
  });

  // What deleting a customer would remove (shown in the confirmation dialog)
  app.get('/api/admin/users/:id/deletion-plan', async (req, reply) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return reply.code(404).send({ error: 'User not found' });
    return deletionPlan(id);
  });

  // Deletes the customer completely in the background: servers, VPN devices,
  // private network, account. ?keepAssigned=true only unassigns servers an
  // admin assigned (servers the customer created are always deleted).
  app.delete('/api/admin/users/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (id === req.account.id) return badRequest(reply, "You can't delete your own account");
    startCustomerDeletion(req, id, {
      keepAssigned: req.query.keepAssigned === 'true',
      keepNetwork: req.query.keepNetwork === 'true',
    });
    return reply.code(202).send({ started: true });
  });

  // ---- Server assignments ---------------------------------------------

  // Every guest in the cluster, with its current owner (if any)
  app.get('/api/admin/vms', async () => {
    const owners = new Map(
      db.prepare(`SELECT v.vmid, v.label, v.user_id, v.state, v.created_by_customer, u.email
                  FROM vms v JOIN users u ON u.id = v.user_id`)
        .all().map((r) => [r.vmid, r])
    );
    const guests = await clusterGuests(true);
    const list = [...guests.values()]
      .filter((g) => !g.template)
      .map((g) => {
        const o = owners.get(Number(g.vmid));
        return {
          vmid: Number(g.vmid), name: g.name ?? '', node: g.node, type: g.type, status: g.status,
          userId: o?.user_id ?? null, owner: o?.email ?? null, label: o?.label ?? null,
          state: o?.state ?? null, createdByCustomer: !!o?.created_by_customer,
        };
      });
    // Assignments whose guest no longer exists in the cluster (deleted in PVE)
    for (const [vmid, o] of owners) {
      if (!guests.has(vmid)) {
        list.push({ vmid, name: '', node: null, type: null, status: 'missing',
          userId: o.user_id, owner: o.email, label: o.label,
          state: o.state, createdByCustomer: !!o.created_by_customer });
      }
    }
    return list.sort((a, b) => a.vmid - b.vmid);
  });

  app.put('/api/admin/vms/:vmid', {
    schema: {
      body: {
        type: 'object',
        required: ['userId'],
        properties: { userId: { type: 'integer' }, label: { type: 'string', maxLength: 80 } },
      },
    },
  }, async (req, reply) => {
    const vmid = Number(req.params.vmid);
    const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.body.userId);
    if (!user) return badRequest(reply, 'That customer no longer exists');
    const guest = await locateGuest(vmid);
    const label = req.body.label?.trim() || null;
    const previous = db.prepare('SELECT user_id FROM vms WHERE vmid = ?').get(vmid);
    db.prepare(`
      INSERT INTO vms (vmid, user_id, type, label) VALUES (?, ?, ?, ?)
      ON CONFLICT(vmid) DO UPDATE SET user_id = excluded.user_id, type = excluded.type, label = excluded.label
    `).run(vmid, user.id, guest.type, label);
    invalidateGuestCache();
    const renamedOnly = previous?.user_id === user.id;
    audit(req, vmid, renamedOnly ? 'admin_vm_rename' : 'admin_vm_assign', { email: user.email, label });
    return { vmid, userId: user.id, owner: user.email, label, type: guest.type };
  });

  // ---- Acting on customer servers ------------------------------------------
  // Only servers assigned to a customer; the VPN gateway and templates never.
  async function customerServer(req) {
    const vmid = Number(req.params.vmid);
    const row = db.prepare('SELECT * FROM vms WHERE vmid = ?').get(vmid);
    if (!row) {
      const err = new Error('Only servers assigned to a customer can be managed here');
      err.statusCode = 404;
      throw err;
    }
    const guest = await locateGuest(vmid);
    if (isProtected(vmid, guest)) {
      const err = new Error('This server is protected');
      err.statusCode = 403;
      throw err;
    }
    return { row, guest };
  }

  app.post('/api/admin/vms/:vmid/power/:action', async (req, reply) => {
    const { row, guest } = await customerServer(req);
    const { action } = req.params;
    if (!['start', 'shutdown', 'reboot', 'stop'].includes(action)) {
      return reply.code(400).send({ error: `Unsupported action "${action}"` });
    }
    if (row.state !== 'ready') return reply.code(409).send({ error: 'Wait until the current operation has finished' });
    const upid = await pve.post(`${guestPath(guest)}/status/${action}`);
    invalidateGuestCache();
    audit(req, guest.vmid, `admin_power_${action}`);
    return { task: typeof upid === 'string' && upid.startsWith('UPID:') ? upid : null };
  });

  // Stops (if needed) and destroys the server with its disks, in the background.
  app.delete('/api/admin/vms/:vmid/server', async (req, reply) => {
    const { row, guest } = await customerServer(req);
    if (row.state === 'creating' || row.state === 'deleting') {
      return reply.code(409).send({ error: 'Wait until the current operation has finished' });
    }
    const actor = { account: { id: req.account.id }, ip: req.ip };
    destroyServer(actor, guest.vmid).catch((err) => {
      db.prepare("UPDATE vms SET state = 'failed', error = ? WHERE vmid = ?")
        .run(`Deleting failed: ${err.message}`.slice(0, 500), guest.vmid);
    });
    return reply.code(202).send({ started: true });
  });

  // Progress of any task (admins see all)
  app.get('/api/admin/tasks/:upid', async (req, reply) => {
    const upid = req.params.upid;
    if (!/^UPID:[^:]+:/.test(upid)) return reply.code(400).send({ error: 'Not a task id' });
    const node = upid.split(':')[1];
    const s = await pve.get(`/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`);
    return { done: s.status === 'stopped', ok: s.status === 'stopped' ? s.exitstatus === 'OK' : null, message: s.exitstatus ?? null };
  });

  app.delete('/api/admin/vms/:vmid', async (req, reply) => {
    const vmid = Number(req.params.vmid);
    db.prepare('DELETE FROM vms WHERE vmid = ?').run(vmid);
    audit(req, vmid, 'admin_vm_unassign');
    return reply.code(204).send();
  });

  // ---- Templates for self-service creation --------------------------------

  app.get('/api/admin/templates', async () => {
    const rows = new Map(db.prepare('SELECT * FROM templates').all().map((t) => [t.vmid, t]));
    const guests = await clusterGuests(true);
    const templates = [...guests.values()].filter((g) => g.template && g.type === 'qemu');

    // Storages that can hold VM disks, per node, for the target-storage field
    const nodes = [...new Set(templates.map((t) => t.node))];
    const storages = {};
    await Promise.all(nodes.map(async (node) => {
      try {
        const list = await pve.get(`/nodes/${encodeURIComponent(node)}/storage`, { content: 'images', enabled: 1 });
        storages[node] = list.map((st) => st.storage).sort();
      } catch {
        storages[node] = [];
      }
    }));

    const list = templates.map((g) => {
      const row = rows.get(Number(g.vmid));
      return {
        vmid: Number(g.vmid), name: g.name ?? '', node: g.node,
        offered: !!row, label: row?.label ?? '', storage: row?.storage ?? '',
        ciUser: row?.ci_user ?? '', ipconfig: row?.ipconfig ?? 'ip=dhcp',
        setup: row?.setup ?? (/^win/.test(g.name ?? '') ? 'windows' : 'cloudinit'),
      };
    }).sort((a, b) => a.vmid - b.vmid);
    return { templates: list, storages };
  });

  app.put('/api/admin/templates/:vmid', {
    schema: {
      body: {
        type: 'object',
        required: ['label'],
        additionalProperties: false,
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 80 },
          storage: { type: 'string', maxLength: 100 },
          ciUser: { type: 'string', maxLength: 32 },
          ipconfig: { type: 'string', maxLength: 200 },
          setup: { type: 'string', enum: ['cloudinit', 'windows'] },
        },
      },
    },
  }, async (req) => {
    const vmid = Number(req.params.vmid);
    await locateTemplate(vmid);
    const { label, storage, ciUser, ipconfig, setup = 'cloudinit' } = req.body;
    db.prepare(`
      INSERT INTO templates (vmid, label, storage, ci_user, ipconfig, setup) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(vmid) DO UPDATE SET label = excluded.label, storage = excluded.storage,
        ci_user = excluded.ci_user, ipconfig = excluded.ipconfig, setup = excluded.setup
    `).run(vmid, label.trim(), storage?.trim() || null, ciUser?.trim() || null,
      ipconfig?.trim() || 'ip=dhcp', setup);
    audit(req, vmid, 'admin_template_offer', { label });
    return { vmid };
  });

  app.delete('/api/admin/templates/:vmid', async (req, reply) => {
    const vmid = Number(req.params.vmid);
    db.prepare('DELETE FROM templates WHERE vmid = ?').run(vmid);
    audit(req, vmid, 'admin_template_withdraw');
    return reply.code(204).send();
  });

  // ---- VPN ------------------------------------------------------------------
  app.get('/api/admin/vpn', async () => ({
    ...(await adminOverview()),
    tailscale: { enabled: config.tailscale.enabled, servers: tailscaleOverview() },
  }));

  app.delete('/api/admin/vpn/devices/:id', async (req, reply) => {
    await removeDevice(req, Number(req.params.id), { asAdmin: true });
    return reply.code(204).send();
  });

  app.post('/api/admin/vpn/sync', async () => {
    await syncGateway();
    return { ok: true };
  });

  // ---- Networks -------------------------------------------------------------
  app.get('/api/admin/networks', async () => allNetworks());

  // ---- Activity ---------------------------------------------------------

  app.get('/api/admin/audit', async (req) => {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    return db.prepare(`
      SELECT a.id, a.vmid, a.action, a.detail, a.ip, a.created_at AS createdAt, u.email
      FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC LIMIT ?
    `).all(limit);
  });
}
