'use strict';

// Unit test — client creation, the onboarding chain, and the chart's setup
// checklist (public/app/views/clients.js).
//
// Two properties this pins, both of which are about a client with NOTHING set:
//
// 1. EXISTING-CLIENT COMPATIBILITY. Every per-client billing default is
//    nullable with no DB default, so every row that existed before migration
//    021 has five nulls. Such a client must behave EXACTLY as it did before the
//    feature existed: no validation failure, no "undefined" rendered anywhere,
//    no accidental zero fee, no fallback billing data invented from nowhere.
//    The zero case matters most — a truthiness test rather than a null test
//    would turn "no default fee" into "bill nothing", and turn a deliberate
//    free session into "bill the client's default rate".
//
// 2. ONBOARDING IS SKIPPABLE AND RESUMABLE. The client is created by its own
//    committed request BEFORE the chain starts, so creation is never contingent
//    on finishing the billing steps. Dismissing any step leaves the client
//    intact, and the chart's "Finish setting up" checklist is the way back into
//    whatever was skipped.
//
// clients.js is a browser IIFE, so it is evaluated against a minimal fake DOM
// and a fake window.Reddably kit whose api is a recording stub. Fixtures are
// synthetic — no PHI.
//
//   node backend/tests/client_onboarding_ui.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// --- a minimal fake DOM ------------------------------------------------------

function textNode(value) {
  return { nodeType: 3, textContent: String(value), childNodes: [] };
}

function createElement(tag) {
  const el = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    className: '',
    attributes: {},
    dataset: {},
    childNodes: [],
    listeners: {},
    parentNode: null,
    disabled: false,
    value: '',
    appendChild(child) { child.parentNode = el; el.childNodes.push(child); return child; },
    removeChild(child) {
      const i = el.childNodes.indexOf(child);
      if (i !== -1) el.childNodes.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute(name, value) {
      el.attributes[name] = String(value);
      if (name === 'value') el.value = String(value);
      if (name === 'disabled') el.disabled = true;
    },
    addEventListener(type, fn) { (el.listeners[type] || (el.listeners[type] = [])).push(fn); },
    dispatch(type, arg) { (el.listeners[type] || []).forEach((fn) => fn(arg || { target: el })); },
    get firstChild() { return el.childNodes[0]; },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return el.childNodes.map((c) => c.textContent).join(''); },
    set(v) { el.childNodes = [textNode(v)]; },
  });
  return el;
}

const fakeDocument = { createElement, createTextNode: textNode };

function h(tag, attrs, children) {
  const el = createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach((key) => {
      const val = attrs[key];
      if (val === null || val === undefined || val === false) return;
      if (key === 'class' || key === 'className') el.className = val;
      else if (key === 'text' || key === 'textContent') el.textContent = val;
      else if (key.indexOf('on') === 0 && typeof val === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), val);
      } else el.setAttribute(key, val);
    });
  }
  append(el, children);
  return el;
}

function append(el, children) {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) { children.forEach((c) => append(el, c)); return; }
  el.appendChild(children.nodeType ? children : textNode(children));
}

function walk(node, out) {
  out = out || [];
  (node.childNodes || []).forEach((c) => {
    if (c.nodeType === 1) { out.push(c); walk(c, out); }
  });
  return out;
}

function byLabel(root, label) {
  return walk(root).filter((el) => el.tagName === 'BUTTON')
    .find((b) => b.textContent === label) || null;
}

// --- fixtures ----------------------------------------------------------------

const CLIENT_ID = 'c-1';

