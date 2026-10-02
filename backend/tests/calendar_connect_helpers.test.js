'use strict';

// Behavioural test — the Google Calendar connect helpers in public/app/views.js:
//   * R.connectGoogleCalendar(btn): asks the API for the consent URL (a browser
//     navigation cannot authenticate the server's 302) and navigates to it; the button
//     is busy meanwhile and comes back, with an error toast, if that fails;
//   * the consent round trip returns to /app/app.html?calendar=connected|declined: the
//     flag is stripped from the URL (a refresh must not repeat the message), the user
//     is routed to Calendar / Settings, and told what happened.
//
//   node backend/tests/calendar_connect_helpers.test.js

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


const viewsSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app', 'views.js'), 'utf8');

// Load views.js into a fresh window whose URL/history/api the test controls.
function load(search, startImpl) {
  const log = { assigned: [], replaced: [] };
  const w = {
    document, setTimeout, clearTimeout, URLSearchParams,
    location: {
      hash: '', search, pathname: '/app/app.html',
      assign(u) { log.assigned.push(u); },
    },
    history: { replaceState(_s, _t, url) { log.replaced.push(url); } },
    addEventListener() {},
    ReddablyAPI: { calendarConnections: { start: startImpl || (() => Promise.resolve({ url: 'https://accounts.example/consent' })) } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  w.window = w;
  vm.createContext(w);
  vm.runInContext(viewsSrc, w, { filename: 'views.js' });
  return { w, R: w.Reddably, log };
}
const toastTexts = () => document.body.querySelectorAll('.toast').map((t) => t.textContent);

(async () => {
  // --- connect: navigates to the URL the API returned ---
  {
    const { R, log } = load('');
    const btn = R.h('button', null, 'Connect Google Calendar');
    await R.connectGoogleCalendar(btn);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(log.assigned)), ['https://accounts.example/consent']);
  }

  // --- connect: shows busy while the request is in flight ---
  {
    let release;
    const { R } = load('', () => new Promise((res) => { release = res; }));
    const btn = R.h('button', null, 'Connect Google Calendar');
    const p = R.connectGoogleCalendar(btn);
    assert.strictEqual(btn.disabled, true, 'busy: cannot be double-clicked');
    assert.match(btn.textContent, /Opening Google/);
    await new Promise((r) => setTimeout(r, 0));   // the request is issued a tick later
    release({ url: 'https://accounts.example/consent' });
    await p;
  }

  // --- connect: failure restores the button and says so ---
  {
    const { R, log } = load('', () => Promise.reject(new Error('Calendar is unavailable')));
    const btn = R.h('button', null, 'Connect Google Calendar');
    await R.connectGoogleCalendar(btn);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(log.assigned)), [], 'no navigation on failure');
    assert.strictEqual(btn.disabled, false);
    assert.strictEqual(btn.textContent, 'Connect Google Calendar', 'original label restored');
    assert.ok(toastTexts().some((t) => /Calendar is unavailable/.test(t)));
  }

  // --- connect: a response with no URL is an error, not a silent no-op ---
  {
    const { R, log } = load('', () => Promise.resolve({}));
    const btn = R.h('button', null, 'Connect Google Calendar');
    await R.connectGoogleCalendar(btn);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(log.assigned)), []);
    assert.strictEqual(btn.disabled, false);
  }

  // --- return: connected ---
  {
    const before = toastTexts().length;
    const { w, log } = load('?calendar=connected');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(log.replaced)), ['/app/app.html#calendar'], 'the flag is stripped from the URL');
    assert.strictEqual(w.location.hash, '#calendar', 'lands on the Calendar (which syncs on open)');
    assert.ok(toastTexts().slice(before).some((t) => /Google Calendar connected/.test(t)));
  }

  // --- return: declined ---
  {
    const before = toastTexts().length;
    const { w, log } = load('?calendar=declined');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(log.replaced)), ['/app/app.html#settings']);
    assert.strictEqual(w.location.hash, '#settings');
    assert.ok(toastTexts().slice(before).some((t) => /was not granted/.test(t)));
  }

  // --- return: any other query is left completely alone ---
  {
    const { w, log } = load('?utm_source=email');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(log.replaced)), []);
    assert.strictEqual(w.location.hash, '');
    const l2 = load('?calendar=garbage');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(l2.log.replaced)), [], 'an unknown flag does nothing');
  }

  console.log('calendar_connect_helpers.test.js: OK');
})().catch((err) => { console.error('calendar_connect_helpers.test.js: FAIL', err); process.exit(1); });
