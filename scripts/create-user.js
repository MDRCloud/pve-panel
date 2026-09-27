// Usage: npm run user:create -- <email> <password> [--admin] [--require-2fa]
import bcrypt from 'bcryptjs';
import { db } from '../src/db.js';

const [email, password] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const isAdmin = process.argv.includes('--admin');
const require2fa = process.argv.includes('--require-2fa');

if (!email || !password) {
  console.error('Usage: npm run user:create -- <email> <password> [--admin]');
  process.exit(1);
}
if (password.length < 12) {
  console.error('Use a password of at least 12 characters.');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);
try {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (email, password_hash, is_admin, totp_required) VALUES (?, ?, ?, ?)')
    .run(email, hash, isAdmin ? 1 : 0, require2fa ? 1 : 0);
  console.log(`Created ${isAdmin ? 'admin' : 'customer'} ${email} (id ${lastInsertRowid})`);
} catch (err) {
  console.error(String(err.message).includes('UNIQUE') ? `${email} already exists` : err.message);
  process.exit(1);
}
