// Central WireGuard gateway for customer VPN access.
//
//   laptop ──WireGuard──▶ VPN_ENDPOINT (UDP) ──▶ gateway VM (wg0 10.101.0.1/16)
//                                                   │  customer N devices: 10.101.N.x/32
//                                                   │  may only reach      10.100.N.0/24
//                                                   ▼
//                                  Proxmox host routes into the customer's VNet
//
// The panel's database is the source of truth. After every change it writes the
// complete peer list and firewall rules to the gateway (through the QEMU guest
// agent, so the gateway needs no management port) and applies them atomically.
//
// Isolation, three layers:
//   1. WireGuard: each device may only send from its own /32 (cryptokey routing)
//   2. Gateway nftables: customer N's devices may only reach 10.100.N.0/24
//   3. VM firewall on every customer server: only its own customer's VPN range

import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { db, audit } from './db.js';
import { config } from './config.js';
import { locateGuest, guestPath } from './pve.js';
import { agentExec } from './agent.js';
import { networkOf, allNetworks, ensureVpnRules } from './network.js';

const { prefix: vpnPrefix, maxDevices, endpoint } = config.vpn;
const customerPrefix = config.network.prefix;

export class VpnError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
    this.expose = true;
  }
}

// ---- Keys -------------------------------------------------------------------

/** WireGuard keys are raw X25519 keys in base64 (32 bytes). */
function generateKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const raw = (b64url) => Buffer.from(b64url, 'base64url').toString('base64');
  return {
    privateKey: raw(privateKey.export({ format: 'jwk' }).d),
    publicKey: raw(publicKey.export({ format: 'jwk' }).x),
  };
}

// ---- Gateway ------------------------------------------------------------------

async function gatewayPath() {
  const guest = await locateGuest(config.vpn.gatewayVmid);
  if (guest.status !== 'running') throw new VpnError(503, 'The VPN gateway is not running');
  return guestPath(guest);
}

const sh = (script) => ['/bin/bash', '-c', script];

let cachedGatewayKey = null;
async function gatewayPublicKey(path) {
  if (cachedGatewayKey) return cachedGatewayKey;
  const r = await agentExec(path, sh('wg show wg0 public-key'), 30_000);
  const key = r.out.trim();
  if (r.code !== 0 || !/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/.test(key)) {
    throw new VpnError(503, 'The VPN gateway is not set up (wg0 not running)');
  }
  cachedGatewayKey = key;
  return key;
}

function allDevices() {
  return db.prepare(`
    SELECT d.*, n.idx FROM vpn_devices d
    JOIN networks n ON n.user_id = d.user_id
    ORDER BY n.idx, d.host
  `).all();
}

function renderPeers(devices) {
  const lines = ['# Managed by pve-panel. Changes here are overwritten.'];
  for (const d of devices) {
    lines.push('', `# customer ${d.user_id}: ${d.name.replace(/[\r\n]/g, ' ')}`, '[Peer]',
      `PublicKey = ${d.public_key}`,
      `AllowedIPs = ${vpnPrefix}.${d.idx}.${d.host}/32`);
  }
  return `${lines.join('\n')}\n`;
}

function renderRules(networks) {
  const perCustomer = networks.flatMap((n) => [
    `    iifname "wg0" ip saddr ${vpnPrefix}.${n.idx}.0/24 ip daddr ${customerPrefix}.${n.idx}.0/24 accept`,
  ]);
  return `# Managed by pve-panel. Changes here are overwritten.
table inet panel_vpn
delete table inet panel_vpn
table inet panel_vpn {
  chain input {
    type filter hook input priority 0; policy accept;
    # VPN devices may not talk to the gateway itself (SSH etc.)
    iifname "wg0" drop
  }
  chain forward {
    type filter hook forward priority 0; policy accept;
${perCustomer.join('\n')}
    iifname "wg0" drop
    oifname "wg0" ct state established,related accept
    oifname "wg0" drop
  }
}
`;
}

let syncChain = Promise.resolve();

/** Writes all peers + rules to the gateway and applies them (serialised). */
export function syncGateway() {
  const run = syncChain.then(async () => {
    const path = await gatewayPath();
    const devices = allDevices();
    const networks = [...new Map(devices.map((d) => [d.idx, { idx: d.idx }])).values()];

    const write = async (file, content) => {
      const r = await agentExec(path, sh(`umask 077; cat > ${file}.new && mv ${file}.new ${file}`), 30_000, content);
      if (r.code !== 0) throw new VpnError(502, `Updating the VPN gateway failed: ${r.err.trim() || r.code}`);
    };
    await write('/etc/wireguard/panel-peers.conf', renderPeers(devices));
    await write('/etc/wireguard/panel-rules.nft', renderRules(networks));

    const r = await agentExec(path, sh(
      'set -e; wg syncconf wg0 <(wg-quick strip wg0; cat /etc/wireguard/panel-peers.conf); '
      + 'nft -f /etc/wireguard/panel-rules.nft; echo applied',
    ), 60_000);
    if (!r.out.includes('applied')) {
      throw new VpnError(502, `Applying the VPN configuration failed: ${r.err.trim() || `exit code ${r.code}`}`);
    }
  });
  syncChain = run.catch(() => {});
  return run;
}

/** Latest handshake per public key (unix seconds, 0 = never). */
async function handshakes() {
  try {
    const path = await gatewayPath();
    const r = await agentExec(path, sh('wg show wg0 latest-handshakes'), 30_000);
    const map = new Map();
    for (const line of r.out.split('\n')) {
      const [key, ts] = line.trim().split(/\s+/);
      if (key && ts) map.set(key, Number(ts));
    }
    return map;
  } catch {
    return null; // gateway unreachable: show devices without status
  }
}

