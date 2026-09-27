// Helpers shared by the customer panel and the admin interface.

export const $ = (sel, root = document) => root.querySelector(sel);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export class SignedOut extends Error {}

let onUnauthorized = () => {};
/** Called when the session has expired (any 401 except from the login call). */
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  // Sign-in steps answer 401 for wrong input (password, 2FA code); only other
  // requests mean the session has ended.
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    onUnauthorized();
    throw new SignedOut();
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : kind === 'warn' ? 12000 : 4000);
}

export function fail(err) {
  if (!(err instanceof SignedOut)) toast(err.message, 'error');
}

export function confirmAction(text, okLabel) {
  const dialog = $('#confirm');
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

let promptReady = false;
function setupPrompt() {
  if (promptReady) return;
  promptReady = true;
  // Enter in the prompt means "save", not the first button in the form ("Cancel").
  $('#prompt-input').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.target.reportValidity()) $('#prompt').close('ok');
  });
  $('#prompt-ok').addEventListener('click', (e) => {
    if (!$('#prompt-input').reportValidity()) e.preventDefault();
  });
}

export function promptText(text, {
  value = '', hint = '', okLabel = 'Save', minLength = 0, pattern = null, danger = false,
} = {}) {
  setupPrompt();
  const dialog = $('#prompt');
  const input = $('#prompt-input');
  const ok = $('#prompt-ok');
  $('#prompt-text').textContent = text;
  $('#prompt-hint').textContent = hint;
  ok.textContent = okLabel;
  ok.className = `btn ${danger ? 'danger' : 'primary'}`;
  input.value = value;
  input.minLength = minLength;
  input.required = minLength > 0 || !!pattern;
  if (pattern) input.pattern = pattern; else input.removeAttribute('pattern');
  dialog.returnValue = '';
  dialog.showModal();
  input.select();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'ok' ? input.value : null);
    }, { once: true });
  });
}

export function generatePassword(length = 16) {
  // No look-alike characters (0/O, 1/l/I), so it can be read out or typed by hand.
  // Always contains upper, lower and a digit, which satisfies Windows' complexity rule.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  for (;;) {
    const values = crypto.getRandomValues(new Uint32Array(length));
    const pw = Array.from(values, (v) => chars[v % chars.length]).join('');
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw) && /\d/.test(pw)) return pw;
  }
}

export const bytes = (n) => {
  if (n == null) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
};
export const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;
export const duration = (s) => {
  if (!s) return '–';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
