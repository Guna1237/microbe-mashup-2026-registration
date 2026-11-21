const env = process.env;
function fee(name, fallback) {
  const value = Number(env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) {
    throw new Error(name + ' must be a positive whole-rupee amount.');
  }
  return value;
}

export const basicFee = fee('BASIC_FEE', 800);
export const basicRates = { 1: basicFee, 3: 750, 4: 750, 5: 700 };

export const batches = [
  { id: 'mbbs24', name: '2k24 MBBS', competition: true },
  { id: 'mbbs25', name: '2k25 MBBS', competition: true },
  { id: 'bds24', name: '2k24 BDS', competition: false },
  { id: 'final', name: 'Final Year / Interns', competition: false },
  { id: 'pg', name: 'Microbiology PGs', competition: false },
];

export const events = [
  { id: 'quiz', name: 'Quiz', category: 'Active', fee: 250 },
  { id: 'debate', name: 'Debate', category: 'Active', fee: 250 },
  { id: 'spell', name: 'Spell Bee', category: 'Active', fee: 250 },
  { id: 'poster', name: 'Poster Presentation', category: 'Passive', fee: 200 },
  { id: 'doodle', name: 'Doodling', category: 'Passive', fee: 200 },
  { id: 'fashion', name: 'Fashion Parade', category: 'Passive', fee: 200 },
  { id: 'mayhem', name: 'Microbe Mayhem', category: 'Team competition', fee: 200 },
];

export const workshops = [
  { id: 'ipc', name: 'IPC in Action', description: 'Simulated ICU training', fee: fee('IPC_FEE', 2500) },
  { id: 'antibiotic', name: 'Antibiotic IQ', description: 'Know the Bug, Nail the Drug', fee: fee('ANTIBIOTIC_FEE', 2200) },
  { id: 'beyond', name: 'Beyond the White Coat', description: 'An experiential workshop for medical students', fee: fee('BEYOND_FEE', 4999) },
];

export const states = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar',
  'Chandigarh', 'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand',
  'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra',
  'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
  'Uttarakhand', 'West Bengal',
];

export class InputError extends Error {}

function field(data, name, label, limit = 120) {
  const value = typeof data[name] === 'string' ? data[name].trim() : '';
  if (!value || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new InputError('Enter a valid ' + label + '.');
  }
  return value;
}

function phone(value) {
  const normalized = value.replace(/[\s()-]/g, '').replace(/^\+91(?=\d{10}$)/, '');
  if (!/^\d{10}$/.test(normalized)) throw new InputError('Enter a 10-digit phone number.');
  return normalized;
}

export function emailAddress(value) {
  const email = field({ value }, 'value', 'email address', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InputError('Enter a valid email address.');
  return email;
}

function participant(body) {
  if (!body || typeof body !== 'object') throw new InputError('Enter the details for every participant.');
  const batch = batches.find(({ id }) => id === body.batch);
  if (!batch) throw new InputError('Select your batch.');
  if (!['Veg', 'Non-veg'].includes(body.meal)) throw new InputError('Select a meal preference.');
  const details = {
    name: field(body, 'name', 'full name').toUpperCase(),
    email: emailAddress(body.email),
    phone: phone(field(body, 'phone', 'phone number', 24)),
    batch: batch.id,
    college: field(body, 'college', 'college name', 180).toUpperCase(),
    meal: body.meal,
  };
  for (const [key, label] of [['city','city'], ['collegeCity','college city']]) {
    if (body[key]) details[key] = field(body, key, label);
  }
  if (body.state) {
    if (!states.includes(body.state)) throw new InputError('Select your state or union territory.');
    details.state = body.state;
  }
  if (body.pincode) {
    const pincode = field(body, 'pincode', 'PIN code', 6);
    if (!/^[1-9]\d{5}$/.test(pincode)) throw new InputError('Enter a six-digit PIN code.');
    details.pincode = pincode;
  }
  return details;
}

export function registration(body) {
  if (body.consent !== true) throw new InputError('Accept the registration data notice.');
  if (body.events?.length) throw new InputError('Book events separately after Basic Registration.');
  const members = body.members === undefined ? [body] : body.members;
  if (!Array.isArray(members) || !Object.hasOwn(basicRates, members.length)) {
    throw new InputError('Register individually or choose a group of 3, 4 or 5.');
  }
  if (members.length > 1 && body.groupConsent !== true) throw new InputError('Confirm you can share the group members’ details.');
  const people = members.map(participant);
  if (new Set(people.map(({ email }) => email)).size !== people.length) {
    throw new InputError('Use a different email address for each participant.');
  }
  return { people, amount: basicRates[people.length] * people.length * 100 };
}

export const activities = [...events.map((item) => ({ ...item, type: 'event' })),
  ...workshops.map((item) => ({ ...item, type: 'workshop' }))];

export function activitySelection(body, person) {
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > activities.length ||
      new Set(body.items).size !== body.items.length) throw new InputError('Select one or more activities.');
  const items = body.items.map((id) => activities.find((item) => item.id === id));
  if (items.some((item) => !item)) throw new InputError('Select valid activities.');
  if (items.some(({ type }) => type === 'event') && !batches.find(({ id }) => id === person.batch)?.competition) {
    throw new InputError('This batch can book workshops. Competitions are open to 2k24 and 2k25 MBBS.');
  }
  let team;
  if (body.items.includes('mayhem')) {
    const input = body.team || {};
    if (!['leader', 'member'].includes(input.role)) throw new InputError('Select your Microbe Mayhem team role.');
    team = { name: field(input, 'name', 'team name').toUpperCase(), role: input.role };
    if (team.role === 'leader') {
      if (input.permission !== true) throw new InputError('Confirm permission to share your teammates’ details.');
      team.members = [
        { name: person.name, phone: person.phone },
        { name: field(input, 'member2', 'second team member’s name').toUpperCase(), phone: phone(field(input, 'phone2', 'second member’s phone', 24)) },
        { name: field(input, 'member3', 'third team member’s name').toUpperCase(), phone: phone(field(input, 'phone3', 'third member’s phone', 24)) },
      ];
      if (new Set(team.members.map((member) => member.phone)).size !== 3) throw new InputError('Enter a different phone number for each team member.');
    }
  }
  return { items, team };
}