// A client as it exists on a database that has had migration 021 applied but has
// never had a default set — i.e. EVERY row that predates the feature. All five
// default columns are null, exactly as `add column if not exists <name> <type>`
// leaves them (nullable, no DB default, no backfill).
function legacyClient(over) {
  return Object.assign({
    id: CLIENT_ID,
    practice_id: 'p-1',
    primary_clinician_id: 'u-1',
    first_name: 'Legacy',
    last_name: 'Client',
    status: 'active',
    phone: '+13035550123',
    date_of_birth: '1990-01-01',
    gender: 'female',
    address_line1: '1 Main St',
    city: 'Denver',
    state: 'CO',
    postal_code: '80202',
    diagnosis_codes: null,
    default_cpt_code: null,
    default_place_of_service: null,
    default_session_fee: null,
    default_procedure_modifiers: null,
    calendar_display_name: null,
    payment_method_last4: '4242',      // billing already resolved
    payment_method_brand: 'visa',
  }, over || {});
}

function policy(over) {
  return Object.assign({
    id: 'ins-1',
    client_id: CLIENT_ID,
    carrier_name: 'Aetna',
    member_id: 'W1',
    payer_id: '60054',
    is_primary: true,
    is_hidden: false,
    benefits_checked_at: '2026-08-01T00:00:00.000Z',
    benefits_summary: { active: true },
  }, over || {});
}

// --- recording stubs ----------------------------------------------------------

const calls = [];
const toasts = [];
let currentClient = legacyClient();
let currentInsurance = [policy()];
let createdClient = null;
// Queue of values each successive formModal call resolves with. `null` = the
// user dismissed that step.
let formQueue = [];
let confirmQueue = [];
let roster = [
  { id: 'u-1', first_name: 'Pat', last_name: 'Lee', role: 'clinician' },
  { id: 'u-2', first_name: 'Sam', last_name: 'Ng', role: 'clinician' },
];
let practiceRow = { default_cpt_code: '90837', default_place_of_service: '11',
  default_session_fee: '175.00', default_procedure_modifiers: ['95'] };
let signedInUser = { id: 'u-1', role: 'clinician' };
const navigations = [];

const api = {
  clients: {
    get(id) { calls.push({ name: 'clients.get', id }); return Promise.resolve({ client: currentClient }); },
    list() { calls.push({ name: 'clients.list' }); return Promise.resolve({ clients: [currentClient] }); },
    create(payload) {
      calls.push({ name: 'clients.create', payload });
      createdClient = legacyClient({ id: 'c-new', first_name: 'Brand', last_name: 'New' });
      return Promise.resolve({ client: createdClient });
    },
    update(id, payload) { calls.push({ name: 'clients.update', id, payload }); return Promise.resolve({ client: currentClient }); },
    sendPaymentLink(id) { calls.push({ name: 'clients.sendPaymentLink', id }); return Promise.resolve({ ok: true }); },
  },
  insuranceRecords: {
    list() { return Promise.resolve({ insurance_records: currentInsurance }); },
    update() { return Promise.resolve({}); },
  },
  sessions: { list() { return Promise.resolve({ sessions: [] }); } },
  users: { list() { return Promise.resolve({ users: roster }); } },
  practice: { get() { return Promise.resolve({ practice: practiceRow }); } },
  calendarEvents: {
    list() { calls.push({ name: 'calendarEvents.list' }); return Promise.resolve({ calendar_events: [] }); },
    promote(id, clientId) { calls.push({ name: 'calendarEvents.promote', id, clientId }); return Promise.resolve({}); },
  },
};

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

