const screen = document.querySelector('#screen');
const notice = document.querySelector('#notice');
const formArea = document.querySelector('#form-area');
const home = document.querySelector('#home');
const money = (amount) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount);
let catalog;
let accessToken = '';
let generation = 0;
let timer;

async function api(route, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  if (body) headers['content-type'] = 'application/json';
  const response = await fetch('/api/' + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Please try again.');
  return data;
}

function message(text = '') {
  notice.hidden = !text;
  notice.textContent = text;
}

function show(html) { screen.innerHTML = html; }
function title(text) { return '<h2 id="page-title" tabindex="-1">' + text + '</h2>'; }
function input(name, label, attrs = '') {
  return '<label class="field"><span>' + label + '</span><input name="' + name + '" required ' + attrs + '></label>';
}
function select(name, label, options) {
  return '<label class="field"><span>' + label + '</span><select required name="' + name + '">' +
    '<option value="">Choose ' + label.toLowerCase() + '</option>' +
    options.map(({ id, name }) => '<option value="' + id + '">' + name + '</option>').join('') + '</select></label>';
}
const values = (items) => items.map((name) => ({ id: name, name }));
const registrationId = () => input('registrationId', 'Registration ID', 'placeholder="MMSPH-001" maxlength="14" autocomplete="off" autocapitalize="characters"');

function bind(form, version, handler) {
  const button = form.querySelector('[type=submit]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    message();
    button.disabled = true;
    try { await handler(form); }
    catch (error) { if (version === generation) message(error.message); }
    finally { button.disabled = false; }
  });
}

function showBasic(version) {
  if (!catalog.summitOpen) {
    show(title(catalog.launchHold ? 'Registration opens soon' : 'Basic Registration is paused') +
      '<p class="intro">Check back here when registration opens. Please wait to pay until you receive payment instructions from the site.</p>');
    return;
  }
  show(title('Basic Registration') + `
    <p class="intro">Get your summit pass first. After payment is verified, we’ll email each participant their own Registration ID.</p>
    <form id="basic-form" novalidate>
      <section id="basic-details">
        ${select('size', 'Registration type', [
          { id: 1, name: 'Individual · ' + money(catalog.basicRates[1]) },
          ...[3, 4, 5].map((size) => ({ id: size, name: 'Group of ' + size + ' · ' + money(catalog.basicRates[size]) + ' per person' })),
        ])}
        <p class="hint" id="group-note" hidden>The group leader pays the total once. Each member receives a separate email and Registration ID.</p>
        <div id="people"></div>
      </section>
      <section id="basic-review" class="block" hidden aria-labelledby="basic-review-title">
        <h3 id="basic-review-title" tabindex="-1">Review participants</h3>
        <ul class="review-charges" id="review-people"></ul>
        <p class="hint">Check every email address. Each Registration ID will be sent to the address listed here.</p>
        <label class="consent"><input type="checkbox" name="consent" required><span>I agree that the organizers may use these details for registration, payment verification, certificates and event coordination.</span></label>
        <label class="consent" id="group-consent" hidden><input type="checkbox" name="groupConsent"><span>I have each participant’s permission to submit their details.</span></label>
      </section>
      <div class="paybar">
        <div class="total"><span id="basic-total-label">Total</span><strong id="basic-total" aria-live="polite"></strong></div>
        <div class="step-actions"><button class="secondary" type="button" id="basic-back" hidden>Edit details</button><button type="submit" id="basic-next">Review registration</button></div>
      </div>
    </form>`);
  const form = document.querySelector('#basic-form');
  const details = document.querySelector('#basic-details');
  const review = document.querySelector('#basic-review');
  const people = document.querySelector('#people');
  const back = document.querySelector('#basic-back');
  let members = [];
  const readMembers = () => [...people.querySelectorAll('fieldset')].map((row) =>
    Object.fromEntries([...row.querySelectorAll('input,select')].map((field) => [field.name, field.value])));
  form.elements.size.value = '1';

  function updateSize() {
    const old = readMembers();
    const count = Number(form.elements.size.value) || 1;
    document.querySelector('#group-note').hidden = count === 1;
    people.innerHTML = Array.from({ length: count }, (_, index) => `
      <fieldset class="participant">
        <legend>${count === 1 ? 'Participant details' : index === 0 ? 'Group leader' : 'Member ' + (index + 1)}</legend>
        <div class="grid">
          ${input('name', 'Full name', 'maxlength="120"')}
          ${input('email', 'Email address', 'type="email" maxlength="254"')}
          ${input('phone', 'Phone number', 'type="tel" maxlength="24"')}
          ${select('batch', 'Batch', catalog.batches)}
          ${input('college', 'College', 'maxlength="180"')}
          ${select('meal', 'Lunch preference', values(['Veg', 'Non-veg']))}
        </div>
      </fieldset>`).join('');
    [...people.querySelectorAll('fieldset')].forEach((row, index) => {
      for (const field of row.querySelectorAll('input,select')) {
        if (old[index]?.[field.name]) field.value = old[index][field.name];
      }
    });
    document.querySelector('#basic-total-label').textContent = count === 1 ? 'Individual total' : count + ' × ' + money(catalog.basicRates[count]);
    document.querySelector('#basic-total').textContent = money(catalog.basicRates[count] * count);
  }
  form.elements.size.addEventListener('change', updateSize);
  updateSize();
  back.addEventListener('click', () => {
    review.hidden = true;
    details.hidden = false;
    back.hidden = true;
    document.querySelector('#basic-next').textContent = 'Review registration';
    form.elements.size.focus();
  });
  bind(form, version, async () => {
    if (review.hidden) {
      const invalid = [...details.querySelectorAll('input,select')].find((field) => !field.checkValidity());
      if (invalid) { invalid.reportValidity(); return; }
      members = readMembers();
      if (new Set(members.map(({ email }) => email.trim().toLowerCase())).size !== members.length) {
        throw new Error('Every participant needs a different email address.');
      }
      const list = members.map(({ name, email }, index) => {
        const row = document.createElement('li');
        const who = document.createElement('span');
        const address = document.createElement('strong');
        who.textContent = (members.length > 1 && index === 0 ? 'Group leader · ' : '') + name;
        address.textContent = email;
        row.append(who, address);
        return row;
      });
      document.querySelector('#review-people').replaceChildren(...list);
      document.querySelector('#group-consent').hidden = members.length === 1;
      details.hidden = true;
      review.hidden = false;
      back.hidden = false;
      document.querySelector('#basic-next').textContent = 'Continue to payment';
      document.querySelector('#basic-review-title').focus();
      return;
    }
    if (!form.elements.consent.reportValidity()) return;
    if (members.length > 1 && !form.elements.groupConsent.checked) throw new Error('Confirm that you have each participant’s permission.');
    back.disabled = true;
    try {
      const result = await api('register', { method: 'POST', body: {
        members, consent: form.elements.consent.checked, groupConsent: form.elements.groupConsent.checked,
      } });
      if (version !== generation) return;
      if (result.existing) {
        message('At least one email is already registered. Check the original confirmation or payment email, or contact the organizers if you need to change your group.');
      } else location.hash = 'payment=' + result.token;
    } finally { back.disabled = false; }
  });
}

