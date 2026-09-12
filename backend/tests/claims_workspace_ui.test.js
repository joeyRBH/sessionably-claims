'use strict';

// Unit test — Claims workspace rendering (public/app/views/claims.js).
//
// The split this pins down: drafts are verification work and live on top under
// "Ready to verify and submit"; everything else is history underneath. Covers:
//
//   * draft vs non-draft partitioning, in both sections, always;
//   * drafts sorted by date of service descending, created_at as the stable
//     tie-breaker; history sorted by submitted_at descending with created_at as
//     the deterministic fallback for rows that were never submitted;
//   * a draft row shows client, date of service, CPT, diagnosis, billed amount,
//     payer and the server's readiness verdict;
//   * the readiness badge is INFORMATIONAL — the list offers no submit, no
//     batch action, and ready_to_review is never treated as approval;
//   * the status filter belongs to the submitted section only and can never
//     empty the draft queue;
//   * each section has its own empty state;
//   * "New claim" still opens the existing two-step picker, rendered as a
//     secondary (ghost) action.
//
// claims.js is a browser IIFE, so it is evaluated against a minimal fake DOM and
// a fake window.Reddably kit whose api is a recording stub — no jsdom, no
// network, no real DB, in keeping with the hand-stubbed style of the other tests
// here. Fixtures are synthetic ids and placeholder names — no PHI.
//
//   node backend/tests/claims_workspace_ui.test.js

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
      if (name === 'value') el.value = String(value);
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

function tagged(node, tag) {
  return walk(node).filter((el) => el.tagName === tag);
}

function buttonLabels(node) {
  return tagged(node, 'BUTTON').map((b) => b.textContent);
}

// Body rows of the section's table (skips the header row, which lives in THEAD).
function bodyRows(node) {
  const tbody = tagged(node, 'TBODY')[0];
  return tbody ? tagged(tbody, 'TR') : [];
}

function cellTexts(row) {
  return tagged(row, 'TD').map((td) => td.textContent);
}

function headers(node) {
  return tagged(node, 'TH').map((th) => th.textContent);
}

// The card whose .card__title reads `title`.
function section(root, title) {
  const card = walk(root).find(
    (el) => el.className === 'card' &&
      walk(el).some((c) => c.className === 'card__title' && c.textContent === title)
  );
  assert.ok(card, 'section "' + title + '" is rendered');
  return card;
}

function sectionOrNull(root, title) {
  return walk(root).find(
    (el) => el.className === 'card' &&
      walk(el).some((c) => c.className === 'card__title' && c.textContent === title)
  ) || null;
}

// --- fixtures ----------------------------------------------------------------

function readiness(state, blockers, warnings) {
  return { state, blockers: blockers || [], warnings: warnings || [] };
}

function claim(over) {
  return Object.assign({
    id: 'x', client_id: 'c1', client_name: 'Client X', session_date: '2026-06-01',
    cpt_code: '90837', diagnosis_codes: ['F411'], place_of_service: '10',
    billed_amount: '150.00', payer_name: 'Aetna', payer_id: '60054',
    status: 'draft', submitted_at: null, created_at: '2026-06-01T09:00:00.000Z',
    readiness: readiness('ready_to_review'),
  }, over || {});
}

// Three drafts whose service dates deliberately disagree with creation order,
// plus two same-day drafts to exercise the created_at tie-breaker.
const DRAFTS = [
  claim({ id: 'd-old', session_date: '2026-05-01', created_at: '2026-05-01T09:00:00.000Z',
    readiness: readiness('needs_correction',
      [{ code: 'client_date_of_birth', message: 'Client date of birth is required.', status: 422 }]) }),
  claim({ id: 'd-new', session_date: '2026-07-10', created_at: '2026-05-02T09:00:00.000Z',
    client_name: 'Client Newest', diagnosis_codes: ['F411', 'F331', 'F401', 'F900'],
    readiness: readiness('review_warning', [],
      [{ code: 'member_id_length_unusual', message: 'Member ID length looks unusual.' }]) }),
  claim({ id: 'd-mid-a', client_name: 'Client Earlier', session_date: '2026-06-15',
    created_at: '2026-06-15T08:00:00.000Z' }),
  claim({ id: 'd-mid-b', client_name: 'Client Later', session_date: '2026-06-15',
    created_at: '2026-06-15T11:00:00.000Z' }),
];

