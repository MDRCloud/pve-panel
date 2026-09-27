# PVE Panel – Administrator guide

The complete setup and operations reference: Proxmox permissions, host firewall,
customer networks, VPN gateway, Tailscale, Windows templates, single sign-on, 2FA,
Docker, NAS deployment, releases and troubleshooting. For an overview of the
project see the [README](../README.md).

Source and releases: https://github.com/sebastianflint/pve-panel · Image: `ghcr.io/sebastianflint/pve-panel`

A self-service control panel for Proxmox VE. Customers sign in and manage only the
servers (VMs and LXC containers) assigned to them: power actions, live status,
usage graphs, snapshots and a browser console. Optionally, customers can create
and delete their own servers from templates you offer, within limits you set.

```
Customers ──▶ :3000 customer panel ─┐
                                    ├─ pve-panel (Fastify + node:sqlite) ──(API token)──▶ Proxmox VE
Admins ─────▶ :3001 admin interface ┘   (127.0.0.1 only by default)
```

The two ports are separate web servers in one process. The customer server has no
admin routes at all. Each uses its own session cookie and signing key, so a
customer session is rejected by the admin server and vice versa.

The browser never talks to Proxmox and never sees the API token. Every per-server
request is checked against the `vms` ownership table first; servers a customer
doesn't own return 404, the same as servers that don't exist.

## 1. Prepare Proxmox

Run on any cluster node. This creates a dedicated user with only the rights the
panel needs, scoped to a pool that holds customer servers.

```bash
pveum user add panel@pve --comment "Customer panel"

# PVE 9 names. On PVE 8 use VM.Monitor instead of VM.GuestAgent.Audit.
pveum role add PanelCustomer --privs "VM.Audit VM.PowerMgmt VM.Console VM.Snapshot VM.Snapshot.Rollback VM.GuestAgent.Audit"

pveum pool add customers
pveum acl modify /pool/customers --users panel@pve --roles PanelCustomer

# --privsep 0: the token inherits exactly the user's permissions
pveum user token add panel@pve panel --privsep 0
```

Copy the token secret shown at the end. Then put each customer server into the pool:

```bash
pveum pool modify customers --vms 101,102
```

Servers outside the pool are invisible to the panel even if someone assigns them by
mistake, which is a useful second safety net.

### Extra permissions if customers may create servers

Skip this if you only assign servers yourself.

```bash
# Rights to clone, configure (CPU, RAM, cloud-init, disk size) and delete VMs
pveum role modify PanelCustomer --append 1 \
  --privs "VM.Allocate VM.Clone VM.Config.CPU VM.Config.Memory VM.Config.Disk VM.Config.Cloudinit VM.Config.Options VM.Config.Network Datastore.AllocateSpace Datastore.Audit"

# Windows templates (password + computer name through the guest agent)
pveum role modify PanelCustomer --append 1 --privs "VM.GuestAgent.Unrestricted"

# Templates customers can pick from live in their own pool
pveum pool add templates
pveum pool modify templates --vms 9000,9001
pveum acl modify /pool/templates --users panel@pve --roles PanelCustomer

# Storage that new disks are created on
pveum acl modify /storage/VMStorage --users panel@pve --roles PanelCustomer
```

If Proxmox rejects a step with a permission error, the message names the missing
privilege; add it to the role the same way.

New servers are placed into the `customers` pool (`PVE_POOL`), so the panel's
normal permissions cover them automatically.

**Linux templates (cloud-init):** a cloud-init drive and a cloud image that runs
cloud-init (for example the official Debian or Ubuntu cloud images). Install
`qemu-guest-agent` if customers should see IP addresses. In the admin interface,
set the template's setup to "Cloud-init (Linux)".

**Windows templates (guest agent, no cloud-init needed):**

The template must boot straight to the login screen after cloning, without any
setup questions. That's what the sysprep answer file does; the project ships one
in [`docs/windows/unattend.xml`](windows/unattend.xml) that answers every
welcome (OOBE) screen: license terms, product key, region and keyboard, and the
Administrator password.

1. Install Windows, the VirtIO drivers and the QEMU guest agent (both on the
   virtio-win ISO). Enable **Options → QEMU Guest Agent** on the VM.
2. Configure what every customer should get (updates, time zone, software).
   Set the network adapter to **DHCP** (no static IP, gateway or DNS). Windows
   ties IP settings to the adapter's PCI slot, not its MAC address, so clones
   would otherwise inherit the template's static settings. The panel switches
   adapters to DHCP anyway, but a clean template avoids surprises.
