const screen = document.querySelector('#screen');
const notice = document.querySelector('#notice');
const registerTab = document.querySelector('#register-tab');
const workshopTab = document.querySelector('#workshop-tab');
const money = (amount) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount);
let catalog;
let workshopToken = '';
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

function show(html) {
  screen.innerHTML = html;
}

function title(text) { return '<h2 id="page-title" tabindex="-1">' + text + '</h2>'; }
function input(name, label, attrs = '') {
  return '<label class="field"><span>' + label + '</span><input name="' + name + '" required ' + attrs + '></label>';
}
function select(name, label, options) {
  return '<label class="field"><span>' + label + '</span><select required name="' + name + '">' +
    '<option value="">Select ' + label.toLowerCase() + '</option>' +
    options.map(({ id, name }) => '<option value="' + id + '">' + name + '</option>').join('') + '</select></label>';
}
function activityOptions() {
  return ['Active', 'Passive', 'Team competition'].map((category) =>
    '<p class="category">' + category + '</p><div class="options">' +
    catalog.events.filter((event) => event.category === category).map((event) =>
      '<label class="option"><input type="checkbox" name="events" value="' + event.id + '"><span>' +
      event.name + '</span><strong>' + money(event.fee) + '</strong></label>').join('') + '</div>'
  ).join('');
}

