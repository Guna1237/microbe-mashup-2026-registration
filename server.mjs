import { createServer } from 'node:http';
import { mkdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { basicFee, batches, events, workshops, states, registration, emailAddress, InputError } from './event.mjs';
import { createAdmin, installAdminSchema, previewPassword, rejectionReasons } from './admin.mjs';
import { readStaff, previewStaff } from './staff.mjs';
import { createBackup } from './ops.mjs';

const env = process.env;
const demo = env.DEMO === '1';
const razorpayTest = env.RAZORPAY_TEST === '1';
const local = demo || razorpayTest;
const previewPassphrase = local ? env.ADMIN_PASSWORD || (demo ? previewPassword : '') : '';
const staff = env.STAFF_FILE ? readStaff(env.STAFF_FILE) : previewPassphrase ? previewStaff(previewPassphrase) : [];
const paymentMode = env.PAYMENT_MODE || (razorpayTest ? 'razorpay' : 'manual');
if (!['manual', 'razorpay'].includes(paymentMode)) throw new Error('Use PAYMENT_MODE=manual or PAYMENT_MODE=razorpay.');
const manual = paymentMode === 'manual';
const upiId = demo ? '' : (env.MANUAL_UPI_ID || '').trim();
const payee = demo ? '' : (env.MANUAL_PAYEE || '').trim();
const qr = manual && !demo && env.MANUAL_QR_FILE ? readFileSync(env.MANUAL_QR_FILE) : null;
if (qr && qr.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('MANUAL_QR_FILE must be a PNG image.');
const port = Number(env.PORT || 8107);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const publicUrl = local ? 'http://127.0.0.1:' + port : (env.PUBLIC_URL || '').replace(/\/$/, '');
const exporting = process.argv[2] === 'export';
const backup = process.argv[2] === 'backup';
const preflight = process.argv[2] === 'preflight';
const mailPaused = env.MAIL_PAUSED === '1';
const trustProxy = env.TRUST_LOOPBACK_PROXY === '1';
const checkingRazorpay = process.argv[2] === 'check-razorpay';
const expectedKeyPrefix = razorpayTest ? 'rzp_test_' : 'rzp_live_';
const hasRazorpayKeys = env.RAZORPAY_KEY_ID?.startsWith(expectedKeyPrefix) && Boolean(env.RAZORPAY_KEY_SECRET?.trim());
if (demo && razorpayTest) throw new Error('Select one mode. Set DEMO=0 to use Razorpay Test Mode.');
if (razorpayTest && manual) throw new Error('Set PAYMENT_MODE=razorpay to use Razorpay Test Mode.');
if (checkingRazorpay) {
  if (demo || manual || !hasRazorpayKeys) {
    throw new Error('Set DEMO=0, PAYMENT_MODE=razorpay and enter matching Razorpay credentials in .env.');
  }
  try {
    await razor('payment_links?count=1');
    console.log('Connected to Razorpay ' + (razorpayTest ? 'Test Mode.' : 'Live Mode.'));
  } catch (error) {
    console.error('Razorpay connection check failed: ' + error.message);
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
}
const paymentConfigured = manual ? /^[\w.-]+@[\w.-]+$/.test(upiId) && Boolean(payee) : hasRazorpayKeys;
const configuredUrl = URL.canParse(publicUrl) && new URL(publicUrl);
const productionUrl = configuredUrl && configuredUrl.protocol === 'https:' && configuredUrl.origin === publicUrl;
const persistentPath = Boolean(env.DATA_DIR && isAbsolute(env.DATA_DIR));
const ready = demo || (razorpayTest && hasRazorpayKeys) || (env.PRICES_CONFIRMED === 'true' &&
  ['BASIC_FEE', 'IPC_FEE', 'ANTIBIOTIC_FEE', 'BEYOND_FEE', 'RESEND_API_KEY', 'MAIL_FROM']
    .every((key) => env[key]) && productionUrl && persistentPath && paymentConfigured && staff.length);
if (!ready && !exporting && !backup) {
  throw new Error('Configure the HTTPS domain, absolute data path, named staff accounts, payment and email, then confirm fees.');
}
if (!local && (exporting || backup) && !persistentPath) throw new Error('Set the absolute production DATA_DIR.');
if (previewPassphrase && (previewPassphrase.length < 16 || previewPassphrase.length > 256)) {
  throw new Error('Use a local preview passphrase with 16–256 characters.');
}
const whatsapp = env.WHATSAPP_URL || '';
if (whatsapp && !/^https:\/\/chat\.whatsapp\.com\/[\w-]+$/.test(whatsapp)) {
  throw new Error('WHATSAPP_URL must be an official WhatsApp invite URL.');
}

const dir = resolve(demo ? env.DEMO_DATA_DIR || 'demo-data' : razorpayTest ? 'razorpay-test-data' : env.DATA_DIR || 'data');
if (preflight && local) throw new Error('Set DEMO=0 and RAZORPAY_TEST=0 to run the production preflight.');
const dbPath = join(dir, 'mashup.sqlite');
if ((backup || exporting) && !existsSync(dbPath)) throw new Error('The event database was not found at the configured location.');
mkdirSync(dir, { recursive: true, mode: 0o750 });
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS attendees (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE,
    details TEXT NOT NULL, invite TEXT NOT NULL UNIQUE, created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orders (
    ref TEXT PRIMARY KEY, owner INTEGER NOT NULL REFERENCES attendees(seq), product TEXT NOT NULL,
    amount INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, link_id TEXT UNIQUE, link_url TEXT,
    state TEXT NOT NULL DEFAULT 'pending', paid_at INTEGER, last_checked INTEGER NOT NULL DEFAULT 0,
    UNIQUE(owner, product)
  );
  CREATE TABLE IF NOT EXISTS mail (
    id TEXT PRIMARY KEY, recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
    sent INTEGER, first_attempt INTEGER, next_attempt INTEGER NOT NULL DEFAULT 0, error TEXT
  );
  CREATE TABLE IF NOT EXISTS manual_receipts (
    ref TEXT PRIMARY KEY REFERENCES orders(ref), utr TEXT NOT NULL UNIQUE,
    submitted_at INTEGER NOT NULL
  );
`);
installAdminSchema(db);
if (preflight) {
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('SQLite did not pass its quick check.');
  if (mailPaused) console.log('Outgoing email is paused.');
  console.log('Production settings and SQLite verified. Confirm the bank account and run the hosted HTTPS and mail smoke test.');
  db.close();
  process.exit(0);
}
if (backup) {
  console.log('SQLite backup created and verified:', createBackup(db, process.argv[3]));
  db.close();
  process.exit(0);
}
const get = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);
const isOpen = (name) => get('SELECT is_open FROM event_controls WHERE name=?', name)?.is_open !== 0;
function audit(action, target, detail = '', actor = 'host-cli') {
  run('INSERT INTO organizer_audit(action,target,detail,created_at,actor) VALUES(?,?,?,?,?)',
    action, target, detail, Date.now(), actor);
}

if (exporting) {
  const rows = all(`SELECT a.*, o.product, o.ref, o.link_id, o.amount, o.state, o.paid_at, r.utr
    FROM attendees a JOIN orders o ON a.seq=o.owner LEFT JOIN manual_receipts r ON r.ref=o.ref ORDER BY a.seq, o.product`);
  console.log(JSON.stringify(rows.map(({ seq, created, details, product, ref, link_id, amount, state, paid_at, utr }) => ({
    attendeeId: uid(seq), created: new Date(created).toISOString(), ...JSON.parse(details), product, ref,
    razorpayLinkId: link_id, utr, amountINR: amount / 100, state, paidAt: paid_at ? new Date(paid_at).toISOString() : null,
  })), null, 2));
  process.exit(0);
}

const startAt = Number(env.FIRST_ATTENDEE_NUMBER || 1);
if (!Number.isSafeInteger(startAt) || startAt < 1 || startAt > 10000000) throw new Error('Invalid FIRST_ATTENDEE_NUMBER.');
if (startAt > 1 && !get('SELECT 1 FROM attendees LIMIT 1')) {
  run("INSERT INTO sqlite_sequence(name,seq) SELECT 'attendees',? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='attendees')", startAt - 1);
  run("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='attendees'", startAt - 1);
}

function atomic(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function uid(seq) { return 'MMSPH-' + String(seq).padStart(3, '0'); }
function secret() { return randomBytes(24).toString('base64url'); }
function orderFor(seq, product) { return get('SELECT * FROM orders WHERE owner=? AND product=?', seq, product); }
function attendee(seq) { return get('SELECT * FROM attendees WHERE seq=?', seq); }
function newOrder(seq, product, amount) {
  run('INSERT INTO orders (ref,owner,product,amount,token) VALUES (?,?,?,?,?)',
    'MM26-' + randomBytes(12).toString('hex'), seq, product, amount, secret());
  return orderFor(seq, product);
}

const workshopFor = (id) => workshops.find((entry) => entry.id === id);
const orderLabel = (product) => product === 'summit' ? 'Summit registration' : workshopFor(product).name;
const statusUrl = (order) => publicUrl + '/#payment=' + order.token;
const invitation = (person) => publicUrl + '/#workshops=' + person.invite;
function queue(order, template, subject, body) {
  const person = attendee(order.owner);
  run('INSERT OR IGNORE INTO mail (id,recipient,subject,body) VALUES (?,?,?,?)',
    order.ref + '/' + template, person.email, "Microbe Mashup ’26 | " + subject + ' | ' + uid(person.seq),
    'Hello ' + JSON.parse(person.details).name + ',\n\n' + body +
      '\n\nTeam Microbe Mashup ’26\nMamata Academy of Medical Sciences');
}

function acknowledge(order) {
  queue(order, 'received', orderLabel(order.product) + ' received',
    'Your ' + orderLabel(order.product).toLowerCase() + ' request has been received.\n' +
    'Registration ID: ' + uid(order.owner) + '\n' +
    'Payment and status: ' + statusUrl(order) + '\n\n' +
    'Your place is confirmed after payment is verified.');
}

function sendCorrection(order, reason) {
  queue(order, 'correction-' + order.utr + '-' + reason, 'Payment reference needs attention',
    rejectionReasons[reason] + '\n\nRegistration ID: ' + uid(order.owner) +
    '\nPayment and status: ' + statusUrl(order));
}

function confirm(order) {
  atomic(() => {
    recordConfirmation(order);
  });
}

function recordConfirmation(order) {
    const change = run("UPDATE orders SET state='paid', paid_at=? WHERE ref=? AND state<>'paid'", Date.now(), order.ref);
    if (!change.changes) return;
    const label = orderLabel(order.product);
    const intro = label + ' is confirmed.\nRegistration ID: ' + uid(order.owner) + '\n' +
      'Amount received: INR ' + order.amount / 100 + '\n';
    const guidelines = '\n11–12 December 2026 · Mamata Academy of Medical Sciences, Bachupally, Hyderabad\n' +
      'Arrive 30 minutes before reporting time. Bring your college ID, registration ID and any materials required for your activities. ' +
      'Follow staff instructions and maintain professional conduct. Check @microbemashup for updates.\n';
    const summitDetails = '\nBook workshops with your personal link: ' + invitation(attendee(order.owner)) + '\n' +
      (whatsapp ? '\nOfficial WhatsApp group: ' + whatsapp + '\n' : '') + guidelines;
    queue(order, 'paid', label + ' confirmed', intro + (order.product === 'summit' ? summitDetails : guidelines));
}

function normalizeUtr(value) {
  const utr = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{8,30}$/.test(utr)) throw new InputError('Enter the UPI transaction reference from your banking app.');
  return utr;
}

function submitReceipt(order, utr) {
  atomic(() => {
    const current = get('SELECT state, link_id FROM orders WHERE ref=?', order.ref);
    if (current.state !== 'pending' || current.link_id) throw new InputError('This payment cannot accept a new reference.');
    const used = get('SELECT ref FROM manual_receipts WHERE utr=?', utr);
    if (used && used.ref !== order.ref) throw new InputError('This transaction reference is already in use. Check it or contact the organizers.');
    run(`INSERT INTO manual_receipts(ref, utr, submitted_at) VALUES(?,?,?)
      ON CONFLICT(ref) DO UPDATE SET utr=excluded.utr, submitted_at=excluded.submitted_at`, order.ref, utr, Date.now());
    run('DELETE FROM payment_reviews WHERE ref=?', order.ref);
  });
}

function verifyManual(ref, rawUtr, rawAmount, actor) {
  const amount = Number(rawAmount);
  const utr = normalizeUtr(rawUtr);
  if (!Number.isSafeInteger(amount) || amount < 1) throw new InputError('Enter the whole-rupee amount received.');
  return atomic(() => {
    const order = get(`SELECT o.*, r.utr FROM orders o JOIN manual_receipts r ON r.ref=o.ref WHERE o.ref=?`, ref);
    if (!order || order.link_id || order.utr !== utr || order.amount !== amount * 100) {
      throw new InputError('Order reference, submitted UPI reference, or exact amount did not match.');
    }
    if (order.state === 'paid') return 'Payment was already verified.';
    if (order.state !== 'pending') throw new InputError('This order cannot be verified.');
    recordConfirmation(order);
    audit('payment-verified', order.ref, utr + ' · INR ' + amount, actor);
    return 'Payment verified. The confirmation email has been queued.';
  });
}

async function razor(path, body) {
  const authorization = 'Basic ' + Buffer.from(env.RAZORPAY_KEY_ID + ':' + env.RAZORPAY_KEY_SECRET).toString('base64');
  const result = await fetch('https://api.razorpay.com/v1/' + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(9000),
  });
  if (!result.ok) throw new Error('Razorpay API response ' + result.status);
  return result.json();
}

const preparing = new Map();
async function prepare(order) {
  if (order.link_id || order.state !== 'pending') return order;
  if (preparing.has(order.ref)) return preparing.get(order.ref);
  const promise = (async () => {
    let link;
    if (demo) {
      link = { id: 'demo-' + order.ref, short_url: statusUrl(order) };
    } else {
      // Recover a link if the previous request reached Razorpay before the response was saved.
      const found = await razor('payment_links?reference_id=' + encodeURIComponent(order.ref));
      link = found.payment_links?.find((item) => item.reference_id === order.ref);
      if (!link) {
        link = await razor('payment_links', {
          amount: order.amount, currency: 'INR', accept_partial: false, reference_id: order.ref,
          description: 'Microbe Mashup 2026 - ' + orderLabel(order.product),
          notify: { sms: false, email: false }, reminder_enable: false,
        });
      }
      if (link.reference_id !== order.ref || link.amount !== order.amount || link.currency !== 'INR' ||
          typeof link.id !== 'string' || !/^https:\/\//.test(link.short_url || '')) {
        throw new Error('Unexpected Razorpay link details.');
      }
    }
    run('UPDATE orders SET link_id=?, link_url=? WHERE ref=?', link.id, link.short_url, order.ref);
    return get('SELECT * FROM orders WHERE ref=?', order.ref);
  })();
  preparing.set(order.ref, promise);
  try { return await promise; }
  finally { preparing.delete(order.ref); }
}

const refreshing = new Map();
async function refresh(order) {
  if (demo || !order.link_id || order.state !== 'pending') return;
  if (refreshing.has(order.ref)) return refreshing.get(order.ref);
  if (Date.now() - order.last_checked < 5000) return;
  run('UPDATE orders SET last_checked=? WHERE ref=?', Date.now(), order.ref);
  const promise = (async () => {
    const link = await razor('payment_links/' + encodeURIComponent(order.link_id));
    if (link.id !== order.link_id || link.reference_id !== order.ref ||
        link.amount !== order.amount || link.currency !== 'INR') {
      throw new Error('Payment identifier, amount, or currency mismatch.');
    }
    if (link.status === 'paid' && link.amount_paid === order.amount) confirm(order);
    if (['expired', 'cancelled'].includes(link.status)) {
      run("UPDATE orders SET state=? WHERE ref=? AND state='pending'", link.status, order.ref);
    }
  })();
  refreshing.set(order.ref, promise);
  try { await promise; }
  finally { refreshing.delete(order.ref); }
}

async function deliver(msg) {
  const now = Date.now();
  // Resend deduplicates the same send key for 24 hours. Stop automatic retries before that window ends.
  if (msg.first_attempt && now - msg.first_attempt >= 23 * 3600000) {
    run('UPDATE mail SET error=?, next_attempt=? WHERE id=?',
      'Needs operator review before resend', Number.MAX_SAFE_INTEGER, msg.id);
    return;
  }
  run('UPDATE mail SET first_attempt=COALESCE(first_attempt,?), next_attempt=? WHERE id=?',
    now, now + 60000, msg.id);
  if (local) {
    appendFileSync(join(dir, 'outbox.jsonl'), JSON.stringify({
      to: msg.recipient, subject: msg.subject, text: msg.body,
    }) + '\n');
  } else {
    const result = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json',
        'idempotency-key': msg.id,
      },
      body: JSON.stringify({
        from: env.MAIL_FROM, to: [msg.recipient], subject: msg.subject, text: msg.body,
        reply_to: env.REPLY_TO || 'mams.microbemashup@gmail.com',
      }),
      signal: AbortSignal.timeout(9000),
    });
    if (!result.ok) {
      const delay = result.status === 429 ? 15 * 60000 : 5 * 60000;
      run('UPDATE mail SET error=?, next_attempt=? WHERE id=?', 'Resend response ' + result.status, now + delay, msg.id);
      return;
    }
  }
  run('UPDATE mail SET sent=?, error=NULL WHERE id=?', Date.now(), msg.id);
}

let working = false;
let stopping = false;
async function work() {
  if (working || stopping) return;
  working = true;
  try {
    if (!demo && !manual) {
      const pending = all(`SELECT * FROM orders WHERE state='pending' AND link_id IS NOT NULL
        AND last_checked < ? ORDER BY last_checked LIMIT 60`, Date.now() - 45000);
      for (let i = 0; i < pending.length; i += 5) {
        if (stopping) return;
        await Promise.allSettled(pending.slice(i, i + 5).map(refresh));
      }
    }
    if (mailPaused) return;
    const messages = all(`SELECT * FROM mail WHERE sent IS NULL AND next_attempt <= ?
      ORDER BY rowid LIMIT 90`, Date.now());
    for (const msg of messages) {
      if (stopping) return;
      try { await deliver(msg); }
      catch {
        run('UPDATE mail SET error=? WHERE id=?', 'Email service request failed', msg.id);
        console.error('Email attempt failed for ' + msg.id);
      }
    }
  } finally { working = false; }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function read(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new InputError('Expected JSON.');
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16384) throw new InputError('Submission is too large.');
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks)); }
  catch { throw new InputError('Invalid submission.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new InputError('Invalid submission.');
  return parsed;
}

function validToken(token) { return typeof token === 'string' && /^[A-Za-z0-9_-]{32}$/.test(token); }
function bearer(req) { return (req.headers.authorization || '').replace(/^Bearer /, ''); }
function authorizedAttendee(req) {
  const token = bearer(req);
  const person = validToken(token) && get('SELECT * FROM attendees WHERE invite=?', token);
  if (!person || orderFor(person.seq, 'summit')?.state !== 'paid') {
    throw new InputError('Open the workshop link from your confirmed summit email.');
  }
  return person;
}
function authorizedOrder(req) {
  const token = bearer(req);
  const order = validToken(token) && get('SELECT * FROM orders WHERE token=?', token);
  if (!order) throw new InputError('Open the payment status link from your registration email.');
  return order;
}

function summary(order) {
  const manualOrder = manual && !order.link_id;
  return {
    participantId: uid(order.owner), product: order.product, label: orderLabel(order.product),
    amount: order.amount / 100, state: order.state,
    checkout: !demo && order.state === 'pending' ? order.link_url : null,
    token: order.token,
    manual: manualOrder,
    orderReference: manualOrder ? order.ref : null,
    utr: manualOrder ? get('SELECT utr FROM manual_receipts WHERE ref=?', order.ref)?.utr ?? null : null,
    reviewMessage: manualOrder ? rejectionReasons[get('SELECT reason FROM payment_reviews WHERE ref=?', order.ref)?.reason] || null : null,
    workshopToken: order.state === 'paid' && order.product === 'summit' ? attendee(order.owner).invite : null,
  };
}

function importPaid(file, sendInvites) {
  if (!file) throw new Error('Provide the path to a verified paid roster JSON file.');
  const rows = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(rows) || !rows.length) throw new Error('The roster must be a non-empty JSON array.');
  return atomic(() => {
    let imported = 0;
    for (const row of rows) {
      const rawId = /^MMSPH-(\d{3,8})$/.exec(row.attendeeId || '');
      const seq = Number(rawId?.[1]);
      const email = emailAddress(row.email);
      const name = typeof row.name === 'string' ? row.name.trim().toUpperCase() : '';
      if (!Number.isSafeInteger(seq) || seq < 1 || uid(seq) !== row.attendeeId || !name ||
          name.length > 120 || /[\u0000-\u001f\u007f]/.test(name) ||
          !Number.isSafeInteger(row.amountPaise) || row.amountPaise < 1 || !batches.some(({ id }) => id === row.batch)) {
        throw new Error('Each row needs the original attendee ID, name, email, batch and verified amount in paise.');
      }
      const existing = get('SELECT * FROM attendees WHERE email=? OR seq=?', email, seq);
      let order;
      if (existing) {
        order = orderFor(seq, 'summit');
        if (existing.email !== email || existing.seq !== seq || order?.state !== 'paid' ||
            order.amount !== row.amountPaise || order.link_id) throw new Error('Roster conflict at ' + uid(seq));
      } else {
        const details = { name, email, batch: row.batch, imported: true };
        run('INSERT INTO attendees (seq,email,details,invite,created) VALUES (?,?,?,?,?)',
          seq, email, JSON.stringify(details), secret(), Date.now());
        order = newOrder(seq, 'summit', row.amountPaise);
        run("UPDATE orders SET state='paid', paid_at=? WHERE ref=?", Date.now(), order.ref);
        imported++;
      }
      if (sendInvites) {
        queue(order, 'import-invite', 'Your workshop registration link', 'Your summit payment is already verified.\n' +
          'Registration ID: ' + uid(seq) + '\n' + 'Book workshops: ' + invitation(attendee(seq)));
      }
    }
    return imported;
  });
}

if (process.argv[2] === 'import-paid') {
  const imported = importPaid(process.argv[3], process.argv.includes('--send-invites'));
  console.log('Imported ' + imported + ' verified attendee(s).');
  process.exit(0);
}

if (process.argv[2] === 'verify-payment') {
  if (!manual) throw new Error('Manual verification requires PAYMENT_MODE=manual.');
  console.log(verifyManual(process.argv[3], process.argv[4], process.argv[5]));
  process.exit(0);
}

function begin(body) {
  const { details, amount } = registration(body);
  return atomic(() => {
    const email = emailAddress(details.email);
    if (get('SELECT seq FROM attendees WHERE email=?', email)) return null;
    if (!isOpen('summit')) throw new InputError('Summit registration is paused. Existing registrations can still be paid.');
    const result = run('INSERT INTO attendees (email,details,invite,created) VALUES (?,?,?,?)',
      email, JSON.stringify(details), secret(), Date.now());
    const order = newOrder(result.lastInsertRowid, 'summit', amount);
    acknowledge(order);
    return order;
  });
}

function beginWorkshop(req, body) {
  const person = authorizedAttendee(req);
  const item = workshopFor(body.product);
  if (!item) throw new InputError('Select a workshop.');
  return atomic(() => {
    const existing = orderFor(person.seq, item.id);
    if (existing) return existing;
    if (!isOpen('workshops')) throw new InputError('New workshop bookings are paused. Existing bookings can still be paid.');
    return newOrder(person.seq, item.id, item.fee * 100);
  });
}

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/site.css', ['site.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/admin', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin.css', ['admin.css', 'text/css; charset=utf-8']],
  ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']],
  ['/event-logo.webp', ['event-logo.webp', 'image/webp']],
  ['/college-logo.webp', ['college-logo.webp', 'image/webp']],
]);
const headers = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
function clientIp(req) {
  const socketIp = req.socket.remoteAddress || 'unknown';
  const forwarded = req.headers['x-forwarded-for']?.split(',')[0]?.trim();
  if (trustProxy && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socketIp) && forwarded && isIP(forwarded)) {
    return forwarded;
  }
  return socketIp;
}

const requestTotals = new Map();
let bucket = 0;
let globalRegistrations = 0;
function allowRegistration(req) {
  if (local) return true;
  const current = Math.floor(Date.now() / 60000);
  if (bucket !== current) {
    bucket = current;
    globalRegistrations = 0;
    requestTotals.clear();
  }
  const ip = clientIp(req);
  const count = requestTotals.get(ip) || 0;
  if (count >= 60 || globalRegistrations >= 600) return false;
  requestTotals.set(ip, count + 1);
  globalRegistrations++;
  return true;
}

const admin = createAdmin({ db, atomic, manual, accounts: staff, demo, clientIp, publicUrl, local, json, read, uid,
  orderLabel, verifyManual, audit, sendCorrection, mailPaused });

const server = createServer({ requestTimeout: 25000, headersTimeout: 10000 }, async (req, res) => {
  for (const [header, value] of Object.entries(headers)) res.setHeader(header, value);
  try {
    const url = new URL(req.url, publicUrl);
    const { pathname } = url;
    const { method } = req;
    if (method === 'POST' && req.headers.origin && req.headers.origin !== publicUrl) {
      return json(res, 403, { error: 'Open the official registration site to continue.' });
    }
    if (pathname.startsWith('/api/admin/')) return await admin(req, res, url);
    if (method === 'GET' && pathname === '/healthz') {
      get('SELECT 1');
      return json(res, 200, { ok: true });
    }
    if (method === 'GET' && assets.has(pathname)) {
      const [file, type] = assets.get(pathname);
      if (type === 'image/webp') res.setHeader('cache-control', 'public, max-age=86400');
      res.writeHead(200, { 'content-type': type });
      return res.end(readFileSync(new URL('./public/' + file, import.meta.url)));
    }
    if (method === 'GET' && pathname === '/payment-qr.png' && qr) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(qr);
    }
    if (method === 'GET' && pathname === '/api/catalog') {
      return json(res, 200, { demo, razorpayTest, manual, upiId, payee, hasQr: Boolean(qr), basicFee, batches, events, states, workshops, summitOpen: isOpen('summit') });
    }
    if (method === 'POST' && pathname === '/api/register') {
      if (!allowRegistration(req)) {
        res.setHeader('retry-after', '60');
        return json(res, 429, { error: 'Registration is receiving many requests. Try again in one minute.' });
      }
      const body = await read(req);
      const order = begin(body);
      return json(res, 200, order ? { token: order.token } : { existing: true });
    }
    if (pathname === '/api/workshops' && method === 'GET') {
      const person = authorizedAttendee(req);
      return json(res, 200, {
        participantId: uid(person.seq), workshopsOpen: isOpen('workshops'),
        orders: all("SELECT * FROM orders WHERE owner=? AND product<>'summit'", person.seq).map(summary),
      });
    }
    if (pathname === '/api/workshops' && method === 'POST') {
      const order = beginWorkshop(req, await read(req));
      return json(res, 200, { token: order.token });
    }
    if (pathname === '/api/payment' && method === 'GET') {
      return json(res, 200, summary(authorizedOrder(req)));
    }
    if (pathname === '/api/payment' && method === 'POST') {
      const order = authorizedOrder(req);
      if (manual) return json(res, 200, summary(order));
      try {
        const prepared = await prepare(order);
        await refresh(prepared);
      } catch (error) {
        console.error('Payment check failed for ' + order.ref + ': ' + error.message);
        return json(res, 503, { error: 'Payment service is temporarily unavailable. Use Check payment to try again.' });
      }
      return json(res, 200, summary(authorizedOrder(req)));
    }
    if (manual && pathname === '/api/payment/reference' && method === 'POST') {
      const order = authorizedOrder(req);
      const body = await read(req);
      submitReceipt(order, normalizeUtr(body.utr));
      return json(res, 200, summary(authorizedOrder(req)));
    }
    if (demo && !manual && pathname === '/api/demo/settle' && method === 'POST') {
      const order = authorizedOrder(req);
      confirm(await prepare(order));
      return json(res, 200, summary(authorizedOrder(req)));
    }
    return json(res, 404, { error: 'Page not found.' });
  } catch (error) {
    if (error instanceof InputError) return json(res, 400, { error: error.message });
    console.error('Request failed:', error);
    return json(res, 500, { error: 'Something went wrong. Please try again.' });
  }
}).listen(port, '127.0.0.1', () => {
  console.log((demo ? 'Demo ready: ' : razorpayTest ? 'Razorpay Test Mode ready: ' : 'Registration ready: ') + publicUrl);
});
const poller = setInterval(() => work().catch(() => console.error('Background processing failed.')), 15000);
poller.unref();

function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(poller);
  server.close(() => {
    const drain = setInterval(() => {
      if (working) return;
      clearInterval(drain);
      db.close();
    }, 50);
  });
  setTimeout(() => process.exit(1), 25000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
