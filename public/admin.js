const byId = (id) => document.getElementById(id);
const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const time = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
const filters = byId('order-filters');
const review = byId('review-dialog');
let currentTab = 'orders';
let page = 1;
let ticket = 0;
let paymentAction;
let staffRole;

function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
function action(text, handler, primary = false) {
  const button = node('button', text, primary ? '' : 'secondary');
  button.type = 'button';
  button.addEventListener('click', () => withButton(button, handler));
  return button;
}
async function withButton(button, handler) {
  if (button.disabled) return;
  button.disabled = true;
  try { await handler(); }
  catch (error) {
    if (error.status === 401) showLogin('Your session expired. Sign in again.');
    else setMessage(review.open ? 'review-error' : 'admin-message', error.message);
  } finally { button.disabled = false; }
}
function setMessage(id, message = '') {
  const element = byId(id);
  element.hidden = !message;
  element.textContent = message;
}

async function api(path, payload) {
  const response = await fetch('/api/admin/' + path, payload === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Please try again.'), { status: response.status });
  return result;
}

function showLogin(message = '') {
  ticket++;
  if (review.open) review.close();
  byId('loading').hidden = true;
  byId('dashboard').hidden = true;
  for (const id of ['order-list', 'mail-list', 'audit-list', 'review-fields']) byId(id).replaceChildren();
  filters.reset();
  page = 1;
  paymentAction = undefined;
  byId('login-panel').hidden = false;
  byId('login-form').reset();
  setMessage('login-message', message);
  byId('passphrase').focus();
}

async function refreshDashboard() {
  const overview = await api('overview');
  byId('loading').hidden = true;
  byId('login-panel').hidden = true;
  byId('dashboard').hidden = false;
  byId('admin-preview').hidden = !overview.demo;
  byId('mail-paused').hidden = !overview.mailPaused;
  byId('mail-paused').textContent = overview.launchHold
    ? 'Launch setup is in progress. Registration, workshop booking and outgoing email are paused.'
    : 'Outgoing email is paused on this host.';
  staffRole = overview.role;
  const owner = staffRole === 'owner';
  const checkin = staffRole === 'checkin';
  byId('staff-identity').textContent = overview.user + ' · ' +
    { owner: 'Owner', payments: 'Payment reviewer', checkin: 'Check-in staff' }[staffRole];
  byId('export-roster').hidden = !owner;
  byId('registration-controls').hidden = !owner;
  byId('view-filter').hidden = checkin;
  filters.elements.q.placeholder = checkin ? 'Name or attendee ID' : 'Name, email, attendee ID, or UTR';
  document.querySelector('[data-tab=audit]').hidden = !owner;
  const mailButton = document.querySelector('[data-tab=mail]');
  mailButton.hidden = !owner;
  const metrics = checkin ? [['Paid summit attendees', overview.summitPaid], ['Checked in', overview.checkedIn]] : [
    ['Summit paid', overview.summitPaid + ' / ' + overview.registrations],
    ['Needs review', overview.review], ['Workshops paid', overview.workshopPaid],
    ['Checked in', overview.checkedIn], ['Recorded payments', money.format(overview.received / 100)],
  ];
  byId('metrics').replaceChildren(...metrics.map(([label, value]) => {
    const card = node('div', undefined, 'metric');
    card.append(node('span', label), node('strong', value));
    return card;
  }));
  const controls = owner ? Object.entries({ summit: 'Summit', workshops: 'Workshops' }).map(([key, label]) => {
    const open = overview.controls[key];
    const button = action(label + (open ? ' open · Pause' : ' paused · Reopen'), async () => {
      await change('controls', { name: key, open: !open });
    });
    if (overview.launchHold) {
      button.disabled = true;
      button.textContent = label + ' closed for setup';
    }
    return button;
  }) : [];
  byId('controls').replaceChildren(...controls);
  if (owner) mailButton.textContent = 'Email queue' + (overview.mail.issues ? ' (' + overview.mail.issues + ' need attention)' : '');
}

async function change(path, body) {
  const result = await api(path, body);
  setMessage('admin-message', result.message);
  await Promise.all([refreshDashboard(), refreshView()]);
}

function empty(container, text) {
  container.replaceChildren(node('p', text, 'empty'));
}

function renderOrder(order) {
  const item = node('article', undefined, 'order-item');
  const person = node('div');
  person.append(node('h3', order.name + ' · ' + order.attendeeId));
  if (order.email) person.append(node('p', order.email));
  person.append(node('p', order.label));
  const payment = node('div');
  const paid = order.state === 'paid';
  let status = 'Awaiting payment';
  if (paid) status = order.checkedInAt && order.product === 'summit' ? 'Checked in' : 'Paid';
  else if (order.utr && order.state === 'pending') status = 'Needs review';
  else if (order.reason) status = 'Correction requested';
  else if (order.state !== 'pending') status = order.state;
  payment.append(node('span', status + (order.amount === undefined ? '' : ' · ' + money.format(order.amount)), 'queue-status' + (paid ? ' verified' : '')));
  if (order.utr) payment.append(node('p', 'UPI ref ' + order.utr));
  if (staffRole !== 'checkin') payment.append(node('p', order.ref));
  const controls = node('div', undefined, 'actions');
  if (!paid && order.utr && order.state === 'pending') {
    controls.append(action('Verify', () => reviewPayment(order, false), true), action('Request correction', () => reviewPayment(order, true)));
  } else if (paid && order.product === 'summit' && staffRole !== 'payments') {
    controls.append(action(order.checkedInAt ? 'Undo check-in' : 'Check in', async () => {
      if (order.checkedInAt && !confirm('Undo check-in for ' + order.attendeeId + '?')) return;
      await change('check-in', { ref: order.ref, checkedIn: !order.checkedInAt });
    }, !order.checkedInAt));
  }
  item.append(person, payment, controls);
  return item;
}

async function refreshView() {
  const id = ++ticket;
  const tab = currentTab;
  if (tab === 'orders') {
    const data = new URLSearchParams({ view: filters.elements.view.value, q: filters.elements.q.value, page });
    const result = await api('orders?' + data);
    if (id !== ticket) return;
    if (page > result.pages) { page = result.pages; return refreshView(); }
    if (result.rows.length) byId('order-list').replaceChildren(...result.rows.map(renderOrder));
    else empty(byId('order-list'), 'No orders match this view.');
    byId('page').textContent = 'Page ' + result.page + ' of ' + result.pages + ' · ' + result.total + ' orders';
    byId('prev').disabled = page <= 1;
    byId('next').disabled = page >= result.pages;
    return;
  }
  const { entries } = await api(tab);
  if (id !== ticket) return;
  const container = byId(tab + '-list');
  if (!entries.length) return empty(container, tab === 'mail' ? 'No queued emails.' : 'No organizer actions yet.');
  container.replaceChildren(...entries.map((entry) => {
    const item = node('article', undefined, 'order-item');
    const main = node('div');
    const meta = node('div');
    if (tab === 'mail') {
      main.append(node('h3', entry.subject), node('p', entry.recipient));
      meta.append(node('p', entry.error || 'Queued for sending'));
      if (entry.error && (!entry.first_attempt || Date.now() - entry.first_attempt < 23 * 3600000)) {
        const buttons = node('div', undefined, 'actions');
        buttons.append(action('Retry email', () => change('retry-email', { id: entry.id })));
        item.append(main, meta, buttons);
        return item;
      }
    } else {
      const names = {
        'payment-verified': 'Payment verified', 'payment-rejected': 'Correction requested',
        'check-in': 'Checked in', 'check-in-undone': 'Check-in undone',
        'registration-paused': 'Registration paused', 'registration-resumed': 'Registration reopened',
        'email-retry-requested': 'Email retry requested', 'roster-exported': 'Roster exported',
      };
      main.append(node('h3', names[entry.action] || entry.action), node('p', entry.target));
      meta.append(node('p', time.format(entry.created_at)), node('p', 'By ' + entry.actor));
      if (entry.detail) meta.append(node('p', entry.detail));
    }
    item.append(main, meta);
    return item;
  }));
}

function pickTab(tab) {
  currentTab = tab;
  document.querySelectorAll('[data-tab]').forEach((button) => {
    if (button.dataset.tab === tab) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('.admin-view').forEach((section) => { section.hidden = section.id !== tab; });
  return refreshView();
}

function reviewPayment(order, reject) {
  paymentAction = { order, reject };
  byId('review-heading').textContent = reject ? 'Request a payment correction' : 'Verify UPI payment';
  byId('review-help').textContent = order.attendeeId + ' · ' + order.label + ' · ' +
    money.format(order.amount) + ' · UPI ref ' + order.utr;
  byId('review-submit').textContent = reject ? 'Send back for correction' : 'Mark payment verified';
  setMessage('review-error');
  const fields = byId('review-fields');
  if (reject) {
    const label = node('label', 'Why does the payment need correction?', 'field');
    const select = node('select');
    select.name = 'reason';
    select.required = true;
    for (const [id, name] of [['', 'Select a reason'], ['not-found', 'Reference not found'], ['wrong-amount', 'Amount does not match'], ['wrong-account', 'Wrong receiving account']]) {
      const option = node('option', name);
      option.value = id;
      select.append(option);
    }
    label.append(select);
    fields.replaceChildren(label);
  } else {
    const label = node('label', 'Amount credited in rupees', 'field');
    const input = node('input');
    input.name = 'amount';
    input.type = 'number';
    input.min = '1';
    input.required = true;
    input.inputMode = 'numeric';
    label.append(input);
    const confirmation = node('label', undefined, 'consent');
    const box = node('input');
    box.type = 'checkbox';
    box.name = 'matched';
    box.required = true;
    confirmation.append(box, node('span', 'I matched this UPI reference and amount against the receiving account.'));
    fields.replaceChildren(label, confirmation);
  }
  review.showModal();
}

function guarded(handler) {
  return async () => {
    try { await handler(); }
    catch (error) {
      if (error.status === 401) showLogin('Your session expired. Sign in again.');
      else setMessage('admin-message', error.message);
    }
  };
}

byId('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  setMessage('login-message');
  try {
    await api('login', { user: event.target.elements.user.value, password: byId('passphrase').value });
    event.target.reset();
    await refreshDashboard();
    await pickTab('orders');
  } catch (error) { showLogin(error.message); }
  finally { button.disabled = false; }
});
byId('logout').addEventListener('click', guarded(async () => {
  await api('logout', {});
  showLogin('Signed out.');
}));
document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', guarded(() => pickTab(button.dataset.tab))));
document.querySelectorAll('[data-refresh]').forEach((button) => button.addEventListener('click', guarded(async () => {
  await Promise.all([refreshDashboard(), refreshView()]);
})));
filters.addEventListener('submit', (event) => { event.preventDefault(); page = 1; guarded(refreshView)(); });
filters.elements.view.addEventListener('change', () => { page = 1; guarded(refreshView)(); });
byId('prev').addEventListener('click', guarded(() => { page--; return refreshView(); }));
byId('next').addEventListener('click', guarded(() => { page++; return refreshView(); }));
byId('review-close').addEventListener('click', () => review.close());
byId('review-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const { order, reject } = paymentAction;
  const body = { ref: order.ref, utr: order.utr };
  if (reject) body.reason = form.elements.reason.value;
  else { body.amount = Number(form.elements.amount.value); body.matched = form.elements.matched.checked; }
  withButton(byId('review-submit'), async () => {
    const result = await api(reject ? 'reject' : 'verify', body);
    review.close();
    setMessage('admin-message', result.message);
    await Promise.all([refreshDashboard(), refreshView()]);
  });
});

try {
  await refreshDashboard();
  await pickTab('orders');
} catch (error) { showLogin(error.status === 401 ? '' : error.message); }
