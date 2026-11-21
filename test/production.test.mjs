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
import { pathToFileURL } from 'node:url';
import { brevoFailure } from '../mail-policy.mjs';
import { registrationEmail } from '../mail-template.mjs';

const origin = 'https://register.example.test';
const screenshot = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aeykAAAAASUVORK5CYII=';
const node = process.execPath;
const attendee = {
  name: 'Test Attendee', phone: '9876543210', batch: 'bds24', state: 'Telangana',
  city: 'Hyderabad', college: 'Test College', collegeCity: 'Hyderabad', pincode: '500090',
  meal: 'Veg', consent: true, events: [],
};

test('Brevo backoff respects credit limits and rate-limit headers', () => {
  const now = Date.UTC(2026, 10, 30, 22, 15);
  assert.equal(brevoFailure(402, 'not_enough_credits', null, now).retryAt, now + 3600000);
  assert.equal(brevoFailure(429, '', '3', now).retryAt, now + 3000);
  assert.ok(brevoFailure(403, '', null, now).pauseQueue);
  assert.equal(brevoFailure(503, '', null, now).definitivelyRejected, false);
});

test('verification email template renders safe booking and WhatsApp actions', () => {
  const booking = origin + '/activities#access=' + 'A'.repeat(32);
  const whatsapp = 'https://chat.whatsapp.com/TestGroupOnly';
  const body = 'Hello <Attendee>,\nRegistration ID: MMSHP-123\nOpen your personal booking link: ' + booking +
    '\nOfficial Events & Workshops WhatsApp group: ' + whatsapp;
  const markup = registrationEmail({ subject: 'Microbe Mashup | Booking confirmed', body }, origin);
  assert.match(markup, /Booking confirmed/);
  assert.match(markup, /MMSHP-123/);
  assert.match(markup, /Hello &lt;Attendee&gt;/);
  assert.ok(markup.includes('href="' + booking + '"'));
  assert.ok(markup.includes('href="' + whatsapp + '"'));
  assert.doesNotMatch(registrationEmail({ subject: 'Test', body: 'Booking: https://other.example.test/' }, origin), /<a href=/);
});

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
    const testQr = join(root, 'test-qr.png');
    writeFileSync(testQr, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64'));
    const accounts = {};
    for (const [user, role] of [['event-owner', 'owner'], ['reviewer', 'payments'], ['front-desk', 'checkin']]) {
      const result = run(['staff.mjs', 'create', user, role, staffFile]);
      const password = /Copy this passphrase now: ([A-Za-z0-9_-]+)/.exec(result)?.[1];
      assert.ok(password);
      accounts[user] = password;
    }
    const env = {
      ...process.env, DEMO: '0', RAZORPAY_TEST: '0', MAIL_PAUSED: '1', TRUST_LOOPBACK_PROXY: '1',
      LAUNCH_HOLD: '0', MASHUP_ENV_FILE: '', MASHUP_PUBLIC_URL: '',
      PRICES_CONFIRMED: 'true', STAFF_FILE: staffFile, PUBLIC_URL: origin, DATA_DIR: join(root, 'live'),
      BASIC_FEE: '800', IPC_FEE: '2500', ANTIBIOTIC_FEE: '2200', BEYOND_FEE: '4999',
      PAYMENT_MODE: 'manual', MANUAL_UPI_ID: 'test@example', MANUAL_PAYEE: 'QA only', MANUAL_QR_FILE: testQr,
      BREVO_API_KEY: 'unused-test-key', BREVO_SENDER_EMAIL: 'mail@example.test', MAIL_NOTICES: 'all', WHATSAPP_URL: '',
    };
    assert.throws(() => run(['server.mjs', 'preflight'], { ...env, PRICES_CONFIRMED: 'false' }));
    assert.throws(() => run(['server.mjs', 'preflight'], { ...env, STAFF_FILE: '', ADMIN_PASSWORD: 'shared-password-is-not-supported' }));
    assert.match(run(['server.mjs', 'preflight'], env), /Production settings and SQLite verified/);
    const base = await boot(env, (fn) => cleanup.push(fn));
    const guest = api(base);
    const publicRoutes = ['/basic-registration', '/activities', '/location', '/brochure'];
    for (const route of publicRoutes) assert.match(await (await fetch(base + route)).text(), /Registration Guidelines/);
    for (const [asset, type] of [['site-css', 'text/css'], ['registration-script', 'text/javascript'], ['event-mark', 'image/webp']]) {
      const response = await fetch(base + '/assets/summit/' + asset);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get('content-type').startsWith(type));
      await response.arrayBuffer();
    }

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
    writeFileSync(config, 'LAUNCH_HOLD=1\nMASHUP_PUBLIC_URL=' + origin + '\n', { mode: 0o600 });
    const { LAUNCH_HOLD, MASHUP_PUBLIC_URL, ...holdConfig } = env;
    const hold = await boot({ ...holdConfig, PUBLIC_URL: 'https://host-injected.example.test',
      MASHUP_ENV_FILE: config, BREVO_API_KEY: '', BREVO_SENDER_EMAIL: '',
      DATA_DIR: join(root, 'launch-hold') }, (fn) => cleanup.push(fn));
    const holding = api(hold);
    const { data: heldCatalog } = await holding('catalog', 200);
    assert.equal(heldCatalog.launchHold, true);
    assert.equal(heldCatalog.summitOpen, false);
    assert.ok(!('upiId' in heldCatalog));
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
    assert.ok(!('upiId' in (await guest('catalog', 200)).data));
    assert.equal((await fetch(base + '/payment-qr')).status, 400);
    const initialOrder = (await person('payment', 200)).data;
    assert.equal(initialOrder.paymentDetails.upiId, 'test@example');
    assert.equal(initialOrder.paymentDetails.hasQr, true);
    const qr = await fetch(base + '/payment-qr', { headers: { authorization: 'Bearer ' + firstToken } });
    assert.equal(qr.status, 200);
    assert.deepEqual(Buffer.from(await qr.arrayBuffer()), readFileSync(testQr));
    await person('payment/reference', 400, { utr: '111122223333' });
    await person('payment/reference', 400, { utr: '111122223333', screenshot: Buffer.from('<svg/>').toString('base64') });
    const { data: manual } = await person('payment/reference', 200, { utr: '111122223333', screenshot });
    assert.equal(manual.state, 'pending');
    assert.equal(manual.paymentDetails, null);
    assert.equal((await fetch(base + '/payment-qr', { headers: { authorization: 'Bearer ' + firstToken } })).status, 404);
    assert.equal((await frontDesk('admin/orders?view=all', 200)).data.total, 0);
    const ref = manual.orderReference;
    const proofRoute = 'admin/payment-proof?ref=' + ref;
    await guest(proofRoute, 401);
    await frontDesk(proofRoute, 403);
    const reviewerLogin = await guest('admin/login', 200, { user: 'reviewer', password: accounts.reviewer });
    const proof = await fetch(base + '/api/' + proofRoute, { headers: { cookie: reviewerLogin.headers.get('set-cookie').split(';')[0] } });
    assert.equal(proof.status, 200);
    assert.equal(proof.headers.get('content-type'), 'image/png');
    assert.match(proof.headers.get('cache-control'), /no-store/);
    assert.deepEqual(Buffer.from(await proof.arrayBuffer()), Buffer.from(screenshot, 'base64'));
    const payment = { ref, utr: manual.utr, amount: 800, matched: true };
    await frontDesk('admin/verify', 403, payment);
    await finance('admin/verify', 400, { ...payment, amount: 799 });
    await finance('admin/reject', 200, { ref, utr: manual.utr, reason: 'not-found' });
    assert.match((await person('payment', 200)).data.reviewMessage, /could not find/);
    await finance(proofRoute, 404);
    await person('payment/reference', 200, { utr: '111122223334', screenshot });
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
    await ws('activities', 400, { items: ['ipc'], registrationId: paid.participantId });
    await owner('admin/controls', 200, { name: 'workshops', open: true });
    const workshop = (await ws('activities', 200, { items: ['ipc'], registrationId: paid.participantId })).data;
    const workshopStatus = api(base, { token: workshop.token });
    await workshopStatus('payment/reference', 400, { utr: '111122223334', screenshot });
    const workshopReceipt = (await workshopStatus('payment/reference', 200, { utr: '111122223335', screenshot })).data;
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

    const providerMock = join(root, 'provider-mock.mjs');
    const requestLog = join(root, 'provider-requests.log');
    writeFileSync(providerMock, `import { appendFileSync } from 'node:fs';
      globalThis.fetch = async (url, request) => {
        if (request.headers['api-key'] !== 'unused-test-key') throw new Error('Missing test key');
        if (url === 'https://api.brevo.com/v3/senders') {
          return Response.json({ senders: [{ active: true, email: 'mail@example.test' }] });
        }
        if (url !== 'https://api.brevo.com/v3/smtp/email') throw new Error('Unexpected network request');
        const payload = JSON.parse(request.body);
        if (payload.sender.email !== 'mail@example.test' ||
            !payload.messageVersions[0].to[0].email.endsWith('@example.test') ||
            !payload.htmlContent.includes('<!doctype html>') || !payload.textContent ||
            !/^[0-9a-f-]{36}$/.test(payload.headers.idempotencyKey)) throw new Error('Invalid Brevo payload');
        appendFileSync(process.env.MOCK_REQUEST_LOG, 'attempt\\n');
        return Response.json({ code: 'not_enough_credits' }, { status: 402 });
      };`);
    const mockEnv = { ...env, MAIL_PAUSED: '0', MOCK_REQUEST_LOG: requestLog };
    const worker = ['--import', pathToFileURL(providerMock).href, 'server.mjs', 'jobs:drain'];
    assert.match(run([...worker.slice(0, -1), 'check-brevo'], mockEnv), /No email was sent/);
    run(worker, mockEnv);
    run(worker, mockEnv);
    assert.equal(readFileSync(requestLog, 'utf8'), 'attempt\n');
    const outbox = (await owner('admin/mail', 200)).data;
    assert.match(outbox.provider.reason, /credits/);
    assert.equal(outbox.entries[0].first_attempt, null);
    assert.equal(outbox.entries[0].canRetry, 1);

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

