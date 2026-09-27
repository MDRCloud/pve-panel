// Encrypting values the panel must be able to read back (e.g. the SMTP password).
// AES-256-GCM with a key derived from JWT_SECRET and a per-purpose label, so
// changing JWT_SECRET makes stored secrets unreadable (they must be re-entered).
import crypto from 'node:crypto';
import { config } from './config.js';

const keyFor = (purpose) => crypto.createHash('sha256').update(`${purpose}:${config.jwtSecret}`).digest();

export function seal(purpose, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFor(purpose), iv);
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function open(purpose, sealed) {
  const [v, iv, tag, ct] = String(sealed).split(':');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', keyFor(purpose), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
