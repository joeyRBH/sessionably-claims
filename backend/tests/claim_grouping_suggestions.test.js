'use strict';

// Unit test — suggestGroups(), the half of backend/lib/claim_grouping.js that
// spots groupable drafts unprompted instead of waiting for a biller to notice.
//
// ADVISORY, NOT MONEY-PATH — but only because of one invariant, which is the
// most important thing these tests hold: every set suggestGroups() emits is
// accepted by evaluateGroup(). The suggester is a CALLER of the rules, never a
// copy of them. If that invariant broke, the UI would offer groupings the server
// then refuses (merely annoying) or — if the gate were ever relaxed to trust the
// suggestion — file a claim nobody checked (not annoying at all).
//
// The other thing under test is restraint: a suggestion that includes a draft it
// should not is worse than no suggestion, because the confirm dialog shows dates
// and a total, not the reasoning. So the exclusions get more cases than the
// happy path does.
//
//   node backend/tests/claim_grouping_suggestions.test.js

const assert = require('node:assert');
const G = require('../lib/claim_grouping');

let seq = 0;
// One groupable draft. Every case changes exactly one thing from here, so a
// failure names its own cause.
function claim(over) {
  seq += 1;
  return Object.assign({
    id: 'claim-' + seq,
    session_id: 'session-' + seq,
    client_id: 'client-1',
    clinician_id: 'user-1',
    insurance_record_id: 'ins-1',
    status: 'draft',
    billed_amount: 175,
    session_date: '2026-08-0' + ((seq % 9) + 1),
    cpt_code: '90837',
    place_of_service: '10',
    diagnosis_codes: ['F411'],
    control_number: null,
    submitted_at: null,
    corrects_claim_id: null,
    submission_frequency_code: null,
  }, over || {});
}

// n groupable drafts for one client, dated consecutively.
function drafts(n, over) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(claim(Object.assign({
      session_date: '2026-08-' + String(i + 1).padStart(2, '0'),
    }, over || {})));
  }
  return out;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- the invariant ------------------------------------------------------------

// Asserted on EVERY case below, not just its own test: whatever the input, a
// suggestion the gate would refuse must never leave the module.
function suggest(claims) {
  const out = G.suggestGroups(claims);
  const byId = Object.create(null);
  claims.forEach((c) => { byId[c.id] = c; });
  out.forEach((s) => {
    const verdict = G.evaluateGroup(s.claim_ids.map((id) => byId[id]));
    assert.ok(verdict.ok,
      'INVARIANT BROKEN: suggested a set evaluateGroup refuses — '
      + JSON.stringify(verdict.conflicts));
  });
  return out;
}

// --- the happy path -----------------------------------------------------------

test('two compatible drafts for one client are suggested as one claim', () => {
  const rows = drafts(2);
  const out = suggest(rows);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0].claim_ids, [rows[0].id, rows[1].id]);
  assert.strictEqual(out[0].lines, 2);
  assert.strictEqual(out[0].total, 350);
  assert.strictEqual(out[0].client_id, 'client-1');
});

test('the total is the sum of the line charges, rounded to cents', () => {
  const rows = [claim({ billed_amount: 149.99 }), claim({ billed_amount: 300 })];
  assert.strictEqual(suggest(rows)[0].total, 449.99);
});

test('a lone draft is not a grouping', () => {
  assert.deepStrictEqual(suggest(drafts(1)), []);
});

test('an empty queue suggests nothing', () => {
  assert.deepStrictEqual(G.suggestGroups([]), []);
  assert.deepStrictEqual(G.suggestGroups(null), []);
});

// --- the must-match contract: one bucket per compatible set -------------------

// Each of these is the SAME rule evaluateGroup enforces, approached from the
// other side: a difference that would be a conflict must instead be a bucket
// boundary, so the two drafts are simply never suggested together.

test('different clients are never suggested together', () => {
  assert.deepStrictEqual(suggest([claim(), claim({ client_id: 'client-2' })]), []);
});

test('different rendering clinicians are never suggested together', () => {
  assert.deepStrictEqual(suggest([claim(), claim({ clinician_id: 'user-2' })]), []);
});

test('different insurance policies are never suggested together', () => {
  assert.deepStrictEqual(suggest([claim(), claim({ insurance_record_id: 'ins-2' })]), []);
});

test('different places of service are never suggested together', () => {
  assert.deepStrictEqual(suggest([claim(), claim({ place_of_service: '11' })]), []);
});

test('genuinely different diagnoses are never suggested together', () => {
  assert.deepStrictEqual(suggest([claim(), claim({ diagnosis_codes: ['F321'] })]), []);
});

test('a subset of the diagnoses is still a different set', () => {
  const rows = [claim({ diagnosis_codes: ['F411', 'F321'] }), claim({ diagnosis_codes: ['F411'] })];
  assert.deepStrictEqual(suggest(rows), []);
});

// Diagnoses compare as a normalized SET — the suggester must use the same
// normalizer as the gate, or it would withhold suggestions the server accepts.
test('diagnoses differing only in order, case or padding are the same set', () => {
  const rows = [
    claim({ diagnosis_codes: ['F411', 'f321'] }),
    claim({ diagnosis_codes: [' F321 ', 'F411'] }),
  ];
  assert.strictEqual(suggest(rows).length, 1, 'these are the same diagnosis set');
});

// --- per-claim exclusions ------------------------------------------------------