function showActivityGate(token, version) {
  accessToken = /^[A-Za-z0-9_-]{32}$/.test(token || '') ? token : '';
  if (!accessToken) {
    show(title('Events &amp; Workshops') + `
      <p class="intro">Enter the Registration ID from your confirmed Basic Registration email. We’ll send a private booking link to your registered address.</p>
      <form id="activity-gate">
        <div class="grid">${registrationId()}${input('email', 'Registered email address', 'type="email" maxlength="254" autocomplete="email"')}</div>
        <div class="actions"><button type="submit">Email my booking link</button><a class="button secondary" href="/basic-registration">Start Basic Registration</a></div>
      </form>`);
    bind(document.querySelector('#activity-gate'), version, async (form) => {
      await api('activities/access', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      if (version === generation) message('If the details match a confirmed registration, a booking link will be sent to that email address.');
    });
    return;
  }
  show(title('Events &amp; Workshops') + `
    <p class="intro">Enter your personal Registration ID to view eligible activities and existing bookings.</p>
    <form id="activity-gate">${registrationId()}<div class="actions"><button type="submit">See activities</button></div></form>`);
  bind(document.querySelector('#activity-gate'), version, async (form) => {
    const id = form.elements.registrationId.value.trim().toUpperCase();
    const state = await api('activities/unlock', { method: 'POST', token: accessToken, body: { registrationId: id } });
    if (version === generation) showActivitySelection(id, state, version);
  });
}

function showActivitySelection(id, state, version) {
  const eligible = catalog.batches.find((batch) => batch.id === state.batch)?.competition;
  const items = [...catalog.events, ...catalog.workshops];
  const itemById = (key) => items.find((item) => item.id === key);
  const reserved = new Set([...state.legacy, ...state.orders.flatMap((order) => order.items)]);
  const selectable = (item) => !reserved.has(item.id);
  function options(group) {
    return group.filter(selectable).map((item) => `
      <label class="option activity-option">
        <input type="checkbox" name="items" value="${item.id}">
        <span>${item.name}${item.description ? '<small>' + item.description + '</small>' : ''}</span>
        <strong>${money(item.fee)}</strong>
      </label>`).join('') || '<p class="hint">You’ve already selected the available activities in this section.</p>';
  }
  const orders = state.orders.map((order) => `
    <li><span>${order.items.map((item) => itemById(item)?.name).filter(Boolean).join(', ')}</span>
      ${order.state === 'paid' ? '<strong>Confirmed</strong>' : '<a href="#payment=' + order.token + '">View payment</a>'}</li>`).join('');
  const legacy = state.legacy.map((item) => itemById(item)?.name).filter(Boolean);
  show(title('Events &amp; Workshops') +
    '<p class="intro">Registration <strong>' + id + '</strong> is confirmed. Choose your activities and review the total before paying.</p>' +
    (orders || legacy.length ? '<section class="block"><h3>Your activity bookings</h3><ul class="review-charges">' + orders +
      (legacy.length ? '<li><span>' + legacy.join(', ') + '</span><strong>Confirmed</strong></li>' : '') + '</ul></section>' : '') +
    (state.activitiesOpen ? `
      <form id="activities-form">
        <section class="block"><h3>Events</h3><div class="options">${eligible ? options(catalog.events) :
          '<p class="hint">Event competitions are open to 2k24 and 2k25 MBBS. You can still book workshops.</p>'}</div></section>
        <fieldset class="team" id="team" disabled hidden>
          <legend>Microbe Mayhem team</legend>
          <p class="hint">Use the same team name for all three members.</p>
          <div class="grid">${input('teamName', 'Team name', 'maxlength="120"')}
            ${select('teamRole', 'Team role', [{ id: 'leader', name: 'Group leader' }, { id: 'member', name: 'Team member' }])}</div>
          <fieldset id="members" class="block" disabled hidden>
            <legend>Teammate details</legend>
            <div class="grid">${input('member2', 'Second member name', 'maxlength="120"')}${input('phone2', 'Second member phone', 'type="tel" maxlength="24"')}
              ${input('member3', 'Third member name', 'maxlength="120"')}${input('phone3', 'Third member phone', 'type="tel" maxlength="24"')}</div>
            <label class="consent"><input type="checkbox" name="permission" required><span>I have permission to share my teammates’ details.</span></label>
          </fieldset>
        </fieldset>
        <section class="block"><h3>Workshops</h3><div class="options">${options(catalog.workshops)}</div></section>
        <div class="paybar"><div class="total"><span>Activity total</span><strong id="activities-total" aria-live="polite">${money(0)}</strong></div>
          <button type="submit" id="activities-next" disabled>Continue to payment</button></div>
      </form>` : '<p class="journey-note">New activity bookings are paused. Existing payments can still be completed.</p>'));
  const form = document.querySelector('#activities-form');
  if (!form) return;
  const team = form.querySelector('#team');
  const teammates = form.querySelector('#members');
  const selected = () => new FormData(form).getAll('items');
  form.addEventListener('change', () => {
    const choices = selected();
    team.hidden = team.disabled = !choices.includes('mayhem');
    teammates.hidden = teammates.disabled = team.disabled || form.elements.teamRole.value !== 'leader';
    document.querySelector('#activities-total').textContent = money(choices.reduce((sum, item) => sum + itemById(item).fee, 0));
    document.querySelector('#activities-next').disabled = !choices.length;
  });
  bind(form, version, async () => {
    const fields = Object.fromEntries(new FormData(form));
    const result = await api('activities', { method: 'POST', token: accessToken, body: {
      registrationId: id, items: selected(),
      team: { name: fields.teamName, role: fields.teamRole, member2: fields.member2, phone2: fields.phone2,
        member3: fields.member3, phone3: fields.phone3, permission: fields.permission === 'on' },
    } });
    if (version === generation) location.hash = 'payment=' + result.token;
  });
}

function showInfo(path) {
  if (path === '/brochure') {
    show(title('Summit Brochure') + '<p class="intro">Microbe Mashup ’26 · 11–12 December 2026</p>' +
      (catalog.hasBrochure ? '<a class="button" href="/summit-brochure.pdf" target="_blank" rel="noopener">Open brochure PDF</a>' :
        '<p>The official summit brochure will be added here when it’s available.</p>'));
    return;
  }
  show(title('Location') + `
    <p class="intro"><strong>Mamata Academy of Medical Sciences</strong><br>Bachupally, Hyderabad, Telangana</p>
    <a class="button" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&amp;query=Mamata+Academy+of+Medical+Sciences+Bachupally+Hyderabad">Open in Google Maps</a>
    <iframe class="location-map" title="Google map of Mamata Academy of Medical Sciences, Bachupally" loading="lazy" referrerpolicy="no-referrer"
      src="https://maps.google.com/maps?q=Mamata%20Academy%20of%20Medical%20Sciences%2C%20Bachupally%2C%20Hyderabad&amp;output=embed"></iframe>`);
}

async function showPayment(token, version) {
  show(title('Loading payment…'));
  let rendered;
  let checking = false;

  function render(order) {
    const current = JSON.stringify(order);
    if (rendered === current || version !== generation) return;
    rendered = current;
    const paid = order.state === 'paid';
    const pending = order.state === 'pending';
    const awaiting = pending && order.manual && order.utr;
    const activityNames = [...catalog.events, ...catalog.workshops]
      .filter((item) => order.items.includes(item.id)).map(({ name }) => name);
    show(title(paid ? 'Payment confirmed' : order.reviewMessage ? 'Payment reference needs attention' : awaiting ? 'Awaiting payment verification' :
      pending ? 'Complete your payment' : 'Payment link ' + order.state) +
      '<p class="intro">' + order.label + ' · ' + money(order.amount) + '</p>' +
      (order.partySize > 1 ? '<p class="hint">' + order.partySize + ' participants covered by this payment.</p>' : '') +
      (activityNames.length ? '<p class="hint">' + activityNames.join(', ') + '</p>' : '') +
      (order.participantId ? '<div class="card"><h3>' + order.participantId + '</h3><p>' +
        (order.partySize > 1 ? 'Group leader’s Registration ID' : 'Registration ID') + '</p></div>' : '') +
      '<p>' + (paid ? (order.product === 'summit'
        ? (order.partySize > 1 ? 'Each group member receives their own Registration ID and booking link by email.' : 'Keep your Registration ID to book Events & Workshops and check in at the summit.')
        : 'Your activity bookings are confirmed.') :
        pending ? (order.manual ? (order.reviewMessage ? 'Check the note from the organizers and review your payment details.' :
          awaiting ? 'The organizers will check your payment and email you once it’s verified.' :
          'Pay the exact amount by UPI and enter the transaction reference from your banking app.') :
          catalog.demo ? 'Simulate a successful payment to preview confirmation.' :
          'Pay on Razorpay, then return here to check the status. Your confirmation email is sent after verification.') :
          'Contact the organizers to arrange a new payment link.') + '</p><div class="actions"></div>');
    const actions = screen.querySelector('.actions');
    if (order.workshopToken) {
      actions.innerHTML = '<a class="button" href="/activities#access=' + order.workshopToken + '">Book Events &amp; Workshops</a>';
    } else if (paid && order.product !== 'summit') {
      actions.innerHTML = '<a class="button secondary" href="/activities' + (accessToken ? '#access=' + accessToken : '') + '">Back to Events &amp; Workshops</a>';
    }
    if (!pending) return;
    if (order.manual) {
      showManualPayment(order, actions, token, version, render);
      return;
    }
    if (order.checkout) {
      const link = document.createElement('a');
      link.className = 'button';
      link.href = order.checkout;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Pay ' + money(order.amount) + ' on Razorpay';
      actions.append(link);
    }
    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'secondary';
    check.textContent = 'Check payment';
    check.addEventListener('click', () => refresh(true));
    actions.append(check);
    if (catalog.demo) {
      const settle = document.createElement('button');
      settle.type = 'button';
      settle.textContent = 'Simulate successful payment';
      settle.addEventListener('click', async () => {
        settle.disabled = true;
        try { render(await api('demo/settle', { method: 'POST', token })); }
        catch (error) { if (version === generation) message(error.message); }
        finally { settle.disabled = false; }
      });
      actions.prepend(settle);
    }
  }

  async function refresh(manual = false) {
    if (checking || version !== generation) return;
    clearTimeout(timer);
    checking = true;
    try {
      const order = await api('payment', { method: 'POST', token });
      if (version !== generation) return;
      render(order);
      message(manual && order.state === 'pending' ? 'Payment is still pending.' : '');
      if (order.state === 'pending') timer = setTimeout(refresh, 15000);
    } catch (error) {
      if (version !== generation) return;
      message(error.message);
      timer = setTimeout(refresh, 20000);
    } finally { checking = false; }
  }
  const initial = await api('payment', { token });
  render(initial);
  if (initial.state === 'pending') await refresh();
}

function showManualPayment(order, actions, token, version, render) {
  const panel = document.createElement('div');
  panel.className = 'card manual-payment';
  panel.innerHTML = `
    <p id="manual-payee" hidden></p>
    ${catalog.hasQr && !order.utr && !order.reviewMessage ? '<img class="payment-qr" src="/payment-qr.png" alt="Scan to pay the event organizers by UPI">' : ''}
    <p class="hint" id="manual-order"></p>
    <form id="reference-form">
      <label class="field"><span>UPI transaction reference / UTR</span>
        <input name="utr" required maxlength="30" autocomplete="off" spellcheck="false">
      </label>
      <div class="actions"><button type="submit"></button></div>
    </form>`;
  actions.before(panel);
  if (order.reviewMessage) {
    const note = document.createElement('p');
    note.className = 'journey-note';
    note.textContent = order.reviewMessage;
    panel.before(note);
  }
  const payee = panel.querySelector('#manual-payee');
  if (catalog.upiId && !order.utr && !order.reviewMessage) {
    payee.textContent = catalog.payee + ' · UPI ID ' + catalog.upiId;
    payee.hidden = false;
    if (navigator.clipboard) {
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'secondary copy-upi';
      copy.textContent = 'Copy UPI ID';
      payee.after(copy);
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(catalog.upiId); message('UPI ID copied.'); }
        catch { message('Copy the UPI ID shown above.'); }
      });
    }
  }
  panel.querySelector('#manual-order').textContent = 'Order reference ' + order.orderReference;
  const form = panel.querySelector('form');
  form.elements.utr.value = order.utr || '';
  const button = form.querySelector('button');
  button.textContent = order.utr ? 'Update reference' : 'Submit for verification';
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    try {
      const data = await api('payment/reference', { method: 'POST', token, body: { utr: form.elements.utr.value } });
      if (version === generation) {
        render(data);
        message('Payment reference saved. Keep your banking receipt until the organizers confirm.');
      }
    } catch (error) { if (version === generation) message(error.message); }
    finally { button.disabled = false; }
  });
}