// ---- Devices ----------------------------------------------------------------

function present(d, hs) {
  const idx = d.idx ?? networkOf(d.user_id)?.idx;
  return {
    id: d.id,
    name: d.name,
    address: `${vpnPrefix}.${idx}.${d.host}`,
    createdAt: d.created_at,
    lastHandshake: hs ? (hs.get(d.public_key) || 0) : null, // null = unknown
  };
}

export async function listDevices(userId) {
  const rows = db.prepare(`
    SELECT d.*, n.idx FROM vpn_devices d JOIN networks n ON n.user_id = d.user_id
    WHERE d.user_id = ? ORDER BY d.host
  `).all(userId);
  const hs = rows.length ? await handshakes() : null;
  return rows.map((d) => present(d, hs));
}

export function vpnInfoFor(userId) {
  const net = networkOf(userId);
  return {
    enabled: config.vpn.enabled && !!net,
    maxDevices,
    network: net ? net.subnet : null,
    endpoint,
  };
}

function clientConfig({ privateKey, address, gatewayKey, net }) {
  return `[Interface]
PrivateKey = ${privateKey}
Address = ${address}/32

[Peer]
PublicKey = ${gatewayKey}
Endpoint = ${endpoint}
AllowedIPs = ${net.subnet}
PersistentKeepalive = 25
`;
}

/**
 * Creates a device, updates the gateway, and returns the client config.
 * The private key only exists in this response.
 */
export async function addDevice(req, name) {
  if (!config.vpn.enabled) throw new VpnError(404, 'VPN access is not available');
  const userId = req.account.id;
  const net = networkOf(userId);
  if (!net) throw new VpnError(409, 'Create a server first. Your private network is set up with it.');

  const count = db.prepare('SELECT COUNT(*) AS n FROM vpn_devices WHERE user_id = ?').get(userId).n;
  if (count >= maxDevices) {
    throw new VpnError(409, `You can have up to ${maxDevices} VPN devices. Remove one to add another.`);
  }

  const path = await gatewayPath();
  const gatewayKey = await gatewayPublicKey(path);

  const used = new Set(db.prepare('SELECT host FROM vpn_devices WHERE user_id = ?').all(userId).map((r) => r.host));
  let host = 2;
  while (used.has(host)) host += 1;

  const keys = generateKeyPair();
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO vpn_devices (user_id, name, public_key, host) VALUES (?, ?, ?, ?)'
  ).run(userId, name, keys.publicKey, host);
  const id = Number(lastInsertRowid);

  try {
    await syncGateway();
  } catch (err) {
    db.prepare('DELETE FROM vpn_devices WHERE id = ?').run(id);
    throw err;
  }

  // Servers created before VPN was switched on get their VPN firewall rules now.
  await addVpnRulesToServers(userId, net).catch((err) => req.log?.warn({ err }, 'adding VPN rules failed'));

  const address = `${vpnPrefix}.${net.idx}.${host}`;
  const conf = clientConfig({ privateKey: keys.privateKey, address, gatewayKey, net });
  audit(req, null, 'vpn_device_add', { name, address });

  return {
    device: { id, name, address, createdAt: new Date().toISOString(), lastHandshake: 0 },
    config: conf,
    qrSvg: await QRCode.toString(conf, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
  };
}

async function addVpnRulesToServers(userId, net) {
  const rows = db.prepare(
    "SELECT vmid FROM vms WHERE user_id = ? AND created_by_customer = 1 AND state = 'ready'"
  ).all(userId);
  for (const { vmid } of rows) {
    const guest = await locateGuest(vmid).catch(() => null);
    if (guest) await ensureVpnRules(guestPath(guest), net);
  }
}

/** Removes a device. Customers can only remove their own; admins any. */
export async function removeDevice(req, id, { asAdmin = false } = {}) {
  const row = asAdmin
    ? db.prepare('SELECT * FROM vpn_devices WHERE id = ?').get(id)
    : db.prepare('SELECT * FROM vpn_devices WHERE id = ? AND user_id = ?').get(id, req.account.id);
  if (!row) throw new VpnError(404, 'Device not found');

  db.prepare('DELETE FROM vpn_devices WHERE id = ?').run(id);
  try {
    await syncGateway();
  } catch (err) {
    // Keep the database and the gateway consistent: put it back and report.
    db.prepare('INSERT INTO vpn_devices (id, user_id, name, public_key, host, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.user_id, row.name, row.public_key, row.host, row.created_at);
    throw err;
  }
  audit(req, null, asAdmin ? 'admin_vpn_device_remove' : 'vpn_device_remove', { name: row.name });
}

// ---- Admin --------------------------------------------------------------------

export async function adminOverview() {
  const status = { enabled: config.vpn.enabled, endpoint, gatewayVmid: config.vpn.gatewayVmid };
  if (!config.vpn.enabled) return { status, devices: [] };
  try {
    const path = await gatewayPath();
    status.publicKey = await gatewayPublicKey(path);
    status.reachable = true;
  } catch (err) {
    status.reachable = false;
    status.error = err.message;
  }
  const emails = new Map(allNetworks().map((n) => [n.userId, n.email]));
  const hs = status.reachable ? await handshakes() : null;
  const devices = allDevices().map((d) => ({ ...present(d, hs), email: emails.get(d.user_id) ?? null }));
  return { status, devices };
}

/** Re-apply the full state, e.g. after the panel starts or the gateway was rebuilt. */
export async function syncOnStartup(log) {
  if (!config.vpn.enabled) return;
  try {
    await syncGateway();
    log.info('VPN gateway configuration applied');
  } catch (err) {
    log.warn(`VPN gateway not updated at startup: ${err.message}`);
  }
}