// The shared point of these: an ineligible draft must be stepped over, NOT
// allowed to suppress the suggestion for the eligible drafts around it.

test('a non-draft claim is excluded without suppressing the rest', () => {
  const rows = drafts(2).concat(claim({ status: 'submitted' }));
  const out = suggest(rows);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].lines, 2, 'the submitted claim is not a line');
});

test('a replacement claim is excluded without suppressing the rest', () => {
  const byFlag = drafts(2).concat(claim({ submission_frequency_code: '7' }));
  assert.strictEqual(suggest(byFlag)[0].lines, 2);
  const byLink = drafts(2).concat(claim({ corrects_claim_id: 'claim-older' }));
  assert.strictEqual(suggest(byLink)[0].lines, 2);
});

test('a draft already sent to the clearinghouse is excluded', () => {
  const byControl = drafts(2).concat(claim({ control_number: 'CN-1' }));
  assert.strictEqual(suggest(byControl)[0].lines, 2);
  const bySubmitted = drafts(2).concat(claim({ submitted_at: '2026-08-20T00:00:00Z' }));
  assert.strictEqual(suggest(bySubmitted)[0].lines, 2);
});

test('a draft with no billable amount is excluded', () => {
  [null, 0, '', 'abc', -10].forEach((amount) => {
    const rows = drafts(2).concat(claim({ billed_amount: amount }));
    assert.strictEqual(suggest(rows)[0].lines, 2,
      'billed_amount ' + JSON.stringify(amount) + ' is not a service line');
  });
});

test('two ineligible drafts leave nothing to suggest', () => {
  const rows = [claim({ status: 'denied' }), claim({ status: 'paid' })];
  assert.deepStrictEqual(suggest(rows), []);
});

// --- the six-line ceiling ------------------------------------------------------

test('eight groupable drafts are suggested as two claims, not one of six', () => {
  const rows = drafts(8);
  const out = suggest(rows);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].lines, 6);
  assert.strictEqual(out[1].lines, 2);
  // Chunked in filing order, so each suggested claim is contiguous in time.
  assert.deepStrictEqual(out[0].claim_ids, rows.slice(0, 6).map((c) => c.id));
  assert.deepStrictEqual(out[1].claim_ids, rows.slice(6).map((c) => c.id));
});

test('a trailing chunk of one is dropped rather than suggested alone', () => {
  const out = suggest(drafts(7));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].lines, 6);
});

test('exactly six is one suggestion', () => {
  const out = suggest(drafts(6));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].lines, 6);
});

// --- the same session twice ----------------------------------------------------

test('two drafts for one session are BOTH excluded, never silently picked', () => {
  const twins = [claim({ session_id: 'session-dup' }), claim({ session_id: 'session-dup' })];
  const rows = drafts(2).concat(twins);
  const out = suggest(rows);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].lines, 2, 'the unambiguous drafts are still suggested');
  twins.forEach((t) => {
    assert.ok(!out[0].claim_ids.includes(t.id),
      'choosing WHICH of two drafts for a session to file is the biller\'s call');
  });
});

test('a duplicated session with nothing else groupable suggests nothing', () => {
  const rows = [claim({ session_id: 'session-dup' }), claim({ session_id: 'session-dup' })];
  assert.deepStrictEqual(suggest(rows), []);
});

// --- several clients at once ---------------------------------------------------

test('each client gets their own suggestion, oldest work first', () => {
  const later = drafts(2, { client_id: 'client-2' }).map((c, i) => Object.assign(c, {
    session_date: '2026-09-0' + (i + 1),
  }));
  const earlier = drafts(2, { client_id: 'client-3' }).map((c, i) => Object.assign(c, {
    session_date: '2026-07-0' + (i + 1),
  }));
  const out = suggest(later.concat(earlier));
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].client_id, 'client-3', 'the draft waiting longest comes first');
  assert.strictEqual(out[1].client_id, 'client-2');
});

test('the order does not depend on the order rows arrive in', () => {
  const rows = drafts(2, { client_id: 'client-a' })
    .concat(drafts(2, { client_id: 'client-b' }));
  const forward = suggest(rows).map((s) => s.claim_ids.join());
  const backward = suggest(rows.slice().reverse()).map((s) => s.claim_ids.join());
  assert.deepStrictEqual(forward, backward, 'suggestions are stable across reloads');
});

// --- the payload ----------------------------------------------------------------

test('a suggestion carries ids, counts and a total — never PHI', () => {
  const out = suggest(drafts(2, { diagnosis_codes: ['F411'] }));
  assert.deepStrictEqual(Object.keys(out[0]).sort(), ['claim_ids', 'client_id', 'lines', 'total']);
  // The browser already holds the claims these ids name and does its own
  // labelling; nothing here should be a name, a member id or a diagnosis.
  const serialized = JSON.stringify(out);
  assert.ok(!/F411/.test(serialized), 'no diagnosis codes in the suggestion payload');
});

// --- the ordering key does not leak ---------------------------------------------

test('the internal sort key is stripped from the returned suggestion', () => {
  const out = G.suggestGroups(drafts(2));
  assert.ok(!('earliest' in out[0]), 'earliest is an ordering key, not part of the API');
});

// --- runner ---------------------------------------------------------------------

let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log('  ok  ' + t.name);
  } catch (err) {
    failed++;
    console.error('FAIL  ' + t.name + '\n      ' + (err && err.message));
  }
}
console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