test('group passes issue individual IDs and activity checkout uses the correct identity', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'mashup-group-'));
  let stop;
  try {
    const env = { ...process.env, DEMO: '1', RAZORPAY_TEST: '0', PAYMENT_MODE: 'manual',
      JOB_MODE: 'cron', DEMO_DATA_DIR: root, STAFF_FILE: '', ADMIN_PASSWORD: '',
      MAIL_PAUSED: '0', MAIL_NOTICES: 'essential', WHATSAPP_URL: 'https://chat.whatsapp.com/ExampleTestInvite', LAUNCH_HOLD: '0', MASHUP_ENV_FILE: '',
    };
    const base = await boot(env, (fn) => { stop = fn; });
    const call = (token, cookie) => (path, status, body) => api(base, { token, cookie })(path, status, body, { origin: base });
    const guest = call();
    const { headers } = await guest('admin/login', 200, { user: 'organizer', password: 'mashup-local-preview-only' });
    const owner = call(undefined, headers.get('set-cookie').split(';')[0]);
    const membersFor = (size, prefix) => Array.from({ length: size }, (_, index) => ({
      ...attendee, name: prefix + ' Member ' + (index + 1), email: prefix + index + '@example.test',
      batch: ['mbbs24', 'bds24', 'final', 'pg'][index],
    }));
    for (const size of [2, 3, 5]) {
      await guest('register', 400, { members: membersFor(size, 'invalid'), consent: true, groupConsent: true });
    }
    const four = membersFor(4, 'four');
    await guest('register', 400, { members: [four[0], four[0], four[1], four[2]], consent: true, groupConsent: true });
    const group = (await guest('register', 200, { members: four, consent: true, groupConsent: true })).data;
    const leaderPayment = call(group.token);
    const pending = (await leaderPayment('payment', 200)).data;
    assert.equal(pending.amount, 2880);
    assert.equal(pending.partySize, 4);
    assert.equal(pending.participantId, null);
    assert.equal(pending.workshopToken, null);
    await guest('register/access', 200, { email: four[0].email });
    run(['server.mjs', 'jobs:drain'], env);
    assert.ok(!existsSync(join(root, 'outbox.jsonl')));
    const receipt = (await leaderPayment('payment/reference', 200, { utr: '333333444444', screenshot })).data;
    await owner('admin/verify', 200, { ref: receipt.orderReference, utr: receipt.utr, amount: 2880, matched: true });
    run(['server.mjs', 'jobs:drain'], env);
    const messages = readFileSync(join(root, 'outbox.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(messages.length, 4);
    assert.doesNotMatch(JSON.stringify(messages), /registration received|chat\.whatsapp\.com/i);
    const confirmations = messages.filter(({ subject }) => subject.includes('confirmed'));
    assert.equal(confirmations.length, 4);
    const ids = confirmations.map((mail) => ({
      id: /Registration ID: (MMSHP-\d+)/.exec(mail.text)[1],
      token: /#access=([A-Za-z0-9_-]+)/.exec(mail.text)[1],
      email: mail.to,
    }));
    assert.equal(new Set(ids.map(({ id }) => id)).size, 4);
    assert.equal(new Set(ids.map(({ token }) => token)).size, 4);
    const person = ids.find(({ email }) => email === four[0].email);
    const member = ids.find(({ email }) => email === four[1].email);
    await guest('activities/unlock', 400, { registrationId: person.id });
    await call(person.token)('activities/unlock', 400, { registrationId: member.id });
    const priorId = member.id.replace('MMSHP-', 'MMSPH-');
    await call(member.token)('activities/unlock', 200, { registrationId: member.id });
    await call(member.token)('activities/unlock', 200, { registrationId: priorId });
    for (const [index, expectedBatch] of ['bds24', 'final', 'pg'].entries()) {
      const { id, token } = ids.find(({ email }) => email === four[index + 1].email);
      const participant = call(token);
      const { data: state } = await participant('activities/unlock', 200, { registrationId: id });
      assert.equal(state.batch, expectedBatch);
      for (const items of [['quiz'], ['poster', 'ipc'], ['mayhem']]) {
        const { data } = await participant('activities', 400, { registrationId: id, items });
        assert.match(data.error, /can book workshops only/);
      }
      const { data: booking } = await participant('activities', 200, { registrationId: id, items: ['ipc'] });
      assert.equal((await call(booking.token)('payment', 200)).data.amount, 2500);
    }
    async function mayhemRegistration(prefix, utr) {
      const [details] = membersFor(1, prefix);
      const { data: registration } = await guest('register', 200, details);
      const payment = call(registration.token);
      if (utr) {
        const { data: receipt } = await payment('payment/reference', 200, { utr, screenshot });
        await owner('admin/verify', 200, { ref: receipt.orderReference, utr, amount: 800, matched: true });
        const { data: verified } = await payment('payment', 200);
        return { id: verified.participantId, token: verified.workshopToken };
      }
      const { data } = await owner('admin/orders?view=unpaid&q=' + encodeURIComponent(details.email), 200);
      return { id: data.rows[0].attendeeId };
    }
    const second = await mayhemRegistration('mayhem-two', '333333444445');
    const third = await mayhemRegistration('mayhem-three', '333333444446');
    const unpaid = await mayhemRegistration('mayhem-unpaid');
    const team = { role: 'leader', member2Id: second.id, member3Id: third.id, permission: true };
    const leaderBooking = { registrationId: person.id, items: ['mayhem'], team };
    const memberBooking = {
      registrationId: second.id, items: ['mayhem'], team: { role: 'member', leaderId: person.id },
    };
    await call(second.token)('activities', 400, memberBooking);
    for (const invalid of [person.id, second.id, member.id, unpaid.id, 'MMSHP-99999999']) {
      await call(person.token)('activities', 400, { ...leaderBooking, team: { ...team, member3Id: invalid } });
    }
    await call(person.token)('activities', 200, leaderBooking);
    await call(third.token)('activities', 400, {
      registrationId: third.id, items: ['mayhem'], team: { ...team, member3Id: person.id },
    });
    await call(second.token)('activities', 200, memberBooking);
    const mayhemRoster = (await owner('admin/orders?view=activities&activity=mayhem', 200)).data.rows;
    const leader = mayhemRoster.find(({ attendeeId }) => attendeeId === person.id);
    assert.deepEqual(leader.selections[0].team.memberIds, [second.id, third.id]);
    assert.equal(mayhemRoster.find(({ attendeeId }) => attendeeId === second.id).selections[0].team.leaderId, person.id);

    const selected = { registrationId: person.id, items: ['quiz', 'ipc'] };
    const result = (await call(person.token)('activities', 200, selected)).data;
    assert.equal((await call(person.token)('activities', 200, selected)).data.token, result.token);
    await call(person.token)('activities', 400, { registrationId: person.id, items: ['ipc', 'beyond'] });
    const paidActivities = call(result.token);
    const activityReceipt = (await paidActivities('payment/reference', 200, { utr: '888888444444', screenshot })).data;
    assert.equal(activityReceipt.amount, 2750);
    await owner('admin/verify', 200, { ref: activityReceipt.orderReference, utr: activityReceipt.utr, amount: 2750, matched: true });
    const checkin = (await owner('admin/orders?view=check-in&q=' + priorId, 200)).data.rows;
    assert.equal(checkin[0].attendeeId, member.id);
    await owner('admin/check-in', 200, { ref: receipt.orderReference, attendeeId: priorId, checkedIn: true });
    const report = (await owner('admin/activity-summary', 200)).data.entries;
    assert.equal(report.find(({ id }) => id === 'ipc').paid, 1);
    assert.equal(report.find(({ id }) => id === 'quiz').paid, 1);
    const checkinRows = (await owner('admin/orders?view=check-in', 200)).data.rows;
    assert.equal(checkinRows.length, 6);
    assert.equal(checkinRows.filter(({ checkedInAt }) => checkedInAt).length, 1);
    await guest('activities/access', 200, { registrationId: person.id.replace('MMSHP-', 'MMSPH-'), email: person.email });
    await guest('activities/access', 200, { registrationId: person.id, email: person.email });
    run(['server.mjs', 'jobs:drain'], env);
    const mail = readFileSync(join(root, 'outbox.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(mail.filter(({ subject }) => subject.includes('Your Events & Workshops link')).length, 1);
    const invites = mail.filter(({ text }) => text.includes(env.WHATSAPP_URL));
    assert.equal(invites.length, 1);
    assert.equal(invites[0].to, person.email);
    assert.match(invites[0].subject, /Events & Workshops confirmed/);
  } finally {
    if (stop) await stop();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('mashup-group-'));
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
      MAIL_PAUSED: '0', MAIL_NOTICES: 'all', WHATSAPP_URL: '', LAUNCH_HOLD: '0', MASHUP_ENV_FILE: '',
    };
    const base = await boot(env, (fn) => { stop = fn; });
    const reply = await fetch(base + '/api/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ ...attendee, email: 'cron-test@example.test' }),
    });
    assert.equal(reply.status, 200);
    const { token } = await reply.json();
    const { data: receipt } = await api(base, { token })('payment/reference', 200,
      { utr: '444444555555', screenshot }, { origin: base });
    const { headers } = await api(base)('admin/login', 200,
      { user: 'organizer', password: 'mashup-local-preview-only' }, { origin: base });
    await api(base, { cookie: headers.get('set-cookie').split(';')[0] })('admin/verify', 200,
      { ref: receipt.orderReference, utr: receipt.utr, amount: 800, matched: true }, { origin: base });
    const outbox = join(root, 'outbox.jsonl');
    assert.ok(!existsSync(outbox));
    const runWorker = () => promisify(execFile)(node, ['server.mjs', 'jobs:drain'], { env });
    await Promise.all([runWorker(), runWorker(), runWorker()]);
    const messages = readFileSync(outbox, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].to, 'cron-test@example.test');
    assert.match(messages[0].subject, /registration confirmed/i);
  } finally {
    if (stop) await stop();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('mashup-cron-'));
    rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
});
