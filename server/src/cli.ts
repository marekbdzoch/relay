// Admin command line for self-hosters.
//   node server/src/cli.ts backup [dir]                 – consistent online backup of the database
//   node server/src/cli.ts reset-password <email> <pw>  – set a new password (and sign out everywhere)
//   node server/src/cli.ts make-owner <email>           – promote a user to workspace owner
//   node server/src/cli.ts users                        – list accounts
// In Docker: docker compose exec relay node server/src/cli.ts <command>
import fs from 'node:fs';
import path from 'node:path';
import { all, db, get, run } from './db.ts';
import { config } from './config.ts';
import { hashPassword } from './lib/auth.ts';

const [cmd, ...args] = process.argv.slice(2);

function user(email: string) {
  const u = get<{ id: string; full_name: string }>('SELECT id, full_name FROM users WHERE email = ?', email.toLowerCase());
  if (!u) {
    console.error(`No user with email ${email}`);
    process.exit(1);
  }
  return u;
}

switch (cmd) {
  case 'backup': {
    const dir = path.resolve(args[0] ?? path.join(config.dataDir, 'backups'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `relay-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    console.log(`Database backed up to ${file}`);
    console.log(`Uploaded files live in ${config.uploadsDir} – back that directory up as well.`);
    break;
  }
  case 'reset-password': {
    const [email, pw] = args;
    if (!email || !pw || pw.length < 8) {
      console.error('Usage: reset-password <email> <new-password (min 8 chars)>');
      process.exit(1);
    }
    const u = user(email);
    run('UPDATE users SET password_hash = ?, deactivated = 0 WHERE id = ?', await hashPassword(pw), u.id);
    run('DELETE FROM sessions WHERE user_id = ?', u.id);
    console.log(`Password updated for ${u.full_name}.`);
    break;
  }
  case 'make-owner': {
    const u = user(args[0] ?? '');
    run("UPDATE users SET role = 'owner', deactivated = 0 WHERE id = ?", u.id);
    console.log(`${u.full_name} is now an owner.`);
    break;
  }
  case 'users': {
    for (const u of all<{ email: string; full_name: string; role: string; deactivated: number }>('SELECT email, full_name, role, deactivated FROM users ORDER BY created_at')) {
      console.log(`${u.role.padEnd(7)} ${u.deactivated ? '(deactivated) ' : ''}${u.full_name} <${u.email}>`);
    }
    break;
  }
  default:
    console.log('Commands: backup [dir] | reset-password <email> <password> | make-owner <email> | users');
}
