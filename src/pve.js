import fs from 'node:fs';
import { Agent, fetch } from 'undici';
import { config } from './config.js';

const ca = config.pve.caFile ? fs.readFileSync(config.pve.caFile) : undefined;

export const tlsOptions = { rejectUnauthorized: config.pve.verifyTls, ca };
export const authHeader = `PVEAPIToken=${config.pve.tokenId}=${config.pve.tokenSecret}`;

const dispatcher = new Agent({ connect: tlsOptions });

export class PveError extends Error {
  constructor(status, message, errors) {
    super(message);
    this.name = 'PveError';
    this.statusCode = status;
    this.errors = errors;
  }
}

async function request(method, path, params) {
  const url = new URL(`${config.pve.url}/api2/json${path}`);
  const init = { method, headers: { Authorization: authHeader }, dispatcher };

  if (params) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      // Array parameters (e.g. agent exec "command") are sent as repeated keys.
      if (Array.isArray(v)) v.forEach((item) => body.append(k, String(item)));
      else body.append(k, String(v));
    }
    if (method === 'GET' || method === 'DELETE') {
      url.search = body.toString();
    } else {
      init.body = body.toString();
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // Network/TLS failure: log the cause server-side, keep details out of the response.
    console.error('Proxmox unreachable:', err.cause?.code || err.cause?.message || err.message);
    throw new PveError(503, 'The server platform is unreachable right now. Try again in a minute.');
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }

  if (!res.ok) {
    // Proxmox puts the human-readable reason in the status text,
    // e.g. "VM 101 not running".
    const message = json?.message || res.statusText || text || 'Proxmox request failed';
    throw new PveError(res.status, message.trim(), json?.errors);
  }
  return json?.data;
}

export const pve = {
  get: (path, params) => request('GET', path, params),
  post: (path, params) => request('POST', path, params),
  put: (path, params) => request('PUT', path, params),
  del: (path, params) => request('DELETE', path, params),
};

// ---- Guest lookup -------------------------------------------------------
// Guests can migrate between nodes, so the node is resolved on demand
// from /cluster/resources instead of being stored in our database.

let cache = { at: 0, byId: new Map() };

export async function clusterGuests(force = false) {
  if (!force && Date.now() - cache.at < 5000) return cache.byId;
  const list = await pve.get('/cluster/resources', { type: 'vm' });
  const byId = new Map();
  for (const r of list) byId.set(Number(r.vmid), r);
  cache = { at: Date.now(), byId };
  return byId;
}

export async function locateGuest(vmid) {
  let guest = (await clusterGuests()).get(vmid);
  if (!guest) guest = (await clusterGuests(true)).get(vmid);
  if (!guest || guest.template) {
    const err = new Error('Server not found');
    err.statusCode = 404;
    throw err;
  }
  return guest; // { vmid, node, type: 'qemu' | 'lxc', name, status, ... }
}

export function guestPath(guest) {
  return `/nodes/${encodeURIComponent(guest.node)}/${guest.type}/${guest.vmid}`;
}

export function invalidateGuestCache() {
  cache.at = 0;
}

export async function locateTemplate(vmid) {
  let guest = (await clusterGuests()).get(vmid);
  if (!guest) guest = (await clusterGuests(true)).get(vmid);
  if (!guest || !guest.template || guest.type !== 'qemu') {
    const err = new Error('Template not found');
    err.statusCode = 404;
    throw err;
  }
  return guest;
}

// ---- Tasks ----------------------------------------------------------------

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits for a Proxmox task (UPID) to finish; throws if it didn't end OK. */
export async function waitTask(node, upid, timeoutMs = 30 * 60_000) {
  if (typeof upid !== 'string' || !upid.startsWith('UPID:')) return; // synchronous call
  node = node ?? upid.split(':')[1];
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await pve.get(
      `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`
    );
    if (s.status === 'stopped') {
      const exit = s.exitstatus ?? '';
      if (exit === 'OK' || exit.startsWith('WARNINGS')) return exit;
      throw new Error(`Proxmox task failed: ${exit || 'unknown error'}`);
    }
    await sleep(2000);
  }
  throw new Error('Proxmox task did not finish in time');
}

// ---- Disk helpers -----------------------------------------------------------

/** Finds the key of the boot disk in a VM config, e.g. "scsi0". */
export function bootDiskKey(cfg) {
  const order = /order=([^,\s]+)/.exec(cfg.boot ?? '')?.[1]?.split(';') ?? [];
  const candidates = [...order, cfg.bootdisk, 'scsi0', 'virtio0', 'sata0', 'ide0'].filter(Boolean);
  for (const key of candidates) {
    const value = cfg[key];
    if (typeof value === 'string' && !value.includes('media=cdrom') && !value.includes('cloudinit')) {
      return key;
    }
  }
  return null;
}

/** "local-lvm:vm-101-disk-0,size=32G" -> 32 */
export function diskSizeGb(value) {
  const m = /size=(\d+(?:\.\d+)?)([KMGT]?)/.exec(value ?? '');
  if (!m) return 0;
  const n = Number(m[1]);
  return { K: n / 1024 ** 2, M: n / 1024, G: n, T: n * 1024, '': n / 1024 ** 3 }[m[2]];
}

// ---- Serialisation ----------------------------------------------------------
// "Get next free VMID" and "start clone" must not interleave between two
// requests, or both would get the same ID.
let chain = Promise.resolve();
export function serial(fn) {
  const run = chain.then(() => fn());
  chain = run.catch(() => {});
  return run;
}
