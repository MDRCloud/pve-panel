// Usage: npm run vm:assign -- <vmid> <email> ["Display name"]
import { db } from '../src/db.js';
import { locateGuest } from '../src/pve.js';

const [vmidArg, email, label] = process.argv.slice(2);
const vmid = Number(vmidArg);

if (!Number.isInteger(vmid) || !email) {
  console.error('Usage: npm run vm:assign -- <vmid> <email> ["Display name"]');
  process.exit(1);
}

const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
if (!user) {
  console.error(`No user with email ${email}. Create one with npm run user:create.`);
  process.exit(1);
}

const guest = await locateGuest(vmid); // also confirms the guest exists
db.prepare(`
  INSERT INTO vms (vmid, user_id, type, label) VALUES (?, ?, ?, ?)
  ON CONFLICT(vmid) DO UPDATE SET user_id = excluded.user_id, type = excluded.type, label = excluded.label
`).run(vmid, user.id, guest.type, label ?? null);

console.log(`Assigned ${guest.type} ${vmid} (${guest.name}, node ${guest.node}) to ${email}`);
