// Two-factor authentication screens shared by the customer panel and the admin
// interface: the code step at sign-in, the setup wizard (QR code + first code),
// the recovery codes screen, and the "Account" security panel.

import { api, esc, toast, fail, confirmAction, promptText } from '/shared/ui.js';

const CODE_INPUT = `<input name="code" required inputmode="numeric" autocomplete="one-time-code"
  class="code-input" maxlength="6" pattern="[0-9]{6}" placeholder="000000" aria-label="6-digit code">`;

// ---- Recovery codes -------------------------------------------------------------

function downloadCodes(codes, email) {
  const text = [`Recovery codes for ${email}`, 'Each code works once. Keep them somewhere safe.', '', ...codes, ''].join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'recovery-codes.txt' });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Shows new recovery codes; `onContinue` runs once the user confirmed saving them. */
export function showRecoveryCodes(container, { codes, email, continueLabel = 'Continue', onContinue }) {
  container.innerHTML = `
    <div class="twofa">
      <h2 class="twofa-title">Save your recovery codes</h2>
      <p class="muted">If you lose your phone, sign in with one of these codes instead of the 6-digit code.
        Each code works once. They won't be shown again.</p>
      <ul class="recovery-grid">${codes.map((c) => `<li class="mono">${esc(c)}</li>`).join('')}</ul>
      <div class="row">
        <button type="button" class="btn" data-dl>Download</button>
        <button type="button" class="btn" data-copy>Copy</button>
      </div>
      <label class="check saved-check"><input type="checkbox" data-saved><span>I have saved these codes</span></label>
      <button type="button" class="btn primary wide" data-continue disabled>${esc(continueLabel)}</button>
    </div>`;
  container.querySelector('[data-dl]').onclick = () => downloadCodes(codes, email);
  container.querySelector('[data-copy]').onclick = () => navigator.clipboard?.writeText(codes.join('\n'))
    .then(() => toast('Recovery codes copied'))
    .catch(() => toast('Copy failed. Use Download instead.', 'error'));
  const cont = container.querySelector('[data-continue]');
  container.querySelector('[data-saved]').onchange = (e) => { cont.disabled = !e.target.checked; };
  cont.onclick = () => onContinue();
}

// ---- Setup wizard ----------------------------------------------------------------

/**
 * @param container   where to render
 * @param begin       () => Promise<{ key, qrSvg }>
 * @param activate    (code) => Promise<{ recoveryCodes, ... }>
 * @param onDone      (result) => void, after the recovery codes were saved
 */
export async function setupWizard(container, { title, intro, begin, activate, email, onDone, onCancel }) {
  container.innerHTML = '<p class="muted">Preparing…</p>';
  let setup;
  try { setup = await begin(); } catch (err) { container.innerHTML = ''; fail(err); onCancel?.(); return; }

  container.innerHTML = `
    <form class="twofa" novalidate>
      <h2 class="twofa-title">${esc(title)}</h2>
      ${intro ? `<p class="muted">${intro}</p>` : ''}
      <ol class="twofa-steps">
        <li>Install an authenticator app on your phone, for example Google Authenticator or Microsoft Authenticator.</li>
        <li>In the app, add an account and scan this code.
          <div class="twofa-qr" aria-label="QR code for your authenticator app">${setup.qrSvg}</div>
          <details class="twofa-manual"><summary>Can't scan it? Enter the key by hand</summary>
            <p class="mono selectable">${esc(setup.key)}</p>
            <p class="muted small">Type: time-based, 6 digits, every 30 seconds.</p>
          </details>
        </li>
        <li>Enter the 6-digit code the app shows:
          ${CODE_INPUT}
        </li>
      </ol>
      <p class="form-error" role="alert"></p>
      <div class="row">
        <button class="btn primary">Turn on two-factor authentication</button>
        ${onCancel ? '<button type="button" class="btn ghost" data-cancel>Cancel</button>' : ''}
      </div>
    </form>`;
  const form = container.querySelector('form');
  form.code.focus();
  container.querySelector('[data-cancel]')?.addEventListener('click', () => onCancel());
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = form.querySelector('.form-error');
    err.textContent = '';
    if (!form.reportValidity()) return;
    const button = form.querySelector('.btn.primary');
    button.disabled = true;
    try {
      const result = await activate(form.code.value.trim());
      showRecoveryCodes(container, { codes: result.recoveryCodes, email, onContinue: () => onDone(result) });
    } catch (ex) {
      err.textContent = ex.message;
      button.disabled = false;
      form.code.select();
    }
  };
}

// ---- Sign-in -----------------------------------------------------------------------

/**
 * Second step after a correct password.
 * stage 'verify': ask for the code; stage 'setup': 2FA is required but not set up.
 */