3. Copy `docs/windows/unattend.xml` into the VM and edit the lines marked
   `CHANGE`:
   - **Product key:** the key for your licensing. For KMS, Microsoft publishes
     the client setup keys (GVLK) per edition ("KMS client activation and
     product keys"); for SPLA or MAK, use the key from your agreement. This line
     answers the "enter product key" screen; if the image already has a key,
     the line can go.
   - **Language, keyboard, time zone:** `UILanguage` must be a language that's
     installed in the image.
   - **Temporary Administrator password:** only used until the panel sets the
     customer's password.
4. Run sysprep with it:
   ```
   copy unattend.xml C:\Windows\System32\Sysprep\unattend.xml
   C:\Windows\System32\Sysprep\sysprep.exe /generalize /oobe /shutdown /unattend:C:\Windows\System32\Sysprep\unattend.xml
   ```
5. When the VM has shut down, convert it to a template **without booting it
   again**. Booting it would run the welcome screens and use up the sysprep.

**Test the template before offering it:** clone it by hand, start the clone and
watch the console. It must end at the login screen without asking anything.

**Fixing a template that stops at the welcome screens:** a sysprep'd template
can't be edited in place. Make a full clone, start it, click through the welcome
screens once, put the corrected `unattend.xml` in place, run step 4 again, and
make that VM your new template (then point the panel's template list at it).

In the admin interface set the template's setup to "Guest agent (Windows)".
After cloning, the panel starts the VM, waits until Windows reports its setup as
complete (registry `ImageState`), sets the Administrator password, renames the
computer to the customer's hostname and reboots. The password is verified inside
Windows after setting it and again after the reboot; if the guest agent's
password call didn't take effect, the panel sets it a second way (`Set-LocalUser`).
A server is never marked ready while the template's temporary password still works. Expect 10–20 minutes. Customers
must use a password Windows accepts (three of: lowercase, uppercase, numbers,
symbols); the panel checks this before starting.

With customer networks enabled, the panel then switches every network adapter
to DHCP (removing static addresses, gateways and DNS servers left over from the
template) and waits until Windows has an address in the customer's subnet. If
none arrives within 3 minutes, creation fails with the addresses it found,
which usually points to DHCP being blocked (see the host firewall rules).

If Windows still stops at a welcome screen, the panel notices: after 15 minutes
at those screens (`WINDOWS_OOBE_TIMEOUT_MINUTES`) creation fails with a message
saying so, instead of the customer waiting for the full 45 minutes. A server
that's already waiting there can be rescued by finishing the screens in its
console; the panel then carries on by itself.

The guest agent lets the panel run commands as SYSTEM inside customer VMs, which
is why `VM.GuestAgent.Unrestricted` is needed. Keep the API token secret.

Keep template disks small; customers choose the final size and the panel grows
the disk after cloning. Servers are full clones on the template's node.

For TLS, either give Proxmox a trusted certificate or copy `/etc/pve/pve-root-ca.pem`
to the panel host and set `PVE_CA_FILE`. Avoid `PVE_VERIFY_TLS=false` outside development.

### Customer networks (optional)

With `CUSTOMER_NETWORKS=true`, each customer who creates a server gets their own
private network: an SDN VNet (`cu0001`, `cu0002`, …) with a `/24` subnet from
`CUSTOMER_NET_PREFIX`, a gateway, DHCP, and NAT to the internet. All servers the
customer creates join it. Servers you assign manually are not changed.

```
customer 1 ──▶ cu0001  10.100.1.0/24 ─┐
customer 2 ──▶ cu0002  10.100.2.0/24 ─┼─ NAT (SNAT on the host) ─▶ internet
                                      ┘
```

The host routes between VNets, so isolation is done with the Proxmox VM firewall,
which the panel configures on every server it creates:

- drop incoming traffic from other customer networks (`10.100.0.0/16`),
- allow the customer's own subnet,
- IP filter + MAC filter: the server can only use addresses of its own subnet,
  so changing the IP inside the VM doesn't get around the rules.
- **Outgoing:** allow the customer's own network and own VPN devices, then block
  every internal range (`CUSTOMER_BLOCKED_NETS`, default all private ranges:
  `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`,
  `169.254.0.0/16`). Without this, the host would route and NAT customer
  traffic into your LAN and any private network behind it. The public internet
  stays reachable. If `CUSTOMER_NET_DNS` is an internal server, DNS to it is
  allowed automatically.

When the panel starts, it checks every customer-created server and adds any of
these rules that are missing, so servers created before a rule existed are
brought up to date by restarting the panel.

One-time host setup:

```bash
# 1. dnsmasq for SDN DHCP (Proxmox runs its own instances per zone)
apt install dnsmasq
systemctl disable --now dnsmasq

# 2. Rights for the panel to create VNets/subnets and apply SDN changes
pveum role add PanelNetwork --privs "SDN.Allocate SDN.Audit SDN.Use"
pveum acl modify /sdn --users panel@pve --roles PanelNetwork

# 3. Let customers' DHCP requests reach the host. No --source on purpose:
#    a server asking for an address doesn't have one yet, so its request comes
#    from 0.0.0.0 and a source filter would block it (Windows then shows a
#    169.254.x.x address). The only DHCP server on the host is the SDN one.
pvesh create /cluster/firewall/rules --type in --action ACCEPT --proto udp \
  --dport 67 --enable 1 --comment "DHCP for customer networks"

# 4. Allow ping to the host. The Proxmox firewall does NOT allow ping by default,
#    not even from the host's own subnet. Without a source, ping is allowed from
#    everywhere, including customers pinging their gateway (useful for their own
#    troubleshooting, and it exposes no service). Add --source to restrict it.
pvesh create /cluster/firewall/rules --type in --action ACCEPT --macro Ping \
  --enable 1 --comment "Ping to the host"
```

5. **Allow your own access first.** With the firewall on, Proxmox only allows the
   web UI (8006), SSH and console ports from the host's *own* subnet
   (`local_network`) plus the `management` IPSet. If you manage Proxmox from
   another subnet, or the panel runs on a machine outside the host's subnet,
   add them **before** enabling the firewall, or you lock yourself (and the
   panel) out:

   ```bash
   pvesh create /cluster/firewall/ipset --name management --comment "Admin access"
   pvesh create /cluster/firewall/ipset/management --cidr 192.168.50.0/24   # admin subnet
   pvesh create /cluster/firewall/ipset/management --cidr 192.168.60.10/32  # panel host
   pve-firewall localnet   # shows what will be allowed
   ```

6. **Enable the datacenter firewall** (Datacenter → Firewall → Options → Firewall: Yes,
   or `pvesh set /cluster/firewall/options --enable 1`). Without it, the VM firewall
   rules above are not enforced and customers are **not** isolated. Keep an
   IPMI/console session open and test web UI and SSH from your admin subnet in a
   new session before closing it. If you get locked out, run
   `pvesh set /cluster/firewall/options --enable 0` from the console.

   With the host firewall on, customers also can't reach the host's own services
   through their gateway address.

The panel creates the SDN zone (`SDN_ZONE`, type simple, DHCP dnsmasq) on first
use. Each VNet's alias is the customer's user name, e.g. `lena (example.com)` for
lena@example.com, so you can tell networks apart in the Proxmox UI; existing
VNets get their alias updated when the panel starts. Applying SDN changes applies *all* pending SDN changes, including any you
started in the web UI.

**If servers get no address** (Windows shows `169.254.x.x`, Linux has no IPv4),
watch DHCP on the host while the server asks for an address:
`tcpdump -ni cu0001 port 67 or port 68`. Requests without replies point to the
host (DHCP firewall rule above, `systemctl status 'dnsmasq@*'`); no requests at
all point to the VM (bridge in Hardware → Network Device, adapter enabled).

**Test the outgoing block once:** from a customer server, reaching your LAN
(e.g. `ping 192.168.1.1` or the Proxmox UI at `https://192.168.1.105:8006`) must
fail, while `ping 1.1.1.1` works.

**Test the isolation once** with two test customers: from a server in customer
A's network, `ping 1.1.1.1` should work and pinging customer B's server should not.

Customer servers have private addresses only. They can reach the internet, but
nothing can reach them from outside except through the panel's console, or
through the VPN described next.

### VPN access (optional)

Customers connect their laptops and phones to their private network with
WireGuard, for example to use Remote Desktop or SSH. One central gateway VM
serves all customers; the panel manages it.

```
laptop ──WireGuard──▶ your public IP : UDP 51820 ──▶ gateway VM (LAN)
                                                       │ customer N's devices: 10.101.N.x
                                                       │ may only reach        10.100.N.0/24
                                                       ▼
                                      Proxmox host ──▶ customer N's VNet
```

In the customer panel, **VPN access** lets customers add devices (up to
`VPN_MAX_DEVICES`), download the configuration or scan it as a QR code with the
WireGuard phone app, see when each device last connected, and remove devices.
The device's private key is generated by the panel, shown **once** and never
stored; the panel keeps only the public key. The VPN is split tunnel: only
traffic to the customer's own network goes through it.

Isolation is enforced three times: WireGuard only accepts traffic from each
device's own address; the gateway's firewall lets customer N's devices reach only
`10.100.N.0/24` (and not the gateway itself); and every customer server only
accepts its own customer's VPN range.

The panel talks to the gateway through the QEMU guest agent, so the gateway
needs no management port or SSH access for the panel. After every change the
panel writes the complete peer list and firewall rules to the gateway and
applies them at once; it also re-applies everything when the panel starts, and
admins can trigger it in the admin interface (VPN tab, "Re-apply configuration").

**Setup (once):**

1. **Create the gateway VM:** a small Debian 12 or 13 VM (1 core, 512 MB, 8 GB) on
   your LAN bridge (`vmbr0`) with a **fixed LAN IP** (static, or a DHCP
   reservation), e.g. `192.168.1.110`. Enable **Options → QEMU Guest Agent**.
   Don't put it into the `customers` pool.

2. **Run the setup script** on it as root, with the Proxmox host's LAN IP:
   ```bash
   bash setup-gateway.sh 192.168.1.105        # [port] [customer prefix] [vpn prefix]
   ```
   It installs WireGuard, nftables and the guest agent, creates the server key,
   starts `wg0` on UDP 51820, and prints the gateway's public key.

3. **Route the VPN range on the Proxmox host** to the gateway. In
   `/etc/network/interfaces`, in the `vmbr0` section:
   ```
   post-up ip route add 10.101.0.0/16 via 192.168.1.110
   pre-down ip route del 10.101.0.0/16 via 192.168.1.110
   ```
   and apply it right away with `ip route add 10.101.0.0/16 via 192.168.1.110`.

4. **Forward UDP 51820** on your internet router to the gateway VM, and choose a
   DNS name (or use your public IP) for `VPN_ENDPOINT`.

5. **Let the panel's token manage the gateway** (replace 150 with its VMID):
   ```bash
   pveum role add PanelGateway --privs "VM.Audit VM.GuestAgent.Unrestricted"
   pveum acl modify /vms/150 --users panel@pve --roles PanelGateway
   ```

6. **Enable it in the panel's `.env`** and restart the panel:
   ```
   VPN_ENABLED=true
   VPN_GATEWAY_VMID=150
   VPN_ENDPOINT=vpn.example.com:51820
   ```
   The admin interface's **VPN** tab should now show the gateway as running with
   its public key.

Servers created before the VPN was enabled get their VPN firewall rules
automatically when their customer adds the first device.

**Test once:** as a test customer, add a device, connect with the WireGuard app
from outside your network, and open RDP or SSH to one of the customer's servers
(`10.100.N.x`). Then check that a server of another customer can't be reached.
Windows blocks ping by default, so test with RDP rather than ping.

**"qga command 'guest-exec-status' failed - got timeout":** the guest agent in a
server didn't answer for a moment, which happens while the server is busy
(installers, heavy disk activity, Windows setup). The panel waits such stalls out
and only gives up after `AGENT_UNRESPONSIVE_SECONDS` (default 180) of silence. If
it does give up, check the server's load and that `qemu-guest-agent` is running,
then try again. Updating the agent (virtio-win ISO on Windows) helps with
recurring stalls.

**"Agent error: PID lld does not exist":** the guest agent reports a finished
command only once; if that answer arrived late, the agent has already forgotten the
process ("lld" is a formatting bug in the Windows agent's message). The command
did run. The panel now handles this: commands that are safe to repeat are run once
more, and one-shot steps (`tailscale up`, `tailscale logout`) are never repeated;
instead the panel checks whether Tailscale is really connected or disconnected.

**If a device doesn't connect:**
- *"Last connected: Never"* means the device never reached the gateway. Check
  the router port forward and `VPN_ENDPOINT`, and on the gateway run `wg show`.
- *Connected, but servers not reachable:* on the gateway,
  `tcpdump -ni wg0` should show the traffic arriving. On the Proxmox host,
  `tcpdump -ni cu000N host 10.101.N.x` should show it reaching the customer's
  network; if not, the route from step 3 is missing. Also check the server's own
  firewall (Windows Firewall, `ufw`) allows the service.

### Tailscale (optional, in addition to the VPN)

With `TAILSCALE_ENABLED=true`, every server page gets a **Remote access** tab where
customers connect the server to **their own** Tailscale account (tailnet). You
operate nothing: the customer creates an auth key in their Tailscale admin console
(Settings, Keys), pastes it, and chooses:

- **Just this server:** the server joins their tailnet and is reachable by its
  Tailscale name or `100.x` address.
- **Gateway to my private network** (Linux only): the server also advertises the
  customer's `10.100.N.0/24`, so all their servers are reachable. The customer
  approves the route once in Tailscale (Machines, the server, Edit route settings);
  the panel shows this step until it's done.

The panel installs Tailscale inside the server through the QEMU guest agent
(Linux: Tailscale's install script; Windows: the official MSI), connects it with
the key and shows the live status (connected, address, name, route approval).
Customers can disconnect again, which logs the server out of their tailnet.

- **Security:** the auth key reaches the server over the guest agent's input
  channel, sits in a root/SYSTEM-only file only while `tailscale up` runs, and is
  deleted right after. It never appears on a command line and is never stored in
  the panel. Isolation stays intact: Tailscale only connects outward (allowed by
  the egress rules), and a gateway forwards traffic with its own address in the
  customer's subnet, so other customers and your internal networks stay blocked.
- **Requirements:** the QEMU guest agent installed in the server and enabled in its
  Proxmox options (also for Linux templates now; most cloud images don't include
  it), `curl` on Linux, and outbound internet access (already there via NAT).
- **Deleting a server** doesn't remove it from the customer's tailnet; it simply
  shows as offline there until the customer removes it in their Tailscale console.

The admin interface's VPN tab lists which customer servers are connected to
Tailscale and in which mode. The panel doesn't see or manage customers' Tailscale
accounts.

## 2. Install and configure

Requires Node.js 22.13 or newer (it uses Node's built-in `node:sqlite`, so there is nothing to compile).

```bash
npm install
cp example.env .env     # then fill in PVE_URL, PVE_TOKEN_ID, PVE_TOKEN_SECRET, JWT_SECRET
```

Create the first administrator on the command line:

```bash
npm run user:create -- admin@example.com 'a-long-password' --admin
```

Then open the admin interface on port 3001 to add customers, assign servers,
offer templates, set limits, reset passwords and read the activity log.

**Managing customer servers:** in the Servers tab, every server assigned to a
customer has buttons to start, shut down, restart, force stop and delete it.
Deleting stops the server if needed and removes it with its disks and snapshots
(type the server ID to confirm). Unassigned servers, templates and the VPN gateway
can't be controlled or deleted from the panel.

**Deleting a customer** removes everything that belongs to them, in the
background: their servers are stopped and deleted, their VPN devices removed from
the gateway, their private VNet and subnet deleted from Proxmox (SDN applied),
and finally the account. The dialog lists what will be deleted and asks for the
customer's email. Tick "Keep the servers you assigned" to only unassign servers
you gave them; servers they created are always deleted. The customer can't sign
in once deletion starts. If a step fails, the Customers tab shows the reason;
click Retry, which reopens the dialog with the current situation. Every step is
safe to repeat.

**Servers that are no longer the customer's but still in their network** (for
example a server you reassigned to yourself) keep the VNet in use, and Proxmox
can't remove a network that's in use. The dialog lists them and preselects **Keep
the private network**: the customer is deleted, the VNet stays for those servers,
and its address range isn't given to anyone else. Alternatively move the server
out first (Hardware, Network Device, another bridge). If you move it, also remove
the panel's firewall entries from it (Firewall: the `ipfilter-net0` IP set and
the rules starting with "panel:"), since they pin it to the customer's subnet. The CLI
commands still work if you prefer scripts:

```bash
npm run user:create -- admin@example.com 'a-long-password' --admin
npm run user:create -- customer@example.com 'another-long-password'
npm run vm:assign -- 101 customer@example.com "Web server"
```

`vm:assign` looks the guest up in the cluster, so it detects VM vs container
automatically.

**Product name:** set `PANEL_NAME` in `.env` (default `PVE Panel`) and restart. It
appears on both sign-in pages, in the sidebar and in browser tabs.

**Own OS icons:** the panel shows neutral glyphs for Windows and Linux servers. To
use your own icons instead, put `os-windows.svg` and/or `os-linux.svg` (or `.png` /
`.webp`) into the branding folder: `BRANDING_DIR`, default `data/branding/` next to
the database. With Docker, mount a folder and set `BRANDING_DIR` (see
`docker-compose.yml`). Only these file names are served, with a strict sandbox
policy. Make sure you're allowed to use the images you put there.

### Two-factor authentication

Every account can use two-factor authentication with an authenticator app
(Google Authenticator, Microsoft Authenticator, Authy, 1Password …). Signing in
then takes the password and a 6-digit code, in both the customer panel and the
admin interface.

- **Customers turn it on themselves** under **Account** (click the email at the
  bottom of the sidebar): scan the QR code, enter a first code, save the 10
  recovery codes. Admins do the same under **Your account** in the admin interface.
- **Requiring it:** when adding a user, tick "Require two-factor authentication",
  or change it later with the **2FA** button in the Customers tab. A user who
  hasn't set it up yet has to do so at the next sign-in, before anything else,
  and can't switch it off.
- **Lost phone:** the user signs in with a recovery code (each works once) and
  can create new codes under Account. If the codes are gone too, reset it with
  the **2FA** button (Reset); if it's required, they set it up again at the next
  sign-in. Confirm who is asking before resetting.
- **Locked out yourself:** on the panel host run
  `npm run user:reset-2fa -- admin@example.com`. `npm run user:create` accepts
  `--require-2fa`.

Details: codes follow TOTP (RFC 6238, SHA-1, 6 digits, 30 seconds), accepted one
step early or late for clock drift, and each code works only once. Secrets are
stored AES-256-GCM encrypted, recovery codes only as SHA-256 hashes. The second
sign-in step is rate-limited and expires after 5 minutes.

Two things to know:
- **Keep the panel host's clock right** (NTP; Windows does this by default).
  Codes depend on the time; a clock more than about a minute off rejects them.
- **The encryption key is derived from `JWT_SECRET`.** Changing `JWT_SECRET`
  makes existing 2FA setups unreadable; reset the affected users afterwards.

### Single sign-on (OIDC)

Users can sign in with your identity provider (Microsoft Entra ID, Keycloak,
Authentik, Google Workspace, Okta …) through OpenID Connect, in addition to or
instead of passwords, separately for the customer panel and the admin interface.

How it's done (current best practice, OAuth 2.0 Security BCP RFC 9700 and
OpenID Connect Core), using the OpenID-certified `openid-client` library:

- Authorization Code flow with **PKCE (S256)**, `state` and `nonce`; nothing else.
- **Pushed Authorization Requests (PAR, RFC 9126)** automatically when the provider
  offers them (`OIDC_USE_PAR=auto`), so the request parameters never pass through
  the browser.
- Endpoints and signing keys from the provider's discovery document; the ID token
  is fully validated (signature, issuer, audience, expiry with 30 s tolerance,
  nonce), and the issuer in the response is checked when the provider sends it
  (RFC 9207). If the ID token has no email, it's fetched from UserInfo, which must
  belong to the same user (`sub`).
- Confidential client (client secret via HTTP Basic), exact callback URL per
  portal, login transaction in a 10-minute, single-use, httpOnly cookie.

**Accounts:** after the first single sign-on, an account is linked to the
provider's permanent user ID (issuer + `sub`), not to the email address. The first
link happens only by an email the provider marks as **verified**, optionally only
for `OIDC_ALLOWED_DOMAINS`. Unknown users are refused unless `OIDC_AUTO_CREATE=true`,
which creates them as customers without rights (you then grant limits). The admin
interface only accepts accounts that are administrators in the panel. The
Customers tab shows linked accounts (SSO tag); **Sign-in** lets you unlink one.

**2FA:** if the provider confirms a multi-factor sign-in (`amr` claim), the panel's
own 2FA step is skipped (`OIDC_TRUST_IDP_MFA`); otherwise users with panel 2FA
still enter their code.

**Setup:**

1. Register the panel as a web application ("confidential client") at your
   provider with these redirect (callback) URLs:
   - `https://panel.example.com/api/auth/oidc/callback` (customer panel)
   - `http://localhost:3001/api/auth/oidc/callback` (admin interface, if used; the
     URL must match how you open it, e.g. through your SSH tunnel)
   Allow the scopes `openid email profile`.
2. Set `OIDC_ENABLED=true`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`,
   `PANEL_PUBLIC_URL` and `ADMIN_PUBLIC_URL` in `.env`, and restart.
3. Test with one account, then optionally turn passwords off with
   `PASSWORD_LOGIN_CUSTOMER=false` and/or `PASSWORD_LOGIN_ADMIN=false`. The panel
   refuses to start if a portal would have no way to sign in. Keep password
   sign-in on the admin port at least until single sign-on works for you.

**Provider notes:**
- **Keycloak / Authentik:** issuer is the realm URL (Keycloak:
  `https://host/realms/<realm>`). Both send `email_verified`; Keycloak supports PAR.
- **Microsoft Entra ID:** issuer `https://login.microsoftonline.com/<tenant-id>/v2.0`.
  Entra doesn't send `email_verified`: set `OIDC_REQUIRE_VERIFIED_EMAIL=false`
  **together with** `OIDC_ALLOWED_DOMAINS` listing your own verified domains. Add
  the optional `email` claim in the app registration's token configuration.
- **Google:** issuer `https://accounts.google.com`; restrict with
  `OIDC_ALLOWED_DOMAINS` to your Workspace domain.

Sign-out ends the panel session only, not the session at the provider.

**Network:** only the **panel host → provider** direction is needed (outbound
HTTPS, port 443: discovery, signing keys, PAR, token and UserInfo endpoints). The
provider never connects to the panel; it only redirects the user's browser back.
So the provider does **not** need to reach the panel through your firewall.

**Troubleshooting:** the Activity tab records the exact reason of every failed
single sign-on.
- *"…couldn't be completed in this browser"* with the reason "the browser brought
  no sign-in cookie": the sign-in started under a different address than
  `PANEL_PUBLIC_URL` / `ADMIN_PUBLIC_URL` (IP instead of name, other port, tunnel).
  The sign-on button now always starts on the configured address, so open the
  panel under that address and it works. Other causes: cookies blocked in the
  browser, or `COOKIE_SECURE=true` on a plain-http address other than localhost
  (the panel warns about this at startup).
- *"Single sign-on is unavailable right now"*: the panel host can't reach the
  provider (firewall, DNS, proxy) or `OIDC_ISSUER` is wrong; the panel log has the
  details.

## 3. Run

```bash
npm start          # production
npm run dev        # restarts on file changes
```

For local testing over plain http, set `COOKIE_SECURE=false`, otherwise the browser
won't store the session cookie.

### Running with Docker

The project includes a `Dockerfile`, a `docker-compose.yml` and a `Caddyfile`.
The image is small and pure JavaScript, so it builds the same on amd64 and arm64.
It runs as an unprivileged user, has a health check, and stops cleanly within
milliseconds on `docker stop`.

```bash
cp example.env .env            # fill in PVE_*, JWT_SECRET, … as usual
docker compose up -d --build

# first administrator (and all other helper commands) inside the container
docker compose exec panel npm run user:create -- admin@example.com 'a-long-password' --admin
```

- **Ports:** the customer panel on `3000`, the admin interface only on
  `127.0.0.1:3001` of the Docker host (SSH tunnel as before). The container itself
  listens on all interfaces; the compose file keeps the admin port local.
  `HOST`, `ADMIN_HOST` and `DB_PATH` are set by the compose file, whatever `.env` says.
- **Data:** the database lives in the `panel-data` volume. Back it up while the
  panel runs with `docker compose exec panel npm run db:backup` (writes a
  consistent copy to `/app/data/backups/`), then copy it out:
  `docker compose cp panel:/app/data/backups ./backups`.
- **HTTPS with automatic certificates:** set `PANEL_DOMAIN=panel.example.com` in
  `.env` (DNS pointing at this host, ports 80 and 443 reachable) and start with
  `docker compose --profile https up -d --build`. Caddy gets and renews a Let's
  Encrypt certificate and forwards to the panel, including the console's
  WebSockets. Set `COOKIE_SECURE=true` and `PANEL_PUBLIC_URL=https://panel.example.com`,
  and remove the `3000:3000` line so the panel is only reachable through Caddy.
- **Proxmox CA:** mount your `pve-root-ca.pem` (see the commented line in
  `docker-compose.yml`) and set `PVE_CA_FILE=/app/certs/pve-root-ca.pem`.
- **Updating:** `docker compose up -d --build` after replacing the files; the
  database is migrated at start, the volume keeps everything.
- **Networking:** the container needs outbound access to the Proxmox API (8006)
  and, for single sign-on, to your identity provider. The panel host's clock
  (which containers share) must be right for 2FA codes.

### Publishing the image with GitHub (recommended)

Instead of building on the server or NAS, let GitHub build the image and
download the finished image from the GitHub Container Registry (`ghcr.io`). The
workflow `.github/workflows/docker-publish.yml` builds for amd64 and arm64 on
every push to `main` and every release tag, and publishes the image with an SBOM
and signed build provenance. Pull requests only build (as a test).

1. **Create a repository** on GitHub and push the project:
   ```bash
   git init && git add . && git commit -m "Initial version"
   git branch -M main
   git remote add origin https://github.com/sebastianflint/pve-panel.git
   git push -u origin main
   ```
   `.gitignore` keeps `.env`, the database and `node_modules` out of the repository;
   no secrets go to GitHub, and none are in the image.
2. **Watch it build** in the repository's **Actions** tab (the first run takes a
   few minutes; the arm64 part is emulated). The image then appears under
   **Packages** as `ghcr.io/sebastianflint/pve-panel`.
3. **Releases:** see "Versions and releases" below (`npm version`, then
   `git push --follow-tags`).
4. **Who may download it:**
   - *Public package:* anyone can pull it, no login needed on the NAS. Set it under
     the package's **Package settings, Change visibility**. The image contains
     code only, no configuration.
   - *Private package* (default for a private repository): log the NAS in once with
     a GitHub personal access token (classic) that only has `read:packages`:
     `sudo docker login ghcr.io -u sebastianflint` over SSH, token as password.
5. **On the server or NAS** you only need two files in one folder: 
   `deploy/docker-compose.yml` (saved there as `docker-compose.yml`) and your
   `.env` with, among the usual settings,
   `PANEL_IMAGE` only if you want to pin a release (e.g.
   `ghcr.io/sebastianflint/pve-panel:1.0.0`); the default is `ghcr.io/sebastianflint/pve-panel:latest`. Then create the Docker Project there, or run
   `docker compose up -d`.
6. **Updating:** push changes (or a new tag), wait for the Actions run, then
   redeploy the project; `pull_policy: always` fetches the new image. With a
   pinned release, change the version at the end of `PANEL_IMAGE` first.

**With Portainer:** use `deploy/docker-compose.portainer.yml` instead (Stacks, Add
stack, Web editor) and enter your settings under **Environment variables**, or
load your `.env` there. Portainer uses those variables only to fill in `${...}`
in the compose file and saves them to `stack.env`; the Portainer version passes
that file into the container (`env_file: stack.env`). With `env_file: .env` the
container starts without your settings and stops with
"Missing required environment variable JWT_SECRET".

Optional: verify an image came from your workflow with
`gh attestation verify oci://ghcr.io/sebastianflint/pve-panel:latest --owner sebastianflint`.
Dependabot (`.github/dependabot.yml`) proposes weekly updates for npm packages,
the Node base image and the workflow's actions.

### Email and invitations

Email is set up in the admin interface under **Settings** (stored in the database,
not in `.env`): SMTP server, port, encryption, username, password, sender, and the
customer panel's address for links. **Send test email** checks connection,
encryption, sign-in and delivery at once and shows the mail server's answer on
failure.

- **Encryption:** TLS (usually port 465) or STARTTLS (usually 587); certificates are
  always verified and at least TLS 1.2 is required. "None" is only for a relay inside
  your own network; with a username set, the panel warns that the password would
  travel unencrypted.
- **The SMTP password** is stored AES-256-GCM encrypted with a key derived from
  `JWT_SECRET` and is never sent back to the browser. Leave the field empty to keep
  it. After changing `JWT_SECRET`, enter it again.
- **Invitations:** with email configured, **Add a customer → Send an invitation email**
  creates the account without a password and emails the panel address, the
  sign-in email and a one-time link to set a password (plus a note about required
  2FA or single sign-on). The link works once, expires after 3 days, is stored only
  as a SHA-256 hash, and carries its token after `#` so it never appears in server
  logs. **Resend invitation** in the list replaces the link. If sending fails when
  creating the user, the account still exists; fix the settings and resend.
- **Single sign-on only** (`PASSWORD_LOGIN_CUSTOMER=false`): the invitation contains
  no password link, only the panel address and how to sign in with single sign-on.
- Setting a password yourself via **Reset password** cancels a pending invitation.

### Versions and releases

The admin interface shows the running version in the top bar (a dot means a newer
release exists) and details under **About**: version, commit, build date, uptime,
update status and how to update. Signed-in customers see the version number in
the sidebar and on their Account page (nothing else, and not on the sign-in page);
`SHOW_VERSION_TO_CUSTOMERS=false` hides it from them.

The version comes from the **Git tag** and is stamped into the image by the
workflow, so there's nothing to edit by hand:

- **Release:** from the project folder, with everything committed:
  ```powershell
  npm version patch      # 1.0.0 -> 1.0.1  (fixes)
  npm version minor      # 1.0.1 -> 1.1.0  (new features)
  npm version major      # 1.1.0 -> 2.0.0  (breaking changes)
  git push --follow-tags
  ```
  `npm version` raises the version in `package.json`, commits that and creates
  the tag `v1.0.1`. The push starts the workflow: it builds the image as `1.0.1`
  (plus `1.0`, `1` and `latest`) and creates a **GitHub Release** with release notes
  generated from the commits. The workflow refuses a tag that doesn't match
  `package.json`, so the two can't drift apart.
- **Everyday pushes** to `main` without a tag build a development version, e.g.
  `1.0.1-dev.a1b2c3d`, published as `edge` (shown as "Development build" in About).
  They never replace `latest`, which always points to the newest release.
- **First release:** `package.json` starts at `1.0.0`; publish it once with
  `git tag -a v1.0.0 -m "v1.0.0"` and `git push --follow-tags`. From then on use
  `npm version`.
- **Update check:** About asks GitHub for the latest release (cached 6 hours,
  "Check for updates now" forces it). It needs outbound access to
  `api.github.com`; for a private repository it can't see releases.
  `UPDATE_CHECK=false` turns it off.
- **Which image to run:** `latest` is the newest release. `1.0` follows only `1.0.x`
  fixes, `1.0.0` is fully pinned, and `edge` is the newest development build from
  `main` (for testing). Releasing an *older* line later (e.g. `1.3.1` after `1.4.0`)
  would also move `latest`; pin a version if you maintain several lines.

### Running on a UGREEN NAS (UGOS Pro)

UGOS Pro's Docker app runs Compose projects from a folder on the NAS; no terminal
is needed for the normal setup. (DXP models; the DH2300 has no Docker support.)

**Easiest with GitHub:** if you publish the image as described above, upload only
`deploy/docker-compose.yml` (as `docker-compose.yml`) and your `.env` with
`PANEL_IMAGE` set into `/volume1/docker/pve-panel`, and do steps 3 to 5 below;
nothing is built on the NAS. The steps below describe building on the NAS instead.

1. **Prepare `.env` on your PC:** copy `example.env` to `.env` and fill in the
   Proxmox settings and `JWT_SECRET`. For the first start add
   `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` (at least 12 characters):
   the panel creates that administrator on first start if no accounts exist.
   While testing over plain `http://<nas-ip>:3000`, set `COOKIE_SECURE=false`.
2. **Upload:** in the UGOS **Files** app, open the `docker` shared folder, create a
   folder `pve-panel` and upload the project into it: `Dockerfile`,
   `docker-compose.yml`, `Caddyfile`, `package.json`, `package-lock.json`, `.env`
   and the folders `src`, `web`, `scripts`, `docs`. Don't upload `node_modules`.
   Check that `.env` really arrived as `.env` (not `.env.txt`).
3. **Deploy:** open the **Docker** app, go to **Project**, click **Create**, name it
   `pve-panel` and choose `/volume1/docker/pve-panel` as the path. The existing
   `docker-compose.yml` is used; start the deployment. The first build downloads
   the Node image and dependencies and takes a few minutes. The container should
   then show as running and, after about 20 seconds, healthy.
4. **Sign in** at `http://<nas-ip>:3000` (customer panel) with the initial admin,
   then remove `INITIAL_ADMIN_PASSWORD` from `.env` on the NAS.
5. **Let the NAS reach Proxmox:** add the NAS's IP to the `management` IPSet on
   Proxmox (see the firewall steps above), otherwise the panel can't call the
   Proxmox API on port 8006.

**Admin interface on the NAS:** by default it's published only on the NAS itself
(`127.0.0.1:3001`). Either enable SSH on the NAS (Control Panel, Terminal) and
open a tunnel from your PC, `ssh -L 3001:127.0.0.1:3001 <user>@<nas-ip>`, then
browse to `http://localhost:3001`; or, in `docker-compose.yml`, replace that line
with the commented alternative using the NAS's LAN IP (never forward it on your
router).