let viewFn = null;
const Reddably = {
  h,
  api,
  clear,
  get currentUser() { return { user: signedInUser }; },
  renderLoading(root) { clear(root); root.appendChild(h('div', { class: 'skeleton' })); },
  renderError(root, err) { clear(root); root.appendChild(h('div', { class: 'inline-error' }, String(err && err.message))); },
  renderEmpty(root, opts) {
    clear(root);
    const btn = h('button', { class: 'btn', onClick: opts.onAction }, opts.actionLabel || 'Action');
    root.appendChild(h('div', { class: 'empty-state' }, [opts.title, btn]));
  },
  fmtDate(s) { return s ? String(s).slice(0, 10) : '—'; },
  fmtMoney(v) { return v == null ? '—' : '$' + v; },
  statusBadge(status) { return h('span', { class: 'badge badge--neutral' }, status); },
  toast(message, tone, dwell) { toasts.push({ message, tone, dwell }); },
  navigate(route) { navigations.push(route); },
  confirmModal() {
    return Promise.resolve(confirmQueue.length ? confirmQueue.shift() : false);
  },
  formModal(opts) {
    calls.push({
      name: 'formModal', title: opts.title,
      fields: (opts.fields || []).map((f) => f.name),
      fieldDefs: opts.fields || [], values: opts.values || {}, actions: opts.actions || null,
    });
    const v = formQueue.length ? formQueue.shift() : null;
    if (!v) return Promise.resolve(null);
    // The real modal runs onSubmit with the collected values while it is still open,
    // then resolves; a rejection keeps it open (resolves nothing here).
    if (typeof opts.onSubmit === 'function') {
      return Promise.resolve(opts.onSubmit(v)).then(() => v, () => null);
    }
    return Promise.resolve(v);
  },
  registerView(name, fn) { if (name === 'clients') viewFn = fn; },
};

