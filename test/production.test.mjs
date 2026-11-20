import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const origin = 'https://register.example.test';
const node = process.execPath;
const attendee = {
  name: 'Test Attendee', phone: '9876543210', batch: 'bds24', state: 'Telangana',
  city: 'Hyderabad', college: 'Test College', collegeCity: 'Hyderabad', pincode: '500090',
  meal: 'Veg', consent: true, events: [],
};

async function availablePort() {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  return port;
}

function run(args, env = process.env) {
  return execFileSync(node, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function boot(env, onExit) {
  const port = await availablePort();
  const child = spawn(node, ['server.mjs'], { env: { ...env, PORT: String(port) } });
  const exited = once(child, 'exit');
  onExit(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  let errors = '';
  child.stderr.on('data', (data) => { errors += data; });
  const url = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Server did not start: ' + errors);
    try { if ((await fetch(url + '/healthz')).ok) return url; } catch {}
    await delay(75);
  }
  throw new Error('Health probe timed out: ' + errors);
}

function api(base, { cookie, token, ip = '198.51.100.2' } = {}) {
  return async (route, status, body, overrides = {}) => {
    const headers = { 'x-forwarded-for': ip, ...overrides };
    if (cookie) headers.cookie = cookie;
    if (token) headers.authorization = 'Bearer ' + token;
    if (body !== undefined) Object.assign(headers, { 'content-type': 'application/json', origin: origin, ...overrides });
    const res = await fetch(base + '/api/' + route, {
      method: body === undefined ? 'GET' : 'POST', headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json();
    assert.equal(res.status, status, route + ' returned ' + JSON.stringify(data));
    return { data, headers: res.headers };
  };
}

test('production roles, 525 registrations, full UPI flow, rate limits, backup and restore', { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'mashup-production-'));
  const cleanup = [];
  try {
    const staffFile = join(root, 'staff.json');
    const accounts = {};
    for (const [user, role] of [['event-owner', 'owner'], ['reviewer', 'payments'], ['front-desk', 'checkin']]) {
      const result = run(['staff.mjs', 'create', user, role, staffFile]);
      const password = /Copy this passphrase now: ([A-Za-z0-9_-]+)/.exec(result)?.[1];
      assert.ok(password);
      accounts[user] = password;
    }
    const env = {
      ...process.env, DEMO: '0', RAZORPAY_TEST: '0', MAIL_PAUSED: '1', TRUST_LOOPBACK_PROXY: '1',
      LAUNCH_HOLD: '0', MASHUP_ENV_FILE: '',
      PRICES_CONFIRMED: 'true', STAFF_FILE: staffFile, PUBLIC_URL: origin, DATA_DIR: join(root, 'live'),
      BASIC_FEE: '800', IPC_FEE: '2500', ANTIBIOTIC_FEE: '2200', BEYOND_FEE: '4999',
      PAYMENT_MODE: 'manual', MANUAL_UPI_ID: 'test@example', MANUAL_PAYEE: 'QA only', MANUAL_QR_FILE: '',
      RESEND_API_KEY: 'unused-test-key', MAIL_FROM: 'Event Test <mail@example.test>', WHATSAPP_URL: '',
    };
    assert.throws(() => run(['server.mjs', 'preflight'], { ...env, PRICES_CONFIRMED: 'false' }));
    assert.throws(() => run(['server.mjs', 'preflight'], { ...env, STAFF_FILE: '', ADMIN_PASSWORD: 'shared-password-is-not-supported' }));
    assert.match(run(['server.mjs', 'preflight'], env), /Production settings and SQLite verified/);
    const base = await boot(env, (fn) => cleanup.push(fn));
    const guest = api(base);

    async function signIn(user, expectedRole, target = base) {
      const { headers } = await api(target)('admin/login', 200, { user, password: accounts[user] });
      const raw = headers.get('set-cookie');
      assert.match(raw, /^__Host-mashup_admin=.*; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
      const loggedIn = api(target, { cookie: raw.split(';')[0] });
      assert.equal((await loggedIn('admin/overview', 200)).data.role, expectedRole);
      return loggedIn;
    }

    await guest('admin/export', 401);
    await guest('admin/login', 403, { user: 'event-owner', password: accounts['event-owner'] }, { origin: 'https://other.example.test' });
    const owner = await signIn('event-owner', 'owner');
    const finance = await signIn('reviewer', 'payments');
    const frontDesk = await signIn('front-desk', 'checkin');
    await finance('admin/export', 403);
    await finance('admin/mail', 403);
    await finance('admin/controls', 403, { name: 'summit', open: false });
    await frontDesk('admin/audit', 403);
    await frontDesk('admin/export', 403);

    const config = join(root, 'runtime.env');
    writeFileSync(config, 'LAUNCH_HOLD=1\n', { mode: 0o600 });
    const { LAUNCH_HOLD, ...holdConfig } = env;
    const hold = await boot({ ...holdConfig, MASHUP_ENV_FILE: config, RESEND_API_KEY: '', MAIL_FROM: '',
      DATA_DIR: join(root, 'launch-hold') }, (fn) => cleanup.push(fn));
    const holding = api(hold);
    const { data: heldCatalog } = await holding('catalog', 200);
    assert.equal(heldCatalog.launchHold, true);
    assert.equal(heldCatalog.summitOpen, false);
    assert.equal(heldCatalog.upiId, '');
    await holding('register', 400, { ...attendee, email: 'hold@example.test' });
    const holdOwner = await signIn('event-owner', 'owner', hold);
    await holdOwner('admin/controls', 400, { name: 'summit', open: true });

    await owner('admin/controls', 200, { name: 'summit', open: false });
    await guest('register', 400, { ...attendee, email: 'sample@example.test' });
    await owner('admin/controls', 200, { name: 'summit', open: true });
    let firstToken;
    for (let i = 0; i < 525; i += 25) {
      const sizes = Array.from({ length: Math.min(25, 525 - i) }, (_, j) => i + j);
      const rows = await Promise.all(sizes.map((n) => api(base, { ip: '203.0.113.' + (n % 12 + 1) })('register', 200,
        { ...attendee, email: 'qa' + n + '@example.test' })));
      if (i === 0) firstToken = rows[0].data.token;
      assert.ok(rows.every((row) => row.data.token));
    }
    const person = api(base, { token: firstToken });
    const { data: manual } = await person('payment/reference', 200, { utr: '111122223333' });
    assert.equal(manual.state, 'pending');
    assert.equal((await frontDesk('admin/orders?view=all', 200)).data.total, 0);
    const ref = manual.orderReference;
    const payment = { ref, utr: manual.utr, amount: 800, matched: true };
    await frontDesk('admin/verify', 403, payment);
    await finance('admin/verify', 400, { ...payment, amount: 799 });
    await finance('admin/reject', 200, { ref, utr: manual.utr, reason: 'not-found' });
    assert.match((await person('payment', 200)).data.reviewMessage, /could not find/);
    await person('payment/reference', 200, { utr: '111122223334' });
    await finance('admin/verify', 400, payment);
    await finance('admin/verify', 200, { ...payment, utr: '111122223334' });
    assert.match((await finance('admin/verify', 200, { ...payment, utr: '111122223334' })).data.message, /already verified/);
    const paid = (await person('payment', 200)).data;
    assert.equal(paid.state, 'paid');
    const checkInList = (await frontDesk('admin/orders?view=all', 200)).data.rows;
    assert.equal(checkInList.length, 1);
    assert.equal(checkInList[0].attendeeId, paid.participantId);
    assert.ok(!('email' in checkInList[0]) && !('utr' in checkInList[0]) && !('amount' in checkInList[0]));
    await finance('admin/check-in', 403, { ref, checkedIn: true });
    await frontDesk('admin/check-in', 200, { ref, checkedIn: true });
    const ws = api(base, { token: paid.workshopToken });
    await owner('admin/controls', 200, { name: 'workshops', open: false });
    await ws('workshops', 400, { product: 'ipc' });
    await owner('admin/controls', 200, { name: 'workshops', open: true });
    const workshop = (await ws('workshops', 200, { product: 'ipc' })).data;
    const workshopStatus = api(base, { token: workshop.token });
    await workshopStatus('payment/reference', 400, { utr: '111122223334' });
    const workshopReceipt = (await workshopStatus('payment/reference', 200, { utr: '111122223335' })).data;
    await finance('admin/verify', 200, { ref: workshopReceipt.orderReference, utr: workshopReceipt.utr, amount: 2500, matched: true });

    const audit = (await owner('admin/audit', 200)).data.entries;
    assert.ok(audit.some((entry) => entry.action === 'payment-verified' && entry.actor === 'reviewer'));
    assert.ok(audit.some((entry) => entry.action === 'check-in' && entry.actor === 'front-desk'));
    const roster = (await owner('admin/export', 200)).data;
    assert.equal(new Set(roster.map(({ attendeeId }) => attendeeId)).size, 525);
    assert.equal(roster.filter(({ state }) => state === 'paid').length, 2);
    assert.ok(!JSON.stringify(roster).includes(paid.workshopToken));

    const throttle = api(base, { ip: '192.0.2.10' });
    await Promise.all(Array.from({ length: 60 }, () => throttle('register', 400, {})));
    assert.equal((await throttle('register', 429, {})).headers.get('retry-after'), '60');

    const snapshot = join(root, 'backup.sqlite');
    assert.match(run(['server.mjs', 'backup', snapshot], env), /attendees: 525/);
    assert.match(run(['ops.mjs', snapshot]), /orders: 526/);
    const restore = join(root, 'restore');
    mkdirSync(restore);
    copyFileSync(snapshot, join(restore, 'mashup.sqlite'));
    const restored = await boot({ ...env, DATA_DIR: restore }, (fn) => cleanup.push(fn));
    const verified = await signIn('event-owner', 'owner', restored);
    const overview = (await verified('admin/overview', 200)).data;
    assert.equal(overview.registrations, 525);
    assert.equal(overview.summitPaid, 1);
    assert.equal(overview.workshopPaid, 1);
    assert.equal(overview.checkedIn, 1);
    assert.equal(overview.mailPaused, true);
    await frontDesk('admin/logout', 200, {});
    await frontDesk('admin/orders', 401);
  } finally {
    for (const stop of cleanup) await stop();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('mashup-production-'));
    rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
});

test('cron mode sends queued demo email once across overlapping processes', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'mashup-cron-'));
  let stop;
  try {
    const env = {
      ...process.env, DEMO: '1', RAZORPAY_TEST: '0', PAYMENT_MODE: 'manual',
      JOB_MODE: 'cron', DEMO_DATA_DIR: root, STAFF_FILE: '', ADMIN_PASSWORD: '',
      MAIL_PAUSED: '0', WHATSAPP_URL: '', LAUNCH_HOLD: '0', MASHUP_ENV_FILE: '',
    };
    const base = await boot(env, (fn) => { stop = fn; });
    const reply = await fetch(base + '/api/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ ...attendee, email: 'cron-test@example.test' }),
    });
    assert.equal(reply.status, 200);
    const outbox = join(root, 'outbox.jsonl');
    assert.ok(!existsSync(outbox));
    const runWorker = () => promisify(execFile)(node, ['server.mjs', 'jobs:drain'], { env });
    await Promise.all([runWorker(), runWorker(), runWorker()]);
    const messages = readFileSync(outbox, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].to, 'cron-test@example.test');
    assert.match(messages[0].subject, /registration received/i);
  } finally {
    if (stop) await stop();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('mashup-cron-'));
    rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
});