**If the Project wizard doesn't build the image** (older UGOS versions only run
ready-made images), build it once over SSH and then manage it in the Docker app:

```bash
cd /volume1/docker/pve-panel
sudo docker compose up -d --build
```

**Updating:** upload the new files over the old ones (keep `.env`), then rebuild
the project in the Docker app (or `sudo docker compose up -d --build`). Data stays
in the `panel-data` volume. For backups:
`sudo docker compose exec panel npm run db:backup`, then
`sudo docker compose cp panel:/app/data/backups /volume1/docker/pve-panel/backups`.

**Ports:** 3000 and 3001 are normally free on UGOS. The optional Caddy/HTTPS
profile needs ports 80 and 443; if UGOS or another app already uses them, keep
the panel on 3000 behind your existing reverse proxy instead.

### Reaching the admin interface

By default the admin server listens on `127.0.0.1:3001` only. From your own
machine, open an SSH tunnel and browse to http://localhost:3001:

```bash
ssh -L 3001:127.0.0.1:3001 you@panel-host
```

To reach it over a VPN or internal network instead, set `ADMIN_HOST` to that
interface's address (or `0.0.0.0`) and restrict the port with a firewall. The
panel logs a warning at startup when the admin server isn't local-only.

### Behind a reverse proxy

Terminate TLS in front of the customer panel, and publish only that port. The
console needs websocket upgrades:

```nginx
server {
    listen 443 ssl http2;
    server_name panel.example.com;
    # ssl_certificate ...;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
    }
}
```

## Project layout

```
src/
  server.js          customer + admin servers, security headers, error handling
  config.js          environment variables
  db.js              SQLite schema (users, vms, tasks, audit_log)
  pve.js             Proxmox API client and node lookup
  auth.js            sign-in, session cookie, auth guards
  routes/vms.js      customer API: list, detail, power, graphs, snapshots, tasks
  routes/console.js  VNC ticket + websocket proxy to Proxmox
  routes/admin.js    admin API: users, limits, assignments, templates, audit log
  provision.js       server creation/deletion jobs and quota checks
  network.js         per-customer SDN networks and VM firewall isolation
  windows.js         Windows setup through the QEMU guest agent
  cleanup.js         admin deletion of servers and complete customer deletion
  tailscale.js       Tailscale install/connect/status/disconnect via the guest agent
  totp.js            two-factor authentication: codes, encrypted secrets, recovery codes
  oidc.js            single sign-on: discovery, PKCE/PAR, token checks, account linking
  version.js         running version (build stamps) and the GitHub release check
  vpn.js             central WireGuard gateway: devices, keys, gateway sync
  agent.js           running commands in VMs through the guest agent
docs/
  windows/unattend.xml     sysprep answer file for Windows templates
  vpn/setup-gateway.sh     one-time setup of the WireGuard gateway VM
web/
  customer/          customer panel (served on PORT); netmap.js draws the network map
  admin/             admin interface (served on ADMIN_PORT)
  shared/            styles, icons (icons.js) and helpers used by both
scripts/             user:create, vm:assign, user:reset-2fa and db:backup CLI helpers
Dockerfile, docker-compose.yml, Caddyfile   container setup (optional HTTPS via Caddy)
deploy/docker-compose.yml                    run the prebuilt image from ghcr.io
.github/                                     image build workflow, Dependabot
```