const APP = path.join(__dirname, '..', '..', 'public', 'app');
const context = vm.createContext({
  window: {
    Reddably,
    ReddablyDiagnoses: { label(c) { return c; } },
    ReddablyPhone: { normalize(v) { return { ok: true, value: v }; } },
    ReddablyPlan: { state: { loaded: true }, get() { return 'founder'; } },
    location: { hash: '' },
  },
  document: fakeDocument,
  console,
  Promise,
  Date,
});
vm.runInContext(fs.readFileSync(path.join(APP, 'client-defaults.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(APP, 'views', 'clients.js'), 'utf8'), context);
assert.ok(typeof viewFn === 'function', 'clients.js registers the clients view');

function flush() {
  return new Promise((resolve) => setImmediate(() => setImmediate(() =>
    setImmediate(() => setImmediate(() => setImmediate(resolve))))));
}

function reset() {
  calls.length = 0;
  toasts.length = 0;
  currentClient = legacyClient();
  currentInsurance = [policy()];
  createdClient = null;
  formQueue = [];
  confirmQueue = [];
  navigations.length = 0;
  signedInUser = { id: 'u-1', role: 'clinician' };
  roster = [
    { id: 'u-1', first_name: 'Pat', last_name: 'Lee', role: 'clinician' },
    { id: 'u-2', first_name: 'Sam', last_name: 'Ng', role: 'clinician' },
  ];
}

async function chart(clientOver, insurance) {
  currentClient = legacyClient(clientOver);
  if (insurance !== undefined) currentInsurance = insurance;
  const root = createElement('div');
  viewFn(root, [CLIENT_ID]);
  await flush();
  return root;
}

async function clientList() {
  const root = createElement('div');
  viewFn(root, []);
  await flush();
  return root;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- 1. existing-client compatibility ----------------------------------------

test('a client with no defaults renders with no "undefined" anywhere', async () => {
  const root = await chart();
  assert.ok(!/undefined/.test(root.textContent),
    'a null default must never reach the page as the string "undefined"');
  assert.ok(!/null/.test(root.textContent),
    'nor as the string "null"');
});

test('a client with no defaults shows the defaults item as outstanding', async () => {
  const root = await chart();
  assert.ok(/Finish setting up/.test(root.textContent), 'the checklist is shown');
  assert.ok(/Set claim defaults/.test(root.textContent),
    'the unset defaults are named as outstanding work, not silently assumed');
  // And it explains the consequence rather than just listing a chore.
  assert.ok(/no CPT code, place of service or fee/i.test(root.textContent));
});

test('a client WITH defaults set drops that checklist item', async () => {
  const root = await chart({ default_cpt_code: '90837' });
  assert.ok(!/Set claim defaults/.test(root.textContent),
    'a resolved item disappears — a checklist of ticks is a nag, not information');
});

test('a zero default fee counts as SET, not as absent', async () => {
  // The bug a truthiness test would introduce: a genuinely free session is a
  // real default, and the checklist must not nag for it forever.
  const root = await chart({ default_session_fee: 0 });
  assert.ok(!/Set claim defaults/.test(root.textContent),
    'a 0 fee is a deliberate value, not an unset one');
});

test('the checklist vanishes entirely once nothing is outstanding', async () => {
  const root = await chart({ default_cpt_code: '90837' });
  assert.ok(!/Finish setting up/.test(root.textContent),
    'card + insurance + defaults all present → no card at all');
});

test('a client with nothing set at all lists every outstanding item', async () => {
  const root = await chart(
    { payment_method_last4: null, payment_method_brand: null, primary_clinician_id: null },
    []
  );
  assert.ok(/Save a card for the per-claim fee/.test(root.textContent));
  assert.ok(/Assign a clinician/.test(root.textContent));
  assert.ok(/Add an insurance policy/.test(root.textContent));
  assert.ok(/Set claim defaults/.test(root.textContent));
  assert.ok(/4 items left/.test(root.textContent), 'the count is honest');
});

// --- 2. New client is ONE screen ----------------------------------------------

async function openNewClient() {
  const root = await clientList();
  const newBtn = byLabel(root, 'New client');
  assert.ok(newBtn, 'the New client action exists');
  return newBtn;
}
const formCall = () => calls.filter((c) => c.name === 'formModal').slice(-1)[0];

test('New client opens exactly ONE form, in the specified order, with no Status field', async () => {
  const newBtn = await openNewClient();
  formQueue = [];                       // dismissed
  newBtn.dispatch('click');
  await flush();
  const forms = calls.filter((c) => c.name === 'formModal');
  assert.strictEqual(forms.length, 1, 'one modal, never a chain');
  const names = forms[0].fields;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(names.slice(0, 8))),
    ['first_name', 'last_name', 'preferred_name', 'phone', 'email', 'gender',
      'primary_clinician_id', 'diagnosis_codes']);
  assert.ok(names.indexOf('status') === -1, 'no raw Status dropdown on create');
  assert.ok(names.indexOf('default_cpt_code') > names.indexOf('diagnosis_codes'),
    'session defaults come after the diagnosis');
  const gender = forms[0].fieldDefs.find((f) => f.name === 'gender');
  assert.ok(!gender.required, 'Biological Sex is optional on create');
});

test('the session-defaults fields are one COLLAPSED group, pre-filled from the practice', async () => {
  const newBtn = await openNewClient();
  newBtn.dispatch('click');
  await flush();
  const f = formCall();
  const defaults = f.fieldDefs.filter((d) => d.name.indexOf('default_') === 0);
  assert.strictEqual(defaults.length, 4);
  assert.ok(defaults.every((d) => d.group === 'Session defaults' && !d.groupOpen),
    'grouped, and not opened by default');
  assert.strictEqual(f.values.default_cpt_code, '90837');
  assert.strictEqual(f.values.default_place_of_service, '11');
  assert.strictEqual(f.values.default_session_fee, '175.00');
  assert.strictEqual(f.values.default_procedure_modifiers, '95');
});

test('the clinician defaults to the signed-in clinician', async () => {
  signedInUser = { id: 'u-2', role: 'clinician' };
  const newBtn = await openNewClient();
  newBtn.dispatch('click');
  await flush();
  assert.strictEqual(formCall().values.primary_clinician_id, 'u-2');
});

test('an admin who is not a clinician starts Unassigned in a multi-person practice', async () => {
  signedInUser = { id: 'u-9', role: 'practice_admin' };
  roster = roster.concat([{ id: 'u-9', first_name: 'Ad', last_name: 'Min', role: 'practice_admin' }]);
  const newBtn = await openNewClient();
  newBtn.dispatch('click');
  await flush();
  assert.strictEqual(formCall().values.primary_clinician_id, '');
});

test('a one-person practice defaults to its only user', async () => {
  signedInUser = { id: 'u-9', role: 'practice_admin' };
  roster = [{ id: 'u-9', first_name: 'Solo', last_name: 'Owner', role: 'practice_admin' }];
  const newBtn = await openNewClient();
  newBtn.dispatch('click');
  await flush();
  assert.strictEqual(formCall().values.primary_clinician_id, 'u-9');
});

test('the two actions: "Save & send payment link" (primary, needs a phone) and "Save only"', async () => {
  const newBtn = await openNewClient();
  newBtn.dispatch('click');
  await flush();
  const actions = formCall().actions;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actions.map((a) => a.label))), ['Save & send payment link', 'Save only']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actions[0].requires)), ['phone'], 'the SMS-only link requires a phone');
  assert.ok(!actions[1].requires);
  assert.ok(actions[1].enter && !actions[0].enter,
    'Enter in a field triggers the quiet Save only, never the SMS');
});

