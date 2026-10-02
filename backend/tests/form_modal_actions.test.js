'use strict';

// Behavioural test — R.formModal's multi-action footer and collapsible groups
// (public/app/views.js), used by the one-screen "New client" form.
//
//   * opts.actions: several submit buttons on one form. The resolved value carries
//     `_action`; an action's `requires` fields block only THAT action, with an inline
//     error; Enter triggers the action marked `enter` (the quiet one), never the
//     first/primary one.
//   * f.group: fields grouped into one collapsed <details>, which pops open when one
//     of its fields fails validation (so a hidden field cannot fail silently).
//   * Without these options the single-submit form behaves exactly as before.
//
// Driven against a minimal DOM shim (same approach as busy_state.test.js).
//
//   node backend/tests/form_modal_actions.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// --- minimal DOM -------------------------------------------------------------

function El(tag) {
  this.tagName = String(tag).toUpperCase();
  this.childNodes = [];
  this.attributes = {};
  this.listeners = {};
  this.nodeType = 1;
  this.parentNode = null;
  this.style = {};
  this.dataset = {};
  this.hidden = false;
  this.disabled = false;
  this.value = '';
  this.checked = false;
  this._classes = [];
  const self = this;
  this.classList = {
    add(c) { if (!self._classes.includes(c)) self._classes.push(c); },
    remove(c) { const i = self._classes.indexOf(c); if (i >= 0) self._classes.splice(i, 1); },
    toggle(c, on) { if (on) this.add(c); else this.remove(c); },
    contains(c) { return self._classes.includes(c); },
  };
}
Object.defineProperty(El.prototype, 'className', {
  get() { return this._classes.join(' '); },
  set(v) { this._classes = String(v).split(/\s+/).filter(Boolean); },
});
Object.defineProperty(El.prototype, 'firstChild', { get() { return this.childNodes[0] || null; } });
Object.defineProperty(El.prototype, 'textContent', {
  get() { return this.childNodes.map((c) => (c.nodeType === 3 ? c.text : c.textContent)).join(''); },
  set(v) { this.childNodes = [{ nodeType: 3, text: String(v), parentNode: this }]; },
});
Object.defineProperty(El.prototype, 'innerHTML', {
  get() { return this._html || ''; },
  set(v) { this._html = String(v); },
});
El.prototype.setAttribute = function (k, v) {
  this.attributes[k] = String(v);
  if (k === 'hidden') this.hidden = true;
};
El.prototype.getAttribute = function (k) {
  return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
};
El.prototype.removeAttribute = function (k) { delete this.attributes[k]; };
El.prototype.appendChild = function (c) { c.parentNode = this; this.childNodes.push(c); return c; };
El.prototype.removeChild = function (c) {
  const i = this.childNodes.indexOf(c);
  if (i >= 0) this.childNodes.splice(i, 1);
  c.parentNode = null;
  return c;
};
El.prototype.addEventListener = function (t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); };
El.prototype.removeEventListener = function () {};
El.prototype.focus = function () {};
El.prototype.scrollIntoView = function () {};
El.prototype.dispatch = function (type, ev) {
  (this.listeners[type] || []).forEach((fn) => fn(ev || { preventDefault() {}, stopPropagation() {} }));
};
El.prototype._descendants = function (out = []) {
  this.childNodes.forEach((c) => { if (c.nodeType === 1) { out.push(c); c._descendants(out); } });
  return out;
};
El.prototype.querySelectorAll = function (sel) {
  const parts = String(sel).split(',').map((s) => s.trim());
  return this._descendants().filter((el) => parts.some((p) => (
    p.startsWith('.') ? el.classList.contains(p.slice(1))
      : p.startsWith('[') ? true
        : el.tagName === p.toUpperCase()
  )));
};
El.prototype.closest = function () { return null; };
El.prototype.querySelector = function (sel) { return this.querySelectorAll(sel)[0] || null; };

const document = {
  createElement: (t) => new El(t),
  createTextNode: (t) => ({ nodeType: 3, text: String(t), parentNode: null, textContent: String(t) }),
  // views.js boots its hash router on load and looks for the shell's mount point.
  // Returning null is the honest answer here (this shim renders no app shell), and
  // renderRoute() already tolerates a missing root.
  getElementById: () => null,
  addEventListener() {},
  removeEventListener() {},
  activeElement: null,
};
document.body = new El('body');

const window = {
  document,
  setTimeout,
  clearTimeout,
  location: { hash: '' },
  addEventListener() {},
  ReddablyAPI: { payers: { search: () => Promise.resolve({ payers: [] }) } },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
window.window = window;

// --- load the real views.js --------------------------------------------------

const viewsSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'app', 'views.js'), 'utf8'
);
vm.createContext(window);
vm.runInContext(viewsSrc, window, { filename: 'views.js' });

const R = window.Reddably;
assert.ok(R && typeof R.setBusy === 'function', 'views.js exports setBusy');

const live = () => document.body.childNodes[document.body.childNodes.length - 1];
const footer = () => live().querySelectorAll('.modal__footer')[0].childNodes;
const input = (name) => live().querySelectorAll('input').find((i) => i.attributes.name === name);
const form = () => live().querySelectorAll('form')[0];
const tick = () => new Promise((r) => setTimeout(r, 0));
const plain = (v) => JSON.parse(JSON.stringify(v));

