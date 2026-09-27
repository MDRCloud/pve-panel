// Consistent copy of the database while the panel keeps running (SQLite VACUUM INTO).
// Usage: npm run db:backup [-- <target file>]
// Default target: <data dir>/backups/panel-<timestamp>.db
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../src/db.js';
import { config } from '../src/config.js';

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = path.resolve(process.argv[2]
  || path.join(path.dirname(path.resolve(config.dbPath)), 'backups', `panel-${stamp}.db`));
fs.mkdirSync(path.dirname(target), { recursive: true });
if (fs.existsSync(target)) {
  console.error(`${target} already exists`);
  process.exit(1);
}
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
console.log(`Backup written to ${target} (${(fs.statSync(target).size / 1024).toFixed(0)} KB)`);