test('Save & send: the client is created by its OWN request, then the link is sent', async () => {
  const newBtn = await openNewClient();
  formQueue = [{ _action: 'send', first_name: 'Brand', last_name: 'New', phone: '+13035550100',
    primary_clinician_id: 'u-1', default_cpt_code: '90837' }];
  newBtn.dispatch('click');
  await flush();
  const order = calls.filter((c) => ['clients.create', 'clients.sendPaymentLink'].includes(c.name))
    .map((c) => c.name);
  assert.deepStrictEqual(order, ['clients.create', 'clients.sendPaymentLink']);
  const created = calls.find((c) => c.name === 'clients.create').payload;
  assert.strictEqual(created.primary_clinician_id, 'u-1', 'the clinician is the primary clinician');
  assert.strictEqual(created.default_cpt_code, '90837', 'per-client session defaults ride along');
  assert.ok(!('_action' in created), 'the form-only action key never reaches the API');
  assert.ok(!('status' in created), 'status is never sent on create');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(navigations)), ['clients/c-new'], 'lands on the new chart');
});

test('Save only creates the client and sends NO link', async () => {
  const newBtn = await openNewClient();
  formQueue = [{ _action: 'save', first_name: 'Brand', last_name: 'New' }];
  newBtn.dispatch('click');
  await flush();
  assert.strictEqual(calls.filter((c) => c.name === 'clients.create').length, 1);
  assert.ok(!calls.some((c) => c.name === 'clients.sendPaymentLink'));
  assert.ok(!toasts.some((t) => t.tone === 'error'));
});

test('a failed link send still saves the client and says exactly that', async () => {
  const original = api.clients.sendPaymentLink;
  api.clients.sendPaymentLink = (id) => {
    calls.push({ name: 'clients.sendPaymentLink', id });
    return Promise.reject(new Error('Twilio unavailable'));
  };
  const newBtn = await openNewClient();
  formQueue = [{ _action: 'send', first_name: 'Brand', last_name: 'New', phone: '+13035550100' }];
  newBtn.dispatch('click');
  await flush();
  api.clients.sendPaymentLink = original;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(navigations)), ['clients/c-new'], 'the client exists, so we go to it');
  const err = toasts.find((t) => t.tone === 'error');
  assert.ok(err && /Client saved, but the payment link could not be sent/.test(err.message));
});

test('a failed create keeps the form open and navigates nowhere', async () => {
  const original = api.clients.create;
  api.clients.create = (payload) => { calls.push({ name: 'clients.create', payload }); return Promise.reject(new Error('boom')); };
  const newBtn = await openNewClient();
  formQueue = [{ _action: 'send', first_name: 'Brand', last_name: 'New', phone: '+13035550100' }];
  newBtn.dispatch('click');
  await flush();
  api.clients.create = original;
  assert.deepStrictEqual(navigations, []);
  assert.ok(!calls.some((c) => c.name === 'clients.sendPaymentLink'), 'no link for a client that was not saved');
  assert.ok(toasts.some((t) => t.tone === 'error' && /boom/.test(t.message)));
});

