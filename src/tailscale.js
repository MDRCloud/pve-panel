// Tailscale on customer servers, in the customer's OWN tailnet.
//
// The customer creates an auth key in their Tailscale account and pastes it in
// the panel. The panel installs Tailscale inside the server through the QEMU
// guest agent and connects it:
//   mode "server":  only this server joins the tailnet
//   mode "gateway": it also advertises the customer's 10.100.N.0/24 (subnet
//                   router, Linux only) so every server there is reachable
//
// The auth key reaches the VM on the agent's stdin, lives in a root-only file
// for the moment `tailscale up` needs it, and is deleted right after. The panel
// never stores it. Tailscale's default SNAT on subnet routes keeps forwarded
// traffic inside the customer's own subnet, so the existing firewall and IP
// filter rules stay in force.

import crypto from 'node:crypto';
import { db, audit } from './db.js';
import { config } from './config.js';
import { pve, locateGuest, guestPath } from './pve.js';
import { agentExec } from './agent.js';
import { networkOf } from './network.js';

export class TailscaleError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
    this.expose = true;
  }
}

const bash = (script) => ['/bin/bash', '-c', script];
const powershell = (script) => [
  'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
];
const WIN_TS = '& "$env:ProgramFiles\\Tailscale\\tailscale.exe"';

const firstLine = (t) => (t ?? '').trim().split('\n').filter(Boolean).slice(-1)[0]?.trim() ?? '';

function osFamily(cfg) {
  return /^w/.test(cfg.ostype ?? '') ? 'windows' : 'linux';
}

