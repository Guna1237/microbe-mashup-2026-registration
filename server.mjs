import './config.mjs';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { basicFee, basicRates, batches, events, workshops, states, activities, activitySelection, registration, emailAddress, normalizeRegistrationId, InputError } from './event.mjs';
import { createAdmin, installAdminSchema, previewPassword, rejectionReasons } from './admin.mjs';
import { readStaff, previewStaff } from './staff.mjs';
import { createBackup } from './ops.mjs';
import { brevoFailure, brevoKey, dailyLimit, dayMs, retryWindowMs } from './mail-policy.mjs';

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
const publicUrl = local ? 'http://127.0.0.1:' + port : (env.MASHUP_PUBLIC_URL || env.PUBLIC_URL || '').replace(/\/$/, '');
const exporting = process.argv[2] === 'export';
const backup = process.argv[2] === 'backup';
const preflight = process.argv[2] === 'preflight';
const oneShotJobs = process.argv[2] === 'jobs:drain';
const jobMode = env.JOB_MODE || 'inline';
if (!['inline', 'cron'].includes(jobMode)) throw new Error('Use JOB_MODE=inline or JOB_MODE=cron.');
const launchHold = env.LAUNCH_HOLD === '1';
const mailPaused = launchHold || env.MAIL_PAUSED === '1';
const mailNotices = env.MAIL_NOTICES || 'essential';
if (!['essential', 'all'].includes(mailNotices)) throw new Error('Use MAIL_NOTICES=essential or MAIL_NOTICES=all.');
const mailAll = mailNotices === 'all';
const sender = (env.BREVO_SENDER_EMAIL || '').trim();
const brevoConfigured = Boolean(env.BREVO_API_KEY && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender));
if (process.argv[2] === 'check-brevo') {
  if (!brevoConfigured) throw new Error('Set BREVO_API_KEY and BREVO_SENDER_EMAIL.');
  const response = await fetch('https://api.brevo.com/v3/senders', {
    headers: { 'api-key': env.BREVO_API_KEY, accept: 'application/json' },
    signal: AbortSignal.timeout(9000),
  });
  if (!response.ok) throw new Error('Brevo sender check failed with HTTP ' + response.status + '.');
  const result = await response.json();
  const active = result.senders?.some((entry) => entry.active === true && entry.email?.toLowerCase() === sender.toLowerCase());
  if (!active) throw new Error('The configured sender is not active in Brevo.');
  console.log('Brevo API key and active sender verified. No email was sent.');
  process.exit(0);
}
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
  ['BASIC_FEE', 'IPC_FEE', 'ANTIBIOTIC_FEE', 'BEYOND_FEE'].every((key) => env[key]) &&
  (launchHold || brevoConfigured) &&
  productionUrl && persistentPath && paymentConfigured && staff.length);
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
const activityConfirmationEmail = mailAll || Boolean(whatsapp);