function showRegistration(version) {
  if (!catalog.summitOpen) {
    show(title(catalog.launchHold ? 'Registration opens soon' : 'Summit registration is paused') +
      (catalog.launchHold
        ? '<p class="intro">Check back here when registration opens. Please wait to pay until you receive payment instructions from the site.</p>'
        : '<p class="intro">If you already registered, use the personal link in your registration email to complete payment or check its status.</p>'));
    return;
  }
  show(title('Register for the summit') + `
    <ol class="form-steps" aria-label="Registration progress">
      <li aria-current="step">Your details</li><li>Activities</li><li>Review</li>
    </ol>
    <form id="registration" novalidate>
      <section class="form-step" data-step="0" aria-labelledby="details-heading">
      <h3 id="details-heading" tabindex="-1">Your details</h3>
      <p class="intro">Use the email address where you want to receive your registration ID and payment updates.</p>
      <div class="grid">
        ${input('name', 'Full name', 'autocomplete="name" maxlength="120"')}
        ${input('email', 'Email address', 'type="email" autocomplete="email" maxlength="254"')}
        ${input('phone', 'Phone number', 'type="tel" autocomplete="tel" maxlength="24" title="Enter a 10-digit Indian phone number"')}
        ${select('batch', 'Batch', catalog.batches)}
        ${select('state', 'State or union territory', catalog.states.map((name) => ({ id: name, name })))}
        ${input('city', 'City', 'autocomplete="address-level2" maxlength="120"')}
        ${input('pincode', 'PIN code', 'inputmode="numeric" autocomplete="postal-code" pattern="[1-9][0-9]{5}" maxlength="6"')}
        ${input('college', 'Full college name', 'autocomplete="organization" maxlength="180"')}
        ${input('collegeCity', 'College city', 'maxlength="120"')}
      </div>
      </section>
      <section class="form-step" data-step="1" aria-labelledby="activities-heading" hidden>
      <h3 id="activities-heading" tabindex="-1">Activities and lunch</h3>
      <p class="intro">Workshops can be booked separately after your summit payment is verified.</p>
      <div class="grid">
        ${select('meal', 'Lunch preference', ['Veg', 'Non-veg'].map((name) => ({ id: name, name })))}
      </div>
      <p class="hint" id="eligibility" hidden>Your batch can attend the summit and register for workshops. Competition entries are open to 2k24 and 2k25 MBBS.</p>
      <section class="block" id="competitions" hidden aria-labelledby="competition-title">
        <h3 id="competition-title">Competitions</h3>
        <p class="hint">Leave these blank if you’re attending the summit without entering a competition.</p>
        ${activityOptions()}
        <fieldset class="team" id="team" disabled hidden>
          <legend>Microbe Mayhem team</legend>
          <p class="hint">Each team needs three people. Use the same team name when each member registers.</p>
          <div class="grid">
            ${input('teamName', 'Team name', 'maxlength="120"')}
            ${select('teamRole', 'Team role', [{ id: 'leader', name: 'Group leader' }, { id: 'member', name: 'Team member' }])}
          </div>
          <fieldset id="members" class="block" disabled hidden>
            <legend>Teammate details</legend>
            <div class="grid">
              ${input('member2', 'Second member name', 'maxlength="120"')}
              ${input('phone2', 'Second member phone', 'type="tel" maxlength="24"')}
              ${input('member3', 'Third member name', 'maxlength="120"')}
              ${input('phone3', 'Third member phone', 'type="tel" maxlength="24"')}
            </div>
            <label class="consent"><input type="checkbox" name="permission" required><span>I have my teammates’ permission to share these details.</span></label>
          </fieldset>
        </fieldset>
      </section>
      </section>
      <section class="form-step" data-step="2" aria-labelledby="review-heading" hidden>
        <h3 id="review-heading" tabindex="-1">Review before paying</h3>
        <p class="intro" id="payment-explainer"></p>
        <dl id="review-details" class="review-details"></dl>
        <ul id="review-charges" class="review-charges"></ul>
        <div class="block">
        <label class="consent"><input type="checkbox" name="consent" required><span>I agree that the organizers can use my details for registration, payment verification, certificates and event coordination.</span></label>
        </div>
      </section>
      <div class="paybar">
          <div class="total"><span id="total-label">Summit registration</span><strong id="total" aria-live="polite">${money(catalog.basicFee)}</strong></div>
          <div class="step-actions">
            <button type="button" id="back-step" class="secondary" hidden>Back</button>
            <button type="submit" id="continue-step">Continue</button>
          </div>
      </div>
    </form>`);
  const form = document.querySelector('#registration');
  const competitions = document.querySelector('#competitions');
  const team = document.querySelector('#team');
  const members = document.querySelector('#members');
  const checks = [...form.querySelectorAll('[name=events]')];
  const stepSections = [...form.querySelectorAll('[data-step]')];
  const stepLabels = [...document.querySelectorAll('.form-steps li')];
  const submit = document.querySelector('#continue-step');
  const back = document.querySelector('#back-step');
  let step = 0;

  function displayStep(next) {
    step = next;
    stepSections.forEach((section, index) => { section.hidden = index !== step; });
    stepLabels.forEach((label, index) => {
      if (index === step) label.setAttribute('aria-current', 'step');
      else label.removeAttribute('aria-current');
    });
    back.hidden = step === 0;
    submit.textContent = step === 2 ? 'Continue to payment' : 'Continue';
    if (step === 2) reviewRegistration();
    stepSections[step].querySelector('h3').focus();
  }

  function reviewRegistration() {
    const info = [
      ['Attendee', form.elements.name.value], ['Email', form.elements.email.value],
      ['Batch', catalog.batches.find(({ id }) => id === form.elements.batch.value).name],
      ['Lunch', form.elements.meal.value],
    ];
    document.querySelector('#review-details').replaceChildren(...info.map(([label, value]) => {
      const row = document.createElement('div');
      const term = document.createElement('dt');
      const detail = document.createElement('dd');
      term.textContent = label;
      detail.textContent = value;
      row.append(term, detail);
      return row;
    }));
    const choices = checks.filter((check) => check.checked).map((check) => check.value);
    const charges = [{ name: 'Summit pass', fee: catalog.basicFee }, ...catalog.events.filter(({ id }) => choices.includes(id))];
    document.querySelector('#review-charges').replaceChildren(...charges.map(({ name, fee }) => {
      const row = document.createElement('li');
      const label = document.createElement('span');
      const price = document.createElement('strong');
      label.textContent = name;
      price.textContent = money(fee);
      row.append(label, price);
      return row;
    }));
    document.querySelector('#payment-explainer').textContent = catalog.manual
      ? 'After submitting, pay by UPI and enter the transaction reference. The organizers will verify it before confirming your registration.'
      : 'After submitting, pay through the hosted checkout. Your registration is confirmed once payment is verified.';
  }

  function update() {
    const batch = catalog.batches.find(({ id }) => id === form.elements.batch.value);
    const allowed = !!batch?.competition;
    competitions.hidden = !allowed;
    document.querySelector('#eligibility').hidden = !batch || allowed;
    for (const check of checks) {
      check.disabled = !allowed;
      if (!allowed) check.checked = false;
    }
    const selected = checks.filter((check) => check.checked).map((check) => check.value);
    const mayhem = selected.includes('mayhem');
    team.hidden = team.disabled = !mayhem;
    members.hidden = members.disabled = !mayhem || form.elements.teamRole.value !== 'leader';
    const fee = catalog.basicFee + catalog.events.filter(({ id }) => selected.includes(id)).reduce((total, event) => total + event.fee, 0);
    document.querySelector('#total-label').textContent = selected.length ? 'Summit and selected competitions' : 'Summit registration';
    document.querySelector('#total').textContent = money(fee);
  }
  form.addEventListener('change', update);
  back.addEventListener('click', () => { message(); displayStep(step - 1); });
  update();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    message();
    for (const field of stepSections[step].querySelectorAll('input[type="tel"]')) {
      const phone = field.value.trim().replace(/[\s()-]/g, '').replace(/^\+91(?=\d{10}$)/, '');
      field.setCustomValidity(field.willValidate && phone && !/^\d{10}$/.test(phone) ? 'Enter a 10-digit Indian phone number.' : '');
    }
    const invalid = [...stepSections[step].querySelectorAll('input, select')]
      .find((field) => field.willValidate && !field.checkValidity());
    if (invalid) { invalid.reportValidity(); return; }
    if (step < 2) { displayStep(step + 1); return; }
    submit.disabled = true;
    const fields = new FormData(form);
    const data = Object.fromEntries(fields);
    data.events = fields.getAll('events');
    data.consent = fields.has('consent');
    data.team = {
      name: data.teamName, role: data.teamRole, member2: data.member2, phone2: data.phone2,
      member3: data.member3, phone3: data.phone3, permission: fields.has('permission'),
    };
    try {
      const result = await api('register', { method: 'POST', body: data });
      if (version !== generation) return;
      if (result.existing) {
        show(title('Check your email') + '<p>For an existing registration, use the payment link from your registration email. If you need help finding it, contact the organizers.</p>');
        document.querySelector('#page-title').focus({ preventScroll: true });
        return;
      }
      location.hash = 'payment=' + result.token;
    } catch (error) { if (version === generation) message(error.message); }
    finally { submit.disabled = false; }
  });
}