const ACTIONS = [
  { key: 'send', label: 'Save & send payment link', requires: ['phone'],
    requiresMessage: { phone: 'Add a mobile phone to text the payment link.' } },
  { key: 'save', label: 'Save only', enter: true },
];
const FIELDS = [
  { name: 'first_name', label: 'First name', type: 'text', required: true },
  { name: 'phone', label: 'Phone', type: 'text' },
  { name: 'fee', label: 'Fee', type: 'text', group: 'Session defaults',
    validate: (v) => (/^\d+$/.test(v) ? null : 'Digits only.') },
];

(async () => {
  // --- footer: Cancel + one button per action; the first is primary ---
  {
    const p = R.formModal({ title: 'T', fields: FIELDS, actions: ACTIONS });
    const [cancel, send, save] = footer();
    assert.strictEqual(footer().length, 3);
    assert.strictEqual(send.textContent, 'Save & send payment link');
    assert.ok(send.classList.contains('btn--primary'), 'first action is the primary one');
    assert.ok(!save.classList.contains('btn--primary'));
    cancel.dispatch('click');
    assert.strictEqual(await p, null);
  }

  // --- requires: blocks only that action, inline, and keeps the modal open ---
  {
    const p = R.formModal({ title: 'T', fields: FIELDS, actions: ACTIONS });
    input('first_name').value = 'Ann';
    const [, send, save] = footer();
    const depth = document.body.childNodes.length;
    send.dispatch('click');
    await tick();
    assert.strictEqual(document.body.childNodes.length, depth, 'still open: phone is missing');
    assert.match(live().textContent, /Add a mobile phone to text the payment link\./);
    // Fill the phone: the same action now goes through, tagged.
    input('phone').value = '+13035550100';
    send.dispatch('click');
    const v = await p;
    assert.strictEqual(v._action, 'send');
    assert.strictEqual(v.phone, '+13035550100');
  }

  // --- the other action needs no phone ---
  {
    const p = R.formModal({ title: 'T', fields: FIELDS, actions: ACTIONS });
    input('first_name').value = 'Ann';
    footer()[2].dispatch('click');
    const v = await p;
    assert.strictEqual(v._action, 'save');
    assert.strictEqual(v.phone, null);
  }

  // --- Enter runs the `enter` action, never the primary one ---
  {
    const p = R.formModal({ title: 'T', fields: FIELDS, actions: ACTIONS });
    input('first_name').value = 'Ann';
    input('phone').value = '+13035550100';
    form().dispatch('submit');
    const v = await p;
    assert.strictEqual(v._action, 'save', 'Enter must not send an SMS');
  }

  // --- groups: collapsed by default, opened by a validation error inside ---
  {
    const p = R.formModal({ title: 'T', fields: FIELDS, actions: ACTIONS });
    const details = live().querySelectorAll('details')[0];
    assert.ok(details, 'the grouped field lives in a <details>');
    assert.strictEqual(details.getAttribute('open'), null, 'collapsed by default');
    assert.match(details.querySelector('summary').textContent, /Session defaults/);
    input('first_name').value = 'Ann';
    input('fee').value = 'abc';
    footer()[2].dispatch('click');
    await tick();
    assert.strictEqual(details.getAttribute('open'), 'open',
      'an error inside a collapsed group opens it');
    assert.match(live().textContent, /Digits only\./);
    footer()[0].dispatch('click');
    await p;
  }

  // --- onSubmit: the pressed button goes busy, others lock, rejection re-enables ---
  {
    let attempt = 0;
    const p = R.formModal({ title: 'T', fields: FIELDS, actions: ACTIONS,
      onSubmit(v) { attempt += 1; return attempt === 1 ? Promise.reject(new Error('x')) : Promise.resolve(v); } });
    input('first_name').value = 'Ann';
    const [cancel, send, save] = footer();
    save.dispatch('click');
    assert.strictEqual(save.disabled, true);
    assert.strictEqual(send.disabled, true, 'the other action is locked while in flight');
    assert.strictEqual(cancel.disabled, true);
    await tick();
    assert.strictEqual(send.disabled, false, 'a rejected submit leaves the form retryable');
    assert.strictEqual(save.disabled, false);
    assert.strictEqual(save.textContent, 'Save only', 'label restored');
    save.dispatch('click');
    assert.strictEqual((await p)._action, 'save');
    assert.strictEqual(attempt, 2);
  }

  // --- legacy: no actions → a single submit button, no _action ---
  {
    const p = R.formModal({ title: 'T', fields: [FIELDS[0]], submitLabel: 'Create' });
    assert.strictEqual(footer().length, 2);
    input('first_name').value = 'Ann';
    footer()[1].dispatch('click');
    const v = plain(await p);
    assert.deepStrictEqual(v, { first_name: 'Ann' });
  }

  console.log('form_modal_actions.test.js: OK');
})().catch((err) => { console.error('form_modal_actions.test.js: FAIL', err); process.exit(1); });
