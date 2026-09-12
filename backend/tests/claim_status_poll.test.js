'use strict';

// Unit test — the scheduled clearinghouse status poller
// (backend/handlers/claim_status_poll.js).
//
// This is the first thing in the system that can change a claim's status, and
// therefore raise a refund request, WITH NO HUMAN IN THE LOOP. Everything below
// is about the two switches that stand between it and that:
//
//   * DRY RUN IS THE DEFAULT, and only the exact string "false" leaves it. An
//     unset, empty or misspelled value must read as dry — the safe reading of an
//     ambiguous configuration is the one that writes nothing.
//   * A dry run writes ONLY the acknowledgment (claim_acknowledgments is the
//     "stored, never acted on" dataset, and collecting real payloads is the
//     whole point of running dry). No status change, no claim_event, no refund
//     request.
//
// The schedule itself is disabled in terraform; that is asserted separately in
// infra, not here.
//
//   node backend/tests/claim_status_poll.test.js

const assert = require('node:assert');
const path = require('node:path');

function mock(rel, exports) {
  const resolved = require.resolve(path.join(__dirname, '..', rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const PRACTICE = '11111111-1111-4111-8111-111111111111';
const CLAIM = { id: '2f1c9a3e-7b4d-4c2a-9e11-abcdef012345', practice_id: PRACTICE,
  client_id: '44444444-4444-4444-8444-444444444444', status: 'submitted',
  control_number: 'CN-1', is_hidden: false };

let candidates = [];
let statusResult = null;
let statusThrows = null;
let writes = [];
let acks = [];
let events = [];
let audits = [];
let applied = [];

function reset() {
  candidates = [CLAIM]; statusThrows = null;
  writes = []; acks = []; events = []; audits = []; applied = [];
  statusResult = { status: 'denied', denial_class: 'adjudicated', raw: { ok: true } };
  delete process.env.CLAIM_POLL_DRY_RUN;
  // All three present, so hydrateFromSsm() never reaches for the AWS SDK (which
  // the Lambda runtime provides and package.json deliberately does not).
  process.env.DATABASE_URL = 'postgres://stub';
  process.env.STEDI_API_KEY = 'stub-key';
  process.env.CLEARINGHOUSE = 'stedi';
}

mock('lib/db.js', {
  query: async (sql) => {
    writes.push(sql);
    if (/from claims c/i.test(sql)) return { rowCount: candidates.length, rows: candidates };
    return { rowCount: 0, rows: [] };
  },
  withTransaction: async (fn) => fn({ query: async (sql) => { writes.push(sql); return { rowCount: 1, rows: [{}] }; } }),
});
mock('lib/claims.js', {
  logClaimEvent: async (c, e) => { events.push(e); },
  logClaimAcknowledgment: async (c, a) => { acks.push(a); },
  primaryInsuranceForClient: async () => null,
  loadClaimSessions: async () => [],
});
mock('lib/claim_context.js', {
  buildClaimContext: async () => ({ claim: CLAIM }),
  eventTypeForStatus: () => 'denied',
  loadSession: async () => null,
  loadInsuranceRecord: async () => null,
});
mock('lib/clearinghouse/index.js', {
  getClearinghouse: () => ({
    name: 'stedi',
    getStatus: async () => { if (statusThrows) throw statusThrows; return statusResult; },
  }),
});
mock('lib/audit.js', { audit: async (e, ctx, entry) => { audits.push({ ctx, entry }); }, sanitizeFields: (x) => x });
mock('lib/claim_status_apply.js', {
  applyStatusResult: async (db, p) => {
    applied.push(p);
    return { updated: Object.assign({}, p.claim, { status: p.statusResult.status }),
      changed: true, autoRefund: { created: true, request: { id: 'req-1' } } };
  },
  refundOutcomeCode: (a) => (a && a.created ? 'created' : 'declined'),
});

const { handler } = require('../handlers/claim_status_poll.js');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- the default is dry ---------------------------------------------------------

test('with no configuration at all, the run is DRY', async () => {
  reset();
  const out = await handler();
  assert.strictEqual(out.summary.dry_run, true,
    'an unconfigured poller must never be a writing poller');
  assert.strictEqual(applied.length, 0, 'nothing was applied');
});

test('only an explicit "false" leaves dry run', async () => {
  // Case and surrounding whitespace are forgiven — someone who typed "False"
  // meant false. Everything ELSE reads as dry, including values that look
  // vaguely negative ('no', '0', 'falsey'): the dangerous mistake is a value
  // meaning "stay safe" being read as "go live", and none of these can be.
  for (const v of ['true', 'TRUE', '', 'no', '0', 'falsey', 'yes', 'off', 'nope']) {
    reset();
    process.env.CLAIM_POLL_DRY_RUN = v;
    const out = await handler();
    assert.strictEqual(out.summary.dry_run, true,
      JSON.stringify(v) + ' must read as DRY — an ambiguous value cannot start writing');
  }
  // ...and the two spellings that do disable it.
  for (const v of ['false', 'FALSE', 'False', ' false ']) {
    reset();
    process.env.CLAIM_POLL_DRY_RUN = v;
    const out = await handler();
    assert.strictEqual(out.summary.dry_run, false, JSON.stringify(v) + ' disables dry run');
  }
});

// --- what a dry run does, and does not, write -------------------------------------

test('a dry run stores the acknowledgment and NOTHING else', async () => {
  reset();
  const out = await handler();

  assert.strictEqual(acks.length, 1, 'the verbatim payload is kept — that is the point of running dry');
  assert.deepStrictEqual(acks[0].payload, { ok: true });
  assert.strictEqual(acks[0].kind, 'status');

  assert.strictEqual(applied.length, 0, 'no status was applied');
  assert.strictEqual(events.length, 0, 'no claim_event was written');
  assert.ok(!writes.some((w) => /insert into refund_requests/i.test(w)),
    'NO REFUND REQUEST — a dry run must never raise one');
  assert.ok(!writes.some((w) => /update claims/i.test(w)), 'no claim was updated');
});

test('a dry run REPORTS what it would have done', async () => {
  reset();
  const out = await handler();
  assert.strictEqual(out.summary.would_update, 1);
  assert.strictEqual(out.summary.would_create_refund_request, 1,
    'the classifier verdict on a real payload is the number worth reading');
  assert.strictEqual(out.summary.refund_requests_created, 0, 'and it created none');
});

test('a dry run does not count a front-door rejection as a refund', async () => {
  reset();
  statusResult = { status: 'denied', denial_class: 'acknowledgement_reject', raw: {} };
  const out = await handler();
  assert.strictEqual(out.summary.would_create_refund_request, 0,
    'the same distinction applies whether a human or a schedule found it');
});

// --- the live path ----------------------------------------------------------------

test('a live run applies the status as the SYSTEM actor', async () => {
  reset();
  process.env.CLAIM_POLL_DRY_RUN = 'false';
  const out = await handler();

  assert.strictEqual(applied.length, 1);
  assert.deepStrictEqual(applied[0].actor, { actorType: 'system' },
    'no user did this, and audit_log/claim_events both model that');
  assert.strictEqual(applied[0].practiceId, PRACTICE, 'scoped to the claim\'s own practice');
  assert.strictEqual(out.summary.updated, 1);
  assert.strictEqual(out.summary.refund_requests_created, 1);
  assert.ok(audits.some((a) => a.entry.action === 'claim.status_poll'),
    'an unattended status change is auditable');
});

// --- resilience --------------------------------------------------------------------

test('one claim failing does not end the run', async () => {
  reset();
  const other = Object.assign({}, CLAIM, { id: '99999999-9999-4999-8999-999999999999' });
  candidates = [CLAIM, other];
  let first = true;
  mock('lib/clearinghouse/index.js', {
    getClearinghouse: () => ({
      name: 'stedi',
      getStatus: async () => {
        if (first) { first = false; throw new Error('timeout'); }
        return statusResult;
      },
    }),
  });
  delete require.cache[require.resolve('../handlers/claim_status_poll.js')];
  const { handler: h2 } = require('../handlers/claim_status_poll.js');

  const out = await h2();
  assert.strictEqual(out.summary.errors, 1);
  assert.strictEqual(out.summary.checked, 2, 'it kept going — the next claim is unrelated');
  assert.strictEqual(acks.length, 1, 'the one that answered was still recorded');
});

test('a candidate with no update is counted, not written', async () => {
  reset();
  statusResult = { no_update: true, raw: {} };
  const out = await handler();
  assert.strictEqual(out.summary.no_update, 1);
  assert.strictEqual(acks.length, 0);
});

test('an empty queue is a clean no-op', async () => {
  reset();
  candidates = [];
  const out = await handler();
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.summary.checked, 0);
});

// --- which claims it asks about ------------------------------------------------------

test('the candidate query excludes terminal claims and recent checks', async () => {
  reset();
  await handler();
  const q = writes.find((w) => /from claims c/i.test(w));
  assert.ok(q, 'it queried for candidates');
  assert.ok(/control_number is not null/i.test(q), 'a claim never sent has nothing to ask about');
  assert.ok(/status = any\(\$1\)/i.test(q), 'only open statuses');
  assert.ok(/claim_acknowledgments/i.test(q),
    're-check window comes from the acknowledgments already stored, not a new column');
  assert.ok(/limit \$4/i.test(q), 'every run is capped');
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('  ok  ' + t.name); }
    catch (err) { failed++; console.error('FAIL  ' + t.name + '\n      ' + (err && err.message)); }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
