'use strict';

// Unit test — Calendar view rendering + actions (public/app/views/calendar.js).
//
// Complements backend/tests/calendar_workflow.test.js (which pins the pure
// bucketing) by actually running the view. calendar.js is a browser IIFE, so it
// is evaluated against a minimal fake DOM and a fake window.Reddably kit whose
// api is a recording stub — no jsdom, no network, no real DB, in keeping with
// the hand-stubbed style of the other tests here.
//
// Covers:
//   * the view loads exactly the resources the workflow needs — the default
//     review queue, state=confirmed, state=ignored, and sessions
//     status=scheduled;
//   * "Confirm session" renders ONLY for an ended, calendar-linked scheduled
//     session, never for a future or in-progress appointment;
//   * clicking it calls sessions.update(session.id, { status: 'completed' }),
//     disables the button while the request is in flight, and reports the
//     server's claim_created verbatim;
//   * matching a client calls calendarEvents.promote(...) and never a delete —
//     the calendar-event row is retained and the view simply reloads;
//   * the visible matching label is "Match client", never a bare "Confirm";
//   * ignored appointments stay visible and can still be matched;
//   * re-rendering the same root does not duplicate rows or click handlers.
//
// Fixtures are synthetic ids and placeholder titles only — no PHI.
//
//   node backend/tests/calendar_workflow_ui.test.js

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

// --- fixtures ----------------------------------------------------------------

const HOUR = 3600 * 1000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

function ev(id, overrides) {
  return Object.assign({
    id: id,
    summary_raw: 'Appointment ' + id,
    starts_at: iso(now - 2 * HOUR),
    ends_at: iso(now - HOUR),
    duration_minutes: 50,
    event_status: 'confirmed',
    match_state: 'unmatched',
    matched_client_id: null,
    matched_client_name: null,
    match_confidence: null,
    session_id: null,
  }, overrides);
}

const ENDED = ev('e-ended', {
  match_state: 'confirmed', session_id: 's-ended', matched_client_name: 'Client A',
});
const IN_PROGRESS = ev('e-in-progress', {
  match_state: 'confirmed', session_id: 's-in-progress', matched_client_name: 'Client B',
  starts_at: iso(now - 10 * 60 * 1000), ends_at: iso(now + 40 * 60 * 1000),
});
const FUTURE_PROMOTED = ev('e-future-promoted', {
  match_state: 'confirmed', session_id: 's-future', matched_client_name: 'Client C',
  starts_at: iso(now + 24 * HOUR), ends_at: iso(now + 25 * HOUR),
});
const PAST_SUGGESTED = ev('e-past-suggested', {
  match_state: 'matched', matched_client_id: 'c-1', matched_client_name: 'Client D',
  match_confidence: 88,
  starts_at: iso(now - 30 * HOUR), ends_at: iso(now - 29 * HOUR),
});
const FUTURE_UNMATCHED = ev('e-future-unmatched', {
  starts_at: iso(now + 3 * HOUR), ends_at: iso(now + 4 * HOUR),
});
const IGNORED = ev('e-ignored', {
  match_state: 'ignored', matched_client_id: 'c-2', matched_client_name: 'Client E',
  starts_at: iso(now - 50 * HOUR), ends_at: iso(now - 49 * HOUR),
});

const SESSIONS = [
  { id: 's-ended', status: 'scheduled', session_date: '2026-07-28' },
  { id: 's-in-progress', status: 'scheduled', session_date: '2026-07-28' },
  { id: 's-future', status: 'scheduled', session_date: '2026-07-29' },
  // Manually created, calendar-less: must never reach the confirm section.
  { id: 's-manual', status: 'scheduled', session_date: '2026-07-28' },
];

const CLIENTS = [
  { id: 'c-1', first_name: 'Client', last_name: 'D', status: 'active' },
  { id: 'c-2', first_name: 'Client', last_name: 'E', status: 'active' },
];

// --- recording api stub ------------------------------------------------------

const calls = [];
let claimCreated = true;

