'use strict';

// Unit test — Calendar client search (public/app/views/calendar.js).
//
// The search box narrows every Calendar section to one client, so the existing
// select-all / "Confirm N sessions" action confirms exactly that client's
// sessions. It is a display filter only: it must never change which bucket a row
// is in, never create a claim itself, and the confirm action it feeds must still
// be exactly PATCH /sessions/{id} { status: 'completed' } per selected row.
//
// Covers:
//   * typing a name shows only that client's rows in "Sessions to confirm";
//   * every word must match, in any order, case-insensitively;
//   * an unmatched appointment is findable by its title;
//   * select-all + the bulk button then act on ONLY the filtered client's
//     sessions (the other client's session id is never sent to the API);
//   * no match shows a search-specific empty message, and clearing restores all;
//   * typing does not rebuild the input (so it keeps focus);
//   * the search text survives the reload that follows a confirm.
//
// Fixtures are synthetic names — no PHI.
//
//   node backend/tests/calendar_client_search.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// --- minimal fake DOM (same shape as calendar_workflow_ui.test.js) -----------

function textNode(v) { return { nodeType: 3, textContent: String(v), childNodes: [] }; }

function createElement(tag) {
  const el = {
    nodeType: 1, tagName: String(tag).toUpperCase(), className: '', attributes: {},
    childNodes: [], listeners: {}, parentNode: null, disabled: false, value: '', checked: false,
    appendChild(c) { c.parentNode = el; el.childNodes.push(c); return c; },
    removeChild(c) {
      const i = el.childNodes.indexOf(c);
      if (i !== -1) el.childNodes.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    setAttribute(n, v) {
      el.attributes[n] = String(v);
      if (n === 'disabled') el.disabled = true;
      if (n === 'value') el.value = String(v);
    },
    addEventListener(t, fn) { (el.listeners[t] || (el.listeners[t] = [])).push(fn); },
    dispatch(t, arg) { (el.listeners[t] || []).forEach((fn) => fn(arg || { target: el })); },
    get firstChild() { return el.childNodes[0]; },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return el.childNodes.map((c) => c.textContent).join(''); },
    set(v) { el.childNodes = [textNode(v)]; },
  });
  return el;
}

function h(tag, attrs, children) {
  const el = createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach((k) => {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class' || k === 'className') el.className = v;
      else if (k === 'text' || k === 'textContent') el.textContent = v;
      else if (k.indexOf('on') === 0 && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v);
    });
  }
  (function add(c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(add); return; }
    el.appendChild(c.nodeType ? c : textNode(c));
  })(children);
  return el;
}

function walk(node, out) {
  out = out || [];
  (node.childNodes || []).forEach((c) => { if (c.nodeType === 1) { out.push(c); walk(c, out); } });
  return out;
}
const byTag = (n, t) => walk(n).filter((e) => e.tagName === t);
const bodyRows = (n) => byTag(n, 'TR').filter((r) => r.parentNode && r.parentNode.tagName === 'TBODY');
function section(root, title) {
  const card = walk(root).find((el) => typeof el.className === 'string'
    && el.className.split(/\s+/).indexOf('card') !== -1
    && walk(el).some((c) => c.className === 'card__title' && c.textContent === title));
  assert.ok(card, 'section "' + title + '" is rendered');
  return card;
}
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };

// --- fixtures ----------------------------------------------------------------

const HOUR = 3600 * 1000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
function ev(id, o) {
  return Object.assign({
    id, summary_raw: 'Appointment ' + id, starts_at: iso(now - 2 * HOUR), ends_at: iso(now - HOUR),
    duration_minutes: 50, event_status: 'confirmed', match_state: 'confirmed',
    matched_client_id: null, matched_client_name: null, match_confidence: null, session_id: null,
  }, o);
}
const J1 = ev('e-j1', { session_id: 's-j1', matched_client_name: 'Jane Doe' });
const J2 = ev('e-j2', { session_id: 's-j2', matched_client_name: 'Jane Doe' });
const S1 = ev('e-s1', { session_id: 's-s1', matched_client_name: 'Sam Lee' });
const S2 = ev('e-s2', { session_id: 's-s2', matched_client_name: 'Sam Lee' });
const UNMATCHED = ev('e-u1', {
  match_state: 'unmatched', summary_raw: 'Parnak Example Appointment',
  starts_at: iso(now - 30 * HOUR), ends_at: iso(now - 29 * HOUR),
});
const SESSIONS = ['s-j1', 's-j2', 's-s1', 's-s2'].map((id) => ({ id, status: 'scheduled' }));

const updates = [];
let confirmed = {};
const api = {
  calendarEvents: {
    list(f) {
      const st = (f && f.state) || null;
      if (st === 'confirmed') {
        // A confirmed session leaves "scheduled", so it drops out of the queue.
        return Promise.resolve({ calendar_events: [J1, J2, S1, S2] });
      }
      return Promise.resolve({ calendar_events: st === null ? [UNMATCHED] : [] });
    },
    promote() { return Promise.resolve({}); },
    ignore() { return Promise.resolve({}); },
    sync() { return Promise.resolve({}); },
  },
  sessions: {
    list() { return Promise.resolve({ sessions: SESSIONS.filter((s) => !confirmed[s.id]) }); },
    update(id, payload) {
      updates.push({ id, payload: JSON.parse(JSON.stringify(payload)) });
      confirmed[id] = true;
      return Promise.resolve({ session: { id, status: 'claim_ready' }, claim_created: true });
    },
  },
  clients: { list() { return Promise.resolve({ clients: [] }); } },
  calendarConnections: { calendars() { return Promise.reject(new Error('no connection')); } },
};

