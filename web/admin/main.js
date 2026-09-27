import {
  $, esc, api, toast, fail, confirmAction, promptText, SignedOut, setUnauthorizedHandler,
} from '/shared/ui.js';
import { createAdmin } from '/admin.js';
import { brandMark, applyBrand } from '/shared/icons.js';
import { signInSecondStep } from '/shared/twofa.js';
import { prepareSignIn, resumeSso } from '/shared/signin.js';

applyBrand('Administration');
document.querySelectorAll('[data-brand-mark]').forEach((el) => { el.innerHTML = brandMark(26); });

let me = null;

function resetLogin() {
  const box = $('#login-2fa');
  box.hidden = true;
  box.innerHTML = '';
  $('#login-form').hidden = false;
  $('#login-form [name=email]').focus();
}

const signInReady = prepareSignIn($('#login-form'));

async function showLogin() {
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  resetLogin();
  await signInReady;
  resumeSso({
    form: $('#login-form'),
    box: $('#login-2fa'),
    errorEl: $('#login-error'),
    onSignedIn: (account) => { resetLogin(); start(account); },
    onRestart: resetLogin,
  });
}
setUnauthorizedHandler(showLogin);

const admin = createAdmin({
  root: $('#admin-view'),
  api, toast, fail, confirmAction, promptText, esc,
  getMe: () => me,
});

function start(account) {
  me = account;
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  $('#account-email').textContent = me.email;
  admin.open();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const err = $('#login-error');
  err.textContent = '';
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const email = form.email.value;
    const r = await api('/api/auth/login', {
      method: 'POST',
      body: { email, password: form.password.value },
    });
    form.reset();
    if (r.twoFactor) {
      form.hidden = true;
      const box = $('#login-2fa');
      box.hidden = false;
      signInSecondStep(box, {
        stage: r.twoFactor,
        email,
        onSignedIn: (account) => { resetLogin(); start(account); },
        onRestart: resetLogin,
      });
    } else {
      start(r);
    }
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    button.disabled = false;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  me = null;
  showLogin();
});

api('/api/auth/me').then(start).catch((err) => {
  if (!(err instanceof SignedOut)) showLogin();
});
