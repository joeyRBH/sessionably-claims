'use strict';

// UI test — connecting Google Calendar from the app and auto-syncing on open
// (public/app/views/calendar.js).
//
// Pins:
//   * with no active connection (known, not merely unknown) the Calendar offers
//     "Connect Google Calendar" — on an empty Calendar it is the whole screen — and
//     hides the useless "Sync now"; a connection needing re-auth says Reconnect;
//   * if the connection status cannot be read, nothing is claimed either way (no
//     Connect card, no auto-sync) — unknown is not "not connected";
//   * with an active connection, opening Calendar syncs ONCE in the background, and
//     repaints only when the sync actually changed something;
//   * the auto-sync is throttled to once per 5 minutes across re-opens (module state +
//     sessionStorage), a manual "Sync now" counts, a FAILED sync does not (the next
//     open retries) and is reported quietly, never as an error toast;
//   * a reload caused by an action (ignoring an event) never re-triggers the sync;
//   * sync only stages appointments — it never matches, promotes, ignores or confirms.
//
// calendar.js is a browser IIFE evaluated against a minimal fake DOM and a recording
// kit — no jsdom, no network. Synthetic data only.
//
//   node backend/tests/calendar_connection_ui.test.js

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
    appendChild(child) {
      child.parentNode = el;
      el.childNodes.push(child);
      return child;
    },
    removeChild(child) {
      const i = el.childNodes.indexOf(child);
      if (i !== -1) el.childNodes.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute(name, value) {
      el.attributes[name] = String(value);
      if (name === 'disabled') el.disabled = true;
    },
    addEventListener(type, fn) {
      (el.listeners[type] || (el.listeners[type] = [])).push(fn);
    },
    dispatch(type, arg) {
      (el.listeners[type] || []).forEach((fn) => fn(arg || { target: el }));
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

function append(el, children) {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) {
    children.forEach((c) => append(el, c));
    return;
  }
  el.appendChild(children.nodeType ? children : textNode(children));
}

// --- tree helpers ------------------------------------------------------------

function walk(node, out) {
  out = out || [];
  (node.childNodes || []).forEach((c) => {
    if (c.nodeType === 1) {
      out.push(c);
      walk(c, out);
    }
  });
  return out;
}

function buttons(node) {
  return walk(node).filter((el) => el.tagName === 'BUTTON');
}

function buttonLabels(node) {
  return buttons(node).map((b) => b.textContent);
}

function rows(node) {
  return walk(node).filter((el) => el.tagName === 'TR');
}

function inputs(node) {
  return walk(node).filter((el) => el.tagName === 'INPUT');
}

// Body rows only — excludes the header row, which is also a <TR>.
function bodyRowsOf(node) {
  return rows(node).filter((r) => r.parentNode && r.parentNode.tagName === 'TBODY');
}

// The card whose .card__title reads `title`. Matched by the base 'card' class
// so a card carrying an additional modifier (e.g. 'card card--focus', a
// Dashboard deep link's highlight) is still found.
function isCard(el) {
  return typeof el.className === 'string' && el.className.split(/\s+/).indexOf('card') !== -1;
}
function section(root, title) {
  const card = walk(root).find(
    (el) => isCard(el) &&
      walk(el).some((c) => c.className === 'card__title' && c.textContent === title)
  );
  assert.ok(card, 'section "' + title + '" is rendered');
  return card;
}


const APP = path.join(__dirname, '..', '..', 'public', 'app');
const WORKFLOW_SRC = fs.readFileSync(path.join(APP, 'workflow.js'), 'utf8');
const CALENDAR_SRC = fs.readFileSync(path.join(APP, 'views', 'calendar.js'), 'utf8');

const flush = () => new Promise((r) => setImmediate(() => setImmediate(() => setImmediate(() => setImmediate(r)))));

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

// A fresh view instance (its own module state) with a controllable clock, storage and
// connection status. `sessionStorage` is shared across reopens within a scenario so
// the "survives a refresh" path is exercised too.
function makeEnv(opts) {
  const o = Object.assign({ connections: [], syncResult: { connections: [], totals: { inserted: 0, updated: 0, cancelled: 0 } } }, opts || {});
  const env = { calls: [], toasts: [], now: Date.parse('2026-10-02T15:00:00Z'), connectBtns: [], storage: {} };

  const api = {
    calendarEvents: {
      list(f) { env.calls.push('events.list'); return Promise.resolve({ calendar_events: o.events || [] }); },
      promote() { env.calls.push('events.promote'); return Promise.resolve({}); },
      ignore() { env.calls.push('events.ignore'); return Promise.resolve({ ignored: true }); },
      sync() {
        env.calls.push('events.sync');
        if (o.syncFails) return Promise.reject(new Error('boom'));
        return Promise.resolve(typeof o.syncResult === 'function' ? o.syncResult() : o.syncResult);
      },
    },
    sessions: {
      list() { env.calls.push('sessions.list'); return Promise.resolve({ sessions: [] }); },
      update() { env.calls.push('sessions.update'); return Promise.resolve({}); },
    },
    clients: { list() { return Promise.resolve({ clients: [] }); } },
    calendarConnections: {
      calendars() { return Promise.reject(new Error('no connection')); },
      status() {
        env.calls.push('connections.status');
        if (o.statusFails) return Promise.reject(new Error('down'));
        return Promise.resolve({ connections: o.connections });
      },
    },
  };
  let viewFn = null;
  const Reddably = {
    h, api, clear,
    renderLoading(r) { clear(r); r.appendChild(h('div', { class: 'skeleton' })); },
    renderError(r, err) { clear(r); r.appendChild(h('div', { class: 'inline-error' }, String(err && err.message))); },
    fmtDate: (s) => String(s),
    toast(message, kind) { env.toasts.push({ message, kind }); },
    connectGoogleCalendar(btn) { env.connectBtns.push(btn); return Promise.resolve(); },
    calendarConnectAllowed() { return Promise.resolve(o.canConnect !== false); },
    registerView(name, fn) { if (name === 'calendar') viewFn = fn; },
  };
  const FakeDate = class extends Date {
    constructor(...a) { if (a.length) super(...a); else super(env.now); }
    static now() { return env.now; }
  };
  const sandbox = {
    window: {
      Reddably, confirm: () => false, setTimeout,
      sessionStorage: {
        getItem: (k) => (k in env.storage ? env.storage[k] : null),
        setItem: (k, v) => { env.storage[k] = String(v); },
      },
    },
    document: fakeDocument, console, Promise, Date: FakeDate,
  };
  vm.runInNewContext(WORKFLOW_SRC, sandbox);
  vm.runInNewContext(CALENDAR_SRC, sandbox);
  env.open = async () => {
    const root = createElement('div');
    viewFn(root);
    await flush();
    env.root = root;
    return root;
  };
  env.count = (name) => env.calls.filter((c) => c === name).length;
  return env;
}

const ACTIVE = { id: 'conn-1', status: 'active', account_email: 'pat@example.com' };
const hasButton = (root, label) => buttons(root).some((b) => b.textContent === label);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('no connection: the (empty) Calendar offers Connect Google Calendar, and hides Sync now', async () => {
  const env = makeEnv({ connections: [] });
  const root = await env.open();
  assert.ok(/Connect your Google Calendar/.test(root.textContent));
  assert.ok(/Reddably only reads them/.test(root.textContent), 'says it is read-only and matching stays manual');
  assert.ok(hasButton(root, 'Connect Google Calendar'));
  assert.ok(!hasButton(root, 'Sync now'), 'a sync button with nothing to sync is just noise');
  assert.strictEqual(env.count('events.sync'), 0, 'no connection, no sync');
  buttons(root).find((b) => b.textContent === 'Connect Google Calendar').dispatch('click');
  assert.strictEqual(env.connectBtns.length, 1, 'the button starts the connect flow via the shared helper');
});

test('a connection that needs re-authorizing is offered Reconnect, not a fresh Connect', async () => {
  const env = makeEnv({ connections: [{ id: 'c', status: 'needs_reauth' }] });
  const root = await env.open();
  assert.ok(hasButton(root, 'Reconnect Google Calendar'));
  assert.ok(!hasButton(root, 'Connect Google Calendar'));
  assert.strictEqual(env.count('events.sync'), 0, 'cannot sync without credentials');
});

test('an unreadable status claims nothing: no Connect card, no auto-sync, Sync now still there', async () => {
  const env = makeEnv({ statusFails: true });
  const root = await env.open();
  assert.ok(!/Connect your Google Calendar/.test(root.textContent));
  assert.ok(hasButton(root, 'Sync now'));
  assert.strictEqual(env.count('events.sync'), 0);
});

test('connected: no Connect card; opening Calendar syncs once in the background', async () => {
  const env = makeEnv({ connections: [ACTIVE] });
  const root = await env.open();
  assert.ok(!/Connect your Google Calendar/.test(root.textContent));
  assert.ok(hasButton(root, 'Sync now'), 'manual Sync now is kept');
  assert.strictEqual(env.count('events.sync'), 1);
  assert.strictEqual(env.toasts.length, 0, 'a background sync is silent');
});

test('the view repaints only when the sync changed something', async () => {
  let env = makeEnv({ connections: [ACTIVE] });
  await env.open();
  assert.strictEqual(env.count('sessions.list'), 1, 'nothing changed: no reload');

  env = makeEnv({ connections: [ACTIVE],
    syncResult: { connections: [{ id: 'conn-1' }], totals: { inserted: 2, updated: 0, cancelled: 0 } } });
  await env.open();
  assert.strictEqual(env.count('sessions.list'), 2, 'new appointments: the list reloads to show them');
  assert.strictEqual(env.count('events.sync'), 1, 'and the reload does not sync again');
});

test('throttled to once per 5 minutes across re-opens; allowed again after', async () => {
  const env = makeEnv({ connections: [ACTIVE] });
  await env.open();
  assert.strictEqual(env.count('events.sync'), 1);
  env.now += 4 * 60 * 1000 + 59 * 1000;
  await env.open();
  assert.strictEqual(env.count('events.sync'), 1, 'under 5 minutes: no second sync');
  env.now += 2 * 1000;
  await env.open();
  assert.strictEqual(env.count('events.sync'), 2, 'past 5 minutes: syncs again');
});

test('the throttle survives a page refresh of the same tab (sessionStorage)', async () => {
  const env = makeEnv({ connections: [ACTIVE] });
  await env.open();
  const storage = env.storage;
  const fresh = makeEnv({ connections: [ACTIVE] });          // new module state = a reloaded page
  Object.assign(fresh.storage, storage);
  fresh.now = env.now + 60 * 1000;
  await fresh.open();
  assert.strictEqual(fresh.count('events.sync'), 0);
});

test('a manual Sync now counts toward the throttle', async () => {
  const env = makeEnv({ connections: [ACTIVE], events: [] });
  // Throttle already expired -> first open syncs; make the manual one the first sync instead.
  env.storage.reddably_calendar_auto_sync_at = String(env.now - 60 * 60 * 1000);
  const root = await env.open();
  const before = env.count('events.sync');
  buttons(root).find((b) => b.textContent === 'Sync now').dispatch('click');
  await flush();
  assert.strictEqual(env.count('events.sync'), before + 1);
  env.now += 60 * 1000;
  await env.open();
  assert.strictEqual(env.count('events.sync'), before + 1, 'no auto-sync one minute after a manual one');
});

test('a failed sync is quiet (no error toast), and does NOT use up the throttle', async () => {
  const env = makeEnv({ connections: [ACTIVE], syncFails: true });
  const root = await env.open();
  assert.strictEqual(env.toasts.length, 0, 'a background failure never toasts');
  assert.ok(/Couldn’t refresh from your calendar just now/.test(root.textContent), 'but says so, in place');
  env.now += 30 * 1000;
  await env.open();
  assert.strictEqual(env.count('events.sync'), 2, 'the next open retries immediately');
});

test('a per-connection error in an otherwise-200 sync counts as a failure', async () => {
  const env = makeEnv({ connections: [ACTIVE],
    syncResult: { connections: [{ id: 'conn-1', error: 'Could not sync this calendar.' }], totals: {} } });
  const root = await env.open();
  assert.ok(/Couldn’t refresh/.test(root.textContent));
  env.now += 30 * 1000;
  await env.open();
  assert.strictEqual(env.count('events.sync'), 2);
});

test('sync only stages appointments: it never matches, promotes, ignores or confirms', async () => {
  const env = makeEnv({ connections: [ACTIVE],
    syncResult: { connections: [{ id: 'conn-1' }], totals: { inserted: 3, updated: 1, cancelled: 1 } } });
  await env.open();
  for (const forbidden of ['events.promote', 'events.ignore', 'sessions.update']) {
    assert.strictEqual(env.count(forbidden), 0, forbidden + ' must stay a human decision');
  }
});

test('a non-clinician (not a one-person practice) sees a note instead of the Connect card; events stay visible', async () => {
  const env = makeEnv({ connections: [], canConnect: false });
  const root = await env.open();
  assert.ok(!hasButton(root, 'Connect Google Calendar'), 'no Connect button');
  assert.ok(/Clinicians connect their own Google calendars/.test(root.textContent), 'a short pointer instead');
  assert.ok(/Sessions to confirm/.test(root.textContent) && /Upcoming appointments/.test(root.textContent),
    'the appointment lists are still there');
  assert.ok(!hasButton(root, 'Sync now'), 'and nothing to sync without a connection');
  assert.strictEqual(env.count('events.sync'), 0);
});

test('a non-clinician who already has a connection is unaffected (auto-sync, no note)', async () => {
  const env = makeEnv({ connections: [ACTIVE], canConnect: false });
  const root = await env.open();
  assert.ok(!/Clinicians connect their own/.test(root.textContent));
  assert.strictEqual(env.count('events.sync'), 1);
});

test('a non-clinician whose connection needs re-auth can still Reconnect', async () => {
  const env = makeEnv({ connections: [{ id: 'c', status: 'needs_reauth' }], canConnect: false });
  const root = await env.open();
  assert.ok(hasButton(root, 'Reconnect Google Calendar'));
});

test('a clinician or the owner of a one-person practice (canConnect) still gets the Connect card', async () => {
  const env = makeEnv({ connections: [], canConnect: true });
  const root = await env.open();
  assert.ok(hasButton(root, 'Connect Google Calendar'));
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
