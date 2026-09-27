// Emergency: remove two-factor authentication from an account (e.g. an admin
// who lost their phone and recovery codes). If 2FA is required for the account,
// it is set up again at the next sign-in.
// Usage: npm run user:reset-2fa -- <email>
import { db } from '../src/db.js';
import { reset } from '../src/totp.js';

const email = process.argv[2];
if (!email) {
  console.error('Usage: npm run user:reset-2fa -- <email>');
  process.exit(1);
}
const user = db.prepare('SELECT id, totp_required FROM users WHERE email = ?').get(email);
if (!user) {
  console.error(`No user with email ${email}`);
  process.exit(1);
}
reset(user.id);
db.prepare("INSERT INTO audit_log (user_id, action, detail, ip) VALUES (?, 'cli_twofa_reset', ?, 'cli')")
  .run(user.id, JSON.stringify({ email }));
console.log(`Two-factor authentication removed for ${email}.`
  + (user.totp_required ? ' It is required for this account, so it will be set up again at the next sign-in.' : ''));
