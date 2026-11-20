import { randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync, existsSync, unlinkSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const accountName = /^[a-z][a-z0-9._-]{2,39}$/;
const roles = new Set(['owner', 'payments', 'checkin']);
const saltFormat = /^[a-f0-9]{48}$/;
const hashFormat = /^[a-f0-9]{64}$/;

function makeAccount(user, role, password) {
  const salt = randomBytes(24).toString('hex');
  return { user, role, salt, hash: scryptSync(password, salt, 32).toString('hex') };
}

export function readStaff(file, requireOwner = true) {
  if (!isAbsolute(file)) throw new Error('STAFF_FILE must use an absolute path.');
  const rows = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(rows) || rows.length > 32 ||
      rows.some((row) => !row || typeof row.user !== 'string' || !accountName.test(row.user) ||
        !roles.has(row.role) || !saltFormat.test(row.salt) || !hashFormat.test(row.hash)) ||
      new Set(rows.map((row) => row.user)).size !== rows.length ||
      (requireOwner && !rows.some((row) => row.role === 'owner'))) {
    throw new Error('The staff file must contain valid unique accounts and at least one owner.');
  }
  return rows;
}

export function previewStaff(password) {
  return [makeAccount('organizer', 'owner', password)];
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [, , operation, user, value, file] = process.argv;
  const location = operation === 'create' ? file : value;
  if (!accountName.test(user || '') || !isAbsolute(location || '') || !['create', 'remove'].includes(operation)) {
    throw new Error('Use staff:create USER ROLE ABSOLUTE_STAFF_FILE or staff:remove USER ABSOLUTE_STAFF_FILE.');
  }
  if (operation === 'create' && !roles.has(value)) throw new Error('Use role owner, payments or checkin.');
  const rows = existsSync(location) ? readStaff(location, false) : [];
  const retained = rows.filter((row) => row.user !== user);
  const password = operation === 'create' ? randomBytes(24).toString('base64url') : null;
  if (password) retained.push(makeAccount(user, value, password));
  else if (retained.length === rows.length) throw new Error('The account was not found.');
  if (!retained.some((row) => row.role === 'owner')) throw new Error('Keep at least one owner account.');
  if (retained.length > 32) throw new Error('The staff file supports up to 32 accounts.');
  const temporary = location + '.' + randomBytes(8).toString('hex') + '.tmp';
  writeFileSync(temporary, JSON.stringify(retained, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try { renameSync(temporary, location); }
  catch (error) { unlinkSync(temporary); throw error; }
  console.log(password
    ? 'Account ' + user + ' · ' + value + '\nCopy this passphrase now: ' + password
    : 'Removed ' + user + '.');
  console.log('Restart the app to apply the change and revoke existing sessions.');
}
