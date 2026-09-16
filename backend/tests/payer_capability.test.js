'use strict';

// Tests — remembering which payers refuse an automated claim-status inquiry
// (backend/lib/payer_capability.js + its use in the scheduled poller).
//
// THE ASYMMETRY THESE TESTS EXIST TO PROTECT. A wasted probe on a payer that
// cannot answer is cheap. A SKIPPED probe on a payer that can is expensive and
// invisible: that claim's denial is never detected, so the patient never gets
// back the fee they were promised. So every uncertain path must fall towards
// PROBING, never towards skipping — including when the database itself fails.
//
//   node backend/tests/payer_capability.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib', 'payer_capability.js');
const cap = require(LIB);

function fakeDb(handler) { return { db: { query: handler } }; }

(async () => {
  // --- payerIdForStatus: mirrors the adapter's own precedence ---------------
  //
  // The payer being asked is the one that RECEIVED the 837, so the id the claim
  // was submitted with beats whatever the insurance record says now. Getting
  // this backwards would record a refusal against the wrong payer.
  assert.strictEqual(
    cap.payerIdForStatus({ clearinghouse_payload: { tradingPartnerServiceId: '60054' } }, { payer_id: '99999' }),
    '60054', 'the submitted payer id wins');
  assert.strictEqual(
    cap.payerIdForStatus({ clearinghouse_payload: {} }, { payer_id: '99999' }),
    '99999', 'falls back to the insurance record');
  assert.strictEqual(cap.payerIdForStatus({}, null), null, 'no payer anywhere -> null');
  assert.strictEqual(cap.payerIdForStatus(null, null), null, 'null-safe');
  assert.strictEqual(
    cap.payerIdForStatus({ clearinghouse_payload: { tradingPartnerServiceId: 60054 } }, null),
    '60054', 'coerced to a string, so Set lookups match');

  // --- unsupportedPayerIds --------------------------------------------------
  {
    const seen = [];
    const set = await cap.unsupportedPayerIds('p1', fakeDb(async (sql, params) => {
      seen.push({ sql, params });
      return { rows: [{ payer_id: '60054' }, { payer_id: '87726' }], rowCount: 2 };
    }));
    assert.deepStrictEqual([...set].sort(), ['60054', '87726']);
    assert.match(seen[0].sql, /supports_claim_status = false/, 'only refusals are skipped');
    assert.match(seen[0].sql, /last_probed_at > now\(\)/, 'and only recent ones — refusals expire');
    assert.strictEqual(seen[0].params[1], String(cap.REPROBE_AFTER_DAYS));
  }

  // A DATABASE FAILURE MUST MEAN "PROBE EVERYTHING", never "skip everything".
  {
    const set = await cap.unsupportedPayerIds('p1', fakeDb(async () => { throw new Error('db down'); }));
    assert.strictEqual(set.size, 0, 'a broken cache degrades into doing more work, not less');
  }

  // --- isUnsupported --------------------------------------------------------
  {
    const yes = await cap.isUnsupported({ practiceId: 'p1', payerId: '60054' },
      fakeDb(async () => ({ rows: [{}], rowCount: 1 })));
    assert.strictEqual(yes, true);
    const no = await cap.isUnsupported({ practiceId: 'p1', payerId: '60054' },
      fakeDb(async () => ({ rows: [], rowCount: 0 })));
    assert.strictEqual(no, false);
    const broken = await cap.isUnsupported({ practiceId: 'p1', payerId: '60054' },
      fakeDb(async () => { throw new Error('db down'); }));
    assert.strictEqual(broken, false, 'unknown means "no warning", never a false warning');
    assert.strictEqual(await cap.isUnsupported({ practiceId: null, payerId: '1' }), false);
    assert.strictEqual(await cap.isUnsupported({ practiceId: 'p1', payerId: null }), false);
  }

  // --- recordProbe ----------------------------------------------------------
  {
    let captured = null;
    const r = await cap.recordProbe(
      { practiceId: 'p1', payerId: '60054', supported: false, errorCode: 'BAD_REQUEST' },
      fakeDb(async (sql, params) => { captured = { sql, params }; return { rowCount: 1 }; })
    );
    assert.deepStrictEqual(r, { recorded: true });
    assert.match(captured.sql, /on conflict \(practice_id, payer_id\) do update/, 'upsert, one row per pair');
    assert.deepStrictEqual(captured.params, ['p1', '60054', false, 'BAD_REQUEST']);
  }
  {
    // A SUCCESS clears the error code and resets the refusal streak, so a payer
    // that starts answering stops being skipped immediately.
    let captured = null;
    await cap.recordProbe({ practiceId: 'p1', payerId: '60054', supported: true },
      fakeDb(async (sql, params) => { captured = { sql, params }; return { rowCount: 1 }; }));
    assert.deepStrictEqual(captured.params, ['p1', '60054', true, null]);
    assert.match(captured.sql, /consecutive_refusals *= *case\s*\n?\s*when excluded\.supports_claim_status then 0/,
      'a success resets the streak');
  }
  // Bookkeeping must never fail the status check that produced it.
  {
    const r = await cap.recordProbe({ practiceId: 'p1', payerId: '60054', supported: false },
      fakeDb(async () => { throw new Error('db down'); }));
    assert.deepStrictEqual(r, { recorded: false }, 'reported, never thrown');
  }
  assert.deepStrictEqual(await cap.recordProbe({ practiceId: null, payerId: '1', supported: false }),
    { recorded: false }, 'nothing to key on -> no write, no throw');

  runStaticChecks();
  console.log('payer_capability: ok');
})().catch((err) => { console.error(err); process.exit(1); });

function runStaticChecks() {
  const poll = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'claim_status_poll.js'), 'utf8');
  const claims = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'claims.js'), 'utf8');

  // An unsupported payer is NOT an error. Counting it as one would bury the real
  // faults in exactly the dry run that exists to be read.
  assert.match(poll, /payer_unsupported: 0/, 'the poller counts unsupported payers separately');
  assert.match(poll, /skipped_unsupported_payer: 0/, 'and counts the ones it skipped outright');
  assert.match(poll, /if \(err && err\.isStatusUnsupported\)/,
    'the poller distinguishes a refusal from a real failure');

  // The skip must happen before `checked` is incremented, or the run overstates
  // what it actually covered.
  const skipIdx = poll.indexOf('summary.skipped_unsupported_payer += 1');
  const checkedIdx = poll.indexOf('summary.checked += 1');
  assert.ok(skipIdx !== -1 && checkedIdx !== -1 && skipIdx < checkedIdx,
    'a skipped claim is not counted as checked');

  // Both paths must clear a stale refusal on success, or a payer that gains
  // support stays skipped for the rest of the window.
  assert.ok((poll.match(/supported: true/g) || []).length >= 1, 'the poller clears on success');
  assert.ok((claims.match(/supported: true/g) || []).length >= 1, 'Refresh clears on success');

  // Refresh must stay usable — the flag is advisory. If a future change starts
  // refusing the request because of it, this breaks loudly.
  assert.doesNotMatch(claims, /isUnsupported[\s\S]{0,200}return json\(4\d\d/,
    'the capability flag never blocks a Refresh request');

  const view = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'app', 'views', 'claims.js'), 'utf8');
  assert.match(view, /payer_status_unsupported/, 'the claim detail reads the flag');
  assert.match(view, /badge--neutral/, 'and renders it as stone, not as a failure');
  assert.doesNotMatch(view, /payerUnpollableNote[\s\S]{0,600}badge--danger/,
    'an unpollable payer is not a claim problem and must not wear the urgent colour');
}