function record(name, args, value) {
  calls.push({ name: name, args: args });
  return Promise.resolve(value);
}

const api = {
  calendarEvents: {
    list(filters) {
      const state = (filters && filters.state) || null;
      const byState = {
        null: [PAST_SUGGESTED, FUTURE_UNMATCHED],
        confirmed: [ENDED, IN_PROGRESS, FUTURE_PROMOTED],
        ignored: [IGNORED],
      };
      return record('calendarEvents.list', [filters],
        { calendar_events: byState[state === null ? 'null' : state] });
    },
    promote(id, clientId) {
      return record('calendarEvents.promote', [id, clientId],
        { session: { id: 's-new', session_date: '2026-07-29' } });
    },
    ignore(id) { return record('calendarEvents.ignore', [id], { ignored: true }); },
    sync() { return record('calendarEvents.sync', [], { synced: true }); },
  },
  sessions: {
    list(filters) { return record('sessions.list', [filters], { sessions: SESSIONS }); },
    update(id, payload) {
      return record('sessions.update', [id, payload],
        { session: { id: id, status: 'claim_ready' }, claim_created: claimCreated });
    },
  },
  clients: {
    list() { return record('clients.list', [], { clients: CLIENTS }); },
  },
  calendarConnections: {
    calendars() { return Promise.reject(new Error('no connection')); },
  },
};

// --- fake window.Reddably kit ------------------------------------------------

const toasts = [];
let viewFn = null;

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

const Reddably = {
  h: h,
  api: api,
  clear: clear,
  renderLoading(root) { clear(root); root.appendChild(h('div', { class: 'skeleton' })); },
  renderError(root, err) { clear(root); root.appendChild(h('div', { class: 'inline-error' }, String(err && err.message))); },
  fmtDate(s) { return String(s); },
  toast(message, kind) { toasts.push({ message: message, kind: kind }); },
  registerView(name, fn) { if (name === 'calendar') viewFn = fn; },
};

const fakeWindow = { Reddably: Reddably, confirm: () => false, setTimeout: setTimeout };

const sandbox = {
  window: fakeWindow, document: fakeDocument, console: console, Promise: Promise, Date: Date,
};

// The workflow bucketing is no longer part of the view: it is the shared
// classifier at public/app/workflow.js, which Dashboard reads too. Load the
// REAL module (not a stub) so this test still exercises the real rules.
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app', 'workflow.js'), 'utf8'),
  sandbox
);
assert.ok(Reddably.workflow && typeof Reddably.workflow.buildCalendarWorkflow === 'function',
  'workflow.js attaches buildCalendarWorkflow to the shared namespace');

vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app', 'views', 'calendar.js'), 'utf8'),
  sandbox
);

assert.ok(typeof viewFn === 'function', 'calendar.js registers the calendar view');

// Objects built inside the vm carry that context's Object.prototype, so
// deepStrictEqual would reject them on identity alone. Compare plain shapes.
function plain(v) {
  return JSON.parse(JSON.stringify(v === undefined ? null : v));
}

// Let the loader's promise chain settle.
function flush() {
  return new Promise((resolve) => setImmediate(() => setImmediate(() => setImmediate(resolve))));
}

// --- the tests ---------------------------------------------------------------

