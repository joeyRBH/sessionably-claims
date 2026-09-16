'use strict';

// Behavioural tests — R.setBusy() and the busy confirm/submit paths in
// public/app/views.js, driven against a minimal DOM shim.
//
// WHAT THIS PROTECTS. Submitting a claim round-trips the clearinghouse and can
// take many seconds (the claims Lambda is given 60s for exactly that). The
// confirm dialog used to close the instant it was clicked and nothing else on
// screen moved, so an in-flight submission was indistinguishable from a click
// that never registered — and nothing stopped a second one.
//
// These tests assert the three properties that fix depends on:
//   1. a busy button is disabled, carries aria-busy + a spinner, and restores its
//      original label afterwards;
//   2. confirmModal({ onConfirm }) keeps the dialog OPEN while the promise is
//      pending, and cannot be cancelled or dismissed out from under itself;
//   3. a rejected action leaves the dialog open and retryable rather than
//      silently closing.
//
// The shim implements only what views.js touches. It is deliberately tiny: a real
// headless browser would be a new dependency and a new build step, which this
// project does not have.
//
//   node backend/tests/busy_state.test.js

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

// --- 1. setBusy round-trips the button --------------------------------------

{
  const btn = R.h('button', { class: 'btn btn--primary' }, 'Submit');
  assert.strictEqual(btn.textContent, 'Submit');

  R.setBusy(btn, true, 'Submitting…');
  assert.strictEqual(btn.disabled, true, 'a busy button cannot be pressed again');
  assert.strictEqual(btn.getAttribute('aria-busy'), 'true', 'announced to assistive tech');
  assert.ok(btn.classList.contains('is-busy'));
  assert.ok(btn.querySelector('.spinner'), 'a spinner is rendered inside the button');
  assert.match(btn.textContent, /Submitting…/, 'the busy label replaces the original');

  // Idempotent: a second setBusy(true) must not stash "Submitting…" as the label
  // to restore.
  R.setBusy(btn, true, 'Submitting…');

  R.setBusy(btn, false);
  assert.strictEqual(btn.disabled, false);
  assert.strictEqual(btn.getAttribute('aria-busy'), null);
  assert.strictEqual(btn.classList.contains('is-busy'), false);
  assert.strictEqual(btn.querySelector('.spinner'), null, 'the spinner is removed');
  assert.strictEqual(btn.textContent, 'Submit', 'the original label comes back exactly');

  R.setBusy(btn, false);                    // un-busying a non-busy button is a no-op
  assert.strictEqual(btn.textContent, 'Submit');
  R.setBusy(null, true);                    // and a missing element never throws
}

// --- 2/3. confirmModal({ onConfirm }) ---------------------------------------

function footerButtons() {
  // The live modal is the last backdrop appended to <body>.
  const backdrop = document.body.childNodes[document.body.childNodes.length - 1];
  const footer = backdrop.querySelectorAll('.modal__footer')[0];
  return { backdrop, buttons: footer.childNodes };
}

(async () => {
  // --- the dialog stays open while the action is pending ---
  {
    let release;
    const pending = new Promise((res) => { release = res; });
    let ran = 0;

    const result = R.confirmModal({
      title: 'Submit claim?',
      confirmLabel: 'Submit',
      busyLabel: 'Submitting…',
      onConfirm() { ran += 1; return pending; },
    });

    const { backdrop, buttons } = footerButtons();
    const [cancelBtn, confirmBtn] = buttons;
    const bodyDepth = document.body.childNodes.length;

    confirmBtn.dispatch('click');
    assert.strictEqual(ran, 1);
    assert.strictEqual(document.body.childNodes.length, bodyDepth,
      'the dialog is still on screen while the submit is in flight');
    assert.strictEqual(confirmBtn.disabled, true);
    assert.match(confirmBtn.textContent, /Submitting…/);
    assert.strictEqual(cancelBtn.disabled, true, 'cancel is inert while in flight');

    // A second click, an Escape, and a backdrop dismiss must all do nothing.
    confirmBtn.dispatch('click');
    cancelBtn.dispatch('click');
    backdrop.dispatch('mousedown', { target: backdrop });
    assert.strictEqual(ran, 1, 'the action never runs twice');
    assert.strictEqual(document.body.childNodes.length, bodyDepth,
      'the dialog cannot be dismissed out from under an in-flight submit');

    release();
    assert.strictEqual(await result, true, 'resolving closes the dialog and confirms');
    assert.strictEqual(document.body.childNodes.length, bodyDepth - 1, 'the dialog is gone');
  }

  // --- a rejected action leaves the dialog open and retryable ---
  {
    let attempt = 0;
    const result = R.confirmModal({
      title: 'Submit claim?',
      confirmLabel: 'Submit',
      busyLabel: 'Submitting…',
      onConfirm() {
        attempt += 1;
        return attempt === 1 ? Promise.reject(new Error('network')) : Promise.resolve();
      },
    });

    const { buttons } = footerButtons();
    const [cancelBtn, confirmBtn] = buttons;
    const bodyDepth = document.body.childNodes.length;

    confirmBtn.dispatch('click');
    await new Promise((r) => setTimeout(r, 0));

    assert.strictEqual(document.body.childNodes.length, bodyDepth,
      'a failed action leaves the dialog open so it can be retried');
    assert.strictEqual(confirmBtn.disabled, false, 'the button is pressable again');
    assert.strictEqual(confirmBtn.textContent, 'Submit', 'and reads normally again');
    assert.strictEqual(cancelBtn.disabled, false, 'cancel works again');

    confirmBtn.dispatch('click');
    assert.strictEqual(await result, true, 'the retry succeeds');
    assert.strictEqual(attempt, 2);
  }

  // --- without onConfirm, nothing changes ---
  {
    const result = R.confirmModal({ title: 'Delete?', confirmLabel: 'Delete' });
    const { buttons } = footerButtons();
    buttons[1].dispatch('click');
    assert.strictEqual(await result, true, 'the legacy path still resolves immediately');
  }
  {
    const result = R.confirmModal({ title: 'Delete?' });
    const { buttons } = footerButtons();
    buttons[0].dispatch('click');
    assert.strictEqual(await result, false, 'cancel still resolves false');
  }

  console.log('busy_state: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