test('creating a client no longer asks anything afterwards: no defaults, link or calendar pop-up', async () => {
  const newBtn = await openNewClient();
  formQueue = [{ _action: 'save', first_name: 'Brand', last_name: 'New' }];
  newBtn.dispatch('click');
  await flush();
  assert.strictEqual(calls.filter((c) => c.name === 'formModal').length, 1);
  assert.ok(!calls.some((c) => c.name === 'calendarEvents.list'),
    'calendar matching is no longer part of creation');
});

test('the form still opens when the roster / practice lookups fail', async () => {
  const u = api.users.list; const p = api.practice.get;
  api.users.list = () => Promise.reject(new Error('down'));
  api.practice.get = () => Promise.reject(new Error('down'));
  const newBtn = await openNewClient();
  newBtn.dispatch('click');
  await flush();
  api.users.list = u; api.practice.get = p;
  const f = formCall();
  assert.ok(f, 'the form opened');
  assert.ok(f.fields.indexOf('primary_clinician_id') === -1, 'no clinician field without a roster');
});

// --- 3. unmatched calendar events are an inline suggestion, not a modal ---------

test('unmatched calendar events show an inline card on the chart with a Match button', async () => {
  const original = api.calendarEvents.list;
  api.calendarEvents.list = () => Promise.resolve({ calendar_events: [
    { id: 'ev-1', starts_at: '2026-10-05T15:00:00Z', summary_raw: 'Appt', event_status: 'confirmed', match_state: 'unmatched', session_id: null },
    { id: 'ev-2', starts_at: '2026-10-06T15:00:00Z', summary_raw: 'Done', event_status: 'confirmed', session_id: 's-1' },
    { id: 'ev-3', starts_at: '2026-10-07T15:00:00Z', summary_raw: 'Gone', event_status: 'cancelled', session_id: null },
  ] });
  const root = await chart();
  api.calendarEvents.list = original;
  assert.ok(/Appointments on your calendar/.test(root.textContent));
  assert.ok(/1 appointment isn’t matched/.test(root.textContent), 'only the unpromoted, live event counts');
  assert.ok(!calls.some((c) => c.name === 'formModal'), 'no modal');
  byLabel(root, 'Match appointment').dispatch('click');
  await flush();
  const promote = calls.find((c) => c.name === 'calendarEvents.promote');
  assert.ok(promote, 'matching is an explicit click');
  assert.strictEqual(promote.clientId, CLIENT_ID);
});

test('no unmatched events → no suggestion card at all', async () => {
  const root = await chart();
  assert.ok(!/Appointments on your calendar/.test(root.textContent));
});

test('an unassigned client gets an "Assign a clinician" checklist item', async () => {
  const root = await chart({ primary_clinician_id: null });
  assert.ok(/Assign a clinician/.test(root.textContent));
  assert.ok(byLabel(root, 'Assign'), 'with an action that opens Edit');
});

test('the checklist is the way back into the skipped defaults step', async () => {
  reset();
  const root = await chart();   // no defaults set
  const button = byLabel(root, 'Set defaults');
  assert.ok(button, 'the checklist offers the action');

  formQueue = [{ default_cpt_code: '90837', default_session_fee: 175 }];
  button.dispatch('click');
  await flush();

  const update = calls.find((c) => c.name === 'clients.update');
  assert.ok(update, 'it reopens the same step and saves');
  assert.deepStrictEqual(Object.keys(update.payload).sort(),
    ['default_cpt_code', 'default_session_fee']);
});

test('the checklist offers no payment-link button without a phone', async () => {
  const root = await chart({
    payment_method_last4: null, payment_method_brand: null, phone: null,
  });
  assert.ok(/Save a card for the per-claim fee/.test(root.textContent), 'still listed');
  assert.ok(/Add a phone number first/.test(root.textContent), 'the prerequisite is named');
  assert.strictEqual(byLabel(root, 'Send payment link'), null,
    'no dead-end button: the endpoint 400s without a phone');
});

// --- runner -------------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      reset();
      await t.fn();
      console.log('  ok  ' + t.name);
    } catch (err) {
      failed++;
      console.error('FAIL  ' + t.name + '\n      ' + (err && err.message));
    }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
