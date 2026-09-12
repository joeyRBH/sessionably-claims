'use strict';

// Unit test — backend/lib/refund_auto.js, the rule deciding when a clearinghouse
// denial raises a refund request for the practice admin.
//
// ONE STEP FROM THE MONEY PATH. Nothing here refunds anything — approval stays a
// human act in handlers/refund_requests.js — but a request raised is a request
// somebody will be asked to approve, and the 5% platform fee is what gets handed
// back. The two failure modes are not symmetric:
//
//   raising one wrongly  → noise in a queue whose value IS that its contents
//                          deserve attention, and an admin nudged toward
//                          refunding a fee that was correctly charged;
//   missing a real one   → the patient is out a fee they were promised back,
//                          and nobody finds out.
//
// So the rule is conservative, and most of what follows tests the REFUSALS.
//
//   node backend/tests/refund_auto.test.js

const assert = require('node:assert');
const R = require('../lib/refund_auto');
const stedi = require('../lib/clearinghouse/stedi');

// An adjudicated denial on a claim whose fee was actually collected — every case
// below changes exactly one thing from here.
function input(over) {
  return Object.assign({
    status: 'denied',
    statusChanged: true,
    denialClass: 'adjudicated',
    paidFeeAmount: 8.75,
    alreadyRefunded: false,
    hasOpenRequest: false,
  }, over || {});
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- the one case that raises a request ---------------------------------------

test('an adjudicated denial on a claim with a paid fee raises a request', () => {
  assert.deepStrictEqual(R.evaluateAutoRefund(input()), { create: true });
});

// --- rejection is not denial ---------------------------------------------------
//
// The distinction the whole feature turns on. A claim rejected at the payer's
// front door was never adjudicated: it is fixable, the practice corrects and
// resubmits, and THAT SUBMISSION CHARGES ITS OWN FEE. Refunding here hands back
// a fee for a claim that is coming straight back.

test('a front-door rejection does NOT raise a request', () => {
  const out = R.evaluateAutoRefund(input({ denialClass: 'acknowledgement_reject' }));
  assert.deepStrictEqual(out, { create: false, reason: R.DECLINE.NOT_ADJUDICATED });
});

test('a denial we cannot classify does NOT raise a request', () => {
  // null is what the adapter returns when the denial came from a bare statusCode
  // with no category — it cannot tell us whether adjudication happened, and we
  // do not raise money questions on evidence we cannot read.
  [null, undefined, '', 'something_new'].forEach((cls) => {
    assert.strictEqual(
      R.evaluateAutoRefund(input({ denialClass: cls })).reason,
      R.DECLINE.NOT_ADJUDICATED,
      'denialClass ' + JSON.stringify(cls) + ' must not be treated as adjudicated'
    );
  });
});

// This is the contract between the two modules: the adapter's vocabulary and
// this rule's expectations have to agree, or the feature silently stops firing.
test('the adapter agrees with this rule about what is adjudicated', () => {
  assert.strictEqual(stedi.denialClass('F2'), 'adjudicated',
    'F2 (Finalized/Denial) is the payer having actually adjudicated');
  ['A3', 'A6', 'A7', 'A8'].forEach((c) => {
    assert.strictEqual(stedi.denialClass(c), 'acknowledgement_reject',
      c + ' is a front-door rejection, not a denial');
  });
  // And the values the adapter can emit must be exactly the values this rule
  // knows how to answer for.
  ['F2', 'A3', 'F1', 'P1', null].forEach((c) => {
    const cls = stedi.denialClass(c);
    assert.ok(cls === 'adjudicated' || cls === 'acknowledgement_reject' || cls === null,
      'denialClass emitted an unexpected value for ' + c + ': ' + cls);
  });
});

// --- the edge, not the state ---------------------------------------------------

test('a refresh that did not move the status raises nothing', () => {
  // Claims sit in 'denied' indefinitely and staff refresh freely. Acting on the
  // STATE would re-raise a request on every click — including for claims whose
  // request an admin has already considered and denied, since the
  // one-open-per-claim index only blocks duplicates while the first is open.
  const out = R.evaluateAutoRefund(input({ statusChanged: false }));
  assert.deepStrictEqual(out, { create: false, reason: R.DECLINE.NO_TRANSITION });
});

test('a second genuine denial does raise a second request', () => {
  // denied -> appealed -> denied is a real edge, and the patient is owed an
  // answer about it just as much as the first time.
  assert.deepStrictEqual(R.evaluateAutoRefund(input({ statusChanged: true })), { create: true });
});

// --- no fee, nothing to hand back ----------------------------------------------

test('a claim whose fee was never collected raises nothing', () => {
  // The fee charge is best-effort on submit and can fail or decline. A refund
  // request against a claim that was never charged is a request to refund zero.
  [null, undefined, 0, '0', -5, 'abc', NaN].forEach((fee) => {
    assert.strictEqual(
      R.evaluateAutoRefund(input({ paidFeeAmount: fee })).reason,
      R.DECLINE.NO_PAID_FEE,
      'paidFeeAmount ' + JSON.stringify(fee) + ' is not a refundable fee'
    );
  });
});

test('a fee given as a numeric string is still a fee', () => {
  // transactions.amount is numeric(12,2); node-postgres hands it back as a string.
  assert.deepStrictEqual(R.evaluateAutoRefund(input({ paidFeeAmount: '8.75' })), { create: true });
});

// --- already handled -----------------------------------------------------------

test('a claim already refunded raises nothing', () => {
  assert.strictEqual(
    R.evaluateAutoRefund(input({ alreadyRefunded: true })).reason,
    R.DECLINE.ALREADY_REFUNDED);
});

test('a claim with an open request raises nothing', () => {
  assert.strictEqual(
    R.evaluateAutoRefund(input({ hasOpenRequest: true })).reason,
    R.DECLINE.REQUEST_ALREADY_OPEN);
});

// --- everything that is not a denial -------------------------------------------

test('no non-denied status raises a request', () => {
  ['draft', 'submitted', 'processing', 'info_requested', 'appealed', 'paid', 'void']
    .forEach((status) => {
      assert.strictEqual(
        R.evaluateAutoRefund(input({ status })).reason,
        R.DECLINE.NOT_DENIED,
        status + ' is not a denial');
    });
});

test('a paid claim never raises a request, whatever else is true', () => {
  // The guarantee is explicit that PAID and DEDUCTIBLE are successes. A paid
  // claim carrying a stale 'adjudicated' class must still be refused.
  assert.strictEqual(
    R.evaluateAutoRefund(input({ status: 'paid', denialClass: 'adjudicated' })).reason,
    R.DECLINE.NOT_DENIED);
});

test('garbage input refuses rather than throwing', () => {
  [undefined, null, {}, { status: 'denied' }].forEach((bad) => {
    const out = R.evaluateAutoRefund(bad);
    assert.strictEqual(out.create, false, 'must refuse: ' + JSON.stringify(bad));
    assert.ok(out.reason, 'a refusal always names the rule that refused');
  });
});

// --- the DB-facing half ---------------------------------------------------------

function fakeDb(over) {
  const o = over || {};
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (/from transactions/.test(text) && /type = \$2/.test(text)) {
        return { rowCount: o.fee == null ? 0 : 1, rows: o.fee == null ? [] : [{ amount: o.fee }] };
      }
      if (/from transactions/.test(text)) {
        return { rowCount: o.refunded ? 1 : 0, rows: [] };
      }
      if (/from refund_requests/.test(text)) {
        return { rowCount: o.openRequest ? 1 : 0, rows: [] };
      }
      if (/insert into refund_requests/.test(text)) {
        if (o.insertError) throw o.insertError;
        return { rowCount: 1, rows: [{ id: 'req-1' }] };
      }
      throw new Error('unexpected query: ' + text);
    },
  };
}