async function showWorkshops(token, version) {
  if (token) workshopToken = token;
  if (!workshopToken) {
    show(title('Workshops') + '<p class="intro">Open the personal workshop link in your summit payment confirmation email to book.</p>' +
      catalog.workshops.map((item) => workshopCard(item)).join(''));
    return;
  }
  show(title('Checking your registration…'));
  const data = await api('workshops', { token: workshopToken });
  if (version !== generation) return;
  show(title('Book your workshops') + '<p class="intro">Summit registration <strong>' + data.participantId +
    '</strong> is confirmed. Each workshop has its own payment.</p>' +
    (data.workshopsOpen ? '' : '<p class="journey-note">New bookings are paused. You can still complete an existing workshop payment.</p>') +
    catalog.workshops.map((item) => workshopCard(item, data.orders.find(({ product }) => product === item.id), data.workshopsOpen || data.orders.some(({ product }) => product === item.id))).join(''));
  for (const button of screen.querySelectorAll('[data-workshop]')) {
    button.addEventListener('click', async () => {
      message();
      button.disabled = true;
      try {
        const result = await api('workshops', { method: 'POST', token: workshopToken, body: { product: button.dataset.workshop } });
        if (version === generation) location.hash = 'payment=' + result.token;
      } catch (error) { if (version === generation) message(error.message); }
      finally { button.disabled = false; }
    });
  }
}

function workshopCard(item, order, eligible = false) {
  let action = '';
  if (eligible) {
    if (order?.state === 'paid') action = '<span class="tag">Confirmed</span>';
    else if (order) action = '<a class="button secondary" href="#payment=' + order.token + '">View payment</a>';
    else action = '<button type="button" data-workshop="' + item.id + '">Book workshop</button>';
  }
  return '<article class="card"><h3>' + item.name + '</h3><p>' + item.description + ' · <strong>' +
    money(item.fee) + '</strong></p>' + action + '</article>';
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
    show(title(paid ? 'Payment confirmed' : order.reviewMessage ? 'Payment reference needs attention' : awaiting ? 'Awaiting payment verification' :
      pending ? 'Complete your payment' : 'Payment link ' + order.state) +
      '<p class="intro">' + order.label + ' · ' + money(order.amount) + '</p>' +
      '<div class="card"><h3>' + order.participantId + '</h3><p>Registration ID</p></div>' +
      '<p>' + (paid ? 'Your place is confirmed. Keep your registration ID for check-in.' :
        pending ? (order.manual ? (order.reviewMessage ? 'Check the note from the organizers and review your payment details.' :
          awaiting ? 'The organizers will check your payment and email you once it’s verified.' :
          'Pay the exact amount by UPI and enter the transaction reference from your banking app.') :
          catalog.demo ? 'Simulate a successful payment to preview confirmation.' :
          'Pay on Razorpay, then return here to check the status. Your confirmation email is sent after verification.') :
          'Contact the organizers to arrange a new payment link.') + '</p><div class="actions"></div>');
    const actions = screen.querySelector('.actions');
    if (order.workshopToken) {
      workshopToken = order.workshopToken;
      actions.innerHTML = '<a class="button" href="#workshops=' + workshopToken + '">Book workshops</a>';
    } else if (paid && workshopToken) {
      actions.innerHTML = '<a class="button secondary" href="#workshops">Back to workshops</a>';
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
  const [page, token] = location.hash.slice(1).split('=');
  if (page === 'workshops') {
    registerTab.removeAttribute('aria-current');
    workshopTab.setAttribute('aria-current', 'page');
  } else {
    workshopTab.removeAttribute('aria-current');
    if (page === 'payment') registerTab.removeAttribute('aria-current');
    else registerTab.setAttribute('aria-current', 'page');
  }
  try {
    if (page === 'payment') await showPayment(token, version);
    else if (page === 'workshops') await showWorkshops(token, version);
    else showRegistration(version);
  } catch (error) {
    if (version !== generation) return;
    show(title(page === 'workshops' ? 'Workshops' : 'Registration'));
    message(error.message);
  }
  if (version === generation && page) {
    document.querySelector('#page-title')?.focus({ preventScroll: true });
    document.querySelector('#form-area').scrollIntoView();
  }
}

window.addEventListener('hashchange', route);
try {
  catalog = await api('catalog');
  const modeLabel = document.querySelector('#demo');
  modeLabel.hidden = !catalog.demo && !catalog.razorpayTest;
  if (catalog.razorpayTest) modeLabel.textContent = 'Razorpay Test Mode · No real charges';
  await route();
} catch {
  show(title('Registration is temporarily unavailable'));
  message('Please reload the page or contact the organizers.');
}