// History, including a void claim that was never submitted (submitted_at null)
// and an unconfirmed-submission sentinel (submitted, no control number).
const HISTORY = [
  claim({ id: 'h-paid', status: 'paid', submitted_at: '2026-06-20T00:00:00.000Z',
    created_at: '2026-06-19T00:00:00.000Z', readiness: null }),
  claim({ id: 'h-sentinel', status: 'submitted', control_number: null,
    submitted_at: '2026-07-01T00:00:00.000Z', created_at: '2026-06-30T00:00:00.000Z', readiness: null }),
  claim({ id: 'h-void', status: 'void', submitted_at: null,
    created_at: '2026-06-25T00:00:00.000Z', readiness: null }),
  claim({ id: 'h-denied', status: 'denied', submitted_at: '2026-06-10T00:00:00.000Z',
    created_at: '2026-06-09T00:00:00.000Z', readiness: null }),
];

// --- recording api stub ------------------------------------------------------

const calls = [];
let listResult = DRAFTS.concat(HISTORY);
// What the SERVER says is groupable. The browser never derives this — it renders
// what it is handed — so the stub is the whole of the rule as far as this test
// is concerned. backend/tests/claim_grouping_suggestions.test.js tests the rule.
let listSuggestions = [];

const api = {
  claims: {
    list(filters) {
      calls.push({ name: 'claims.list', args: [filters] });
      const status = filters && filters.status;
      const rows = status ? listResult.filter((c) => c.status === status) : listResult;
      // Suggestions ride the draft-bearing response only, as the handler sends
      // them: computed over drafts, so a history-only request carries none.
      const suggestions = (!status || status === 'draft') ? listSuggestions : [];
      return Promise.resolve({ claims: rows, suggestions });
    },
    // Recorded, never expected: a suggestion must not file anything on its own.
    group(ids) {
      calls.push({ name: 'claims.group', args: [ids] });
      return Promise.resolve({ claim: { id: 'grouped' } });
    },
  },
  clients: {
    list() {
      calls.push({ name: 'clients.list', args: [] });
      return Promise.resolve({ clients: [{ id: 'c1', first_name: 'Client', last_name: 'X' }] });
    },
  },
  sessions: {
    list(filters) {
      calls.push({ name: 'sessions.list', args: [filters] });
      return Promise.resolve({ sessions: [{ id: 's1', session_date: '2026-06-01', cpt_code: '90837', fee: 150 }] });
    },
  },
};

// --- fake window.Reddably kit ------------------------------------------------

const modals = [];
const confirms = [];
let emptyState = null;

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

let viewFn = null;
const Reddably = {
  h,
  api,
  clear,
  renderLoading(root) { clear(root); root.appendChild(h('div', { class: 'skeleton' })); },
  renderError(root, err) { clear(root); root.appendChild(h('div', { class: 'inline-error' }, String(err && err.message))); },
  renderEmpty(root, opts) {
    clear(root);
    emptyState = opts;
    root.appendChild(h('div', { class: 'empty-state' }, opts.title));
  },
  fmtDate(s) { return s ? String(s).slice(0, 10) : '—'; },
  fmtMoney(v) { return v == null ? '—' : '$' + v; },
  statusBadge(status) { return h('span', { class: 'badge badge--neutral' }, status); },
  scrubVendor(s) { return s; },
  toast() {},
  navigate(hash) { calls.push({ name: 'navigate', args: [hash] }); },
  confirmModal(opts) { confirms.push(opts); return Promise.resolve(false); },
  formModal(opts) { modals.push(opts); return Promise.resolve(null); },
  registerView(name, fn) { if (name === 'claims') viewFn = fn; },
};

vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app', 'views', 'claims.js'), 'utf8'),
  { window: { Reddably }, document: fakeDocument, console, Promise, Date }
);

assert.ok(typeof viewFn === 'function', 'claims.js registers the claims view');

function flush() {
  return new Promise((resolve) => setImmediate(() => setImmediate(() => setImmediate(resolve))));
}

// Objects built inside the vm carry that context's Object.prototype, so
// deepStrictEqual would reject them on identity alone. Compare plain shapes.
function plain(v) {
  return JSON.parse(JSON.stringify(v === undefined ? null : v));
}

// --- the tests ---------------------------------------------------------------

(async function run() {
  const root = createElement('div');
  viewFn(root, []);
  await flush();

  const drafts = section(root, 'Ready to verify and submit');
  const submitted = section(root, 'Submitted claims');

  // 1. The unfiltered page is ONE request; both sections come from it.
  assert.deepStrictEqual(
    calls.filter((c) => c.name === 'claims.list').map((c) => plain(c.args[0])),
    [null],
    'the default page loads claims once, unfiltered'
  );

  // 2. Verification work is on top, history below.
  const order = walk(root).filter((el) => el.className === 'card');
  assert.strictEqual(order[0], drafts, 'the draft queue is the first card on the page');
  assert.strictEqual(order[1], submitted, 'submitted history comes second');

  // 3. Partitioning: every draft above, every non-draft below, nothing shared.
  const draftIds = bodyRows(drafts).map((r) => cellTexts(r)[1]);
  assert.strictEqual(bodyRows(drafts).length, DRAFTS.length, 'every draft is in the draft section');
  assert.strictEqual(bodyRows(submitted).length, HISTORY.length, 'every non-draft is in history');
  ['h-paid', 'h-void', 'h-denied', 'h-sentinel'].forEach((id) => {
    assert.ok(!drafts.textContent.includes(id), id + ' never appears in the draft queue');
  });

  // 4. Draft rows carry the full verification set, in order. The leading blank
  // header is the grouping selection column — ticking several sessions for one
  // client files them on a single multi-line claim.
  assert.deepStrictEqual(headers(drafts), [
    '', 'Client', 'Date of service', 'CPT', 'Diagnosis', 'Billed', 'Payer', 'Validation',
  ], 'a draft row shows everything a human verifies');

  // Cell indices are 1-based past the leading selection checkbox.
  const newest = bodyRows(drafts)[0];
  assert.strictEqual(cellTexts(newest)[1], 'Client Newest');
  assert.strictEqual(cellTexts(newest)[2], '2026-07-10');
  assert.strictEqual(cellTexts(newest)[3], '90837');
  assert.strictEqual(cellTexts(newest)[4], 'F411, F331, F401 +1',
    'multiple diagnoses read concisely, in their stored order');
  assert.strictEqual(cellTexts(newest)[5], '$150.00');
  assert.strictEqual(cellTexts(newest)[6], 'Aetna');
  assert.ok(cellTexts(newest)[7].indexOf('Review warning') === 0, 'the readiness verdict is shown');

  // 5. Drafts sort by service date descending, created_at as the tie-breaker.
  assert.deepStrictEqual(
    bodyRows(drafts).map((r) => cellTexts(r)[2]),
    ['2026-07-10', '2026-06-15', '2026-06-15', '2026-05-01'],
    'drafts are newest date of service first'
  );
  // The two 2026-06-15 drafts share a service date, so created_at breaks the
  // tie deterministically — later creation first.
  assert.deepStrictEqual(
    bodyRows(drafts).slice(1, 3).map((r) => cellTexts(r)[1]),
    ['Client Later', 'Client Earlier'],
    'same-day drafts fall back to creation time descending, stably'
  );
  const draftText = drafts.textContent;

  // 6. Each readiness state renders its own explicit label.
  ['Needs correction', 'Review warning', 'Ready to review'].forEach((label) => {
    assert.ok(draftText.includes(label), 'the "' + label + '" verdict is rendered');
  });
  assert.ok(!draftText.includes('Ready to submit'),
    'the verdict is never phrased as ready to submit');

  // 7. The badge is informational, and the list still never DECIDES anything
  // about a claim. Grouping is the one action here, and it composes drafts —
  // it files nothing. Submitting, approving, voiding and deleting all stay on
  // the detail screen, which is the invariant this originally protected.
  const draftButtons = buttonLabels(drafts);
  assert.deepStrictEqual(draftButtons, ['Group selected'],
    'the draft queue offers grouping and nothing else');
  ['Submit', 'Approve', 'Delete', 'Void', 'Replace'].forEach((label) => {
    assert.ok(!draftButtons.some((b) => b.indexOf(label) !== -1),
      'the list never offers "' + label + '" — that decision stays on the detail screen');
  });
  assert.ok(!/submit|approve|send/i.test(draftText.replace('Ready to verify and submit', '')),
    'nothing in the queue reads as an action on the claim');
  // Rows open the existing detail screen.
  bodyRows(drafts)[0].dispatch('click');
  assert.deepStrictEqual(calls[calls.length - 1], { name: 'navigate', args: ['claims/d-new'] },
    'a draft row opens the claim detail, where edit and submit live');

  // 8. History sorts by submitted_at desc, created_at as the fallback for a
  //    claim that was never submitted.
  assert.deepStrictEqual(
    bodyRows(submitted).map((r) => tagged(r, 'TD')[3].textContent),
    ['submitted', 'paid', 'denied', 'void'],
    'history is most-recently-submitted first; the never-submitted void row falls back to created_at'
  );
  assert.deepStrictEqual(headers(submitted), [
    'Client', 'Date of service', 'Billed', 'Status', 'Payer', 'Submitted',
  ]);

  // 9. The status filter lives in the submitted section and excludes draft.
  const selects = tagged(root, 'SELECT');
  assert.strictEqual(selects.length, 1, 'exactly one status filter on the page');
  assert.ok(walk(submitted).indexOf(selects[0]) !== -1, 'the filter belongs to the submitted section');
  const options = tagged(selects[0], 'OPTION').map((o) => o.attributes.value);
  assert.deepStrictEqual(options,
    ['', 'submitted', 'processing', 'info_requested', 'denied', 'appealed', 'paid', 'void'],
    'the history filter never offers draft — filtering history cannot hide the queue');

  // 10. Choosing a history status keeps the draft queue intact.
  calls.length = 0;
  selects[0].value = 'paid';
  selects[0].dispatch('change', { target: selects[0] });
  await flush();
  assert.deepStrictEqual(
    calls.filter((c) => c.name === 'claims.list').map((c) => plain(c.args[0])),
    [{ status: 'draft' }, { status: 'paid' }],
    'filtering history re-queries drafts unfiltered alongside the filtered history'
  );
  const draftsAfter = section(root, 'Ready to verify and submit');
  assert.strictEqual(bodyRows(draftsAfter).length, DRAFTS.length,
    'every draft is still visible while history is filtered');
  assert.deepStrictEqual(
    bodyRows(section(root, 'Submitted claims')).map((r) => tagged(r, 'TD')[3].textContent),
    ['paid'], 'history shows only the filtered status');

  // 11. Per-section empty states — one quiet section never blanks the other.
  listResult = HISTORY;
  calls.length = 0;
  viewFn(root, []);
  await flush();
  assert.ok(section(root, 'Ready to verify and submit').textContent
    .includes('No claims waiting for verification.'), 'the draft section has its own empty state');
  assert.ok(sectionOrNull(root, 'Submitted claims'), 'the submitted section still renders its rows');

  listResult = DRAFTS;
  viewFn(root, []);
  await flush();
  assert.ok(section(root, 'Submitted claims').textContent.includes('No submitted claims yet.'),
    'the submitted section has its own empty state');
  assert.strictEqual(bodyRows(section(root, 'Ready to verify and submit')).length, DRAFTS.length,
    'the draft queue is untouched by an empty history');

  // 12. Only a wholly empty, unfiltered workspace falls back to the page-level
  //     placeholder.
  listResult = [];
  emptyState = null;
  viewFn(root, []);
  await flush();
  assert.ok(emptyState && emptyState.title === 'No claims yet',
    'a completely empty workspace still shows the full placeholder');

  // 13. New claim stays functional, and stays secondary.
  listResult = DRAFTS.concat(HISTORY);
  viewFn(root, []);
  await flush();
  const newClaim = tagged(root, 'BUTTON').find((b) => b.textContent === 'New claim');
  assert.ok(newClaim, '"New claim" is still available');
  assert.strictEqual(newClaim.className, 'btn btn--ghost',
    'manual creation is a secondary action, not the page\'s primary call');
  assert.ok(!tagged(root, 'BUTTON').some((b) => /btn--primary/.test(b.className)),
    'nothing in the workspace competes with the verification queue as a primary action');

  calls.length = 0;
  modals.length = 0;
  newClaim.dispatch('click');
  await flush();
  assert.ok(calls.some((c) => c.name === 'clients.list'), 'New claim still loads clients');
  assert.ok(modals.length && /choose client/i.test(modals[0].title),
    'New claim still opens the existing two-step picker');

  // 14. Re-rendering the same root duplicates neither rows nor handlers.
  const beforeRows = tagged(root, 'TR').length;
  viewFn(root, []);
  await flush();
  assert.strictEqual(tagged(root, 'TR').length, beforeRows, 're-rendering does not duplicate rows');
  tagged(root, 'TR').forEach((r) => {
    assert.ok((r.listeners.click || []).length <= 1, 'each row carries a single click handler');
  });

  // 15. Grouping suggestions — the software spots groupable drafts itself.
  //
  // The invariant under test is ADVISE, NEVER ACT: a suggestion may change what
  // the biller notices and what is ticked, and nothing else. It routes through
  // the SAME confirmation the manual path uses, and this test refuses to let it
  // reach api.claims.group without one.
  const G1 = claim({ id: 'g-1', client_id: 'cg', client_name: 'Client Grouped',
    session_date: '2026-08-01', created_at: '2026-08-01T09:00:00.000Z' });
  const G2 = claim({ id: 'g-2', client_id: 'cg', client_name: 'Client Grouped',
    session_date: '2026-08-15', created_at: '2026-08-15T09:00:00.000Z' });
  const G3 = claim({ id: 'g-3', client_id: 'cs', client_name: 'Client Solo',
    session_date: '2026-08-20', created_at: '2026-08-20T09:00:00.000Z' });

  async function workspace(rows, suggestions) {
    listResult = rows;
    listSuggestions = suggestions;
    calls.length = 0;
    confirms.length = 0;
    const el = createElement('div');
    viewFn(el, []);
    await flush();
    return el;
  }
  function calloutOf(node) {
    return walk(node).find((el) => el.className === 'claim-suggest') || null;
  }

  const sRoot = await workspace([G1, G2, G3],
    [{ client_id: 'cg', claim_ids: ['g-1', 'g-2'], lines: 2, total: 300 }]);
  const sDrafts = section(sRoot, 'Ready to verify and submit');
  const callout = calloutOf(sDrafts);

  assert.ok(callout, 'a groupable set is offered without the biller having to spot it');
  assert.ok(/Client Grouped/.test(callout.textContent), 'the suggestion names the client');
  assert.ok(/2026-08-01/.test(callout.textContent) && /2026-08-15/.test(callout.textContent),
    'it shows the span of service dates the grouped claim would cover');
  assert.ok(/\$300/.test(callout.textContent),
    'it shows the total that will be filed — and that the 5% fee will be taken on');
  assert.ok(!/Client Solo/.test(callout.textContent),
    'a draft the server did not put in a set is never named in one');

  // It sits above the queue it is about, inside the verification card.
  assert.ok(walk(sDrafts).indexOf(callout) < walk(sDrafts).findIndex((el) => el.tagName === 'TBODY'),
    'the suggestion is read before the table it refers to');

  // Rendering alone files nothing.
  assert.ok(!calls.some((c) => c.name === 'claims.group'),
    'ADVISE, NEVER ACT: showing a suggestion does not group anything');

  // 16. Acting on a suggestion ticks exactly its rows and asks for confirmation.
  const reviewBtn = tagged(callout, 'BUTTON')[0];
  assert.strictEqual(reviewBtn.textContent, 'Review these 2',
    'the button says how many claims it is about');

  // A stray tick from before must not ride along into the grouping: the dialog
  // names dates and a total, not rows, so the ticked set has to be exactly what
  // the dialog is about to describe.
  const soloBox = tagged(
    bodyRows(sDrafts).find((r) => cellTexts(r)[1] === 'Client Solo'), 'INPUT')[0];
  soloBox.checked = true;
  soloBox.dispatch('change');

  reviewBtn.dispatch('click');
  await flush();

  const rowsByClient = {};
  bodyRows(sDrafts).forEach((r) => { rowsByClient[cellTexts(r)[1]] = r; });
  const tickedRows = bodyRows(sDrafts)
    .filter((r) => tagged(r, 'INPUT')[0].checked === true);
  assert.strictEqual(tickedRows.length, 2, 'exactly the suggested rows are ticked');
  assert.ok(tagged(rowsByClient['Client Solo'], 'INPUT')[0].checked !== true,
    'a draft ticked beforehand is cleared, not folded into the suggested claim');

  assert.strictEqual(confirms.length, 1,
    'acting on a suggestion opens the same confirmation the manual path uses');
  assert.ok(/Group 2 claims into one/.test(confirms[0].title),
    'the dialog describes the grouping in the biller\'s terms');
  assert.ok(!calls.some((c) => c.name === 'claims.group'),
    'nothing is filed while the confirmation is unanswered — the stub declines it');

  // 17. A suggestion naming a draft that is not on screen is not offered at all.
  //
  // Rather than ticking fewer rows than its button promises. The list and the
  // suggestions come from one response, so this means the queue moved under us.
  const staleRoot = await workspace([G1, G2, G3],
    [{ client_id: 'cg', claim_ids: ['g-1', 'g-gone'], lines: 2, total: 300 }]);
  assert.strictEqual(calloutOf(section(staleRoot, 'Ready to verify and submit')), null,
    'a suggestion it cannot fully honour is withheld, not partially applied');

  // 18. Nothing groupable, nothing said. A quiet queue stays quiet.
  const quietRoot = await workspace([G1, G3], []);
  assert.strictEqual(calloutOf(section(quietRoot, 'Ready to verify and submit')), null,
    'no callout when the server suggests nothing');

  // 19. An older client without suggestions still renders — the field is optional
  // on the response, so a cached/older API must not blank the workspace.
  listResult = [G1, G3];
  calls.length = 0;
  const legacyApiRoot = createElement('div');
  const realList = api.claims.list;
  api.claims.list = function (filters) {
    calls.push({ name: 'claims.list', args: [filters] });
    return Promise.resolve({ claims: listResult });
  };
  viewFn(legacyApiRoot, []);
  await flush();
  api.claims.list = realList;
  assert.strictEqual(bodyRows(section(legacyApiRoot, 'Ready to verify and submit')).length, 2,
    'a response with no suggestions field still renders the queue');
  assert.strictEqual(calloutOf(section(legacyApiRoot, 'Ready to verify and submit')), null);

  // Restore the fixtures the remaining assertions expect.
  listResult = DRAFTS.concat(HISTORY);
  listSuggestions = [];

  // 20. The cache-buster for this view was bumped.
  const appHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app', 'app.html'), 'utf8');
  assert.match(appHtml, /\.\/views\/claims\.js\?v=20260912a/,
    'app.html serves claims.js?v=20260912a');
  assert.match(appHtml, /\.\/components\.css\?v=20260912a/,
    'app.html serves components.css?v=20260912a — the suggestion callout is styled there');

  console.log('PASS claims_workspace_ui.test.js');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