const CLAIM = { id: 'claim-1', practice_id: 'p-1', client_id: 'c-1' };

test('maybeCreateForDenial inserts with source=system_denial', async () => {
  const db = fakeDb({ fee: '8.75' });
  const out = await R.maybeCreateForDenial(db, {
    claim: CLAIM, status: 'denied', statusChanged: true, denialClass: 'adjudicated',
  });
  assert.strictEqual(out.created, true);
  const insert = db.calls.find((c) => /insert into refund_requests/.test(c.text));
  assert.ok(insert, 'it inserted');
  assert.ok(/'system_denial'/.test(insert.text),
    'provenance is a LITERAL in the SQL — never a parameter a caller could set');
  assert.ok(/'denied'/.test(insert.text) && /'open'/.test(insert.text),
    'a system request is always an OPEN request labelled denied — never approved');
  assert.deepStrictEqual(insert.params, ['p-1', 'claim-1', 'c-1']);
});

test('maybeCreateForDenial touches no database at all for a non-denial', async () => {
  const db = fakeDb({ fee: '8.75' });
  const out = await R.maybeCreateForDenial(db, {
    claim: CLAIM, status: 'paid', statusChanged: true, denialClass: null,
  });
  assert.deepStrictEqual(out, { created: false, reason: R.DECLINE.NOT_DENIED });
  assert.strictEqual(db.calls.length, 0, 'the common case costs nothing');
});

test('maybeCreateForDenial does not insert for a front-door rejection', async () => {
  const db = fakeDb({ fee: '8.75' });
  const out = await R.maybeCreateForDenial(db, {
    claim: CLAIM, status: 'denied', statusChanged: true, denialClass: 'acknowledgement_reject',
  });
  assert.strictEqual(out.created, false);
  assert.ok(!db.calls.some((c) => /insert/.test(c.text)), 'nothing was inserted');
});

test('maybeCreateForDenial declines when the fee was never collected', async () => {
  const db = fakeDb({ fee: null });
  const out = await R.maybeCreateForDenial(db, {
    claim: CLAIM, status: 'denied', statusChanged: true, denialClass: 'adjudicated',
  });
  assert.deepStrictEqual(out, { created: false, reason: R.DECLINE.NO_PAID_FEE });
});

test('a lost race on the unique index is reported, not thrown', async () => {
  // Two staff refreshing the same claim at once is ordinary. The loser has
  // nothing to report: the request it wanted already exists.
  const err = new Error('duplicate key'); err.code = '23505';
  const db = fakeDb({ fee: '8.75', insertError: err });
  const out = await R.maybeCreateForDenial(db, {
    claim: CLAIM, status: 'denied', statusChanged: true, denialClass: 'adjudicated',
  });
  assert.deepStrictEqual(out, { created: false, reason: R.DECLINE.REQUEST_ALREADY_OPEN });
});

test('any other database error still propagates', async () => {
  // Swallowing everything would make a broken queue look like a quiet one. The
  // CALLER decides to ignore it (refreshClaim does, deliberately); this module
  // must not make that decision silently on its behalf.
  const err = new Error('connection reset'); err.code = '08006';
  const db = fakeDb({ fee: '8.75', insertError: err });
  await assert.rejects(() => R.maybeCreateForDenial(db, {
    claim: CLAIM, status: 'denied', statusChanged: true, denialClass: 'adjudicated',
  }), /connection reset/);
});

// --- runner ---------------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log('  ok  ' + t.name);
    } catch (err) {
      failed++;
      console.error('FAIL  ' + t.name + '\n      ' + (err && err.message));
    }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
