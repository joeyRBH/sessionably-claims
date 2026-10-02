'use strict';

// UI test — the manual "Add session" form on the client chart shows the billing
// values that will ACTUALLY be applied (client default, else practice default),
// not blanks (public/app/views/clients.js).
//
// The server stays authoritative (lib/billing_fields.js applyClientDefaults); this
// pins that the form mirrors it: client > practice per field, the practice
// duration fills in, a hint says where each value came from, and editing a session
// does not get re-seeded. clients.js is a browser IIFE evaluated against a minimal
// fake DOM and a recording kit. Fixtures are synthetic — no PHI.
//
//   node backend/tests/session_form_defaults_ui.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
    dispatch(type, arg) {
      (el.listeners[type] || []).forEach((fn) => fn(arg || { target: el, stopPropagation() {} }));
    },
    get firstChild() { return el.childNodes[0]; },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return el.childNodes.map((c) => c.textContent).join(''); },
    set(v) { el.childNodes = [textNode(v)]; },
  });
  return el;
}

const fakeDocument = { createElement, createTextNode: textNode };

function append(el, children) {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) { children.forEach((c) => append(el, c)); return; }
  el.appendChild(children.nodeType ? children : textNode(children));
}

// h() mirroring public/app/views.js.
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

function walk(node, out) {
  out = out || [];
  (node.childNodes || []).forEach((c) => { if (c.nodeType === 1) { out.push(c); walk(c, out); } });
  return out;
}

const CLIENT_ID = '11111111-2222-3333-4444-555555555555';

let client;
let practice;
let practiceFails = false;
let lastForm = null;

const api = {
  clients: { get() { return Promise.resolve({ client }); } },
  insuranceRecords: { list() { return Promise.resolve({ insurance_records: [] }); } },
  sessions: { list() { return Promise.resolve({ sessions: [] }); } },
  users: { list() { return Promise.resolve({ users: [{ id: 'u1', first_name: 'Pat', last_name: 'Lee' }] }); } },
  practice: {
    get() { return practiceFails ? Promise.reject(new Error('down')) : Promise.resolve({ practice }); },
  },
};

const Reddably = {
  h, api,
  clear(el) { while (el.firstChild) el.removeChild(el.firstChild); },
  currentUser: { user: { id: 'u1', role: 'practice_admin' } },
  renderLoading(root) { this.clear(root); },
  renderError(root, err) { this.clear(root); root.appendChild(h('div', null, String(err && err.message))); },
  renderEmpty(root, opts) { this.clear(root); root.appendChild(h('div', null, opts.title)); },
  fmtDate(s) { return s ? String(s).slice(0, 10) : '—'; },
  fmtMoney(v) { return v == null ? '—' : '$' + v; },
  statusBadge(s) { return h('span', null, s); },
  toast() {},
  navigate() {},
  confirmModal() { return Promise.resolve(false); },
  formModal(opts) { lastForm = opts; return Promise.resolve(null); },
  registerView(name, fn) { if (name === 'clients') Reddably._viewFn = fn; },
};

const APP = path.join(__dirname, '..', '..', 'public', 'app');
vm.runInNewContext(fs.readFileSync(path.join(APP, 'client-defaults.js'), 'utf8'),
  { window: { Reddably }, console, Promise });
vm.runInNewContext(fs.readFileSync(path.join(APP, 'views', 'clients.js'), 'utf8'), {
  window: {
    Reddably,
    ReddablyDiagnoses: { label(c) { return c; } },
    ReddablyPhone: { normalize(v) { return { ok: true, value: v }; } },
    ReddablyPlan: null,
    location: { hash: '' },
  },
  document: fakeDocument, console, Promise, Date,
});

const flush = () => new Promise((r) => setImmediate(() => setImmediate(() => setImmediate(r))));
const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

function baseClient(over) {
  return Object.assign({
    id: CLIENT_ID, practice_id: 'p', primary_clinician_id: null, first_name: 'Old', last_name: 'Fixture',
    diagnosis_codes: ['F411'], status: 'active', is_hidden: false,
    default_cpt_code: null, default_place_of_service: null, default_session_fee: null,
    default_procedure_modifiers: null,
  }, over || {});
}

async function openAddSession() {
  lastForm = null;
  const root = createElement('div');
  Reddably._viewFn(root, [CLIENT_ID]);
  await flush();
  const btn = walk(root).filter((e) => e.tagName === 'BUTTON').find((b) => b.textContent === 'Add session');
  assert.ok(btn, 'the chart offers an Add session button');
  btn.dispatch('click');
  await flush();
  assert.ok(lastForm, 'the Add session form opened');
  return lastForm;
}
const fieldHint = (form, name) => (form.fields.find((f) => f.name === name) || {}).hint || '';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('a client with no defaults shows the PRACTICE values, labelled as such', async () => {
  client = baseClient();
  practice = { default_cpt_code: '90837', default_place_of_service: '11', default_session_fee: '175.00',
    default_procedure_modifiers: ['95'], default_session_duration_minutes: 50 };
  const form = await openAddSession();
  const v = plain(form.values);
  assert.strictEqual(v.cpt_code, '90837');
  assert.strictEqual(v.place_of_service, '11');
  assert.strictEqual(v.fee, '175.00');
  assert.strictEqual(v.procedure_modifiers, '95');
  assert.strictEqual(v.duration_minutes, 50);
  assert.ok(/practice default/.test(fieldHint(form, 'cpt_code')), 'says where the value came from');
  assert.ok(/practice default/.test(fieldHint(form, 'duration_minutes')));
});

test('client defaults beat practice defaults, field by field', async () => {
  client = baseClient({ default_cpt_code: '90834', default_session_fee: '120.00' });
  practice = { default_cpt_code: '90837', default_place_of_service: '11', default_session_fee: '175.00' };
  const form = await openAddSession();
  const v = plain(form.values);
  assert.strictEqual(v.cpt_code, '90834', 'client CPT wins');
  assert.strictEqual(v.fee, '120.00', 'client fee wins');
  assert.strictEqual(v.place_of_service, '11', 'practice fills what the client lacks');
  assert.ok(/client/.test(fieldHint(form, 'cpt_code')) && !/practice/.test(fieldHint(form, 'cpt_code')));
});

test('a client fee of 0 is a real default, not a blank', async () => {
  client = baseClient({ default_session_fee: '0.00' });
  practice = { default_session_fee: '175.00' };
  const form = await openAddSession();
  assert.strictEqual(plain(form.values).fee, '0.00');
});

test('no defaults anywhere leaves the fields blank with no misleading hint', async () => {
  client = baseClient();
  practice = {};
  const form = await openAddSession();
  const v = plain(form.values);
  for (const k of ['cpt_code', 'fee', 'place_of_service', 'procedure_modifiers', 'duration_minutes']) {
    assert.strictEqual(v[k], undefined, k + ' stays blank');
  }
  assert.ok(!/Pre-filled/.test(fieldHint(form, 'cpt_code')));
});

test('a failed practice lookup never blocks the form (client defaults still show)', async () => {
  client = baseClient({ default_cpt_code: '90834' });
  practiceFails = true;
  const form = await openAddSession();
  practiceFails = false;
  assert.strictEqual(plain(form.values).cpt_code, '90834');
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('  ok  ' + t.name); }
    catch (err) { failed++; console.error('FAIL  ' + t.name + '\n      ' + (err && err.stack || err)); }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
