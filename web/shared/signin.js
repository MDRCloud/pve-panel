// Sign-in page extras shared by both portals: the single sign-on button, and
// picking up where single sign-on left off (errors, or the 2FA step).

import { api, esc } from '/shared/ui.js';
import { signInSecondStep } from '/shared/twofa.js';

const SSO_ERRORS = {
  not_found: "There's no account for this sign-in. Ask your provider to add you.",
  not_admin: "This account isn't an administrator.",
  email_unverified: "Your identity provider hasn't confirmed your email address, so it can't be matched to an account.",
  no_email: "The identity provider didn't share an email address. The email scope must be allowed for this app.",
  domain: "Single sign-on isn't allowed for your email domain.",
  linked_other: 'Your account is already linked to a different single sign-on identity. Ask your provider to unlink it.',
  denied: 'Sign-in was cancelled at the identity provider.',
  expired: "The sign-in couldn't be completed in this browser. Please try again. If it keeps happening, "
    + 'your administrator can see the reason in the activity log.',
  unavailable: 'Single sign-on is unavailable right now. Try again later.',
  failed: "Single sign-on didn't work. Please try again.",
};

let options = null;

/** Adds the single sign-on button; hides the password fields when passwords are off. */
export async function prepareSignIn(form) {
  try { options = await api('/api/auth/options'); } catch { options = { password: true, oidc: { enabled: false } }; }
  if (options.oidc.enabled && !form.querySelector('.sso-btn')) {
    const anchor = form.querySelector('label');
    anchor.insertAdjacentHTML('beforebegin', `
      <a class="btn sso-btn wide${options.password ? '' : ' primary'}" href="${esc(options.oidc.startUrl ?? '/api/auth/oidc/start')}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4.5h4.5v15H14"/><path d="M10 8l4 4-4 4M14 12H4.5"/></svg>
        <span>${esc(options.oidc.label)}</span>
      </a>
      ${options.password ? '<div class="or-divider" role="separator"><span>or with your password</span></div>' : ''}`);
  }
  if (!options.password) {
    form.querySelectorAll('label, button[type=submit]').forEach((el) => { el.hidden = true; });
  }
}

let resumed = false;

/**
 * Handles ?sso_error=… and ?sso=2fa after the provider sent the browser back.
 * Returns true when the 2FA step took over the sign-in box.
 */
export async function resumeSso({ form, box, errorEl, onSignedIn, onRestart }) {
  if (resumed) return false;
  resumed = true;
  const params = new URLSearchParams(location.search);
  const error = params.get('sso_error');
  const twofa = params.get('sso') === '2fa';
  if (!error && !twofa) return false;
  history.replaceState(null, '', location.pathname + location.hash);

  if (error) {
    errorEl.textContent = SSO_ERRORS[error] ?? SSO_ERRORS.failed;
    return false;
  }
  try {
    const pending = await api('/api/auth/2fa/pending');
    form.hidden = true;
    box.hidden = false;
    signInSecondStep(box, { stage: pending.stage, email: pending.email, onSignedIn, onRestart });
    return true;
  } catch {
    errorEl.textContent = SSO_ERRORS.expired;
    return false;
  }
}
