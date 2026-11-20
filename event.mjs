const env = process.env;
function fee(name, fallback) {
  const value = Number(env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) {
    throw new Error(name + ' must be a positive whole-rupee amount.');
  }
  return value;
}

export const basicFee = fee('BASIC_FEE', 800);

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

export function registration(body) {
  const batch = batches.find(({ id }) => id === body.batch);
  if (!batch) throw new InputError('Select your batch.');
  if (!states.includes(body.state)) throw new InputError('Select your state or union territory.');
  if (!['Veg', 'Non-veg'].includes(body.meal)) throw new InputError('Select a meal preference.');
  if (body.consent !== true) throw new InputError('Accept the registration data notice.');
  if (!Array.isArray(body.events) || body.events.length > events.length ||
      body.events.some((id) => !events.some((event) => event.id === id))) {
    throw new InputError('Select valid competition options.');
  }
  const eventIds = [...new Set(body.events)];
  if (!batch.competition && eventIds.length) {
    throw new InputError('This batch can register for the summit and workshops. Competitions are restricted to 2k24 and 2k25 MBBS.');
  }
  const pincode = field(body, 'pincode', 'PIN code', 6);
  if (!/^[1-9]\d{5}$/.test(pincode)) throw new InputError('Enter a six-digit PIN code.');
  const details = {
    name: field(body, 'name', 'full name').toUpperCase(),
    email: emailAddress(body.email),
    phone: phone(field(body, 'phone', 'phone number', 24)),
    batch: batch.id,
    state: body.state,
    city: field(body, 'city', 'city'),
    pincode,
    college: field(body, 'college', 'college name', 180).toUpperCase(),
    collegeCity: field(body, 'collegeCity', 'college city'),
    meal: body.meal,
    events: eventIds,
  };
  if (eventIds.includes('mayhem')) {
    const team = body.team && typeof body.team === 'object' ? body.team : {};
    if (!['leader', 'member'].includes(team.role)) throw new InputError('Select your Microbe Mayhem team role.');
    details.team = { name: field(team, 'name', 'team name').toUpperCase(), role: team.role };
    if (team.role === 'leader') {
      if (team.permission !== true) throw new InputError('Confirm permission to share your teammates’ details.');
      details.team.members = [
        { name: details.name, phone: details.phone },
        { name: field(team, 'member2', 'second team member’s name').toUpperCase(), phone: phone(field(team, 'phone2', 'second member’s phone', 24)) },
        { name: field(team, 'member3', 'third team member’s name').toUpperCase(), phone: phone(field(team, 'phone3', 'third member’s phone', 24)) },
      ];
      if (new Set(details.team.members.map((member) => member.phone)).size !== 3) {
        throw new InputError('Enter a different phone number for each team member.');
      }
    }
  }
  const amount = 100 * (basicFee + events.filter(({ id }) => eventIds.includes(id)).reduce((total, event) => total + event.fee, 0));
  return { details, amount };
}
