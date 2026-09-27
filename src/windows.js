// Windows setup through the QEMU guest agent (no cloud-init / cloudbase-init needed).
//
// Template requirements: sysprep'd (generalize + OOBE with an unattend file that
// skips the setup screens), VirtIO drivers, QEMU guest agent installed and
// "QEMU Guest Agent" enabled in the VM's Proxmox options.

import { pve, waitTask, sleep } from './pve.js';
import { config } from './config.js';
import { agentExec } from './agent.js';

const SETUP_STATE_KEY = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Setup\\State';

const powershell = (script) => ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script];

/** Multi-line scripts are passed base64-encoded (UTF-16LE), so no quoting issues. */
const powershellScript = (script) => [
  'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
];

// Windows ties IP settings to the adapter's PCI slot, not its MAC address, so a
// clone keeps the template's static IP, gateway and DNS even after sysprep.
// Switch every hardware adapter to DHCP and drop leftover static settings.
const RESET_NETWORK_SCRIPT = `
$ErrorActionPreference = 'Continue'
foreach ($a in Get-NetAdapter | Where-Object { $_.HardwareInterface }) {
  $i = $a.ifIndex
  Get-NetRoute -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.DestinationPrefix -eq '0.0.0.0/0' } |
    Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
  Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.PrefixOrigin -eq 'Manual' } |
    Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
  Set-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -Dhcp Enabled
  Set-DnsClientServerAddress -InterfaceIndex $i -ResetServerAddresses
}
ipconfig /renew | Out-Null
'done'
`;

const IPV4_ADDRESSES_SCRIPT = `
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  ForEach-Object { $_.IPAddress }
`;

/** Switches Windows to DHCP and waits for an address inside the customer's subnet. */
async function useCustomerNetwork(path, net, timeoutMs = 3 * 60_000) {
  const r = await agentExec(path, powershellScript(RESET_NETWORK_SCRIPT), 180_000);
  if (!r.out.includes('done')) {
    throw new Error(`Switching Windows to DHCP failed: ${r.err.trim() || `exit code ${r.code}`}`);
  }

  const prefix = net.gateway.replace(/\.\d+$/, '.'); // "10.100.3.1" -> "10.100.3."
  const end = Date.now() + timeoutMs;
  let seen = '';
  while (Date.now() < end) {
    const ips = await agentExec(path, powershellScript(IPV4_ADDRESSES_SCRIPT), 60_000);
    seen = ips.out.split(/\s+/).filter(Boolean).join(', ');
    if (ips.out.split(/\s+/).some((ip) => ip.startsWith(prefix))) return;
    await sleep(5000);
  }
  throw new Error(`The server did not get an address in its private network ${net.subnet} `
    + `(DHCP). Addresses found: ${seen || 'none'}. Please contact support.`);
}

/**
 * Waits until Windows has finished sysprep specialize + OOBE. The guest agent
 * starts early in that process, so "agent answers" alone isn't enough; the
 * registry's ImageState says when setup is really complete.
 *
 * ImageState while waiting:
 *   IMAGE_STATE_GENERALIZE_RESEAL_TO_OOBE  specialize pass still running
 *   IMAGE_STATE_SPECIALIZE_RESEAL_TO_OOBE  OOBE running, or stuck waiting for input
 *   IMAGE_STATE_COMPLETE                   done
 *
 * An unattended OOBE passes through the second state within a few minutes. If it
 * stays there much longer, the template's unattend.xml doesn't answer every OOBE
 * screen and Windows is waiting for someone to click through; fail with a clear
 * message instead of waiting for the full timeout.
 */
async function waitForWindowsSetup(path, timeoutMs, progress) {
  const end = Date.now() + timeoutMs;
  const oobeLimit = config.windows.oobeTimeoutMs;
  let oobeSince = null;
  while (Date.now() < end) {
    try {
      await pve.post(`${path}/agent/ping`);
      const r = await agentExec(path, powershell(`(Get-ItemProperty '${SETUP_STATE_KEY}').ImageState`), 60_000);
      if (r.out.includes('IMAGE_STATE_COMPLETE')) return;
      if (r.out.includes('SPECIALIZE_RESEAL_TO_OOBE')) {
        oobeSince ??= Date.now();
        progress('Waiting for Windows to finish its welcome screens');
        if (Date.now() - oobeSince > oobeLimit) {
          throw new OobeStuckError();
        }
      } else {
        oobeSince = null;
      }
    } catch (err) {
      if (err instanceof OobeStuckError) throw err;
      // agent not up yet, or Windows is rebooting during setup
    }
    await sleep(10_000);
  }
  throw new Error('Windows setup did not finish within 45 minutes. Check the console of the server.');
}