const dir = resolve(demo ? env.DEMO_DATA_DIR || 'demo-data' : razorpayTest ? 'razorpay-test-data' : env.DATA_DIR || 'data');
if (preflight && local) throw new Error('Set DEMO=0 and RAZORPAY_TEST=0 to run the production preflight.');
const dbPath = join(dir, 'mashup.sqlite');
if ((backup || exporting || oneShotJobs) && !existsSync(dbPath)) {
  throw new Error('The event database was not found at the configured location.');
}
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
  CREATE TABLE IF NOT EXISTS payment_proofs (
    ref TEXT PRIMARY KEY REFERENCES manual_receipts(ref) ON DELETE CASCADE,
    mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp')),
    image BLOB NOT NULL
  );
  CREATE TABLE IF NOT EXISTS job_leases (
    name TEXT PRIMARY KEY, worker TEXT NOT NULL, expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mail_provider (
    name TEXT PRIMARY KEY, retry_at INTEGER NOT NULL, reason TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS registration_members (
    ref TEXT NOT NULL REFERENCES orders(ref), attendee INTEGER NOT NULL UNIQUE REFERENCES attendees(seq),
    PRIMARY KEY(ref,attendee)
  );
  CREATE TABLE IF NOT EXISTS activity_items (
    ref TEXT NOT NULL REFERENCES orders(ref), attendee INTEGER NOT NULL REFERENCES attendees(seq),
    activity TEXT NOT NULL, fee INTEGER NOT NULL, details TEXT,
    PRIMARY KEY(attendee,activity)
  );
  CREATE INDEX IF NOT EXISTS activity_items_ref ON activity_items(ref);
  CREATE VIEW IF NOT EXISTS summit_roster AS
    SELECT ref, owner AS attendee FROM orders WHERE product='summit'
    UNION ALL SELECT ref, attendee FROM registration_members;
`);
if (!db.prepare('PRAGMA table_info(mail)').all().some(({ name }) => name === 'send_provider')) {
  db.exec('ALTER TABLE mail ADD COLUMN send_provider TEXT');
}
installAdminSchema(db);
db.exec(`DELETE FROM mail WHERE sent IS NULL AND
  (id LIKE '%/received' OR id LIKE '%/correction-%'
    OR (id LIKE '%/registration-access-%' AND instr(body,char(10) || 'Registration ID: ')=0))`);
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
const isOpen = (name) => !launchHold && get('SELECT is_open FROM event_controls WHERE name=?', name)?.is_open !== 0;
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

function uid(seq) { return 'MMSHP-' + String(seq).padStart(3, '0'); }
function secret() { return randomBytes(24).toString('base64url'); }
function orderFor(seq, product) { return get('SELECT * FROM orders WHERE owner=? AND product=?', seq, product); }
function attendee(seq) { return get('SELECT * FROM attendees WHERE seq=?', seq); }
function basicOrderFor(seq) {
  return get('SELECT o.* FROM summit_roster s JOIN orders o ON o.ref=s.ref WHERE s.attendee=?', seq);
}
function newOrder(seq, product, amount) {
  run('INSERT INTO orders (ref,owner,product,amount,token) VALUES (?,?,?,?,?)',
    'MM26-' + randomBytes(12).toString('hex'), seq, product, amount, secret());
  return orderFor(seq, product);
}

const workshopFor = (id) => workshops.find((entry) => entry.id === id);
const orderLabel = (product) => product === 'summit' ? 'Basic Registration'
  : product.startsWith('activities:') ? 'Events & Workshops'
  : workshopFor(product)?.name || 'Activity registration';
const statusUrl = (order) => publicUrl + '/#payment=' + order.token;
const invitation = (person) => publicUrl + '/activities#access=' + person.invite;
function queue(order, template, subject, body, person = attendee(order.owner)) {
  run('INSERT OR IGNORE INTO mail (id,recipient,subject,body) VALUES (?,?,?,?)',
    order.ref + '/' + template, person.email, "Microbe Mashup ’26 | " + subject,
    'Hello ' + JSON.parse(person.details).name + ',\n\n' + body +
      '\n\nTeam Microbe Mashup ’26\nMamata Academy of Medical Sciences');
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
    const guidelines = '\n11–12 December 2026 · Mamata Academy of Medical Sciences, Bachupally, Hyderabad\n' +
      'Arrive 30 minutes before reporting time. Bring your college ID, registration ID and any materials required for your activities. ' +
      'Follow staff instructions and maintain professional conduct. Check @microbemashup for updates.\n';
    if (order.product === 'summit') {
      const people = all('SELECT a.* FROM summit_roster s JOIN attendees a ON a.seq=s.attendee WHERE s.ref=?', order.ref);
      for (const person of people) {
        queue(order, 'paid-' + person.seq, label + ' confirmed',
          'Your Basic Registration is confirmed.\nRegistration ID: ' + uid(person.seq) +
          '\n\nUse your Registration ID and this personal link to book Events & Workshops: ' + invitation(person) + '\n' +
          guidelines, person);
      }
      return;
    }
    if (!activityConfirmationEmail) return;
    const booked = all('SELECT activity FROM activity_items WHERE ref=? ORDER BY activity', order.ref)
      .map(({ activity }) => activities.find(({ id }) => id === activity)?.name).filter(Boolean);
    queue(order, 'paid', label + ' confirmed',
      label + ' payment is confirmed.\nRegistration ID: ' + uid(order.owner) +
      '\nAmount received: INR ' + order.amount / 100 + (booked.length ? '\nBooked: ' + booked.join(', ') + '\n' : '\n') +
      (whatsapp ? '\nOfficial Events & Workshops WhatsApp group: ' + whatsapp + '\n' : '') + guidelines);
}

function normalizeUtr(value) {
  const utr = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{8,30}$/.test(utr)) throw new InputError('Enter the UPI transaction reference from your banking app.');
  return utr;
}

const proofLimit = 3 * 1024 * 1024;

function readProof(value) {
  if (typeof value !== 'string' || !value) throw new InputError('Upload a screenshot of your UPI payment.');
  if (value.length > proofLimit * 4 / 3) throw new InputError('Upload a screenshot smaller than 3 MB.');
  const image = Buffer.from(value, 'base64');
  if (image.toString('base64') !== value) throw new InputError('Upload a valid payment screenshot.');
  if (image.length >= 24 && image.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' &&
      image.toString('ascii', 12, 16) === 'IHDR') return { mime: 'image/png', image };
  if (image.length >= 12 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff &&
      image.at(-2) === 0xff && image.at(-1) === 0xd9) return { mime: 'image/jpeg', image };
  if (image.length >= 20 && image.toString('ascii', 0, 4) === 'RIFF' &&
      image.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', image };
  throw new InputError('Upload a JPG, PNG or WebP screenshot.');
}

function submitReceipt(order, utr, proof) {
  atomic(() => {
    const current = get('SELECT state, link_id FROM orders WHERE ref=?', order.ref);
    if (current.state !== 'pending' || current.link_id) throw new InputError('This payment cannot accept a new reference.');
    const used = get('SELECT ref FROM manual_receipts WHERE utr=?', utr);
    if (used && used.ref !== order.ref) throw new InputError('This transaction reference is already in use. Check it or contact the organizers.');
    run(`INSERT INTO manual_receipts(ref, utr, submitted_at) VALUES(?,?,?)
      ON CONFLICT(ref) DO UPDATE SET utr=excluded.utr, submitted_at=excluded.submitted_at`, order.ref, utr, Date.now());
    run(`INSERT INTO payment_proofs(ref,mime,image) VALUES(?,?,?)
      ON CONFLICT(ref) DO UPDATE SET mime=excluded.mime,image=excluded.image`, order.ref, proof.mime, proof.image);
    run('DELETE FROM payment_reviews WHERE ref=?', order.ref);
  });
}

function verifyManual(ref, rawUtr, rawAmount, actor, submittedAt) {
  const amount = Number(rawAmount);
  const utr = normalizeUtr(rawUtr);
  if (!Number.isSafeInteger(amount) || amount < 1) throw new InputError('Enter the whole-rupee amount received.');
  return atomic(() => {
    const order = get(`SELECT o.*, r.utr, r.submitted_at FROM orders o JOIN manual_receipts r ON r.ref=o.ref WHERE o.ref=?`, ref);
    if (!order || order.link_id || order.utr !== utr || order.amount !== amount * 100 ||
        (submittedAt !== undefined && order.submitted_at !== submittedAt)) {
      throw new InputError('Order reference, submitted UPI reference, or exact amount did not match.');
    }
    if (order.state === 'paid') return 'Payment was already verified.';
    if (order.state !== 'pending') throw new InputError('This order cannot be verified.');
    recordConfirmation(order);
    audit('payment-verified', order.ref, utr + ' · INR ' + amount, actor);
    return order.product === 'summit' || activityConfirmationEmail
      ? 'Payment verified. The confirmation email has been queued.'
      : 'Payment verified. The activity booking status has been updated.';
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
  // Brevo deduplicates the same batch key for 30 minutes. Do not retry uncertain sends from another provider.
  if (msg.first_attempt && (msg.send_provider !== 'brevo' || now - msg.first_attempt >= retryWindowMs)) {
    run('UPDATE mail SET error=?, next_attempt=? WHERE id=?',
      'Needs operator review before resend', Number.MAX_SAFE_INTEGER, msg.id);
    return;
  }
  run("UPDATE mail SET send_provider='brevo',first_attempt=COALESCE(first_attempt,?),next_attempt=? WHERE id=?",
    now, now + 60000, msg.id);
  if (local) {
    appendFileSync(join(dir, 'outbox.jsonl'), JSON.stringify({
      to: msg.recipient, subject: msg.subject, text: msg.body,
    }) + '\n');
  } else {
    const result = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: env.BREVO_SENDER_NAME || 'Microbe Mashup ’26', email: sender },
        replyTo: { email: env.REPLY_TO || 'mams.microbemashup@gmail.com' },
        subject: msg.subject, textContent: msg.body,
        messageVersions: [{ to: [{ email: msg.recipient }] }],
        headers: { idempotencyKey: brevoKey(msg.id, msg.first_attempt || now) },
      }),
      signal: AbortSignal.timeout(9000),
    });
    if (!result.ok) {
      const provider = await result.json().catch(() => null);
      if (msg.first_attempt && provider?.code === 'duplicate_parameter' && /idempotency/i.test(provider.message || '')) {
        run('UPDATE mail SET sent=?,error=NULL WHERE id=?', Date.now(), msg.id);
        return false;
      }
      const failure = brevoFailure(result.status, provider?.code, result.headers.get('retry-after') ||
        result.headers.get('x-sib-ratelimit-reset'), Date.now());
      // An explicit rejection proves only this request was not sent. Preserve any earlier ambiguous attempt.
      run('UPDATE mail SET error=?, next_attempt=?, first_attempt=? WHERE id=?', failure.error, failure.retryAt,
        failure.definitivelyRejected && !msg.first_attempt ? null : msg.first_attempt || now, msg.id);
      if (failure.pauseQueue) run(`INSERT INTO mail_provider(name,retry_at,reason) VALUES('brevo',?,?)
        ON CONFLICT(name) DO UPDATE SET retry_at=excluded.retry_at,reason=excluded.reason`, failure.retryAt, failure.error);
      return failure.pauseQueue;
    }
  }
  run('UPDATE mail SET sent=?, error=NULL WHERE id=?', Date.now(), msg.id);
}

let working = false;
let stopping = false;
async function work() {
  if (working || stopping) return;
  working = true;
  const worker = secret();
  let leased = false;
  const started = Date.now();
  const deadline = started + 50000;
  try {
    const claim = run(`INSERT INTO job_leases(name,worker,expires) VALUES('outbox',?,?)
      ON CONFLICT(name) DO UPDATE SET worker=excluded.worker, expires=excluded.expires
      WHERE job_leases.expires<=?`, worker, started + 90000, started);
    if (!claim.changes) return;
    leased = true;
    if (!demo && !manual) {
      const pending = all(`SELECT * FROM orders WHERE state='pending' AND link_id IS NOT NULL
        AND last_checked < ? ORDER BY last_checked LIMIT 60`, Date.now() - 45000);
      for (let i = 0; i < pending.length; i += 5) {
        if (stopping || Date.now() >= deadline) return;
        await Promise.allSettled(pending.slice(i, i + 5).map(refresh));
      }
    }
    if (mailPaused || get("SELECT retry_at FROM mail_provider WHERE name='brevo'")?.retry_at > Date.now()) return;
    const messages = all(`SELECT * FROM mail WHERE sent IS NULL AND next_attempt <= ?
      ORDER BY CASE WHEN id LIKE '%/paid%' OR id LIKE '%-access-%' THEN 0 ELSE 1 END,rowid LIMIT 90`, Date.now());
    for (const msg of messages) {
      if (stopping || Date.now() >= deadline) return;
      if (!local) {
        const { count, oldest } = get('SELECT COUNT(*) AS count,MIN(sent) AS oldest FROM mail WHERE sent>?', Date.now() - dayMs);
        if (count >= dailyLimit) {
          run(`INSERT INTO mail_provider(name,retry_at,reason) VALUES('brevo',?,'Daily sending budget reached')
            ON CONFLICT(name) DO UPDATE SET retry_at=excluded.retry_at,reason=excluded.reason`, oldest + dayMs + 1000);
          return;
        }
      }
      try { if (await deliver(msg)) return; }
      catch {
        run('UPDATE mail SET error=? WHERE id=?', 'Email service request failed', msg.id);
        console.error('Email attempt failed for ' + msg.id);
      }
      if (!local) await delay(150);
    }
  } finally {
    try { if (leased) run("DELETE FROM job_leases WHERE name='outbox' AND worker=?", worker); }
    finally { working = false; }
  }
}

if (oneShotJobs) {
  try { await work(); }
  finally { db.close(); }
  process.exit(0);
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function read(req, limit = 16384) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new InputError('Expected JSON.');
  if (Number(req.headers['content-length']) > limit) throw new InputError('Submission is too large.');
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new InputError('Submission is too large.');
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
  if (!person || basicOrderFor(person.seq)?.state !== 'paid') {
    throw new InputError('Open the personal link from your confirmed Basic Registration email.');
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
  const basic = order.product === 'summit';
  const confirmedBasic = basic && order.state === 'paid';
  const utr = manualOrder ? get('SELECT utr FROM manual_receipts WHERE ref=?', order.ref)?.utr ?? null : null;
  const reviewMessage = manualOrder ? rejectionReasons[get('SELECT reason FROM payment_reviews WHERE ref=?', order.ref)?.reason] || null : null;
  const payable = !launchHold && manualOrder && order.state === 'pending' && !utr && !reviewMessage;
  return {
    participantId: !basic || confirmedBasic ? uid(order.owner) : null, product: order.product, label: orderLabel(order.product),
    partySize: basic ? get('SELECT COUNT(*) AS count FROM summit_roster WHERE ref=?', order.ref).count : 1,
    items: all('SELECT activity FROM activity_items WHERE ref=? ORDER BY activity', order.ref).map(({ activity }) => activity),
    amount: order.amount / 100, state: order.state,
    checkout: !demo && order.state === 'pending' ? order.link_url : null,
    token: order.token,
    manual: manualOrder,
    orderReference: manualOrder ? order.ref : null,
    utr, reviewMessage,
    paymentDetails: payable ? { upiId, payee, hasQr: Boolean(qr) } : null,
    workshopToken: confirmedBasic ? attendee(order.owner).invite : null,
  };
}

function importPaid(file, sendInvites) {
  if (!file) throw new Error('Provide the path to a verified paid roster JSON file.');
  const rows = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(rows) || !rows.length) throw new Error('The roster must be a non-empty JSON array.');
  return atomic(() => {
    let imported = 0;
    for (const row of rows) {
      const id = normalizeRegistrationId(row.attendeeId);
      const rawId = /^MMSHP-(\d{3,8})$/.exec(id);
      const seq = Number(rawId?.[1]);
      const email = emailAddress(row.email);
      const name = typeof row.name === 'string' ? row.name.trim().toUpperCase() : '';
      if (!Number.isSafeInteger(seq) || seq < 1 || uid(seq) !== id || !name ||
          name.length > 120 || /[\u0000-\u001f\u007f]/.test(name) ||
          !Number.isSafeInteger(row.amountPaise) || row.amountPaise < 1 || !batches.some(({ id }) => id === row.batch)) {
        throw new Error('Each row needs the original attendee ID, name, email, batch and verified amount in paise.');
      }
      const existing = get('SELECT * FROM attendees WHERE email=? OR seq=?', email, seq);
      let order;
      if (existing) {
        order = basicOrderFor(seq);
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
        queue(order, 'import-invite', 'Your Events & Workshops link', 'Your Basic Registration payment is already verified.\n' +
          'Registration ID: ' + uid(seq) + '\n' + 'Book Events & Workshops: ' + invitation(attendee(seq)));
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
  const { people, amount } = registration(body);
  return atomic(() => {
    if (!isOpen('summit')) throw new InputError('Summit registration is paused. Existing registrations can still be paid.');
    if (people.some(({ email }) => get('SELECT 1 FROM attendees WHERE email=?', email))) return null;
    const ids = people.map((details) => run('INSERT INTO attendees (email,details,invite,created) VALUES (?,?,?,?)',
      details.email, JSON.stringify(details), secret(), Date.now()).lastInsertRowid);
    const order = newOrder(ids[0], 'summit', amount);
    for (const id of ids.slice(1)) run('INSERT INTO registration_members(ref,attendee) VALUES (?,?)', order.ref, id);
    return order;
  });
}

function activityAttendee(req, registrationId) {
  const person = authorizedAttendee(req);
  if (normalizeRegistrationId(registrationId) !== uid(person.seq)) {
    throw new InputError('Enter the Registration ID from the email that contains this link.');
  }
  return person;
}

function bookedActivities(person) {
  const orders = all("SELECT * FROM orders WHERE owner=? AND product<>'summit' AND state IN ('pending','paid')", person.seq);
  const legacy = JSON.parse(person.details).events || [];
  return {
    legacy,
    orders: orders.map((order) => {
      const payment = summary(order);
      return { ...payment, items: payment.items.length ? payment.items : [order.product] };
    }),
  };
}

function beginActivities(req, body) {
  const person = activityAttendee(req, body.registrationId);
  const { items, team } = activitySelection(body, JSON.parse(person.details));
  return atomic(() => {
    const prior = bookedActivities(person);
    const requested = items.map(({ id }) => id);
    const repeat = prior.orders.find((order) => order.items.length === requested.length && requested.every((id) => order.items.includes(id)));
    if (repeat) return repeat.token;
    if (!isOpen('workshops')) throw new InputError('New activity bookings are paused. Existing orders can still be paid.');
    if (requested.some((id) => prior.legacy.includes(id) || prior.orders.some((order) => order.items.includes(id)))) {
      throw new InputError('An activity in this selection is already booked. Refresh to view your bookings.');
    }
    // Expired or cancelled Razorpay links release their activity claims before a new order is created.
    run("DELETE FROM activity_items WHERE attendee=? AND ref IN (SELECT ref FROM orders WHERE owner=? AND state IN ('expired','cancelled'))", person.seq, person.seq);
    const order = newOrder(person.seq, 'activities:' + secret().slice(0, 16), items.reduce((sum, item) => sum + item.fee * 100, 0));
    for (const item of items) {
      run('INSERT INTO activity_items(ref,attendee,activity,fee,details) VALUES(?,?,?,?,?)',
        order.ref, person.seq, item.id, item.fee * 100, item.id === 'mayhem' ? JSON.stringify(team) : null);
    }
    return order.token;
  });
}

function sendActivityAccess(body) {
  const email = emailAddress(body.email);
  const id = normalizeRegistrationId(body.registrationId);
  const person = /^MMSHP-\d{3,8}$/.test(id) && get('SELECT * FROM attendees WHERE email=?', email);
  if (!person || uid(person.seq) !== id) return;
  const order = basicOrderFor(person.seq);
  if (order?.state !== 'paid') return;
  queue(order, 'activity-access-' + person.seq + '-' + Math.floor(Date.now() / (15 * 60000)), 'Your Events & Workshops link',
    'Registration ID: ' + id + '\n\nOpen your personal booking link: ' + invitation(person), person);
}

function sendRegistrationAccess(body) {
  const email = emailAddress(body.email);
  const person = get('SELECT * FROM attendees WHERE email=?', email);
  if (!person) return;
  const order = basicOrderFor(person.seq);
  if (order?.state !== 'paid') return;
  const template = 'registration-access-' + person.seq + '-' + Math.floor(Date.now() / (15 * 60000));
  queue(order, template, 'Recover your Basic Registration',
    'Registration ID: ' + uid(person.seq) + '\n\nOpen Events & Workshops: ' + invitation(person), person);
}

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ...['/basic-registration', '/activities', '/brochure', '/location'].map((path) => [path, ['index.html', 'text/html; charset=utf-8']]),
  ['/site.css', ['site.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/admin', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin.css', ['admin.css', 'text/css; charset=utf-8']],
  ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']],
  ['/event-logo.webp', ['event-logo.webp', 'image/webp']],
  ['/event-logo-transparent.webp', ['event-logo-transparent.webp', 'image/webp']],
  ['/college-logo.webp', ['college-logo.webp', 'image/webp']],
  ['/assets/summit/site-css', ['site.css', 'text/css; charset=utf-8']],
  ['/assets/summit/registration-script', ['app.js', 'text/javascript; charset=utf-8']],
  ['/assets/summit/admin-css', ['admin.css', 'text/css; charset=utf-8']],
  ['/assets/summit/admin-script', ['admin.js', 'text/javascript; charset=utf-8']],
  ['/assets/summit/event-mark', ['event-logo-transparent.webp', 'image/webp']],
  ['/assets/summit/college-mark', ['college-logo.webp', 'image/webp']],
  ['/assets/summit/college-crest', ['college-logo-transparent.webp', 'image/webp']],
]);
const headers = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'self'; img-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; frame-src https://maps.google.com https://www.google.com",
};
const brochure = new URL('./public/summit-brochure.pdf', import.meta.url);
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
  orderLabel, verifyManual, audit, mailPaused, launchHold });

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
    if (method === 'GET' && ['/payment-qr', '/payment-qr.png'].includes(pathname)) {
      const payment = summary(authorizedOrder(req));
      if (!payment.paymentDetails?.hasQr) return json(res, 404, { error: 'This payment does not have a QR code.' });
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(qr);
    }
    if (method === 'GET' && ['/brochure-document', '/summit-brochure.pdf'].includes(pathname) && existsSync(brochure)) {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="summit-brochure.pdf"' });
      return res.end(readFileSync(brochure));
    }
    if (method === 'GET' && pathname === '/api/catalog') {
      return json(res, 200, { demo, razorpayTest, manual, activityConfirmationEmail, basicFee, basicRates, batches, events, states, workshops,
        hasBrochure: existsSync(brochure), activitiesOpen: isOpen('workshops'), summitOpen: isOpen('summit'), launchHold });
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
    if (method === 'POST' && pathname === '/api/activities/access') {
      if (!allowRegistration(req)) return json(res, 429, { error: 'Too many attempts. Try again in one minute.' });
      sendActivityAccess(await read(req));
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && pathname === '/api/register/access') {
      if (!allowRegistration(req)) return json(res, 429, { error: 'Too many attempts. Try again in one minute.' });
      sendRegistrationAccess(await read(req));
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && pathname === '/api/activities/unlock') {
      const { registrationId } = await read(req);
      const person = activityAttendee(req, registrationId);
      return json(res, 200, { batch: JSON.parse(person.details).batch, activitiesOpen: isOpen('workshops'), ...bookedActivities(person) });
    }
    if (method === 'POST' && pathname === '/api/activities') {
      return json(res, 200, { token: beginActivities(req, await read(req)) });
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
      const body = await read(req, proofLimit * 4 / 3 + 1024);
      submitReceipt(order, normalizeUtr(body.utr), readProof(body.screenshot));
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
const poller = jobMode === 'inline'
  ? setInterval(() => work().catch(() => console.error('Background processing failed.')), 15000)
  : null;
poller?.unref();

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
