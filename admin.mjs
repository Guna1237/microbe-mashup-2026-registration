import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { InputError, activities } from './event.mjs';

export const previewPassword = 'mashup-local-preview-only';
const deriveKey = promisify(scrypt);
export const rejectionReasons = {
  'not-found': 'The organizers could not find this payment. Double-check the transaction reference.',
  'wrong-amount': 'The amount received did not match the order total. Contact the organizers before sending another payment.',
  'wrong-account': 'The organizers could not match this payment to the event account. Contact the organizers before paying again.',
};

const joins = `
  LEFT JOIN manual_receipts r ON r.ref=o.ref
  LEFT JOIN check_ins c ON c.attendee=a.seq
  LEFT JOIN payment_reviews v ON v.ref=o.ref`;
const listSql = ' FROM orders o JOIN attendees a ON a.seq=o.owner' + joins;
const checkInSql = ' FROM orders o JOIN summit_roster s ON s.ref=o.ref JOIN attendees a ON a.seq=s.attendee' + joins;
const selectSql = `SELECT o.ref, o.product, o.state, o.amount, o.paid_at, a.seq, a.created,
  a.email, a.details, r.utr, r.submitted_at, c.checked_in_at, v.reason`;

export function installAdminSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_controls (name TEXT PRIMARY KEY, is_open INTEGER NOT NULL CHECK(is_open IN (0,1)));
    CREATE TABLE IF NOT EXISTS check_ins (
      attendee INTEGER PRIMARY KEY REFERENCES attendees(seq), checked_in_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS organizer_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, target TEXT NOT NULL,
      detail TEXT NOT NULL, created_at INTEGER NOT NULL, actor TEXT NOT NULL DEFAULT 'legacy'
    );
    CREATE TABLE IF NOT EXISTS payment_reviews (
      ref TEXT PRIMARY KEY REFERENCES orders(ref), reason TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS orders_state_product_idx ON orders(state, product);
  `);
  if (!db.prepare('PRAGMA table_info(organizer_audit)').all().some(({ name }) => name === 'actor')) {
    db.exec("ALTER TABLE organizer_audit ADD COLUMN actor TEXT NOT NULL DEFAULT 'legacy'");
  }
}

export function createAdmin({ db, atomic, manual, accounts, demo, clientIp, publicUrl, local, json, read, uid, orderLabel, verifyManual, audit, sendCorrection, mailPaused, launchHold }) {
  const credentials = new Map(accounts.map((account) => [account.user, account]));
  const fakeCredential = { salt: randomBytes(24).toString('hex'), hash: randomBytes(32).toString('hex') };
  const sessions = new Map();
  const attempts = new Map();
  let signInsInFlight = 0;
  const duration = 8 * 60 * 60 * 1000;
  const loginWindow = 10 * 60 * 1000;
  const secure = local ? '' : '; Secure';
  const cookieName = local ? 'mashup_admin_preview' : '__Host-mashup_admin';

  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const sessionKey = (token) => createHash('sha256').update(token).digest('hex');

  function session(req) {
    const cookie = req.headers.cookie?.split(';').map((value) => value.trim())
      .find((value) => value.startsWith(cookieName + '='));
    const token = cookie?.slice(cookieName.length + 1);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const key = sessionKey(token);
    const account = sessions.get(key);
    if (account && account.expires > Date.now()) return { key, user: account.user, role: account.role };
    sessions.delete(key);
    return null;
  }

  function writeCookie(res, value, age) {
    res.setHeader('set-cookie', cookieName + '=' + value +
      '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + age + secure);
  }

  function clearExpired(now) {
    for (const [key, { expires }] of sessions) if (expires <= now) sessions.delete(key);
  }

  function stats() {
    const counts = get(`SELECT
      (SELECT COUNT(*) FROM summit_roster) AS registrations,
      (SELECT COUNT(*) FROM summit_roster s JOIN orders p ON p.ref=s.ref WHERE p.state='paid') AS summitPaid,
      COALESCE(SUM(CASE WHEN state='paid' THEN amount END), 0) AS received
      FROM orders`);
    const report = activityReport();
    const workshopPaid = report.filter(({ type }) => type === 'workshop').reduce((sum, row) => sum + row.paid, 0);
    const eventPaid = report.filter(({ type }) => type === 'event').reduce((sum, row) => sum + row.paid, 0);
    const review = get(`SELECT COUNT(*) AS count FROM orders o JOIN manual_receipts r ON r.ref=o.ref
      WHERE o.state='pending' AND o.link_id IS NULL`).count;
    const checkedIn = get('SELECT COUNT(*) AS count FROM check_ins').count;
    const mail = get(`SELECT COUNT(CASE WHEN sent IS NULL THEN 1 END) AS queued,
      COUNT(CASE WHEN sent IS NULL AND error IS NOT NULL THEN 1 END) AS issues FROM mail`);
    return { ...counts, review, checkedIn, mail, workshopPaid, eventPaid };
  }

  function activityReport() {
    const counts = all(`SELECT b.activity AS id, o.state, COUNT(*) AS count
      FROM activity_items b JOIN orders o ON o.ref=b.ref
      WHERE o.state IN ('paid','pending') GROUP BY b.activity,o.state
      UNION ALL SELECT product AS id, state, COUNT(*) FROM orders
      WHERE product IN ('ipc','antibiotic','beyond') AND state IN ('paid','pending') GROUP BY product,state`);
    return activities.map(({ id, name, type }) => ({
      id, name, type,
      paid: counts.filter((row) => row.id === id && row.state === 'paid').reduce((sum, row) => sum + row.count, 0),
      pending: counts.filter((row) => row.id === id && row.state === 'pending').reduce((sum, row) => sum + row.count, 0),
    }));
  }

  function mapRow(row, full = false, includeGroup = true) {
    const details = JSON.parse(row.details);
    const selections = all('SELECT activity,details FROM activity_items WHERE ref=? ORDER BY activity', row.ref).map(({ activity, details: itemDetails }) => ({
      name: activities.find(({ id }) => id === activity)?.name || activity,
      ...(full && itemDetails ? { team: JSON.parse(itemDetails) } : {}),
    }));
    const members = includeGroup && row.product === 'summit'
      ? all(`SELECT a.seq, json_extract(a.details,'$.name') AS name FROM registration_members g
        JOIN attendees a ON a.seq=g.attendee WHERE g.ref=? ORDER BY a.seq`, row.ref)
        .map(({ seq, name }) => ({ name, attendeeId: uid(seq) }))
      : [];
    return {
      ref: row.ref, attendeeId: uid(row.seq), name: details.name, email: row.email,
      batch: details.batch, product: row.product, label: orderLabel(row.product),
      state: row.state, amount: row.amount / 100, utr: row.utr, reason: row.reason,
      submittedAt: row.submitted_at, paidAt: row.paid_at, checkedInAt: row.checked_in_at,
      createdAt: row.created, ...(full ? { details } : {}),
      selections, members,
    };
  }

  function queue(url, role) {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 100).toLowerCase();
    const checkin = role === 'checkin';
    const view = checkin ? 'check-in' : url.searchParams.get('view') || 'review';
    const knownViews = new Map([
      ['review', "o.state='pending' AND r.utr IS NOT NULL AND o.link_id IS NULL"],
      ['unpaid', "o.state='pending'"], ['paid', "o.state='paid'"],
      ['basic', "o.product='summit'"], ['activities', "o.product<>'summit'"],
      ['check-in', "o.product='summit' AND o.state='paid'"], ['all', '1=1'],
    ]);
    if (!knownViews.has(view)) throw new InputError('Choose a valid view.');
    const page = Math.min(10000, Math.max(1, Math.trunc(Number(url.searchParams.get('page'))) || 1));
    const limit = 25;
    const roster = view === 'check-in';
    const activity = !roster ? url.searchParams.get('activity') : null;
    if (activity && !activities.some(({ id }) => id === activity)) throw new InputError('Choose a valid activity.');
    const extra = checkin ? '' : ' OR instr(lower(a.email),?) OR instr(lower(o.ref),?) OR instr(lower(r.utr),?)';
    const groupSearch = roster ? '' : ` OR EXISTS (
      SELECT 1 FROM registration_members g JOIN attendees m ON m.seq=g.attendee
      WHERE g.ref=o.ref AND (instr(lower(m.email),?) OR instr(lower(json_extract(m.details,'$.name')),?)
        OR instr(lower(printf('MMSPH-%03d',m.seq)),?)))`;
    const where = ' WHERE ' + knownViews.get(view) + `
      AND (?='' OR instr(lower(json_extract(a.details,'$.name')),?)
      OR instr(lower(printf('MMSPH-%03d', a.seq)),?)` + extra + groupSearch + ')' +
      (activity ? ' AND (o.product=? OR EXISTS (SELECT 1 FROM activity_items b WHERE b.ref=o.ref AND b.activity=?))' : '');
    const params = Array(checkin ? 3 : roster ? 6 : 9).fill(q);
    if (activity) params.push(activity, activity);
    const source = roster ? checkInSql : listSql;
    const total = get('SELECT COUNT(*) AS count ' + source + where, ...params).count;
    const rows = all(selectSql + source + where +
      ' ORDER BY COALESCE(r.submitted_at,a.created) DESC,o.ref,a.seq LIMIT ? OFFSET ?', ...params, limit, (page - 1) * limit);
    const results = rows.map((row) => {
      if (!checkin && !roster) return mapRow(row);
      return { ref: row.ref, attendeeId: uid(row.seq), name: JSON.parse(row.details).name, product: 'summit',
        label: 'Basic Registration', state: 'paid', checkedInAt: row.checked_in_at };
    });
    return { rows: results, page, pages: Math.max(1, Math.ceil(total / limit)), total };
  }

  function reject(body, actor) {
    if (!manual || typeof body.ref !== 'string' || typeof body.utr !== 'string' ||
        !Object.hasOwn(rejectionReasons, body.reason)) throw new InputError('Select a payment review reason.');
    return atomic(() => {
      const order = get(`SELECT o.*, r.utr FROM orders o
        JOIN manual_receipts r ON r.ref=o.ref WHERE o.ref=?`, body.ref);
      if (!order || order.state !== 'pending' || order.link_id || order.utr !== body.utr) {
        throw new InputError('This payment reference changed. Refresh the queue before reviewing it.');
      }
      run('DELETE FROM manual_receipts WHERE ref=?', body.ref);
      run(`INSERT INTO payment_reviews(ref,reason) VALUES(?,?) ON CONFLICT(ref) DO UPDATE SET reason=excluded.reason`,
        body.ref, body.reason);
      audit('payment-rejected', body.ref, body.utr + ' · ' + body.reason, actor);
      sendCorrection(order, body.reason);
      return { message: 'Correction requested. An email with the payment status link was queued.' };
    });
  }

  function checkIn(body, actor) {
    if (typeof body.ref !== 'string' || typeof body.checkedIn !== 'boolean') throw new InputError('Choose a check-in action.');
    return atomic(() => {
      const order = get(`SELECT s.attendee AS owner FROM summit_roster s JOIN orders o ON o.ref=s.ref
        WHERE s.ref=? AND o.state='paid' AND ((? IS NULL AND s.attendee=o.owner) OR printf('MMSPH-%03d',s.attendee)=?)`,
        body.ref, typeof body.attendeeId === 'string' ? body.attendeeId : null, typeof body.attendeeId === 'string' ? body.attendeeId : null);
      if (!order) throw new InputError('Only verified summit attendees can be checked in.');
      const result = body.checkedIn
        ? run('INSERT OR IGNORE INTO check_ins(attendee,checked_in_at) VALUES (?,?)', order.owner, Date.now())
        : run('DELETE FROM check_ins WHERE attendee=?', order.owner);
      if (result.changes) audit(body.checkedIn ? 'check-in' : 'check-in-undone', uid(order.owner), '', actor);
      return { message: body.checkedIn ? 'Attendee checked in.' : 'Check-in undone.' };
    });
  }

  async function route(req, res, url) {
    const { pathname } = url;
    if (!credentials.size) return json(res, 503, { error: 'Organizer sign-in has not been configured.' });
    if (req.method === 'POST' && req.headers.origin !== publicUrl) {
      return json(res, 403, { error: 'Open the official organizer dashboard to continue.' });
    }
    if (req.method === 'POST' && pathname === '/api/admin/login') {
      const now = Date.now();
      const ip = clientIp(req);
      for (const [key, value] of attempts) if (now - value.started >= loginWindow) attempts.delete(key);
      const entry = attempts.get(ip) || { count: 0, started: now };
      if (entry.count >= 12 || attempts.size >= 4096 || sessions.size >= 256) {
        clearExpired(now);
        if (entry.count >= 12 || attempts.size >= 4096 || sessions.size >= 256) {
          return json(res, 429, { error: 'Too many attempts. Wait a few minutes and try again.' });
        }
      }
      const { user, password: value } = await read(req);
      if (typeof value !== 'string' || value.length > 256) throw new InputError('Enter the organizer passphrase.');
      // Recheck after reading the body so overlapping requests cannot reuse an old attempt count.
      const current = attempts.get(ip) || entry;
      if (current.count >= 12 || signInsInFlight >= 8) {
        return json(res, 429, { error: 'Too many attempts. Wait a few minutes and try again.' });
      }
      current.count++;
      attempts.set(ip, current);
      const name = typeof user === 'string' ? user.trim().toLowerCase() : demo ? 'organizer' : '';
      const match = credentials.get(name);
      const credential = match || fakeCredential;
      signInsInFlight++;
      let supplied;
      try { supplied = await deriveKey(value, credential.salt, 32); }
      finally { signInsInFlight--; }
      if (!timingSafeEqual(supplied, Buffer.from(credential.hash, 'hex')) || !match) {
        return json(res, 401, { error: 'The username or passphrase did not match.' });
      }
      attempts.delete(ip);
      const existing = session(req);
      if (existing) sessions.delete(existing.key);
      const token = randomBytes(32).toString('base64url');
      sessions.set(sessionKey(token), { user: match.user, role: match.role, expires: now + duration });
      writeCookie(res, token, duration / 1000);
      return json(res, 200, { ok: true });
    }
    const active = session(req);
    if (!active) return json(res, 401, { error: 'Sign in to the organizer dashboard.' });
    const { user, role } = active;
    const owner = role === 'owner';
    const mayReview = owner || role === 'payments';
    const mayCheckIn = owner || role === 'checkin';
    const forbidden = () => json(res, 403, { error: 'Your staff role cannot use this control.' });
    if (req.method === 'GET') {
      if (pathname === '/api/admin/overview') {
        const controls = Object.fromEntries(all('SELECT name,is_open FROM event_controls').map((row) => [row.name, Boolean(row.is_open)]));
        const counts = stats();
        const visible = role === 'checkin' ? { summitPaid: counts.summitPaid, checkedIn: counts.checkedIn } : counts;
        return json(res, 200, { ...visible, controls: owner ? { summit: true, workshops: true, ...controls } : null,
          manual, demo: local, mailPaused: owner && mailPaused, launchHold: owner && launchHold, user, role });
      }
      if (pathname === '/api/admin/orders') return json(res, 200, queue(url, role));
      if (pathname === '/api/admin/activity-summary') {
        if (!mayReview) return forbidden();
        return json(res, 200, { entries: activityReport() });
      }
      if (pathname === '/api/admin/audit') {
        if (!owner) return forbidden();
        return json(res, 200, { entries: all('SELECT action,target,detail,created_at,actor FROM organizer_audit ORDER BY id DESC LIMIT 50') });
      }
      if (pathname === '/api/admin/mail') {
        if (!owner) return forbidden();
        const provider = get("SELECT retry_at AS retryAt,reason FROM mail_provider WHERE name='resend' AND retry_at>?", Date.now());
        return json(res, 200, { provider, entries: all(`SELECT id,recipient,subject,error,first_attempt,next_attempt
          FROM mail WHERE sent IS NULL ORDER BY error IS NULL, rowid LIMIT 50`) });
      }
      if (pathname === '/api/admin/export') {
        if (!owner) return forbidden();
        audit('roster-exported', 'roster', '', user);
        res.setHeader('content-disposition', 'attachment; filename="microbe-mashup-roster.json"');
        const orders = all(selectSql + listSql + ' ORDER BY a.seq,o.product').map((row) => mapRow(row, true));
        const members = all(selectSql + checkInSql + " WHERE o.product='summit' AND a.seq<>o.owner ORDER BY a.seq")
          .map((row) => ({ ...mapRow(row, true, false), amount: 0, coveredByGroupPayment: true }));
        return json(res, 200, [...orders, ...members]);
      }
    }
    if (req.method === 'POST') {
      if (pathname === '/api/admin/logout') {
        sessions.delete(active.key);
        writeCookie(res, '', 0);
        return json(res, 200, { ok: true });
      }
      const body = await read(req);
      if (pathname === '/api/admin/verify') {
        if (!mayReview) return forbidden();
        if (!manual || typeof body.ref !== 'string' || body.matched !== true || !Number.isSafeInteger(body.amount)) {
          throw new InputError('Confirm that you matched the credited transaction and enter the amount received.');
        }
        return json(res, 200, { message: verifyManual(body.ref, body.utr, body.amount, user) });
      }
      if (pathname === '/api/admin/reject') return mayReview ? json(res, 200, reject(body, user)) : forbidden();
      if (pathname === '/api/admin/check-in') return mayCheckIn ? json(res, 200, checkIn(body, user)) : forbidden();
      if (pathname === '/api/admin/retry-email') {
        if (!owner) return forbidden();
        if (typeof body.id !== 'string') throw new InputError('Select a queued email.');
        const now = Date.now();
        atomic(() => {
          const result = run(`UPDATE mail SET next_attempt=? WHERE id=? AND sent IS NULL
            AND error IS NOT NULL AND (first_attempt IS NULL OR first_attempt>?)`,
            now, body.id, now - 23 * 3600000);
          if (!result.changes) throw new InputError('This email is already sent, queued, or past the safe retry window.');
          audit('email-retry-requested', body.id, '', user);
        });
        return json(res, 200, { message: 'Email queued for retry.' });
      }
      if (pathname === '/api/admin/controls') {
        if (!owner) return forbidden();
        if (launchHold) throw new InputError('Registration is locked while launch setup is in progress.');
        if (!['summit', 'workshops'].includes(body.name) || typeof body.open !== 'boolean') {
          throw new InputError('Choose a valid registration control.');
        }
        atomic(() => {
          run(`INSERT INTO event_controls(name,is_open) VALUES(?,?)
            ON CONFLICT(name) DO UPDATE SET is_open=excluded.is_open`, body.name, Number(body.open));
          audit(body.open ? 'registration-resumed' : 'registration-paused', body.name, '', user);
        });
        return json(res, 200, { message: body.open ? 'Registration reopened.' : 'New registrations paused.' });
      }
    }
    return json(res, 404, { error: 'Page not found.' });
  }
  return route;
}