class OobeStuckError extends Error {
  constructor() {
    super('Windows stopped at its setup screens (OOBE) and is waiting for input. '
      + "The image's answer file doesn't cover every setup screen. Please contact support.");
  }
}

async function waitForAgent(path, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      await pve.post(`${path}/agent/ping`);
      return;
    } catch {
      await sleep(5000);
    }
  }
  throw new Error('The server did not come back after restarting');
}

/**
 * Windows' default password policy: at least 3 of 4 character classes and
 * not containing the account name. Checked up front so customers don't wait
 * 10 minutes for a password Windows will reject.
 */
export function windowsPasswordProblem(password, username) {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) {
    return 'Windows needs a password with at least three of: lowercase letters, uppercase letters, numbers, symbols';
  }
  if (username && username.length >= 3 && password.toLowerCase().includes(username.toLowerCase())) {
    return 'The password must not contain the user name';
  }
  return null;
}

/**
 * @param progress  callback(text) to show the current step to the customer
 */
// ---- Password ---------------------------------------------------------------

const CHECK_PASSWORD_SCRIPT = (user) => `
Add-Type -AssemblyName System.DirectoryServices.AccountManagement
$pw = [Console]::In.ReadToEnd()
$ctx = New-Object System.DirectoryServices.AccountManagement.PrincipalContext([System.DirectoryServices.AccountManagement.ContextType]::Machine)
if ($ctx.ValidateCredentials('${user}', $pw)) { 'valid' } else { 'invalid' }
`;

const SET_PASSWORD_SCRIPT = (user) => `
$ErrorActionPreference = 'Stop'
$pw = [Console]::In.ReadToEnd()
Set-LocalUser -Name '${user}' -Password (ConvertTo-SecureString $pw -AsPlainText -Force)
'set'
`;

async function passwordWorks(path, user, password) {
  const r = await agentExec(path, powershellScript(CHECK_PASSWORD_SCRIPT(user)), 60_000, password);
  return r.out.includes('valid') && !r.out.includes('invalid');
}

/**
 * Sets the account password and proves that it works. The guest agent's
 * set-user-password can report success without the password changing, so the
 * result is always checked, with Set-LocalUser as a second method.
 */
async function ensurePassword(path, user, password) {
  if (!/^[\w .-]{1,32}$/.test(user)) throw new Error(`Invalid Windows user name "${user}" in the template settings`);

  await pve.post(`${path}/agent/set-user-password`, { username: user, password }).catch(() => {});
  if (await passwordWorks(path, user, password)) return;

  const r = await agentExec(path, powershellScript(SET_PASSWORD_SCRIPT(user)), 60_000, password);
  if (await passwordWorks(path, user, password)) return;

  throw new Error(`The password for ${user} could not be set`
    + `${r.err.trim() ? `: ${r.err.trim().split('\n')[0].trim().replace(/\.$/, '')}` : ''}. Please contact support.`);
}

export async function setupWindows({ path, node, hostname, adminUser, password, net, progress }) {
  progress('Waiting for Windows setup to finish');
  await waitForWindowsSetup(path, 45 * 60_000, progress);

  progress('Setting the password');
  await ensurePassword(path, adminUser, password);

  if (net) {
    progress('Connecting to your private network');
    await useCustomerNetwork(path, net);
  }

  progress('Setting the computer name');
  // hostname is validated (letters, digits, hyphens; max 15), so it's safe to embed.
  const current = await agentExec(path, powershell('$env:COMPUTERNAME'));
  if (current.out.trim().toLowerCase() !== hostname.toLowerCase()) {
    const r = await agentExec(path, powershell(`Rename-Computer -NewName '${hostname}' -Force`));
    if (r.code !== 0) throw new Error(`Renaming the computer failed: ${r.err.trim() || `exit code ${r.code}`}`);

    progress('Restarting');
    await waitTask(node, await pve.post(`${path}/status/reboot`));
    await waitForAgent(path, 10 * 60_000);
  }

  // Final check after everything, including the restart: the customer's
  // password must work and the template's temporary one must not.
  progress('Checking the password');
  await ensurePassword(path, adminUser, password);
}
