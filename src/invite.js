// Invitations: a new user gets an email with the panel address and a one-time
// link to set their own password. The token is random (256 bit), only its
// SHA-256 hash is stored, it expires after INVITE_HOURS and works once.
// The link carries the token after "#", so it never reaches server logs or
// Referer headers; the page sends it to the API in the request body.

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, audit } from './db.js';
import { config } from './config.js';
import { emailSettings, sendMail, invitationMessage } from './mail.js';

export const INVITE_HOURS = 72;
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

/** A password nobody knows, for accounts that set theirs via the invitation. */
export const unusablePassword = () => bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12);

/**
 * Creates a fresh token (old ones stop working) and sends the invitation.
 * Returns { sent: true } or throws with the mail server's reason.
 */
export async function sendInvitation(req, userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404, expose: true });

  const passwordLogin = config.auth.password.customer;
  const sso = config.oidc.enabled && config.oidc.portals.includes('customer') ? config.oidc.label : null;
  let link = null;

  if (passwordLogin) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + INVITE_HOURS * 3600 * 1000).toISOString();
    db.prepare('UPDATE users SET invite_token_hash = ?, invite_expires = ?, invited_at = datetime(\'now\') WHERE id = ?')
      .run(hash(token), expires, userId);
    link = `${emailSettings().panelUrl}/#invite=${token}`;
  } else {
    db.prepare('UPDATE users SET invite_token_hash = NULL, invite_expires = NULL, invited_at = datetime(\'now\') WHERE id = ?')
      .run(userId);
  }

  const msg = invitationMessage({
    email: user.email,
    link,
    expiresHours: INVITE_HOURS,
    requireTotp: !!user.totp_required,
    sso,
    passwordLogin,
    isAdmin: !!user.is_admin,
  });
  await sendMail({ to: user.email, ...msg });
  audit(req, null, 'admin_invite_sent', { email: user.email });
  return { sent: true };
}

function findByToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  const user = db.prepare('SELECT * FROM users WHERE invite_token_hash = ?').get(hash(token));
  if (!user || user.deleting) return null;
  if (!user.invite_expires || new Date(user.invite_expires) < new Date()) return { expired: true, user };
  return { user };
}

/** For the "set your password" page: is the link valid, and for whom? */
export function checkInvitation(token) {
  const r = findByToken(token);
  if (!r) return { valid: false, reason: 'invalid' };
  if (r.expired) return { valid: false, reason: 'expired' };
  return { valid: true, email: r.user.email, requireTotp: !!r.user.totp_required };
}

/** Sets the password and uses up the link. */
export async function acceptInvitation(req, token, password) {
  const r = findByToken(token);
  if (!r) throw Object.assign(new Error('This link is not valid. Ask for a new invitation.'), { statusCode: 400, expose: true });
  if (r.expired) throw Object.assign(new Error('This link has expired. Ask for a new invitation.'), { statusCode: 400, expose: true });
  const hashPw = await bcrypt.hash(password, 12);
  db.prepare(`
    UPDATE users SET password_hash = ?, password_set = 1, invite_token_hash = NULL, invite_expires = NULL
    WHERE id = ?`).run(hashPw, r.user.id);
  audit({ account: r.user, ip: req.ip }, null, 'invite_accepted', { email: r.user.email });
  return { email: r.user.email };
}

/** Invitation state for the admin list. */
export function inviteState(u) {
  if (u.password_set && !u.invite_token_hash) return null;
  if (!u.invite_token_hash) return u.invited_at ? { status: 'sent' } : null; // SSO-only invitation
  return new Date(u.invite_expires) < new Date()
    ? { status: 'expired', expires: u.invite_expires }
    : { status: 'pending', expires: u.invite_expires };
}
