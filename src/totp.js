// Two-factor authentication with time-based one-time codes (TOTP, RFC 6238),
// compatible with Google Authenticator, Microsoft Authenticator, Authy, etc.
//
// - Secrets are 160-bit, stored AES-256-GCM encrypted (key derived from JWT_SECRET).
// - A code is accepted for the current 30-second step and one step either side
//   (clock drift), and every step can be used only once (no replay).
// - 10 recovery codes, stored as SHA-256 hashes, each usable once.

import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { db } from './db.js';
import { config } from './config.js';

const STEP = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ---- Base32 (RFC 4648, as used by authenticator apps) -------------------------

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = ((value << 5) | B32.indexOf(ch)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---- Codes ----------------------------------------------------------------------

export function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const num = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(num % 10 ** DIGITS).padStart(DIGITS, '0');
}

const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP);

/** Returns the matched time step, or null. Steps <= lastStep are refused (replay). */
export function checkCode(key, code, lastStep = -1, now = Date.now()) {
  if (!/^\d{6}$/.test(code ?? '')) return null;
  const step = currentStep(now);
  for (const s of [step - 1, step, step + 1]) {
    if (s <= lastStep) continue;
    const expected = Buffer.from(hotp(key, s));
    if (crypto.timingSafeEqual(expected, Buffer.from(code))) return s;
  }
  return null;
}

// ---- Secret storage -------------------------------------------------------------

const encKey = () => crypto.createHash('sha256').update(`totp-secret:${config.jwtSecret}`).digest();

function encrypt(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decrypt(stored) {
  const [v, iv, tag, ct] = String(stored).split(':');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]);
}

// ---- Recovery codes ---------------------------------------------------------------

const hashCode = (c) => crypto.createHash('sha256').update(c.toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');

function newRecoveryCodes() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: 10 }, () => {
    const raw = Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join('');
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}

// ---- Per-user operations ------------------------------------------------------------

const getUser = (id) => db.prepare(`
  SELECT id, email, totp_secret, totp_pending, totp_enabled, totp_required, totp_last_step, recovery_codes
  FROM users WHERE id = ?`).get(id);

export function twoFactorState(userId) {
  const u = getUser(userId);
  return {
    enabled: !!u?.totp_enabled,
    required: !!u?.totp_required,
    recoveryCodesLeft: u?.recovery_codes ? JSON.parse(u.recovery_codes).length : 0,
  };
}

/** Starts enrolment: a fresh secret (kept as "pending" until confirmed) + QR code. */
export async function beginSetup(userId) {
  const u = getUser(userId);
  const secret = crypto.randomBytes(20);
  db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(encrypt(secret), userId);
  const key = base32Encode(secret);
  const issuer = config.brand.name;
  const label = encodeURIComponent(`${issuer}:${u.email}`);
  const uri = `otpauth://totp/${label}?secret=${key}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
  return {
    key: key.match(/.{1,4}/g).join(' '), // grouped for typing by hand
    qrSvg: await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
  };
}

/** Confirms enrolment with a first code; returns the recovery codes (shown once). */
export function activate(userId, code) {
  const u = getUser(userId);
  if (!u?.totp_pending) return null;
  const secret = decrypt(u.totp_pending);
  const step = checkCode(secret, code);
  if (step === null) return null;
  const codes = newRecoveryCodes();
  db.prepare(`
    UPDATE users SET totp_secret = ?, totp_pending = NULL, totp_enabled = 1, totp_last_step = ?, recovery_codes = ?
    WHERE id = ?`).run(u.totp_pending, step, JSON.stringify(codes.map(hashCode)), userId);
  return codes;
}

/**
 * Verifies a sign-in: an authenticator code, or a recovery code (used up).
 * Returns 'code' | 'recovery' | null.
 */
export function verify(userId, input) {
  const u = getUser(userId);
  if (!u?.totp_enabled || !u.totp_secret) return null;
  const value = String(input ?? '').trim();
  if (/^\d{6}$/.test(value.replace(/\s/g, ''))) {
    const step = checkCode(decrypt(u.totp_secret), value.replace(/\s/g, ''), u.totp_last_step ?? -1);
    if (step === null) return null;
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, userId);
    return 'code';
  }
  const hashes = JSON.parse(u.recovery_codes ?? '[]');
  const h = hashCode(value);
  const i = hashes.findIndex((x) => crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h)));
  if (i < 0) return null;
  hashes.splice(i, 1);
  db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(hashes), userId);
  return 'recovery';
}

export function newRecoveryCodesFor(userId) {
  const codes = newRecoveryCodes();
  db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(codes.map(hashCode)), userId);
  return codes;
}

/** Turns 2FA off (secret, pending secret and recovery codes removed). */
export function reset(userId) {
  db.prepare(`
    UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled = 0, totp_last_step = NULL, recovery_codes = NULL
    WHERE id = ?`).run(userId);
}
