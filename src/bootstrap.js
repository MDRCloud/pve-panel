// First administrator from the environment, for setups without a terminal
// (e.g. a NAS Docker UI). Only acts when there are no accounts at all.
import bcrypt from 'bcryptjs';
import { db, audit } from './db.js';

export function bootstrapAdmin(log) {
  const email = (process.env.INITIAL_ADMIN_EMAIL || '').trim();
  const password = process.env.INITIAL_ADMIN_PASSWORD || '';
  if (!email && !password) return;

  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) {
    log.info('INITIAL_ADMIN_EMAIL is set but accounts already exist; nothing created. '
      + 'You can remove INITIAL_ADMIN_* from .env.');
    return;
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    log.error('INITIAL_ADMIN_EMAIL is not a valid email address; no admin created');
    return;
  }
  if (password.length < 12) {
    log.error('INITIAL_ADMIN_PASSWORD must be at least 12 characters; no admin created');
    return;
  }
  const hash = bcrypt.hashSync(password, 12);
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO users (email, password_hash, is_admin, totp_required) VALUES (?, ?, 1, ?)',
  ).run(email, hash, process.env.INITIAL_ADMIN_REQUIRE_2FA === 'true' ? 1 : 0);
  audit({ account: { id: Number(lastInsertRowid) }, ip: 'bootstrap' }, null, 'admin_user_create', { email, bootstrap: true });
  log.warn(`Created the first administrator ${email} from INITIAL_ADMIN_EMAIL. `
    + 'Sign in, then remove INITIAL_ADMIN_PASSWORD from .env.');
}
