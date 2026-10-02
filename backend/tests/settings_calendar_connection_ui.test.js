'use strict';

// UI test — Settings > "Calendar connection" and the renamed "Calendar feed (export)"
// (public/app/views/settings.js).
//
// Pins: the outbound ICS feed is now called "Calendar feed (export)" so it cannot be
// confused with the new inbound connection; the connection card shows Connect /
// Reconnect / Connected + Disconnect from GET /status; Disconnect asks first and only
// then POSTs; and a status failure is contained to its own card (inline, retryable) —
// it never takes Settings down.
//
//   node backend/tests/settings_calendar_connection_ui.test.js

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

let connections = [];
let statusFails = false;
let confirmAnswer = true;
let canConnect = true;
const calls = [];
const toasts = [];
const connectClicks = [];

const api = {
  practice: { get() { return Promise.resolve({ practice: { id: 'p1', name: 'Stone Ridge' } }); }, update() { return Promise.resolve({}); } },
  calendar: { settings() { return new Promise(() => {}); }, regenerate() { return Promise.resolve({}); } },
  providers: {},
  changePassword() { return Promise.resolve(); },
  calendarConnections: {
    status() {
      calls.push('status');
      return statusFails ? Promise.reject(new Error('down')) : Promise.resolve({ connections });
    },
    disconnect(id) { calls.push('disconnect:' + id); connections = connections.map((c) => (c.id === id ? Object.assign({}, c, { status: 'disconnected' }) : c)); return Promise.resolve({ disconnected: true, id }); },
  },
};
const Reddably = {
  h, api,
  clear(el) { while (el.firstChild) el.removeChild(el.firstChild); },
  currentUser: { user: { id: 'u1', role: 'clinician' } },
  renderLoading(root) { this.clear(root); },
  renderError(root, err) { this.clear(root); root.appendChild(h('div', null, String(err && err.message))); },
  toast(message, tone) { toasts.push({ message, tone }); },
  scrubVendor(s) { return s; },
  confirmModal() { return Promise.resolve(confirmAnswer); },
  connectGoogleCalendar(btn) { connectClicks.push(btn); return Promise.resolve(); },
  calendarConnectAllowed() { return Promise.resolve(canConnect); },
  registerView(name, fn) { if (name === 'settings') Reddably._viewFn = fn; },
};
const APP = path.join(__dirname, '..', '..', 'public', 'app');
vm.runInNewContext(fs.readFileSync(path.join(APP, 'client-defaults.js'), 'utf8'), { window: { Reddably }, console, Promise });
vm.runInNewContext(fs.readFileSync(path.join(APP, 'views', 'settings.js'), 'utf8'),
  { window: { Reddably }, document: Object.assign({ getElementById() { return null; } }, fakeDocument), console, Promise });

const flush = () => new Promise((r) => setImmediate(() => setImmediate(() => setImmediate(r))));
async function render() {
  calls.length = 0; toasts.length = 0; connectClicks.length = 0;
  const root = createElement('div');
  Reddably._viewFn(root);
  await flush();
  const cards = walk(root).filter((e) => /\bcard\b/.test(e.className));
  const conn = cards.find((c) => /Calendar connection/.test(c.textContent) && !/Calendar feed/.test(c.textContent));
  assert.ok(conn, 'Settings has a Calendar connection card');
  return { root, conn };
}
const btn = (node, label) => walk(node).filter((e) => e.tagName === 'BUTTON' || e.tagName === 'A').find((b) => b.textContent === label);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('the outbound feed is renamed "Calendar feed (export)"; "Calendar sync" is gone', async () => {
  const { root } = await render();
  const titles = walk(root).filter((e) => /card__title/.test(e.className)).map((e) => e.textContent);
  assert.ok(titles.includes('Calendar feed (export)'));
  assert.ok(titles.includes('Calendar connection'));
  assert.ok(!titles.includes('Calendar sync'), 'the ambiguous name is retired');
});

test('no connection: Connect Google Calendar starts the flow through the shared helper', async () => {
  connections = []; statusFails = false;
  const { conn } = await render();
  assert.ok(/only reads them/.test(conn.textContent), 'says it is read-only');
  btn(conn, 'Connect Google Calendar').dispatch('click');
  assert.strictEqual(connectClicks.length, 1);
});