const row = (vmid) => db.prepare('SELECT * FROM tailscale WHERE vmid = ?').get(vmid);
const setState = (vmid, fields) => {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE tailscale SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE vmid = ?`)
    .run(...keys.map((k) => fields[k]), vmid);
};

// ---- Commands per OS --------------------------------------------------------

async function installLinux(path, gateway) {
  const r = await agentExec(path, bash(
    'set -e; export DEBIAN_FRONTEND=noninteractive; '
    + 'if ! command -v tailscale >/dev/null 2>&1; then curl -fsSL https://tailscale.com/install.sh | sh; fi; '
    + 'systemctl enable --now tailscaled >/dev/null 2>&1 || true; '
    + (gateway
      ? "printf 'net.ipv4.ip_forward = 1\\n' > /etc/sysctl.d/99-tailscale.conf; sysctl -q -p /etc/sysctl.d/99-tailscale.conf; "
      : '')
    + 'echo installed',
  ), 15 * 60_000);
  if (!r.out.includes('installed')) {
    throw new TailscaleError(502, `Installing Tailscale failed: ${firstLine(r.err) || `exit code ${r.code}`}`);
  }
}

async function upLinux(path, authKey, hostname, routes) {
  const keyFile = `/run/ts-authkey-${crypto.randomBytes(6).toString('hex')}`;
  const w = await agentExec(path, bash(`umask 077; cat > ${keyFile}`), 30_000, authKey);
  if (w.code !== 0) throw new TailscaleError(502, 'Could not hand the auth key to the server');
  const r = await agentExec(path, bash(
    `tailscale up --auth-key=file:${keyFile} --hostname=${hostname} --reset`
    + `${routes ? ` --advertise-routes=${routes}` : ''} --timeout=90s; rc=$?; `
    + `shred -u ${keyFile} 2>/dev/null || rm -f ${keyFile}; exit $rc`,
  ), 150_000);
  if (r.code !== 0) throw new TailscaleError(400, `Tailscale did not connect: ${firstLine(r.err) || firstLine(r.out) || `exit code ${r.code}`}`);
}

async function installWindows(path) {
  const r = await agentExec(path, powershell(`
$ErrorActionPreference = 'Stop'
if (-not (Test-Path "$env:ProgramFiles\\Tailscale\\tailscale.exe")) {
  $msi = Join-Path $env:SystemRoot 'Temp\\tailscale-setup.msi'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -UseBasicParsing -Uri 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi' -OutFile $msi
  $p = Start-Process msiexec.exe -ArgumentList '/i', $msi, '/quiet', '/norestart' -Wait -PassThru
  Remove-Item $msi -Force -ErrorAction SilentlyContinue
  if ($p.ExitCode -ne 0) { throw "msiexec exit code $($p.ExitCode)" }
}
'installed'
`), 15 * 60_000);
  if (!r.out.includes('installed')) {
    throw new TailscaleError(502, `Installing Tailscale failed: ${firstLine(r.err) || `exit code ${r.code}`}`);
  }
}

async function upWindows(path, authKey, hostname) {
  const keyFile = `$env:SystemRoot\\Temp\\ts-authkey-${crypto.randomBytes(6).toString('hex')}`;
  const r = await agentExec(path, powershell(`
$key = [Console]::In.ReadToEnd()
$f = "${keyFile}"
Set-Content -Path $f -Value $key -NoNewline
icacls $f /inheritance:r /grant:r 'SYSTEM:F' 'Administrators:F' | Out-Null
try {
  $out = ${WIN_TS} up --unattended "--auth-key=file:$f" "--hostname=${hostname}" --reset --timeout=90s 2>&1
  if ($LASTEXITCODE -ne 0) { throw ($out | Out-String) }
} finally { Remove-Item $f -Force -ErrorAction SilentlyContinue }
'connected'
`), 150_000, authKey);
  if (!r.out.includes('connected')) {
    throw new TailscaleError(400, `Tailscale did not connect: ${firstLine(r.err) || `exit code ${r.code}`}`);
  }
}

/** Live status from inside the server (tailscale status --json). */
async function liveStatus(path, os) {
  const r = await agentExec(path, os === 'windows'
    ? powershell(`${WIN_TS} status --json`)
    : bash('tailscale status --json'), 30_000);
  let s;
  try { s = JSON.parse(r.out); } catch { return null; }
  return {
    backend: s.BackendState ?? null,                 // Running | NeedsLogin | Stopped …
    online: !!s.Self?.Online,
    ip: (s.Self?.TailscaleIPs ?? []).find((a) => a.includes('.')) ?? null,
    name: (s.Self?.DNSName ?? '').replace(/\.$/, '') || s.Self?.HostName || null,
    primaryRoutes: s.Self?.PrimaryRoutes ?? [],     // routes approved + active for this node
  };
}

// ---- Public API ------------------------------------------------------------------

async function serverContext(req, vmid) {
  const vm = db.prepare('SELECT * FROM vms WHERE vmid = ? AND user_id = ?').get(vmid, req.account.id);
  if (!vm) throw new TailscaleError(404, 'Server not found');
  if (vm.state !== 'ready') throw new TailscaleError(409, 'This server is not ready yet');
  const guest = await locateGuest(vmid);
  const path = guestPath(guest);
  const cfg = await pve.get(`${path}/config`);
  return { vm, guest, path, os: osFamily(cfg), agentConfigured: /^1|enabled=1/.test(String(cfg.agent ?? '')) };
}

export async function tailscaleStatus(req, vmid) {
  if (!config.tailscale.enabled) return { available: false };
  const { guest, path, os, agentConfigured } = await serverContext(req, vmid);
  const r = row(vmid);
  const net = networkOf(req.account.id);
  const base = {
    available: true,
    os,
    gatewayPossible: os === 'linux' && !!net,
    subnet: net?.subnet ?? null,
    agentConfigured,
    running: guest.status === 'running',
    state: r?.state ?? 'none',
    mode: r?.mode ?? null,
    progress: r?.progress ?? null,
    error: r?.error ?? null,
    hostname: r?.hostname ?? null,
    ip: r?.ts_ip ?? null,
  };
  if (r?.state === 'connected' && guest.status === 'running') {
    const live = await liveStatus(path, os).catch(() => null);
    if (live) {
      base.live = live;
      base.routeApproved = r.mode === 'gateway' ? live.primaryRoutes.includes(net?.subnet) : null;
    }
  }
  return base;
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const AUTH_KEY = /^tskey-[A-Za-z0-9_-]{10,200}$/;

/** Starts install + connect in the background; returns right away. */
export async function connectTailscale(req, vmid, { authKey, mode, hostname }) {
  if (!config.tailscale.enabled) throw new TailscaleError(404, 'Tailscale is not available');
  if (!AUTH_KEY.test(authKey ?? '')) {
    throw new TailscaleError(400, 'That doesn\'t look like a Tailscale auth key. It starts with "tskey-".');
  }
  if (!HOSTNAME.test(hostname ?? '')) {
    throw new TailscaleError(400, 'Use lowercase letters, numbers and hyphens for the Tailscale name');
  }
  const { guest, path, os } = await serverContext(req, vmid);
  const net = networkOf(req.account.id);
  if (mode === 'gateway' && (os !== 'linux' || !net)) {
    throw new TailscaleError(400, 'Gateway mode needs a Linux server in your private network');
  }
  if (guest.status !== 'running') throw new TailscaleError(409, 'Start the server first');
  const existing = row(vmid);
  if (existing && ['installing', 'disconnecting'].includes(existing.state)) {
    throw new TailscaleError(409, 'Wait until the current Tailscale operation has finished');
  }
  try {
    await pve.post(`${path}/agent/ping`);
  } catch {
    throw new TailscaleError(409, 'The QEMU guest agent is not running in this server. Install it and enable '
      + '"QEMU Guest Agent" in the server options, or ask your provider.');
  }

  db.prepare(`
    INSERT INTO tailscale (vmid, user_id, mode, state, progress, error, hostname, ts_ip)
    VALUES (?, ?, ?, 'installing', 'Installing Tailscale', NULL, ?, NULL)
    ON CONFLICT(vmid) DO UPDATE SET mode = excluded.mode, state = 'installing', progress = excluded.progress,
      error = NULL, hostname = excluded.hostname, ts_ip = NULL, updated_at = datetime('now')
  `).run(vmid, req.account.id, mode, hostname);
  audit(req, vmid, 'tailscale_connect_started', { mode, hostname });
  const actor = { account: { id: req.account.id }, ip: req.ip };

  (async () => {
    try {
      const routes = mode === 'gateway' ? net.subnet : null;
      if (os === 'windows') await installWindows(path); else await installLinux(path, mode === 'gateway');
      setState(vmid, { progress: 'Connecting to your tailnet' });
      if (os === 'windows') await upWindows(path, authKey, hostname); else await upLinux(path, authKey, hostname, routes);
      const live = await liveStatus(path, os).catch(() => null);
      setState(vmid, { state: 'connected', progress: null, ts_ip: live?.ip ?? null });
      audit(actor, vmid, 'tailscale_connected', { mode, ip: live?.ip ?? null });
    } catch (err) {
      setState(vmid, { state: 'failed', progress: null, error: String(err.message).slice(0, 500) });
      audit(actor, vmid, 'tailscale_connect_failed', { error: err.message });
    }
  })();
}

// Disconnect: a proper logout first (also revokes the device in the tailnet).
// On Windows, Tailscale ties its connection to a Windows user; once someone signs
// in and the tray app claims it, a logout from SYSTEM (the guest agent) is refused
// with "the target profile does not belong to the user". Then the local state is
// wiped instead: the server is disconnected, but the device stays listed (offline)
// in the tailnet until the customer removes it there.
const WIN_DISCONNECT = `
$ts = "$env:ProgramFiles\\Tailscale\\tailscale.exe"
$out = & $ts logout 2>&1
if ($LASTEXITCODE -eq 0) { 'logged-out'; exit 0 }
$reason = ($out | Out-String).Trim()
Get-Process tailscale-ipn -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Stop-Service -Name Tailscale -Force -ErrorAction Stop
Get-ChildItem "$env:ProgramData\\Tailscale" -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notlike '*.log' -and $_.Name -ne 'Logs' } |
  Remove-Item -Recurse -Force -ErrorAction Stop