const toasts = [];
let viewFn = null;
const Reddably = {
  h, api, clear,
  renderLoading(r) { clear(r); r.appendChild(h('div', { class: 'skeleton' })); },
  renderError(r, err) { clear(r); r.appendChild(h('div', { class: 'inline-error' }, String(err && err.message))); },
  fmtDate: (s) => String(s),
  toast(m, k) { toasts.push({ m, k }); },
  registerView(n, fn) { if (n === 'calendar') viewFn = fn; },
};
const sandbox = {
  window: { Reddably, confirm: () => false, setTimeout },
  document: { createElement, createTextNode: textNode }, console, Promise, Date,
};
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app', ...p), 'utf8');
vm.runInNewContext(read('workflow.js'), sandbox);
vm.runInNewContext(read('views', 'calendar.js'), sandbox);
assert.ok(typeof viewFn === 'function', 'calendar.js registers the calendar view');

const flush = () => new Promise((r) => setImmediate(() => setImmediate(() => setImmediate(r))));
const searchBox = (root) => {
  const box = byTag(root, 'INPUT').find((i) => i.attributes.type === 'search');
  assert.ok(box, 'a search input is rendered');
  return box;
};
function type(root, text) {
  const box = searchBox(root);
  box.value = text;
  box.dispatch('input', { target: box });
}
// Real session rows only — an empty table still renders one "no matches" row.
const confirmRows = (root) => bodyRows(section(root, 'Sessions to confirm'))
  .filter((r) => byTag(r, 'BUTTON').some((b) => b.textContent === 'Confirm session'));
const names = (rows) => rows.map((r) => r.textContent);

(async function run() {
  const root = createElement('div');
  viewFn(root);
  await flush();

  // 1. No search: everything is shown, bulk is available.
  assert.strictEqual(confirmRows(root).length, 4, 'all four sessions show before any search');

  // 2. Typing a client's name narrows to that client; it never rebuilds the box.
  const boxBefore = searchBox(root);
  type(root, 'jane');
  assert.strictEqual(searchBox(root), boxBefore, 'typing does not rebuild the input (keeps focus)');
  let rows = confirmRows(root);
  assert.strictEqual(rows.length, 2, 'only Jane Doe\'s two sessions remain');
  assert.ok(names(rows).every((t) => t.includes('Jane Doe')), 'and they are all Jane Doe\'s');

  // 3. Case-insensitive, any word order, every word required.
  type(root, 'DOE jane');
  assert.strictEqual(confirmRows(root).length, 2, 'case and word order do not matter');
  type(root, 'jane lee');
  assert.strictEqual(confirmRows(root).length, 0, 'every word must match — "jane lee" is nobody');

  // 4. No match: a search-specific empty message, not the generic one.
  assert.ok(section(root, 'Sessions to confirm').textContent.includes('match “jane lee”'),
    'an empty result names the search');
  assert.ok(!section(root, 'Sessions to confirm').textContent.includes('No sessions waiting'),
    'the generic empty message is not shown while searching');

  // 5. An unmatched appointment is findable by its title.
  type(root, 'parnak');
  assert.ok(section(root, 'Appointments needing a client').textContent.includes('Parnak Example Appointment'),
    'an unmatched appointment is found by its title');
  assert.strictEqual(confirmRows(root).length, 0, 'and no session row matches it');

  // 5b. While searching, sections with no match are left out (no wall of empty
  // boxes), but "Sessions to confirm" always stays.
  const titles = () => walk(root).filter((e) => e.className === 'card__title').map((e) => e.textContent);
  assert.deepStrictEqual(titles(), ['Sessions to confirm', 'Appointments needing a client'],
    'only the section with a match, plus Sessions to confirm, are shown');
  type(root, 'zzz');
  assert.deepStrictEqual(titles(), ['Sessions to confirm'], 'a search with no hits keeps just Sessions to confirm');

  // 6. Clearing the search restores everything.
  type(root, '');
  assert.strictEqual(confirmRows(root).length, 4, 'clearing the search restores all sessions');
  assert.strictEqual(titles().length, 4, 'and all four sections');

  // 7. Search then select-all then bulk confirm acts on ONLY that client.
  type(root, 'sam lee');
  const card = section(root, 'Sessions to confirm');
  const selectAll = byTag(card, 'INPUT').find((i) => i.attributes['aria-label'] === 'Select all sessions to confirm');
  assert.ok(selectAll, 'select-all is offered for the filtered pair');
  selectAll.checked = true;
  selectAll.dispatch('change', { target: selectAll });
  const bulk = byTag(card, 'BUTTON').find((b) => /^Confirm \d+ sessions?$/.test(b.textContent));
  assert.ok(bulk, 'the bulk button appears');
  assert.strictEqual(bulk.textContent, 'Confirm 2 sessions', 'it counts only the filtered client\'s sessions');
  bulk.dispatch('click');
  await flush();
  await flush();

  assert.deepStrictEqual(updates.map((u) => u.id).sort(), ['s-s1', 's-s2'],
    'exactly Sam Lee\'s two sessions were confirmed — never Jane Doe\'s');
  updates.forEach((u) => assert.deepStrictEqual(u.payload, { status: 'completed' },
    'each is the ordinary single-session confirm'));

  // 8. The search survives the reload that follows a confirm.
  assert.strictEqual(searchBox(root).value, 'sam lee', 'the search text is kept across the reload');
  assert.strictEqual(confirmRows(root).length, 0, 'and the confirmed sessions are gone from the filtered view');
  type(root, '');
  assert.deepStrictEqual(names(confirmRows(root)).map((t) => /Jane Doe/.test(t)), [true, true],
    'Jane Doe\'s sessions are untouched and still waiting');

  console.log('PASS calendar_client_search.test.js');
})().catch((err) => { console.error(err); process.exit(1); });