test('a disconnected row is treated as not connected', async () => {
  connections = [{ id: 'c1', status: 'disconnected', account_email: 'old@example.com' }];
  const { conn } = await render();
  assert.ok(btn(conn, 'Connect Google Calendar'));
  assert.ok(!/old@example.com/.test(conn.textContent));
});

test('needs_reauth offers Reconnect', async () => {
  connections = [{ id: 'c1', status: 'needs_reauth', account_email: 'a@example.com' }];
  const { conn } = await render();
  assert.ok(btn(conn, 'Reconnect Google Calendar'));
  assert.ok(!btn(conn, 'Connect Google Calendar'));
});

test('connected: shows the account, last sync and Disconnect; Disconnect asks first', async () => {
  connections = [{ id: 'c1', status: 'active', account_email: 'pat@example.com', last_synced_at: '2026-10-02T15:00:00Z' }];
  confirmAnswer = false;
  let { conn } = await render();
  assert.ok(/Connected/.test(conn.textContent) && /pat@example.com/.test(conn.textContent));
  assert.ok(/Last synced/.test(conn.textContent));
  assert.ok(btn(conn, 'Open Calendar'));
  assert.ok(!btn(conn, 'Connect Google Calendar'));
  btn(conn, 'Disconnect').dispatch('click');
  await flush();
  assert.ok(!calls.some((c) => c.indexOf('disconnect') === 0), 'declining the confirmation sends nothing');

  confirmAnswer = true;
  ({ conn } = await render());
  btn(conn, 'Disconnect').dispatch('click');
  await flush();
  assert.ok(calls.includes('disconnect:c1'), 'confirming POSTs the disconnect for that connection');
  assert.ok(toasts.some((t) => /disconnected/i.test(t.message)));
  assert.strictEqual(calls.filter((c) => c === 'status').length, 2, 'and the card reloads its status');
});

test('"Last synced" carries its time zone: the calendar\'s own zone when recorded', async () => {
  connections = [{ id: 'c1', status: 'active', account_email: 'pat@example.com',
    last_synced_at: '2026-10-02T21:04:00Z', calendar_time_zone: 'America/Denver' }];
  let { conn } = await render();
  assert.ok(/Last synced: Oct 2, 2026, 3:04 PM MDT\./.test(conn.textContent), conn.textContent);
  connections[0].calendar_time_zone = 'Asia/Tokyo';
  ({ conn } = await render());
  assert.ok(/Oct 3, 2026, 6:04 AM GMT\+9/.test(conn.textContent), 'a different zone is shown in that zone');
  connections[0].calendar_time_zone = 'Not/AZone';
  ({ conn } = await render());
  assert.ok(/Last synced: Oct \d, 2026, [\d:]+ [AP]M \S+\./.test(conn.textContent),
    'an unknown zone falls back to the browser zone, still labelled: ' + conn.textContent);
  connections[0].last_synced_at = null;
  ({ conn } = await render());
  assert.ok(/Last synced: not yet/.test(conn.textContent));
});

test('a non-clinician (not a one-person practice) is told clinicians connect their own calendars', async () => {
  connections = []; canConnect = false;
  let { conn } = await render();
  canConnect = true;
  assert.ok(!btn(conn, 'Connect Google Calendar'), 'no Connect button');
  assert.ok(/Clinicians connect their own Google calendars/.test(conn.textContent));
});

test('a non-clinician with a connection that needs re-auth is still offered Reconnect', async () => {
  connections = [{ id: 'c1', status: 'needs_reauth' }]; canConnect = false;
  const { conn } = await render();
  canConnect = true;
  assert.ok(btn(conn, 'Reconnect Google Calendar'));
});

test('a non-clinician who already has an active connection still sees it and can disconnect', async () => {
  connections = [{ id: 'c1', status: 'active', account_email: 'pat@example.com' }]; canConnect = false;
  const { conn } = await render();
  canConnect = true;
  assert.ok(/Connected/.test(conn.textContent) && btn(conn, 'Disconnect'));
});

test('a status failure stays inside its card: inline error + Retry, rest of Settings intact', async () => {
  statusFails = true;
  const { root, conn } = await render();
  statusFails = false;
  assert.ok(/Could not load your calendar connection/.test(conn.textContent));
  assert.ok(btn(conn, 'Retry'));
  assert.ok(/Calendar feed \(export\)/.test(root.textContent), 'the export card still renders');
  connections = [];
  btn(conn, 'Retry').dispatch('click');
  await flush();
  assert.ok(btn(conn, 'Connect Google Calendar'), 'Retry recovers in place');
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
