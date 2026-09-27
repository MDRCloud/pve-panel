import { icon } from '/shared/icons.js';
import { renderSecurity } from '/shared/twofa.js';

// Administration area: assign servers, manage customers, read the activity log.
// Receives the shared helpers from app.js so it behaves like the rest of the panel.

const ACTION_LABELS = {
  login: 'Signed in',
  login_failed: 'Failed sign-in',
  power_start: 'Started server',
  power_shutdown: 'Shut down server',
  power_reboot: 'Restarted server',
  power_stop: 'Force stopped server',
  snapshot_create: 'Took snapshot',
  snapshot_rollback: 'Rolled back snapshot',
  snapshot_delete: 'Deleted snapshot',
  console_open: 'Opened console',
  admin_user_create: 'Added user',
  admin_user_delete: 'Deleted user',
  admin_password_reset: 'Reset password',
  admin_grant: 'Granted admin rights',
  admin_revoke: 'Removed admin rights',
  admin_vm_assign: 'Assigned server',
  admin_vm_unassign: 'Unassigned server',
  admin_vm_rename: 'Renamed server',
  admin_login: 'Signed in to administration',
  admin_login_failed: 'Failed administration sign-in',
  admin_limits: 'Changed limits',
  admin_template_offer: 'Offered template',
  admin_template_withdraw: 'Withdrew template',
  server_create_started: 'Started creating server',
  server_created: 'Created server',
  server_create_failed: 'Server creation failed',
  server_delete_started: 'Started deleting server',
  server_deleted: 'Deleted server',
  vpn_device_add: 'Added VPN device',
  admin_power_start: 'Started server (admin)',
  admin_power_shutdown: 'Shut down server (admin)',
  admin_power_reboot: 'Restarted server (admin)',
  admin_power_stop: 'Force stopped server (admin)',
  admin_server_deleted: 'Deleted server (admin)',
  admin_user_delete_started: 'Started deleting customer',
  admin_user_delete_failed: 'Deleting customer failed',
  twofa_enabled: 'Turned on two-factor authentication',
  twofa_disabled: 'Turned off two-factor authentication',
  twofa_recovery_codes: 'Created new recovery codes',
  admin_twofa_require: 'Required two-factor authentication',
  admin_twofa_unrequire: 'Made two-factor authentication optional',
  admin_twofa_reset: 'Reset two-factor authentication',
  cli_twofa_reset: 'Reset two-factor authentication (command line)',
  sso_login_failed: 'Failed single sign-on',
  admin_sso_login_failed: 'Failed single sign-on (administration)',
  sso_account_linked: 'Linked account to single sign-on',
  sso_account_created: 'Account created by single sign-on',
  admin_sso_unlink: 'Unlinked account from single sign-on',
  tailscale_connect_started: 'Started connecting to Tailscale',
  tailscale_connected: 'Connected to Tailscale',
  tailscale_connect_failed: 'Tailscale connection failed',
  tailscale_disconnected: 'Disconnected from Tailscale',
  vpn_device_remove: 'Removed VPN device',
  admin_vpn_device_remove: 'Removed VPN device',
};