export function signInSecondStep(container, { stage, email, onSignedIn, onRestart }) {
  const restartIfExpired = (err) => {
    if (/took too long/.test(err.message)) { toast(err.message, 'error'); onRestart(); return true; }
    return false;
  };

  if (stage === 'setup') {
    setupWizard(container, {
      title: 'Set up two-factor authentication',
      intro: 'Your account requires a second step when signing in. Set it up once now; it takes about a minute.',
      email,
      begin: () => api('/api/auth/2fa/setup', { method: 'POST' }),
      activate: (code) => api('/api/auth/2fa/activate', { method: 'POST', body: { code } }),
      onDone: (me) => onSignedIn(me),
      onCancel: () => onRestart(),
    }).catch((err) => restartIfExpired(err) || fail(err));
    return;
  }

  let recovery = false;
  const render = () => {
    container.innerHTML = `
      <form class="twofa" novalidate>
        <h2 class="twofa-title">Two-factor authentication</h2>
        <p class="muted">${recovery
          ? 'Enter one of your recovery codes. Each code works once.'
          : 'Enter the 6-digit code from your authenticator app.'}</p>
        ${recovery
          ? '<input name="code" required autocomplete="off" spellcheck="false" class="code-input small-code" placeholder="xxxx-xxxx" aria-label="Recovery code">'
          : CODE_INPUT}
        <p class="form-error" role="alert"></p>
        <button class="btn primary wide">Sign in</button>
        <div class="row twofa-links">
          <button type="button" class="link-btn" data-switch>${recovery ? 'Use the authenticator app instead' : 'Use a recovery code instead'}</button>
          <button type="button" class="link-btn" data-back>Back</button>
        </div>
      </form>`;
    const form = container.querySelector('form');
    form.code.focus();
    container.querySelector('[data-switch]').onclick = () => { recovery = !recovery; render(); };
    container.querySelector('[data-back]').onclick = () => onRestart();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const err = form.querySelector('.form-error');
      err.textContent = '';
      if (!form.reportValidity()) return;
      const button = form.querySelector('.btn.primary');
      button.disabled = true;
      try {
        onSignedIn(await api('/api/auth/2fa/verify', { method: 'POST', body: { code: form.code.value.trim() } }));
      } catch (ex) {
        if (restartIfExpired(ex)) return;
        err.textContent = ex.message;
        button.disabled = false;
        form.code.select();
      }
    };
  };
  render();
}

// ---- Account panel -------------------------------------------------------------------

/** "Two-factor authentication" section of the account page. */
export async function renderSecurity(container, { email }) {
  container.innerHTML = '<p class="muted">Loading…</p>';
  let s;
  try { s = await api('/api/account/2fa'); } catch (err) { container.innerHTML = ''; return fail(err); }

  if (!s.enabled) {
    container.innerHTML = `
      <section class="security-card">
        <div>
          <h2 class="twofa-title">Two-factor authentication <span class="pill">Off</span></h2>
          <p class="muted">Protect your account with a code from your phone in addition to your password.
            Even if someone learns your password, they can't sign in without your phone.</p>
        </div>
        <button class="btn primary" data-enable>Turn on</button>
      </section>`;
    container.querySelector('[data-enable]').onclick = () => setupWizard(container, {
      title: 'Turn on two-factor authentication',
      email,
      begin: () => api('/api/account/2fa/setup', { method: 'POST' }),
      activate: (code) => api('/api/account/2fa/activate', { method: 'POST', body: { code } }),
      onDone: () => { toast('Two-factor authentication is on'); renderSecurity(container, { email }); },
      onCancel: () => renderSecurity(container, { email }),
    });
    return;
  }

  container.innerHTML = `
    <section class="security-card">
      <div>
        <h2 class="twofa-title">Two-factor authentication <span class="pill pill-running">On</span></h2>
        <p class="muted">Signing in needs your password and a code from your authenticator app.
          ${s.required ? 'Your provider requires it for your account.' : ''}</p>
        <p class="small ${s.recoveryCodesLeft <= 3 ? 'warn-text' : 'muted'}">${s.recoveryCodesLeft} of 10 recovery codes left.</p>
      </div>
      <div class="row">
        <button class="btn" data-codes>New recovery codes</button>
        ${s.required ? '' : '<button class="btn danger" data-disable>Turn off</button>'}
      </div>
    </section>`;

  const askCode = (text, okLabel, danger = false) => promptText(text, {
    hint: 'The 6-digit code from your authenticator app, or a recovery code.', okLabel, minLength: 6, danger,
  });

  container.querySelector('[data-codes]').onclick = async () => {
    const code = await askCode('Confirm with a code to create new recovery codes. The old ones stop working.', 'Create new codes');
    if (!code) return;
    try {
      const r = await api('/api/account/2fa/recovery-codes', { method: 'POST', body: { code } });
      showRecoveryCodes(container, { codes: r.recoveryCodes, email, continueLabel: 'Done', onContinue: () => renderSecurity(container, { email }) });
    } catch (err) { fail(err); }
  };

  container.querySelector('[data-disable]')?.addEventListener('click', async () => {
    if (!(await confirmAction('Turn off two-factor authentication? Signing in will only need your password.', 'Continue'))) return;
    const code = await askCode('Confirm with a code to turn off two-factor authentication.', 'Turn off', true);
    if (!code) return;
    try {
      await api('/api/account/2fa/disable', { method: 'POST', body: { code } });
      toast('Two-factor authentication is off');
      renderSecurity(container, { email });
    } catch (err) { fail(err); }
  });
}