## API

Customer endpoints (session required):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/vms` | List own servers with live status |
| GET | `/api/vms/:vmid` | Detail: specs, status, guest-agent IPs |
| POST | `/api/vms/:vmid/power/:action` | `start`, `shutdown`, `reboot`, `stop` |
| GET | `/api/vms/:vmid/rrd?timeframe=hour` | Usage graphs (`hour`, `day`, `week`, `month`) |
| GET/POST | `/api/vms/:vmid/snapshots` | List / create (limited by `MAX_SNAPSHOTS`) |
| POST | `/api/vms/:vmid/snapshots/:name/rollback` | Roll back |
| DELETE | `/api/vms/:vmid/snapshots/:name` | Delete |
| POST | `/api/vms/:vmid/console` | Create a one-time console session |
| GET (ws) | `/api/console/:session` | Console websocket |
| GET | `/api/tasks/:upid` | Progress of a task this user started |
| GET | `/api/account` | Whether the user may create servers, limits and usage |
| GET | `/api/templates` | Images the user can create servers from |
| POST | `/api/vms` | Create a server (runs in the background) |
| DELETE | `/api/vms/:vmid` | Delete a server the customer created (must be stopped) |
| GET | `/api/vpn` | VPN status and the customer's devices |
| POST | `/api/vpn/devices` | Add a device; returns the config and QR code (only time the key is shown) |
| DELETE | `/api/vpn/devices/:id` | Remove a device |
| GET/POST/DELETE | `/api/vms/:vmid/tailscale` | Tailscale status / connect (auth key, mode, name) / disconnect |
| POST | `/api/auth/2fa/verify`, `/api/auth/2fa/setup`, `/api/auth/2fa/activate` | Second sign-in step: code, or forced setup |
| GET/POST | `/api/account/2fa`, `…/setup`, `…/activate`, `…/disable`, `…/recovery-codes` | Manage your own 2FA |

Admin endpoints (admin port, admin session required): `GET/POST /api/admin/users`,
`PATCH/DELETE /api/admin/users/:id`, `GET /api/admin/vms`,
`PUT/DELETE /api/admin/vms/:vmid`, `POST /api/admin/vms/:vmid/power/:action`,
`DELETE /api/admin/vms/:vmid/server`, `GET /api/admin/users/:id/deletion-plan`,
`GET /api/admin/tasks/:upid`, `GET /api/admin/templates`,
`PUT/DELETE /api/admin/templates/:vmid`, `GET /api/admin/vpn`,
`DELETE /api/admin/vpn/devices/:id`, `POST /api/admin/vpn/sync`, `GET /api/admin/audit`.

## How server creation works

1. The customer picks an image, size, hostname and sign-in details.
2. The panel checks their limits (counting all their servers), reserves the next
   free VMID and starts a full clone into the `customers` pool.
3. In the background it sets CPU, memory and cloud-init (user, password, SSH keys,
   network), grows the boot disk to the chosen size and starts the server.
4. The customer sees "Setting up…" until it's ready, or "Setup failed" with the
   reason and a button to remove it.

A customer can only create one server at a time. If the panel restarts during
setup, that server is marked failed; the customer (or you) can remove it.
Customers can delete servers they created, but not servers you assigned to them.

## How the security model works

- **Ownership:** `ownedGuest()` in `routes/vms.js` is the single gate for every
  per-server route. Add new per-server routes through it.
- **Node lookup:** the node is resolved from `/cluster/resources` on each request,
  so live migration doesn't break anything.
- **Tasks:** users can only poll task IDs recorded in the `tasks` table for them.
- **Console:** console sessions are single-use, expire after 30 seconds, and are
  bound to the user who created them.
- **Sessions:** httpOnly, `SameSite=Strict` JWT cookie; the user is re-read from the
  database on every request so deleted accounts lose access immediately.
- **Rate limits** on sign-in, power actions, snapshots and console.
- **Audit log** of every sign-in and action, readable at `/api/admin/audit`.

## Ideas for next steps

- **Reinstall:** reuse the creation job to rebuild an existing server from a template.
- **Cross-node placement:** clone to a chosen target node when templates are on shared storage.
- **Backups:** `POST /nodes/{node}/vzdump` into a per-customer storage, list with
  `/nodes/{node}/storage/{storage}/content`.
- **Firewall rules:** `/nodes/{node}/qemu/{vmid}/firewall/rules`.
- **Two-factor sign-in** (TOTP) and password reset by email.
- **PostgreSQL** instead of SQLite if you run several panel instances.