async function route() {
  if (!catalog) return;
  const version = ++generation;
  clearTimeout(timer);
  message();
  const [kind, token] = location.hash.slice(1).split('=');
  const path = location.pathname;
  const payment = kind === 'payment';
  // Existing confirmation emails used the home page and a workshops fragment.
  if (kind === 'workshops') {
    location.replace('/activities' + (/^[A-Za-z0-9_-]{32}$/.test(token || '') ? '#access=' + token : ''));
    return;
  }
  if (path === '/' && kind === 'register') {
    location.replace('/basic-registration');
    return;
  }
  const page = payment ? 'Payment status' : {
    '/basic-registration': 'Basic Registration', '/activities': 'Events & Workshops',
    '/brochure': 'Summit Brochure', '/location': 'Location',
  }[path];
  home.hidden = !!page;
  formArea.hidden = !page;
  formArea.querySelector('.flow-nav').hidden = !['/basic-registration', '/activities'].includes(path) && !payment;
  for (const link of document.querySelectorAll('[data-flow], .mast-nav a')) {
    if (link.getAttribute('href') === path) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (!page) return;
  document.title = page + ' · Microbe Mashup ’26';
  try {
    if (payment) await showPayment(token, version);
    else if (path === '/basic-registration') showBasic(version);
    else if (path === '/activities') {
      if (catalog.launchHold && !token) show(title('Events &amp; Workshops') +
        '<p class="intro">Activity booking opens after Basic Registration launches. Your confirmed Basic Registration email will contain your personal booking link.</p>');
      else showActivityGate(token, version);
    }
    else showInfo(path);
  } catch (error) {
    if (version !== generation) return;
    show(title(page === 'Events & Workshops' ? 'Events &amp; Workshops' : page));
    message(error.message);
  }
  if (version === generation && payment) {
    document.querySelector('#page-title')?.focus({ preventScroll: true });
    formArea.scrollIntoView();
  }
}

window.addEventListener('hashchange', route);
try {
  catalog = await api('catalog');
  const label = document.querySelector('#demo');
  label.hidden = !catalog.demo && !catalog.razorpayTest;
  if (catalog.razorpayTest) label.textContent = 'Razorpay Test Mode · No real charges';
  await route();
} catch {
  if (location.pathname !== '/' || location.hash.startsWith('#payment=')) {
    home.hidden = true;
    formArea.hidden = false;
    show(title('This page is temporarily unavailable'));
    message('Please reload the page or contact the organizers.');
  }
}