Start-Service -Name Tailscale
"forgotten: $reason"
`;

const LINUX_DISCONNECT = `
if reason=$(tailscale logout 2>&1); then echo logged-out; exit 0; fi
tailscale down >/dev/null 2>&1 || true
systemctl stop tailscaled
rm -f /var/lib/tailscale/tailscaled.state
rm -rf /var/lib/tailscale/profiles /var/lib/tailscale/files
systemctl start tailscaled
echo "forgotten: $reason"
`;

/**
 * Disconnects the server from the customer's tailnet and forgets the connection.
 * Returns { removedFromTailnet } — false when only the local state could be wiped.
 */
export async function disconnectTailscale(req, vmid) {
  const r = row(vmid);
  if (!r || r.user_id !== req.account.id) throw new TailscaleError(404, 'This server is not connected to Tailscale');
  if (r.state === 'failed') {
    db.prepare('DELETE FROM tailscale WHERE vmid = ?').run(vmid);
    return { removedFromTailnet: true };
  }
  if (r.state !== 'connected') throw new TailscaleError(409, 'Wait until the current Tailscale operation has finished');
  const { guest, path, os } = await serverContext(req, vmid);
  if (guest.status !== 'running') throw new TailscaleError(409, 'Start the server to disconnect it from Tailscale');

  setState(vmid, { state: 'disconnecting', progress: 'Disconnecting' });
  const out = await agentExec(path, os === 'windows' ? powershell(WIN_DISCONNECT) : bash(LINUX_DISCONNECT), 120_000)
    .catch((err) => ({ code: 1, out: '', err: err.message }));

  const clean = out.out.includes('logged-out');
  const wiped = !clean && out.out.includes('forgotten');
  if (!clean && !wiped) {
    setState(vmid, { state: 'connected', progress: null });
    throw new TailscaleError(502, `Disconnecting failed: ${firstLine(out.err) || firstLine(out.out) || `exit code ${out.code}`}`);
  }
  db.prepare('DELETE FROM tailscale WHERE vmid = ?').run(vmid);
  audit(req, vmid, 'tailscale_disconnected', wiped
    ? { removedFromTailnet: false, reason: firstLine(out.out.replace(/^forgotten:\s*/m, '')) }
    : { removedFromTailnet: true });
  return { removedFromTailnet: clean, hostname: r.hostname };
}

/** Overview for the admin interface (from the panel's own records). */
export function tailscaleOverview() {
  return db.prepare(`
    SELECT t.vmid, t.mode, t.state, t.error, t.hostname, t.ts_ip AS ip, t.updated_at AS updatedAt,
           u.email, v.label
    FROM tailscale t JOIN users u ON u.id = t.user_id LEFT JOIN vms v ON v.vmid = t.vmid
    ORDER BY u.email, t.vmid
  `).all();
}