export function generatePassword(length = 16) {
  // No look-alike characters (0/O, 1/l/I), so it can be read out or typed by hand.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

export function createAdmin({ root, api, toast, fail, confirmAction, promptText, esc, getMe, onAbout }) {
  const st = {
    tab: 'servers', users: [], vms: [], audit: [], filter: '', newUser: null,
    templates: [], storages: {}, vpn: null,
  };
  const gb = (mb) => `${+(mb / 1024).toFixed(1)} GB`;

  const utc = (s) => new Date(`${s.replace(' ', 'T')}Z`);

  // ---- loading ----------------------------------------------------------
  async function load({ quiet = false } = {}) {
    const body = root.querySelector('#admin-body');
    if (!quiet) body.innerHTML = '<p class="muted">Loading…</p>';
    try {
      if (st.tab === 'servers') {
        [st.vms, st.users] = await Promise.all([api('/api/admin/vms'), api('/api/admin/users')]);
      } else if (st.tab === 'users') {
        st.users = await api('/api/admin/users');
        if (!quiet) setTimeout(watchDeletions);
      } else if (st.tab === 'about') {
        st.about = await api(`/api/admin/about${st.refreshAbout ? '?refresh=1' : ''}`);
        st.refreshAbout = false;
        onAbout?.(st.about);
      } else if (st.tab === 'account') {
        // rendered by the shared security panel
      } else if (st.tab === 'vpn') {
        st.vpn = await api('/api/admin/vpn');
      } else if (st.tab === 'templates') {
        ({ templates: st.templates, storages: st.storages } = await api('/api/admin/templates'));
      } else {
        st.audit = await api('/api/admin/audit?limit=200');
      }
      renderTab();
    } catch (err) {
      body.innerHTML = '';
      fail(err);
    }
  }

  // ---- shell ------------------------------------------------------------
  function render() {
    const tabs = [['servers', 'Servers'], ['users', 'Customers'], ['templates', 'Templates'], ['vpn', 'VPN'], ['activity', 'Activity'], ['account', 'Your account'], ['about', 'About']];
    root.innerHTML = `
      <div class="admin-inner">
        <h1>Administration</h1>
        <div class="tabs" role="tablist">
          ${tabs.map(([id, label]) =>
            `<button class="tab" role="tab" data-admin-tab="${id}" aria-selected="${st.tab === id}">${label}</button>`).join('')}
        </div>
        <section id="admin-body"></section>
      </div>`;
  }

  function renderTab() {
    if (st.tab === 'servers') renderServers();
    if (st.tab === 'users') renderUsers();
    if (st.tab === 'templates') renderTemplates();
    if (st.tab === 'vpn') renderVpn();
    if (st.tab === 'activity') renderActivity();
    if (st.tab === 'account') renderSecurity(root.querySelector('#admin-body'), { email: getMe().email });
    if (st.tab === 'about') renderAbout();
  }

  // ---- servers ----------------------------------------------------------
  function renderServers() {
    root.querySelector('#admin-body').innerHTML = `
      <div class="section-head">
        <p class="muted" style="margin:0" id="vm-summary"></p>
        <input type="search" id="vm-filter" class="filter" placeholder="Filter by ID, name or customer"
               value="${esc(st.filter)}" aria-label="Filter servers">
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th>ID</th><th>Name in Proxmox</th><th>Node</th><th>Customer</th><th>Name shown to customer</th><th><span class="sr-only">Actions</span></th>
          </tr></thead>
          <tbody id="vm-rows"></tbody>
        </table>
      </div>
      <p class="muted small">Changes save immediately. Customers see a server as soon as it's assigned to them.</p>`;
    renderServerRows();
  }

  /** Power and delete buttons, only for servers assigned to a customer. */
  function serverActions(v) {
    if (!v.userId || v.status === 'missing') return '';
    const idle = v.state === 'ready' || v.state === 'failed';
    const on = v.status === 'running';
    const b = (action, ic, label, enabled, cls = '') =>
      `<button class="icon-btn act ${cls}" data-server-action="${action}" title="${label}" aria-label="${label} ${esc(v.name)}" ${enabled ? '' : 'disabled'}>${icon(ic, { size: 17 })}</button>`;
    return `<span class="act-group">
      ${b('start', 'play', 'Start', idle && !on && v.state === 'ready')}
      ${b('shutdown', 'power', 'Shut down', idle && on && v.state === 'ready')}
      ${b('reboot', 'restart', 'Restart', idle && on && v.state === 'ready')}
      ${b('stop', 'stop', 'Force stop', idle && on && v.state === 'ready')}
      ${b('delete', 'trash', 'Delete server', idle, 'danger')}
    </span>`;
  }

  // Reload the current tab quietly every 3 s until done() says so (max 3 min).
  let watchTimer = null;
  function watch(done) {
    clearInterval(watchTimer);
    const until = Date.now() + 180_000;
    watchTimer = setInterval(async () => {
      if (Date.now() > until) return clearInterval(watchTimer);
      await load({ quiet: true });
      if (done()) clearInterval(watchTimer);
    }, 3000);
  }

  async function waitForTask(upid) {
    for (let i = 0; i < 60 && upid; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      const s = await api(`/api/admin/tasks/${encodeURIComponent(upid)}`);
      if (s.done) return s;
    }
    return null;
  }

  const POWER_TEXT = {
    start: ['Starting', 'started'], shutdown: ['Shutting down', 'shut down'],
    reboot: ['Restarting', 'restarted'], stop: ['Stopping', 'stopped'],
  };

  async function serverAction(vm, action) {
    if (action === 'delete') {
      const answer = await promptText(`Type ${vm.vmid} to delete “${vm.name}” of ${vm.owner}`, {
        hint: 'The server is stopped if needed and deleted with its disks and snapshots. The customer loses it immediately.',
        okLabel: 'Delete server', pattern: String(vm.vmid), danger: true,
      });
      if (answer !== String(vm.vmid)) return;
      try {
        await api(`/api/admin/vms/${vm.vmid}/server`, { method: 'DELETE' });
        toast(`Deleting ${vm.name}`);
        await load({ quiet: true });
        watch(() => !st.vms.some((x) => x.vmid === vm.vmid && x.state === 'deleting'));
      } catch (err) { fail(err); }
      return;
    }
    if (action !== 'start') {
      const q = { shutdown: `Shut down ${vm.name}?`, reboot: `Restart ${vm.name}?`,
        stop: `Force stop ${vm.name}? This cuts power immediately; unsaved data in the server may be lost.` }[action];
      const okLabel = { shutdown: 'Shut down', reboot: 'Restart', stop: 'Force stop' }[action];
      if (!(await confirmAction(`${q} The customer ${vm.owner} is affected.`, okLabel))) return;
    }
    try {
      const { task } = await api(`/api/admin/vms/${vm.vmid}/power/${action}`, { method: 'POST' });
      toast(`${POWER_TEXT[action][0]} ${vm.name}…`);
      const result = await waitForTask(task);
      if (result && !result.ok) toast(`${vm.name}: ${result.message}`, 'error');
      else if (result) toast(`${vm.name} ${POWER_TEXT[action][1]}`);
      await load({ quiet: true });
    } catch (err) { fail(err); }
  }

  function renderServerRows() {
    const assigned = st.vms.filter((v) => v.userId).length;
    root.querySelector('#vm-summary').textContent =
      `${st.vms.length} servers in the cluster, ${assigned} assigned to customers.`;

    const q = st.filter.trim().toLowerCase();
    const rows = st.vms.filter((v) => !q
      || String(v.vmid).includes(q)
      || v.name.toLowerCase().includes(q)
      || (v.owner ?? '').toLowerCase().includes(q)
      || (v.label ?? '').toLowerCase().includes(q));

    const options = (selected) => `
      <option value="">Not assigned</option>
      ${st.users.map((u) =>
        `<option value="${u.id}" ${u.id === selected ? 'selected' : ''}>${esc(u.email)}</option>`).join('')}`;

    root.querySelector('#vm-rows').innerHTML = rows.length ? rows.map((v) => `
      <tr data-vmid="${v.vmid}">
        <td class="mono">${v.vmid}</td>
        <td>
          <span class="led ${v.status === 'running' ? 'running' : ''}" title="${esc(v.status)}"></span>
          ${esc(v.name) || '<span class="muted">–</span>'}
          ${v.type === 'lxc' ? '<span class="tag">container</span>' : ''}
          ${v.status === 'missing' ? '<span class="tag warn">deleted in Proxmox</span>' : ''}
          ${v.state === 'creating' ? '<span class="tag">being created</span>' : ''}
          ${v.state === 'deleting' ? '<span class="tag">being deleted</span>' : ''}
          ${v.state === 'failed' ? '<span class="tag warn">setup failed</span>' : ''}
          ${v.createdByCustomer ? '<span class="tag">created by customer</span>' : ''}
        </td>
        <td class="muted">${esc(v.node ?? '–')}</td>
        <td>
          <select data-owner aria-label="Customer for server ${v.vmid}" ${v.status === 'missing' && !v.userId ? 'disabled' : ''}>
            ${options(v.userId)}
          </select>
        </td>
        <td>
          <input data-label value="${esc(v.label ?? '')}" placeholder="${esc(v.name || `Server ${v.vmid}`)}"
                 maxlength="80" aria-label="Name shown to customer for server ${v.vmid}" ${v.userId ? '' : 'disabled'}>
        </td>
        <td class="actions">${serverActions(v)}</td>
      </tr>`).join('')
      : `<tr><td colspan="6" class="muted">No servers match “${esc(st.filter)}”.</td></tr>`;
  }

  async function saveAssignment(row) {
    const vmid = Number(row.dataset.vmid);
    const vm = st.vms.find((v) => v.vmid === vmid);
    const select = row.querySelector('[data-owner]');
    const input = row.querySelector('[data-label]');
    const userId = select.value ? Number(select.value) : null;
    const label = input.value.trim();

    select.disabled = input.disabled = true;
    try {
      if (!userId) {
        await api(`/api/admin/vms/${vmid}`, { method: 'DELETE' });
        Object.assign(vm, { userId: null, owner: null, label: null });
        toast(`Server ${vmid} unassigned`);
        if (vm.status === 'missing') st.vms = st.vms.filter((v) => v !== vm);
      } else {
        const res = await api(`/api/admin/vms/${vmid}`, {
          method: 'PUT',
          body: label ? { userId, label } : { userId },
        });
        const ownerChanged = vm.userId !== userId;
        Object.assign(vm, { userId, owner: res.owner, label: res.label });
        toast(ownerChanged ? `Server ${vmid} assigned to ${res.owner}` : 'Name saved');
      }
    } catch (err) {
      fail(err);
    }
    renderServerRows();
  }

  // ---- customers --------------------------------------------------------
  function renderUsers() {
    const me = getMe();
    const note = st.newUser ? `
      <div class="notice" role="status">
        <p>Added <strong>${esc(st.newUser.email)}</strong>.
        ${st.newUser.password ? `Their password is <span class="mono selectable">${esc(st.newUser.password)}</span>. Copy it now and send it securely; it won't be shown again.` : ''}</p>
        <div class="row">
          ${st.newUser.password ? '<button class="btn" data-copy-password>Copy password</button>' : ''}
          <button class="btn ghost" data-dismiss-note>Dismiss</button>
        </div>
      </div>` : '';

    root.querySelector('#admin-body').innerHTML = `
      <h2 class="h2">Add a customer</h2>
      <form id="user-form" class="user-form" autocomplete="off">
        <label>Email <input name="email" type="email" required maxlength="254"></label>
        <label>Password
          <span class="with-button">
            <input name="password" type="password" required minlength="12" maxlength="200" autocomplete="new-password">
            <button type="button" class="btn" data-generate>Generate</button>
          </span>
        </label>
        <button class="btn primary">Add customer</button>
        <label class="check">
          <input type="checkbox" name="isAdmin">
          <span>Administrator <span class="muted">Can open this area and manage all customers and servers.</span></span>
        </label>
        <label class="check">
          <input type="checkbox" name="requireTotp">
          <span>Require two-factor authentication <span class="muted">The user sets up an authenticator app at the first sign-in, before they can do anything else.</span></span>
        </label>
      </form>
      ${note}

      <h2 class="h2">Customers</h2>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Email</th><th>Role</th><th>2FA</th><th>Servers</th><th>Can create servers</th><th>Network</th><th>Added</th><th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            ${st.users.map((u) => {
              const self = u.id === me.id;
              return `
              <tr data-user="${u.id}">
                <td>${esc(u.email)}${self ? ' <span class="muted">(you)</span>' : ''}${u.ssoLinked ? ' <span class="tag" title="Linked to single sign-on">SSO</span>' : ''}</td>
                <td>${u.isAdmin ? 'Administrator' : 'Customer'}</td>
                <td>${u.totpEnabled
                  ? `<span class="pill pill-running">On</span>${u.totpRequired ? ' <span class="muted small">required</span>' : ''}`
                  : u.totpRequired ? '<span class="pill pill-busy" title="Set up at the next sign-in">Required</span>'
                  : '<span class="pill">Off</span>'}</td>
                <td>${u.servers ? `<button class="linklike" data-show-servers="${esc(u.email)}">${u.servers}</button>` : '0'}</td>
                <td>${u.canCreate
                  ? `Yes <span class="muted small">(up to ${u.maxServers} servers, ${u.maxCores} cores, ${gb(u.maxMemoryMb)}, ${u.maxDiskGb} GB disk)</span>`
                  : '<span class="muted">No</span>'}</td>
                <td>${u.network
                  ? `<span class="mono">${esc(u.network.subnet)}</span> <span class="muted small">${esc(u.network.vnet)}</span>`
                  : '<span class="muted">–</span>'}</td>
                <td class="muted">${utc(u.createdAt).toLocaleDateString()}</td>
                <td class="actions">${u.deleting ? (u.deletionError ? `
                  <span class="pill pill-failed" title="${esc(u.deletionError)}">Deletion failed</span>
                  <button class="btn danger" data-delete-user>Retry</button>` : `
                  <span class="pill pill-busy">Deleting…</span>`) : `
                  <button class="btn" data-limits>Limits</button>
                  <button class="btn" data-twofa>Sign-in</button>
                  <button class="btn" data-reset>Reset password</button>
                  ${self ? '' : `<button class="btn" data-toggle-admin>${u.isAdmin ? 'Remove admin' : 'Make admin'}</button>`}
                  ${self ? '' : '<button class="btn danger" data-delete-user>Delete</button>'}`}
                </td>
              </tr>
              ${u.deleting && u.deletionError ? `<tr class="row-warn"><td colspan="8" class="small">Deleting ${esc(u.email)} stopped: ${esc(u.deletionError)}</td></tr>` : ''}`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function watchDeletions() {
    if (st.users.some((u) => u.deleting && !u.deletionError)) {
      watch(() => st.tab !== 'users' || !st.users.some((u) => u.deleting && !u.deletionError));
    }
  }

  /** Confirmation dialog listing everything that will be deleted. */
  async function deleteCustomer(user) {
    let plan;
    try {
      plan = await api(`/api/admin/users/${user.id}/deletion-plan`);
      if (!st.vms.length) st.vms = await api('/api/admin/vms').catch(() => []);
    } catch (err) { return fail(err); }
    const dialog = document.getElementById('delete-user');
    const form = document.getElementById('delete-user-form');
    const created = plan.servers.filter((x) => x.createdByCustomer);
    const assigned = plan.servers.filter((x) => !x.createdByCustomer);
    const names = new Map(st.vms.map((v) => [v.vmid, v.name]));
    const item = (x) => `<li><span class="mono">${x.vmid}</span> ${esc(x.label || names.get(x.vmid) || '')}</li>`;

    document.getElementById('du-title').textContent = `Delete ${user.email}?`;
    document.getElementById('du-plan').innerHTML = `
      <p>This deletes the account and everything that belongs to it. It can't be undone.</p>
      <ul class="plan-list">
        ${created.length ? `<li><strong>${created.length} server${created.length > 1 ? 's' : ''} the customer created</strong> are stopped and deleted with their disks and snapshots:<ul>${created.map(item).join('')}</ul></li>` : ''}
        ${assigned.length ? `<li><strong>${assigned.length} server${assigned.length > 1 ? 's' : ''} you assigned</strong>:<ul>${assigned.map(item).join('')}</ul></li>` : ''}
        ${plan.vpnDevices ? `<li><strong>${plan.vpnDevices} VPN device${plan.vpnDevices > 1 ? 's' : ''}</strong> lose access.</li>` : ''}
        ${plan.network ? `<li><strong>The private network</strong> <span class="mono">${esc(plan.network.vnet)}</span> (<span class="mono">${esc(plan.network.subnet)}</span>) is removed from Proxmox${plan.othersInNetwork.length ? ', unless you keep it (see below)' : ''}.</li>` : ''}
        ${!plan.servers.length && !plan.vpnDevices && !plan.network ? '<li>No servers, VPN devices or network.</li>' : ''}
      </ul>`;
    const others = plan.othersInNetwork ?? [];
    if (others.length) {
      document.getElementById('du-plan').insertAdjacentHTML('beforeend', `
        <div class="notice warn">
          <p><strong>${others.length === 1 ? 'This server is' : 'These servers are'} still in the customer's network
            but no longer theirs:</strong></p>
          <ul class="plan-list">${others.map((g) => `<li><span class="mono">${g.vmid}</span> ${esc(g.name)}
            <span class="muted">${g.owner ? `assigned to ${esc(g.owner)}` : 'not assigned'}</span></li>`).join('')}</ul>
          <p class="small">They are not deleted. Proxmox can't remove a network that is in use, so either keep the
            network, or first move ${others.length === 1 ? 'it' : 'them'} to another network (Hardware, Network Device).</p>
        </div>`);
    }
    const keepNetWrap = document.getElementById('du-keepnet-wrap');
    keepNetWrap.hidden = !others.length;
    form.keepNetwork.checked = others.length > 0;

    const keepWrap = document.getElementById('du-keep-wrap');
    keepWrap.hidden = !assigned.length;
    form.keepAssigned.checked = false;
    form.confirm.value = '';
    const ok = document.getElementById('du-ok');
    ok.disabled = true;
    const matches = () => form.confirm.value.trim().toLowerCase() === user.email.toLowerCase();
    form.confirm.oninput = () => { ok.disabled = !matches(); };
    form.confirm.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (matches()) dialog.close('ok'); }
    };
    dialog.returnValue = '';
    dialog.showModal();
    form.confirm.focus();

    const confirmed = await new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' && matches()), { once: true });
    });
    if (!confirmed) return;
    try {
      const q = new URLSearchParams();
      if (form.keepAssigned.checked) q.set('keepAssigned', 'true');
      if (form.keepNetwork.checked && !keepNetWrap.hidden) q.set('keepNetwork', 'true');
      const qs = q.toString();
      await api(`/api/admin/users/${user.id}${qs ? `?${qs}` : ''}`, { method: 'DELETE' });
      toast(`Deleting ${user.email}`);
      st.users = await api('/api/admin/users');
      renderUsers();
      watchDeletions();
    } catch (err) { fail(err); }
  }

  /** Require / not require 2FA for a user, or reset it (lost phone). */
  async function editTwoFactor(user) {
    const dialog = document.getElementById('twofa-admin');
    const form = document.getElementById('twofa-admin-form');
    document.getElementById('ta-title').textContent = `Sign-in for ${user.email}`;
    document.getElementById('ta-state').innerHTML = user.totpEnabled
      ? '<span class="pill pill-running">On</span> The user has set it up.'
      : user.totpRequired
        ? '<span class="pill pill-busy">Required</span> The user sets it up at the next sign-in.'
        : '<span class="pill">Off</span> The user signs in with password only.';
    form.required.checked = user.totpRequired;
    document.getElementById('ta-reset-box').hidden = !user.totpEnabled;
    const ssoBox = document.getElementById('ta-sso-box');
    ssoBox.hidden = !user.ssoLinked;
    document.getElementById('ta-sso-issuer').textContent = user.ssoIssuer ?? '';
    document.getElementById('ta-unlink').onclick = async () => {
      if (!(await confirmAction(`Unlink ${user.email} from single sign-on? The next single sign-on links the account again by verified email, or is refused.`, 'Unlink'))) return;
      try {
        await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { unlinkSso: true } });
        toast(`${user.email} unlinked from single sign-on`);
        dialog.close('reset');
      } catch (err) { fail(err); }
    };
    document.getElementById('ta-reset').onclick = async () => {
      if (!(await confirmAction(`Reset two-factor authentication for ${user.email}? Their authenticator app and recovery codes stop working.`, 'Reset'))) return;
      try {
        await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { resetTotp: true } });
        toast(`Two-factor authentication reset for ${user.email}`);
        dialog.close('reset');
      } catch (err) { fail(err); }
    };
    dialog.returnValue = '';
    dialog.showModal();
    const result = await new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
    if (result === 'ok' && form.required.checked !== user.totpRequired) {
      try {
        await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { totpRequired: form.required.checked } });
        toast(form.required.checked ? `Two-factor authentication is now required for ${user.email}` : `Two-factor authentication is optional for ${user.email}`);
      } catch (err) { fail(err); }
    }
    if (result === 'ok' || result === 'reset') {
      st.users = await api('/api/admin/users');
      renderUsers();
    }
  }

  async function createUser(form) {
    const email = form.email.value.trim();
    const password = form.password.value;
    const isAdmin = form.isAdmin.checked;
    const requireTotp = form.requireTotp.checked;
    const generated = form.dataset.generated === password;
    const button = form.querySelector('.btn.primary');
    button.disabled = true;
    try {
      await api('/api/admin/users', { method: 'POST', body: { email, password, isAdmin, requireTotp } });
      st.newUser = { email, password: generated ? password : null };
      st.users = await api('/api/admin/users');
      renderUsers();
    } catch (err) {
      fail(err);
      button.disabled = false;
    }
  }

  // ---- limits -----------------------------------------------------------
  function editLimits(user) {
    const dialog = document.getElementById('limits');
    const form = document.getElementById('limits-form');
    document.getElementById('limits-title').textContent = `Limits for ${user.email}`;
    // Sensible starting values the first time self-service is switched on
    const fresh = !user.canCreate && !user.maxServers && !user.maxCores;
    form.canCreate.checked = user.canCreate;
    form.maxServers.value = fresh ? 2 : user.maxServers;
    form.maxCores.value = fresh ? 4 : user.maxCores;
    form.maxMemoryGb.value = fresh ? 8 : +(user.maxMemoryMb / 1024).toFixed(1);
    form.maxDiskGb.value = fresh ? 100 : user.maxDiskGb;
    const u = user.usage;
    document.getElementById('limits-usage').textContent = u
      ? `In use now: ${u.servers} servers, ${u.cores} cores, ${gb(u.memoryMb)} memory, ${u.diskGb} GB disk.`
      : `${user.servers} server${user.servers === 1 ? '' : 's'} assigned.`;
    dialog.returnValue = '';
    dialog.showModal();

    return new Promise((resolve) => {
      dialog.addEventListener('close', async () => {
        if (dialog.returnValue !== 'ok') return resolve(false);
        try {
          await api(`/api/admin/users/${user.id}`, {
            method: 'PATCH',
            body: {
              canCreate: form.canCreate.checked,
              maxServers: Number(form.maxServers.value),
              maxCores: Number(form.maxCores.value),
              maxMemoryMb: Math.round(Number(form.maxMemoryGb.value) * 1024),
              maxDiskGb: Number(form.maxDiskGb.value),
            },
          });
          toast(`Limits saved for ${user.email}`);
          resolve(true);
        } catch (err) {
          fail(err);
          resolve(false);
        }
      }, { once: true });
    });
  }

  // ---- templates --------------------------------------------------------
  function renderTemplates() {
    const body = root.querySelector('#admin-body');
    if (!st.templates.length) {
      body.innerHTML = `
        <div class="empty">
          <h2>No templates in the cluster</h2>
          <p class="muted">Customers create servers by cloning a Proxmox template. Prepare a VM with cloud-init,
          convert it to a template in Proxmox and add it to the panel's pool; it then appears here.</p>
        </div>`;
      return;
    }
    body.innerHTML = `
      <p class="muted" style="margin-top:0">Customers who may create servers can choose from the templates offered here.
        Linux templates are set up with cloud-init, Windows templates through the QEMU guest agent.</p>
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th>ID</th><th>Template in Proxmox</th><th>Offered</th><th>Name shown to customers</th>
            <th>Setup</th><th>Target storage</th><th>User</th><th>Network (cloud-init)</th><th><span class="sr-only">Save</span></th>
          </tr></thead>
          <tbody>
            ${st.templates.map((t) => `
              <tr data-template="${t.vmid}">
                <td class="mono">${t.vmid}</td>
                <td>${esc(t.name)} <span class="muted small">${esc(t.node)}</span></td>
                <td><input type="checkbox" data-f="offered" ${t.offered ? 'checked' : ''} aria-label="Offer template ${t.vmid}"></td>
                <td><input data-f="label" value="${esc(t.label)}" placeholder="e.g. Debian 12" maxlength="80"></td>
                <td>
                  <select data-f="setup" aria-label="Setup method for template ${t.vmid}">
                    <option value="cloudinit" ${t.setup !== 'windows' ? 'selected' : ''}>Cloud-init (Linux)</option>
                    <option value="windows" ${t.setup === 'windows' ? 'selected' : ''}>Guest agent (Windows)</option>
                  </select>
                </td>
                <td>
                  <select data-f="storage">
                    <option value="">Same as template</option>
                    ${(st.storages[t.node] ?? []).map((name) =>
                      `<option ${name === t.storage ? 'selected' : ''}>${esc(name)}</option>`).join('')}
                  </select>
                </td>
                <td><input data-f="ciUser" value="${esc(t.ciUser)}" placeholder="${t.setup === 'windows' ? 'Administrator' : 'from template'}" maxlength="32" class="narrow"></td>
                <td><input data-f="ipconfig" value="${esc(t.ipconfig)}" maxlength="200" class="mono narrow"></td>
                <td><button class="btn" data-save-template>Save</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="muted small">
        <strong>Cloud-init:</strong> the customer chooses the user name (User is only the suggestion); Network is the
        <span class="mono">ipconfig0</span> value, e.g. <span class="mono">ip=dhcp</span>.
        <strong>Guest agent (Windows):</strong> the template must be sysprep'd with the QEMU guest agent installed and enabled;
        the panel sets the password of User (default Administrator) and the computer name.</p>`;
  }

  async function saveTemplate(row) {
    const vmid = Number(row.dataset.template);
    const field = (f) => row.querySelector(`[data-f="${f}"]`);
    const offered = field('offered').checked;
    const label = field('label').value.trim();
    try {
      if (!offered) {
        await api(`/api/admin/templates/${vmid}`, { method: 'DELETE' });
        toast(`Template ${vmid} is not offered`);
      } else {
        if (!label) {
          field('label').focus();
          return toast('Give the template a name customers will recognise', 'error');
        }
        await api(`/api/admin/templates/${vmid}`, {
          method: 'PUT',
          body: {
            label,
            storage: field('storage').value,
            ciUser: field('ciUser').value.trim(),
            ipconfig: field('ipconfig').value.trim(),
            setup: field('setup').value,
          },
        });
        toast(`${label} is offered to customers`);
      }
      const t = st.templates.find((x) => x.vmid === vmid);
      Object.assign(t, { offered, label });
    } catch (err) { fail(err); }
  }

  // ---- VPN --------------------------------------------------------------
  function tailscaleSection() {
    const ts = st.vpn.tailscale;
    if (!ts?.enabled) return '';
    const stateWord = { connected: 'Connected', installing: 'Connecting…', disconnecting: 'Disconnecting…', failed: 'Failed' };
    const pill = { connected: 'pill-running', installing: 'pill-busy', disconnecting: 'pill-busy', failed: 'pill-failed' };
    return `
      <h2 class="h2">Tailscale</h2>
      <p class="muted" style="margin-top:-4px">Servers customers connected to their own tailnet. The panel doesn't
        see or manage the customers' Tailscale accounts.</p>
      ${ts.servers.length ? `
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Customer</th><th>Server</th><th>Mode</th><th>Tailscale address</th><th>State</th></tr></thead>
            <tbody>
              ${ts.servers.map((x) => `
                <tr>
                  <td>${esc(x.email)}</td>
                  <td><span class="mono">${x.vmid}</span> ${esc(x.label ?? x.hostname ?? '')}</td>
                  <td>${x.mode === 'gateway' ? 'Gateway to private network' : 'Just this server'}</td>
                  <td class="mono">${esc(x.ip ?? '–')}</td>
                  <td><span class="pill ${pill[x.state] ?? ''}" title="${esc(x.error ?? '')}">${stateWord[x.state] ?? esc(x.state)}</span></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : '<p class="muted">No server is connected to Tailscale yet.</p>'}`;
  }

  function renderVpn() {
    const { status, devices } = st.vpn;
    const body = root.querySelector('#admin-body');
    if (!status.enabled) {
      body.innerHTML = `
        <div class="empty">
          <h2>WireGuard VPN is switched off</h2>
          <p class="muted">Set up the WireGuard gateway VM and set <span class="mono">VPN_ENABLED=true</span>,
            <span class="mono">VPN_GATEWAY_VMID</span> and <span class="mono">VPN_ENDPOINT</span> in the panel's
            <span class="mono">.env</span>. The README section “VPN access” has the steps.</p>
        </div>
        ${tailscaleSection()}`;
      return;
    }
    const since = (ts) => (ts == null ? 'unknown' : !ts ? 'Never'
      : Date.now() / 1000 - ts < 180 ? 'Connected now' : new Date(ts * 1000).toLocaleString());
    body.innerHTML = `
      <dl class="specs cols-3">
        <div><dt>Gateway</dt><dd>${status.reachable
          ? '<span class="led running"></span> Running' : '<span class="led failed"></span> Not reachable'}
          <span class="muted small">VM ${status.gatewayVmid}</span></dd></div>
        <div><dt>Endpoint for customers</dt><dd class="mono">${esc(status.endpoint)}</dd></div>
        <div><dt>Devices</dt><dd>${devices.length}</dd></div>
        <div class="wide"><dt>${status.reachable ? 'Gateway public key' : 'Problem'}</dt>
          <dd class="${status.reachable ? 'mono' : ''}">${esc(status.reachable ? status.publicKey : status.error)}</dd></div>
      </dl>
      <div class="section-head">
        <h2 class="h2" style="margin:0">Devices</h2>
        <button class="btn" data-vpn-sync>Re-apply configuration</button>
      </div>
      ${devices.length ? `
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Customer</th><th>Device</th><th>VPN address</th><th>Last connected</th><th>Added</th><th><span class="sr-only">Remove</span></th></tr></thead>
            <tbody>
              ${devices.map((d) => `
                <tr>
                  <td>${esc(d.email ?? '–')}</td>
                  <td>${esc(d.name)}</td>
                  <td class="mono">${esc(d.address)}</td>
                  <td>${esc(since(d.lastHandshake))}</td>
                  <td class="muted">${utc(d.createdAt).toLocaleDateString()}</td>
                  <td class="actions"><button class="btn danger" data-vpn-remove="${d.id}" data-name="${esc(d.name)}">Remove</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : '<p class="muted">No VPN devices yet. Customers add them under “VPN access”.</p>'}
      ${tailscaleSection()}`;
  }

  // ---- about --------------------------------------------------------------
  function renderAbout() {
    const a = st.about;
    const u = a.update ?? {};
    const date = (d) => (d ? new Date(d).toLocaleString() : '–');
    const uptime = (sec) => {
      const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
      return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
    };
    const ext = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;

    const status = !u.checked
      ? `<div class="notice about-notice"><p><strong>Couldn't check for updates.</strong> ${esc(u.reason ?? '')}</p></div>`
      : u.updateAvailable
        ? `<div class="notice warn about-notice">
             <p><strong>Version ${esc(u.latest.version)} is available</strong>${u.latest.publishedAt ? `, released ${esc(new Date(u.latest.publishedAt).toLocaleDateString())}` : ''}.
               ${ext(u.latest.url, "See what's new")}.</p>
           </div>`
        : u.latest
          ? `<div class="notice about-notice ok"><p><strong>You're running the latest release.</strong></p></div>`
          : `<div class="notice about-notice"><p>${esc(u.reason ?? 'No releases published yet.')}</p></div>`;

    root.querySelector('#admin-body').innerHTML = `
      <div class="about">
        <div class="about-head">
          <span class="about-version">v${esc(a.version)}</span>
          <span class="pill ${a.isRelease ? 'pill-running' : 'pill-busy'}">${a.isRelease ? 'Release' : 'Development build'}</span>
        </div>
        ${status}
        <dl class="specs cols-3">
          <div><dt>Version</dt><dd class="mono">${a.releaseUrl && a.isRelease ? ext(a.releaseUrl, esc(a.version)) : esc(a.version)}</dd></div>
          <div><dt>Commit</dt><dd class="mono">${a.commit ? (a.commitUrl ? ext(a.commitUrl, esc(a.commit.slice(0, 7))) : esc(a.commit.slice(0, 7))) : '–'}</dd></div>
          <div><dt>Built</dt><dd>${esc(date(a.buildDate))}</dd></div>
          <div><dt>Running since</dt><dd>${esc(date(a.startedAt))} <span class="muted small">(${esc(uptime(a.uptimeSeconds))})</span></dd></div>
          <div><dt>Node.js</dt><dd class="mono">${esc(a.node)}</dd></div>
          <div><dt>Source</dt><dd>${a.repoUrl ? ext(a.repoUrl, esc(a.repoUrl.replace(/^https:\/\//, ''))) : '–'}</dd></div>
        </dl>
        <div class="row">
          <button class="btn" data-check-updates>Check for updates now</button>
          ${u.checkedAt ? `<span class="muted small">Last checked ${esc(date(u.checkedAt))}</span>` : ''}
        </div>

        <h2 class="h2">How to update</h2>
        <ol class="about-steps">
          <li><strong>Portainer:</strong> Stacks, your stack, <em>Update the stack</em> with
            <em>Re-pull image and redeploy</em> switched on.</li>
          <li><strong>UGREEN Docker app:</strong> Project, your project, redeploy it (it pulls the image again).</li>
          <li><strong>Command line:</strong> <span class="mono">docker compose pull && docker compose up -d</span></li>
        </ol>
        <p class="muted small">If you pinned a release in <span class="mono">PANEL_IMAGE</span>, change the version
          there first. Your data stays in the volume; database changes are applied automatically at start.</p>
      </div>`;
  }

  // ---- activity ---------------------------------------------------------
  function renderActivity() {
    root.querySelector('#admin-body').innerHTML = `
      <div class="section-head">
        <p class="muted" style="margin:0">The last ${st.audit.length} events, newest first.</p>
        <button class="btn" data-refresh-audit>Refresh</button>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Time</th><th>Who</th><th>What</th><th>Server</th><th>IP address</th></tr></thead>
          <tbody>
            ${st.audit.map((a) => {
              let detail = '';
              try {
                const d = a.detail ? JSON.parse(a.detail) : null;
                if (d?.email && (a.action.startsWith('admin_') || a.action.endsWith('login_failed'))) detail = d.email;
                if (d?.hostname) detail = d.hostname;
                if (d?.label && a.action.startsWith('admin_template')) detail = d.label;
                if (d?.error) detail = d.error;
                if (d?.reason && a.action.includes('sso')) detail = d.reason;
              } catch { /* ignore */ }
              return `
              <tr class="${a.action.endsWith('login_failed') || a.action.endsWith('_failed') ? 'row-warn' : ''}">
                <td class="nowrap">${utc(a.createdAt).toLocaleString()}</td>
                <td>${esc(a.email ?? '–')}</td>
                <td>${esc(ACTION_LABELS[a.action] ?? a.action)}${detail ? ` <span class="muted">${esc(detail)}</span>` : ''}</td>
                <td class="mono">${a.vmid ?? ''}</td>
                <td class="mono muted">${esc(a.ip ?? '')}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }

  // ---- events (bound once) ----------------------------------------------
  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;

    if (t.dataset.adminTab) {
      st.tab = t.dataset.adminTab;
      st.newUser = null;
      render();
      load();
      return;
    }

    if (t.hasAttribute('data-generate')) {
      const form = t.closest('form');
      const pw = generatePassword();
      form.password.value = pw;
      form.password.type = 'text';
      form.dataset.generated = pw;
      return;
    }

    if (t.hasAttribute('data-copy-password')) {
      await navigator.clipboard?.writeText(st.newUser.password)
        .then(() => toast('Password copied'))
        .catch(() => toast('Copy failed. Select the password and copy it manually.', 'error'));
      return;
    }

    if (t.hasAttribute('data-dismiss-note')) {
      st.newUser = null;
      renderUsers();
      return;
    }

    if (t.dataset.showServers) {
      st.tab = 'servers';
      st.filter = t.dataset.showServers;
      render();
      load();
      return;
    }

    if (t.hasAttribute('data-refresh-audit')) {
      load();
      return;
    }

    if (t.hasAttribute('data-check-updates')) {
      st.refreshAbout = true;
      t.disabled = true;
      t.textContent = 'Checking…';
      load({ quiet: true });
      return;
    }

    if (t.hasAttribute('data-vpn-sync')) {
      try {
        await api('/api/admin/vpn/sync', { method: 'POST' });
        toast('VPN configuration re-applied on the gateway');
      } catch (err) { fail(err); }
      load();
      return;
    }

    if (t.dataset.vpnRemove) {
      if (!(await confirmAction(`Remove VPN device “${t.dataset.name}”? It can no longer connect.`, 'Remove'))) return;
      try {
        await api(`/api/admin/vpn/devices/${t.dataset.vpnRemove}`, { method: 'DELETE' });
        toast(`${t.dataset.name} removed`);
      } catch (err) { fail(err); }
      load();
      return;
    }

    if (t.dataset.serverAction) {
      const vm = st.vms.find((x) => x.vmid === Number(t.closest('tr').dataset.vmid));
      if (vm) serverAction(vm, t.dataset.serverAction);
      return;
    }

    if (t.hasAttribute('data-save-template')) {
      saveTemplate(t.closest('tr'));
      return;
    }

    const userRow = t.closest('[data-user]');
    if (!userRow) return;
    const user = st.users.find((u) => u.id === Number(userRow.dataset.user));

    if (t.hasAttribute('data-twofa')) {
      editTwoFactor(user);
      return;
    }

    if (t.hasAttribute('data-limits')) {
      if (await editLimits(user)) {
        st.users = await api('/api/admin/users');
        renderUsers();
      }
      return;
    }

    if (t.hasAttribute('data-reset')) {
      const password = await promptText(`New password for ${user.email}`, {
        value: generatePassword(),
        hint: 'At least 12 characters. A random password is filled in; copy it before saving.',
        okLabel: 'Reset password',
        minLength: 12,
      });
      if (!password) return;
      try {
        await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { password } });
        toast(`Password reset for ${user.email}`);
      } catch (err) { fail(err); }
    }

    if (t.hasAttribute('data-toggle-admin')) {
      const makeAdmin = !user.isAdmin;
      const ok = await confirmAction(
        makeAdmin
          ? `Make ${user.email} an administrator? They will be able to see and manage all customers and servers.`
          : `Remove administrator rights from ${user.email}?`,
        makeAdmin ? 'Make admin' : 'Remove admin'
      );
      if (!ok) return;
      try {
        await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { isAdmin: makeAdmin } });
        user.isAdmin = makeAdmin;
        toast(makeAdmin ? `${user.email} is now an administrator` : `${user.email} is now a customer`);
        renderUsers();
      } catch (err) { fail(err); }
    }

    if (t.hasAttribute('data-delete-user')) {
      deleteCustomer(user);
    }
  });

  root.addEventListener('change', (e) => {
    const row = e.target.closest('tr[data-vmid]');
    if (row && (e.target.matches('[data-owner]') || e.target.matches('[data-label]'))) saveAssignment(row);
  });

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-label]')) e.target.blur(); // blur fires "change"
  });

  root.addEventListener('input', (e) => {
    if (e.target.id === 'vm-filter') {
      st.filter = e.target.value;
      renderServerRows();
    }
  });

  root.addEventListener('submit', (e) => {
    if (e.target.id !== 'user-form') return;
    e.preventDefault();
    createUser(e.target);
  });

  return {
    open() {
      render();
      load();
    },
    openTab(tab) {
      st.tab = tab;
      render();
      load();
    },
  };
}