(async function run() {
  const root = createElement('div');
  viewFn(root);
  await flush();

  // 1. The view loads exactly the four workflow resources.
  const listFilters = calls.filter((c) => c.name === 'calendarEvents.list').map((c) => c.args[0]);
  assert.deepStrictEqual(listFilters.map(plain), [null, { state: 'confirmed' }, { state: 'ignored' }],
    'the review queue, confirmed events, and ignored events are each loaded');
  const sessionFilters = calls.filter((c) => c.name === 'sessions.list').map((c) => c.args[0]);
  assert.deepStrictEqual(sessionFilters.map(plain), [{ status: 'scheduled' }],
    "sessions are loaded with status 'scheduled'");

  // 2. Confirm session renders only in the awaiting section, for the one ended
  //    calendar-linked session.
  const awaiting = section(root, 'Sessions to confirm');
  const upcoming = section(root, 'Upcoming appointments');
  const matching = section(root, 'Appointments needing a client');
  const ignoredCard = section(root, 'Ignored appointments');

  assert.deepStrictEqual(buttonLabels(awaiting), ['Confirm session'],
    'exactly one confirmable session, with one dominant action');
  assert.strictEqual(
    buttonLabels(root).filter((l) => l === 'Confirm session').length, 1,
    'Confirm session appears nowhere else in the view'
  );

  // 3. Neither the in-progress nor the future appointment offers confirmation.
  const upcomingText = upcoming.textContent;
  assert.ok(upcomingText.includes('Appointment e-in-progress'), 'in-progress appointment is listed');
  assert.ok(upcomingText.includes('Appointment e-future-promoted'), 'future appointment is listed');
  assert.ok(!buttonLabels(upcoming).includes('Confirm session'),
    'a future or in-progress appointment never offers Confirm session');
  assert.ok(upcomingText.includes('Scheduled'),
    'an already-promoted upcoming appointment shows its scheduled state');

  // 4. Upcoming ordering is soonest-first; past matching is most-recent-first.
  const upcomingOrder = upcoming.textContent;
  assert.ok(
    upcomingOrder.indexOf('e-in-progress') < upcomingOrder.indexOf('e-future-unmatched') &&
    upcomingOrder.indexOf('e-future-unmatched') < upcomingOrder.indexOf('e-future-promoted'),
    'upcoming appointments render starts_at ascending'
  );

  // 5. The manual session is invisible here.
  assert.ok(!root.textContent.includes('s-manual'),
    'a scheduled session with no calendar event never renders');

  // 6. The matching label is "Match client" — never a bare "Confirm".
  assert.ok(buttonLabels(matching).includes('Match client'), 'past matching offers Match client');
  assert.ok(!buttonLabels(root).includes('Confirm'), 'no bare "Confirm" button anywhere');
  assert.ok(matching.textContent.includes('Appointment e-past-suggested'),
    'a past unpromoted appointment stays visible for matching');

  // 7. Ignored appointments stay visible and reversible.
  assert.ok(ignoredCard.textContent.includes('Appointment e-ignored'), 'ignored appointment is listed');
  assert.ok(buttonLabels(ignoredCard).includes('Match client'),
    'an ignored appointment can still be matched');
  assert.ok(!buttonLabels(ignoredCard).includes('Ignore'), 'already ignored — no repeat Ignore');

  // 8. Confirming calls sessions.update(session.id, { status: 'completed' }).
  const confirmBtn = buttons(awaiting)[0];
  calls.length = 0;
  toasts.length = 0;
  confirmBtn.dispatch('click');
  assert.strictEqual(confirmBtn.disabled, true, 'the action disables while in flight');
  const update = calls.find((c) => c.name === 'sessions.update');
  assert.ok(update, 'sessions.update was called');
  assert.deepStrictEqual(plain(update.args), ['s-ended', { status: 'completed' }],
    "confirming PATCHes the linked session to 'completed'");
  assert.ok(!calls.some((c) => /promote|ignore/.test(c.name)),
    'confirming a session touches no calendar-event endpoint');
  await flush();
  assert.deepStrictEqual(plain(toasts[0]),
    { message: 'Session confirmed — claim draft ready in Claims.', kind: 'success' },
    'a created draft claim is reported');

  // 9. When the server reports no new claim, the message says so.
  claimCreated = false;
  const awaiting2 = section(root, 'Sessions to confirm');
  toasts.length = 0;
  buttons(awaiting2)[0].dispatch('click');
  await flush();
  assert.deepStrictEqual(plain(toasts[0]), { message: 'Session confirmed.', kind: 'success' },
    'no new claim -> the plain confirmation message');
  claimCreated = true;

  // 10. Matching a client promotes; it is never a delete, and the row is
  //     re-derived by reloading rather than spliced out of the DOM.
  const matching2 = section(root, 'Appointments needing a client');
  const matchBtn = buttons(matching2).find((b) => b.textContent === 'Match client');
  calls.length = 0;
  matchBtn.dispatch('click');
  const promote = calls.find((c) => c.name === 'calendarEvents.promote');
  assert.ok(promote, 'calendarEvents.promote was called');
  assert.deepStrictEqual(plain(promote.args), ['e-past-suggested', 'c-1'],
    'promotion names the event and the chosen client');
  assert.ok(!calls.some((c) => /remove|delete|destroy/i.test(c.name)),
    'promotion is never implemented as a deletion');
  await flush();
  assert.ok(calls.some((c) => c.name === 'calendarEvents.list' && c.args[0] &&
    c.args[0].state === 'confirmed'), 'the view reloads so the retained event moves sections');

  // 11. Re-rendering the same root duplicates neither rows nor handlers.
  const beforeRows = rows(root).length;
  const beforeButtons = buttons(root).length;
  viewFn(root);
  await flush();
  assert.strictEqual(rows(root).length, beforeRows, 're-rendering does not duplicate rows');
  assert.strictEqual(buttons(root).length, beforeButtons, 're-rendering does not duplicate buttons');
  buttons(root).forEach((b) => {
    assert.ok((b.listeners.click || []).length <= 1, 'each button carries a single click handler');
  });

  const confirmAgain = buttons(section(root, 'Sessions to confirm'))[0];
  calls.length = 0;
  confirmAgain.dispatch('click');
  assert.strictEqual(calls.filter((c) => c.name === 'sessions.update').length, 1,
    'one click after a re-render sends exactly one update');

  // 12. A Dashboard deep link (#calendar/focus/<key>) highlights ONE section —
  // it changes nothing about which appointments are shown or how confirming
  // works, only which card carries the visual nudge.
  calls.length = 0;
  const awaitingFocusRoot = createElement('div');
  viewFn(awaitingFocusRoot, ['focus', 'awaiting']);
  await flush();
  assert.strictEqual(
    section(awaitingFocusRoot, 'Sessions to confirm').className, 'card card--focus',
    '#calendar/focus/awaiting highlights the Sessions to confirm card');
  assert.strictEqual(
    section(awaitingFocusRoot, 'Appointments needing a client').className, 'card',
    'no other section is marked when awaiting is the focus');
  assert.deepStrictEqual(buttonLabels(section(awaitingFocusRoot, 'Sessions to confirm')),
    ['Confirm session'], 'the highlighted section still behaves exactly as before');

  const matchFocusRoot = createElement('div');
  viewFn(matchFocusRoot, ['focus', 'match']);
  await flush();
  assert.strictEqual(
    section(matchFocusRoot, 'Appointments needing a client').className, 'card card--focus',
    '#calendar/focus/match highlights the matching card instead');
  assert.strictEqual(
    section(matchFocusRoot, 'Sessions to confirm').className, 'card',
    'awaiting is not also highlighted when match is the focus');

  // No focus segment (the ordinary #calendar route) highlights nothing.
  const plainRoot = createElement('div');
  viewFn(plainRoot, []);
  await flush();
  assert.strictEqual(section(plainRoot, 'Sessions to confirm').className, 'card');
  assert.strictEqual(section(plainRoot, 'Appointments needing a client').className, 'card');

  // 13. Bulk confirm — at 2+ awaiting sessions the section grows a selection
  // column and a "Confirm selected" action. There is no batch-confirm
  // endpoint (backend/handlers/sessions.js takes one session id per PATCH), so
  // this must still be exactly sessions.update(id, { status: 'completed' }),
  // sent once per selected row, sequentially. Isolated fixtures/api/viewFn (a
  // fresh vm context) so this never perturbs the single-row scenario above,
  // which stays pinned to offer no bulk UI at all.
  {
    const HOUR2 = 3600 * 1000;
    const now2 = Date.now();
    const iso2 = (ms) => new Date(ms).toISOString();
    function ev2(id, overrides) {
      return Object.assign({
        id, summary_raw: 'Appointment ' + id,
        starts_at: iso2(now2 - 2 * HOUR2), ends_at: iso2(now2 - HOUR2),
        duration_minutes: 50, event_status: 'confirmed', match_state: 'confirmed',
        matched_client_id: null, matched_client_name: null, match_confidence: null,
        session_id: null,
      }, overrides);
    }
    const B1 = ev2('b-1', { session_id: 's-b1', matched_client_name: 'Client One' });
    const B2 = ev2('b-2', { session_id: 's-b2', matched_client_name: 'Client Two' });
    const B3 = ev2('b-3', { session_id: 's-b3', matched_client_name: 'Client Three' });
    const BSESSIONS = [
      { id: 's-b1', status: 'scheduled' },
      { id: 's-b2', status: 'scheduled' },
      { id: 's-b3', status: 'scheduled' },
    ];
    // s-b2 fails to confirm — a mid-batch failure must not stop s-b1/s-b3 and
    // must be reported, not swallowed.
    const OUTCOMES = {
      's-b1': { claim_created: true },
      's-b2': null,
      's-b3': { claim_created: false },
    };

    const bulkCalls = [];
    const bulkToasts = [];
    const bulkApi = {
      calendarEvents: {
        list(filters) {
          bulkCalls.push({ name: 'calendarEvents.list', args: [filters] });
          const state = (filters && filters.state) || null;
          const byState = { null: [], confirmed: [B1, B2, B3], ignored: [] };
          return Promise.resolve({ calendar_events: byState[state === null ? 'null' : state] });
        },
        promote() { return Promise.resolve({}); },
        ignore() { return Promise.resolve({}); },
        sync() { return Promise.resolve({}); },
      },
      sessions: {
        list(filters) {
          bulkCalls.push({ name: 'sessions.list', args: [filters] });
          return Promise.resolve({ sessions: BSESSIONS });
        },
        update(id, payload) {
          bulkCalls.push({ name: 'sessions.update', args: [id, payload] });
          const outcome = OUTCOMES[id];
          if (!outcome) return Promise.reject(new Error('confirm failed'));
          return Promise.resolve({
            session: { id, status: 'claim_ready' }, claim_created: outcome.claim_created,
          });
        },
      },
      clients: { list() { return Promise.resolve({ clients: [] }); } },
      calendarConnections: { calendars() { return Promise.reject(new Error('no connection')); } },
    };

    let bulkViewFn = null;
    const BulkReddably = {
      h, api: bulkApi, clear,
      renderLoading(r) { clear(r); r.appendChild(h('div', { class: 'skeleton' })); },
      renderError(r, err) { clear(r); r.appendChild(h('div', { class: 'inline-error' }, String(err && err.message))); },
      fmtDate: (s) => String(s),
      toast(message, kind) { bulkToasts.push({ message, kind }); },
      registerView(name, fn) { if (name === 'calendar') bulkViewFn = fn; },
    };
    const bulkSandbox = {
      window: { Reddably: BulkReddably, confirm: () => false, setTimeout },
      document: fakeDocument, console, Promise, Date,
    };
    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app', 'workflow.js'), 'utf8'),
      bulkSandbox);
    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app', 'views', 'calendar.js'), 'utf8'),
      bulkSandbox);
    assert.ok(typeof bulkViewFn === 'function', 'calendar.js registers in the isolated bulk sandbox');

    const bulkRoot = createElement('div');
    bulkViewFn(bulkRoot);
    await flush();

    const bulkAwaiting = section(bulkRoot, 'Sessions to confirm');
    const bulkRows = bodyRowsOf(bulkAwaiting);
    assert.strictEqual(bulkRows.length, 3, 'all three awaiting sessions render');
    assert.deepStrictEqual(buttonLabels(bulkAwaiting).filter((l) => l === 'Confirm session'),
      ['Confirm session', 'Confirm session', 'Confirm session'],
      'each row keeps its OWN one-click confirm action — bulk is additive, not a replacement');

    const selectAll = inputs(bulkAwaiting)[0];
    const rowBoxes = bulkRows.map((r) => inputs(r)[0]);
    assert.strictEqual(rowBoxes.length, 3, 'a selection checkbox grows on every row once there are 2+');

    const bulkBtn = buttons(bulkAwaiting).find((b) => /^Confirm( \d+ sessions?)?$|^Confirm selected$/.test(b.textContent));
    assert.ok(bulkBtn, 'a bulk confirm action is offered');
    assert.strictEqual(bulkBtn.disabled, true, 'disabled until at least one row is selected');

    // Select two of the three, leave the third alone.
    rowBoxes[0].checked = true;
    rowBoxes[0].dispatch('change');
    rowBoxes[1].checked = true;
    rowBoxes[1].dispatch('change');
    assert.strictEqual(bulkBtn.disabled, false, 'enabled once at least one row is selected');
    assert.strictEqual(bulkBtn.textContent, 'Confirm 2 sessions',
      'the button states how many it is about to confirm');
    assert.strictEqual(selectAll.checked, false, '"select all" is not implicitly checked by picking some rows');

    bulkCalls.length = 0;
    bulkToasts.length = 0;
    bulkBtn.dispatch('click');
    assert.strictEqual(bulkBtn.disabled, true, 'the bulk action disables itself while in flight');
    await flush();

    const updates = bulkCalls.filter((c) => c.name === 'sessions.update');
    assert.deepStrictEqual(updates.map((c) => plain(c.args)),
      [['s-b1', { status: 'completed' }], ['s-b2', { status: 'completed' }]],
      'bulk confirm sends the SAME per-session PATCH as a single confirm, once per selected row, in order — no batch endpoint');
    assert.ok(!bulkCalls.some((c) => c.name === 's-b3'),
      'the row that was never ticked is never confirmed');

    assert.strictEqual(bulkBtn.disabled, false, 're-enabled once the batch settles');
    assert.strictEqual(bulkBtn.textContent, 'Confirm 2 sessions',
      'the button label is restored to what it said before the click (the reload that follows rebuilds it)');

    assert.deepStrictEqual(bulkToasts[0],
      { message: '1 session confirmed — 1 new claim draft ready in Claims.', kind: 'warn' },
      'a mid-batch failure still reports what DID succeed, at a warn (not success) level');
    assert.deepStrictEqual(bulkToasts[1],
      { message: '1 session could not be confirmed. Still selected — try again.', kind: 'error' },
      'the failed row is called out on its own, separately');

    assert.ok(bulkCalls.some((c) => c.name === 'calendarEvents.list' && c.args[0] && c.args[0].state === 'confirmed'),
      'the view reloads once the batch settles, exactly like a single confirm');

    // The toast says the failed row is "still selected" — that claim has to
    // survive the very reload that just tore the whole section down and
    // rebuilt it, or it is just a comforting lie. Client Two is s-b2, the one
    // that failed; it should come back ticked, and the two that succeeded
    // should come back unticked (they are freshly reloaded rows, not the ones
    // that were clicked).
    const afterReload = section(bulkRoot, 'Sessions to confirm');
    function checkedFor(clientName) {
      const row = bodyRowsOf(afterReload).find((r) => r.textContent.includes(clientName));
      assert.ok(row, 'a row for ' + clientName + ' is still rendered after the reload');
      return inputs(row)[0].checked;
    }
    assert.strictEqual(checkedFor('Client Two'), true,
      'the row that failed (s-b2) comes back preselected, exactly as the toast promised');
    assert.ok(!checkedFor('Client One'),
      'a row that succeeded (s-b1) does not come back selected');
    assert.ok(!checkedFor('Client Three'),
      'a row that was never ticked (s-b3) stays unselected');

    const bulkBtnAfterReload = buttons(afterReload)
      .find((b) => /^Confirm( \d+ sessions?)?$|^Confirm selected$/.test(b.textContent));
    assert.strictEqual(bulkBtnAfterReload.textContent, 'Confirm 1 session',
      'the bulk button reflects the one preselected row without any click');
  }

  console.log('PASS calendar_workflow_ui.test.js');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
