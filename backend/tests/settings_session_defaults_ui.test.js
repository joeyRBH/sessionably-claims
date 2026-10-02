'use strict';

// UI test — Settings > "Session defaults" (public/app/views/settings.js).
//
// Pins: the card is a SIBLING form with its own PUT that carries only the five
// default keys (saving it cannot touch identity, saving identity cannot touch it),
// invalid input is rejected before any request, blanks are sent so a default can be
// cleared, and a non-admin sees it read-only with no save button. The server is the
// real boundary (practice_session_defaults.test.js); this is the UX half.
//
//   node backend/tests/settings_session_defaults_ui.test.js

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
    classList: { toggle() {}, add() {}, remove() {} },
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

let role = 'practice_admin';
let updates = [];
const toasts = [];
const practice = {
  id: 'p1', name: 'Stone Ridge', default_cpt_code: '90837', default_place_of_service: '11',
  default_session_fee: '175.00', default_procedure_modifiers: ['95'], default_session_duration_minutes: 50,
};

const api = {
  practice: {
    get() { return Promise.resolve({ practice }); },
    update(payload) { updates.push(payload); return Promise.resolve({ practice: Object.assign({}, practice, payload) }); },
  },
  calendar: { settings() { return new Promise(() => {}); } },
  providers: {},
  changePassword() { return Promise.resolve(); },
};
const Reddably = {
  h, api,
  clear(el) { while (el.firstChild) el.removeChild(el.firstChild); },
  get currentUser() { return { user: { id: 'u1', role } }; },
  renderLoading(root) { this.clear(root); },
  renderError(root, err) { this.clear(root); root.appendChild(h('div', null, String(err && err.message))); },
  toast(message, tone) { toasts.push({ message, tone }); },
  scrubVendor(s) { return s; },
  registerView(name, fn) { if (name === 'settings') Reddably._viewFn = fn; },
};

const APP = path.join(__dirname, '..', '..', 'public', 'app');
vm.runInNewContext(fs.readFileSync(path.join(APP, 'client-defaults.js'), 'utf8'),
  { window: { Reddably }, console, Promise });
vm.runInNewContext(fs.readFileSync(path.join(APP, 'views', 'settings.js'), 'utf8'),
  { window: { Reddably }, document: Object.assign({ getElementById() { return null; } }, fakeDocument),
    console, Promise });

const flush = () => new Promise((r) => setImmediate(() => setImmediate(r)));
const plain = (v) => JSON.parse(JSON.stringify(v));

async function render() {
  updates = []; toasts.length = 0;
  const root = createElement('div');
  Reddably._viewFn(root);
  await flush();
  const forms = walk(root).filter((e) => e.tagName === 'FORM');
  const card = forms.find((f) => /Session defaults/.test(f.textContent));
  assert.ok(card, 'Settings has a Session defaults card');
  return { root, card };
}
const input = (card, name) => walk(card).find((e) => e.attributes.name === name);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('the card is pre-filled from the practice and saves ONLY the five default keys', async () => {
  const { card } = await render();
  assert.strictEqual(input(card, 'default_cpt_code').value, '90837');
  assert.strictEqual(input(card, 'default_procedure_modifiers').value, '95');
  input(card, 'default_cpt_code').value = '90834';
  input(card, 'default_session_duration_minutes').value = '45';
  card.dispatch('submit', { preventDefault() {} });
  await flush();
  assert.strictEqual(updates.length, 1);
  assert.deepStrictEqual(Object.keys(plain(updates[0])).sort(), [
    'default_cpt_code', 'default_place_of_service', 'default_procedure_modifiers',
    'default_session_duration_minutes', 'default_session_fee']);
  assert.strictEqual(updates[0].default_cpt_code, '90834');
  assert.strictEqual(updates[0].default_session_duration_minutes, '45');
  assert.deepStrictEqual(plain(updates[0].default_procedure_modifiers), ['95']);
});

test('a blank is sent so a default can be cleared', async () => {
  const { card } = await render();
  input(card, 'default_session_fee').value = '';
  card.dispatch('submit', { preventDefault() {} });
  await flush();
  assert.strictEqual(updates[0].default_session_fee, '');
});

test('invalid input is rejected before any request', async () => {
  const { card } = await render();
  input(card, 'default_session_duration_minutes').value = '0';
  input(card, 'default_procedure_modifiers').value = 'toolong';
  card.dispatch('submit', { preventDefault() {} });
  await flush();
  assert.strictEqual(updates.length, 0, 'no request');
  assert.ok(/whole minutes/.test(card.textContent) && /two-character/.test(card.textContent));
});

test('a non-admin sees the card read-only with no save button', async () => {
  role = 'billing_staff';
  const { card } = await render();
  role = 'practice_admin';
  assert.ok(input(card, 'default_cpt_code').disabled, 'inputs are disabled');
  assert.ok(!walk(card).some((e) => e.tagName === 'BUTTON'), 'no save button');
  assert.ok(/Only a practice admin/.test(card.textContent));
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
