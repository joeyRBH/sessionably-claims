'use strict';

// Unit test — the Vercel approve adapter (api/refund-requests/[id]/approve.js).
// Mocks the Stripe client and the Lambda API client via the require cache, so the
// test exercises the orchestration only. This is where "approve issues EXACTLY ONE
// Stripe refund" and "a non-refund decision issues NONE" are pinned down:
//   * context says refund:true  -> stripe.createRefund called exactly once, recorded,
//   * context says refund:false -> createRefund called zero times (idempotent skip),
//   * context errors (e.g. not refundable) -> createRefund called zero times.
//
//   node backend/tests/refund_approve_adapter.test.js

const assert = require('node:assert');
const path = require('node:path');

function mock(rel, exports) {
  const resolved = require.resolve(path.join(__dirname, '..', rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Spyable Stripe: counts createRefund calls and records the params it saw.
const stripeSpy = { calls: 0, lastParams: null, result: { id: 're_1', status: 'succeeded' } };
mock('lib/stripe.js', {
  createRefund: async (params) => {
    stripeSpy.calls += 1;
    stripeSpy.lastParams = params;
    return stripeSpy.result;
  },
});

// Scriptable Lambda API: context + record responses set per test.
const lambda = { contextRes: null, recordRes: null, recordCalls: 0 };
mock('lib/lambda_api.js', {
  BASE: 'https://api.test',
  callLambda: async (p) => {
    if (/\/context$/.test(p)) return lambda.contextRes;
    if (/\/record$/.test(p)) { lambda.recordCalls += 1; return lambda.recordRes; }
    return { status: 404, ok: false, data: {} };
  },
});

const approve = require(path.join(__dirname, '..', '..', 'api', 'refund-requests', '[id]', 'approve.js'));

function makeRes() {
  return {
    statusCode: null, payload: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.payload = obj; return this; },
  };
}
function req(body) {
  return { method: 'POST', query: { id: 'req-1' }, headers: { authorization: 'Bearer x' }, body: body || {} };
}
function reset() {
  stripeSpy.calls = 0; stripeSpy.lastParams = null;
  lambda.contextRes = null; lambda.recordRes = null; lambda.recordCalls = 0;
}

(async () => {
  // 1. Happy path: context hands out a target -> exactly ONE Stripe refund, recorded.
  reset();
  lambda.contextRes = {
    status: 200, ok: true,
    data: { refund: true, charge: 'ch_1', amount_cents: 1250, currency: 'usd', reason: 'requested_by_customer', metadata: { claim_id: 'c1' } },
  };
  lambda.recordRes = { status: 200, ok: true, data: { ok: true, recorded: true, refund_request: { id: 'req-1', status: 'approved' } } };
  let res = makeRes();
  await approve(req({ reason: 'denied per EOB' }), res);
  assert.strictEqual(stripeSpy.calls, 1, 'exactly one Stripe refund issued');
  assert.strictEqual(stripeSpy.lastParams.charge, 'ch_1', 'refund targets the fee charge');
  assert.strictEqual(stripeSpy.lastParams.amount, 1250, 'refund amount = the fee amount from context');
  assert.strictEqual(lambda.recordCalls, 1, 'the outcome is recorded once');
  assert.strictEqual(res.statusCode, 200, '-> 200');
  assert.strictEqual(res.payload.refunded, true, 'reports refunded');

  // 2. Idempotent skip: context says refund:false -> NO Stripe refund, no record.
  reset();
  lambda.contextRes = { status: 200, ok: true, data: { refund: false, reason: 'already_refunded' } };
  res = makeRes();
  await approve(req({ reason: 'x' }), res);
  assert.strictEqual(stripeSpy.calls, 0, 'no Stripe refund when context declines');
  assert.strictEqual(lambda.recordCalls, 0, 'nothing recorded');
  assert.strictEqual(res.payload.refunded, false, 'reports not refunded');

  // 3. Guard failure upstream (e.g. not a denied outcome) -> context non-200, NO refund.
  reset();
  lambda.contextRes = { status: 409, ok: false, data: { error: 'Only a denied claim is refundable.' } };
  res = makeRes();
  await approve(req({ reason: 'x' }), res);
  assert.strictEqual(stripeSpy.calls, 0, 'no Stripe refund when the guard rejects');
  assert.strictEqual(res.statusCode, 409, 'passes the upstream status through');

  console.log('refund_approve_adapter.test.js: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
