import { closeSync, existsSync, openSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export function checkBackup(file) {
  const target = resolve(file);
  if (!existsSync(target) || !statSync(target).isFile()) throw new Error('Backup file was not found.');
  const backup = new DatabaseSync(target, { readOnly: true });
  try {
    const integrity = backup.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' ||
        backup.prepare('PRAGMA foreign_key_check').all().length) {
      throw new Error('Backup did not pass SQLite integrity checks.');
    }
    const counts = backup.prepare(`SELECT (SELECT COUNT(*) FROM attendees) AS attendees,
      (SELECT COUNT(*) FROM orders) AS orders, (SELECT COUNT(*) FROM mail) AS emails`).get();
    return counts;
  } finally { backup.close(); }
}

export function createBackup(db, file) {
  if (!file) throw new Error('Provide a new backup file path.');
  const target = resolve(file);
  closeSync(openSync(target, 'wx', 0o600));
  try {
    db.prepare('VACUUM INTO ?').run(target);
    return checkBackup(target);
  } catch (error) {
    unlinkSync(target);
    throw error;
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [, , file] = process.argv;
  if (!file) throw new Error('Provide a backup file to verify.');
  console.log('SQLite backup verified:', checkBackup(file));
}
