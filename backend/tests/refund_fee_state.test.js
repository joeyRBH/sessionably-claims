'use strict';

// Unit tests — the Refunds queue's per-request refundability projection
// (feeState / shapeRequest in backend/handlers/refund_requests.js).
//
// WHAT THIS PROTECTS. The queue used to offer "Approve refund" on every open
// request with a denied outcome, including claims that never collected a platform
// fee at all — the fee charge is best-effort and is skipped entirely when the
// client has no card on file at submit time. Approving one of those could only
// ever 409 ("No platform fee was charged for this claim"), no money moved, and
// the request stayed Open for ever. Four such requests were sitting in the live
// queue.
//
// The projection must therefore agree with approveContext's guard EXACTLY — a
// queue that says "refundable" where the guard says "nothing to refund" just
// moves the dead end one click later.
//
//   node backend/tests/refund_fee_state.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HANDLER = path.join(__dirname, '..', 'handlers', 'refund_requests.js');
const { feeState } = require(HANDLER);
const src = fs.readFileSync(HANDLER, 'utf8');

// --- 'none': nothing to give back -------------------------------------------

assert.strictEqual(feeState({}), 'none', 'no fee row at all');
assert.strictEqual(feeState(null), 'none', 'a missing row never claims to be refundable');
assert.strictEqual(feeState({ fee_amount: null }), 'none', 'a null amount is not a fee');
assert.strictEqual(feeState({ fee_amount: '0.00', fee_charge_id: 'ch_1' }), 'none',
  'a zero-amount fee is not refundable — matches the guard');
assert.strictEqual(feeState({ fee_amount: '-1.00', fee_charge_id: 'ch_1' }), 'none',
  'a negative amount is not refundable');
assert.strictEqual(feeState({ fee_amount: 'not-a-number', fee_charge_id: 'ch_1' }), 'none',
  'an unparseable amount is not refundable');
assert.strictEqual(feeState({ fee_amount: '6.75' }), 'none',
  'a recorded fee with NO Stripe reference cannot be refunded through Stripe');

// --- 'collected': the only refundable state ---------------------------------

assert.strictEqual(feeState({ fee_amount: '6.75', fee_charge_id: 'ch_1' }), 'collected',
  'a positive fee with a charge id is refundable');
assert.strictEqual(feeState({ fee_amount: '6.75', fee_intent_id: 'pi_1' }), 'collected',
  'a payment intent is an acceptable refund target too');
assert.strictEqual(feeState({ fee_amount: 0.01, fee_charge_id: 'ch_1' }), 'collected',
  'a numeric (not string) amount works — pg may hand back either');

// --- 'refunded': already given back, approving is a no-op --------------------

assert.strictEqual(
  feeState({ fee_amount: '6.75', fee_charge_id: 'ch_1', claim_has_refund: true }),
  'refunded', 'an existing refund transaction on the claim wins');
assert.strictEqual(
  feeState({ fee_amount: '6.75', fee_charge_id: 'ch_1', stripe_refund_id: 're_1' }),
  'refunded', "the request's own recorded refund id wins");
assert.strictEqual(
  feeState({ stripe_refund_id: 're_1' }),
  'refunded', 'already-refunded outranks a missing fee row — same order as the guard');

// --- the projection reaches the API ------------------------------------------

assert.match(src, /fee_state: feeState\(r\)/, 'shapeRequest emits fee_state');
assert.match(src, /fee_amount: r\.fee_amount != null/, 'shapeRequest emits fee_amount');

// --- the query the projection reads from -------------------------------------
//
// The lateral joins must apply the SAME predicates as loadPaidFee() /
// claimAlreadyRefunded(), or the queue and the guard can disagree.
assert.match(src, /left join lateral/, 'the queue projection joins the fee laterally (no N+1)');
assert.match(
  src,
  /where t\.claim_id = rr\.claim_id and t\.type = 'platform_fee' and t\.status = 'paid'/,
  'the fee join uses the same predicate as loadPaidFee()'
);
assert.match(
  src,
  /where t\.claim_id = rr\.claim_id and t\.type = 'refund'/,
  'the refunded join uses the same predicate as claimAlreadyRefunded()'
);

// --- the guard still refuses, and now says what to do instead ----------------

assert.match(src, /code: 'no_fee_collected'/,
  'the 409 carries a machine-readable code so a stale client can react');
assert.match(src, /Close the request instead/,
  'the 409 tells the admin what CAN be done, instead of leaving the request stuck');

// The guard itself must not have been softened into auto-resolving. Approving is
// still the only thing that moves money, and it still refuses without a fee.
assert.match(src, /No platform fee was charged for this claim/,
  'approveContext still refuses to refund what was never collected');

console.log('refund_fee_state: ok');
