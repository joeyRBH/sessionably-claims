'use strict';

// Integration test — POST /claims/{id}/refresh raising a refund request from an
// adjudicated denial (backend/handlers/claims.js + lib/refund_auto.js).
//
// The property this file exists for is the THIRD case: a failure to raise the
// request must never fail the refresh. The status update is what the payer told
// us and is the only record of their answer; a request that did not get raised
// is recoverable (the acknowledgment is stored, the claim reads 'denied', an
// admin can file it by hand). Rolling back the former to protect the latter
// would trade the irreplaceable thing for the replaceable one.
//
// Drives the REAL handler against a mocked db / audit / clearinghouse, in the
// hand-stubbed style of claim_submit_integrity.test.js. Synthetic ids only.
//
//   node backend/tests/refund_auto_refresh.test.js

const assert = require('node:assert');
const path = require('node:path');

function mock(rel, exports) {
  const resolved = require.resolve(path.join(__dirname, '..', rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const PRACTICE_ID = '11111111-1111-4111-8111-111111111111';
const CLAIM_ID = '2f1c9a3e-7b4d-4c2a-9e11-abcdef012345';
const USER_ID = '33333333-3333-4333-8333-333333333333';

// What the adapter will report this run, and what the DB holds. Reset per case.
let statusResult = null;
let inserted = [];
let audits = [];
let feeRows = [{ amount: '8.75' }];
let insertShouldThrow = null;

const CLAIM = {
  id: CLAIM_ID,
  practice_id: PRACTICE_ID,
  client_id: '44444444-4444-4444-8444-444444444444',
  status: 'submitted',
  control_number: 'CN-1',
  billed_amount: '175.00',
  is_hidden: false,
};

function one(row) { return { rowCount: row ? 1 : 0, rows: row ? [row] : [] }; }
function none() { return { rowCount: 0, rows: [] }; }

function route(sql, params) {
  if (/^\s*update claims/i.test(sql)) {
    // Echo back the claim with the status the handler is writing.
    return one(Object.assign({}, CLAIM, { status: params[0] }));
  }
  if (/insert into refund_requests/i.test(sql)) {
    if (insertShouldThrow) throw insertShouldThrow;
    inserted.push(params);
    return one({ id: '55555555-5555-4555-8555-555555555555' });
  }
  if (/from refund_requests/i.test(sql)) return none();       // no open request
  if (/from transactions/i.test(sql) && /type = \$2/.test(sql)) {
    return { rowCount: feeRows.length, rows: feeRows };        // the paid fee
  }
  if (/from transactions/i.test(sql)) return none();           // not refunded
  if (/from claims\b/i.test(sql)) return one(CLAIM);
  if (/from users\b/i.test(sql)) return one({ id: USER_ID, practice_id: PRACTICE_ID, role: 'practice_admin' });
  return none();
}

mock('lib/db.js', {
  query: async (sql, params) => route(sql, params),
  withTransaction: async (fn) => fn({ query: async (sql, params) => route(sql, params) }),
});
mock('lib/audit.js', {
  audit: async (event, authCtx, entry) => { audits.push(entry); },
  sanitizeFields: (x) => x,
});
mock('lib/claims.js', {
  primaryInsuranceForClient: async () => null,
  logClaimEvent: async () => {},
  logClaimAcknowledgment: async () => {},
  loadClaimSessions: async () => [],
  buildClaimContext: async () => ({ claim: CLAIM }),
  ensurePatientControlNumber: async () => 'PCN1',
});
mock('lib/clearinghouse/index.js', {
  getClearinghouse: () => ({
    name: 'stedi',
    getStatus: async () => statusResult,
  }),
});
mock('lib/auth.js', {
  requireAuth: () => ({ user: { sub: USER_ID, practice_id: PRACTICE_ID, role: 'practice_admin' } }),
  AuthError: class AuthError extends Error {},
});

const { handler } = require('../handlers/claims.js');

function refreshEvent() {
  return {
    version: '2.0',
    routeKey: 'POST /claims/{id}/refresh',
    rawPath: `/claims/${CLAIM_ID}/refresh`,
    pathParameters: { id: CLAIM_ID },
    headers: { authorization: 'Bearer t' },
    body: '{}',
    requestContext: {
      http: { method: 'POST', path: `/claims/${CLAIM_ID}/refresh`, sourceIp: '127.0.0.1' },
      requestId: 'test',
    },
  };
}

function reset() {
  inserted = []; audits = []; feeRows = [{ amount: '8.75' }]; insertShouldThrow = null;
}

function refreshAudit() {
  return audits.find((a) => a.action === 'claim.refresh');
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('an adjudicated denial raises a refund request', async () => {
  reset();
  statusResult = { status: 'denied', denial_class: 'adjudicated', denial_reason: 'Not covered', raw: {} };
  const res = await handler(refreshEvent());
  const body = JSON.parse(res.body);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(body.claim.status, 'denied', 'the status update landed');
  assert.strictEqual(body.refund_request_created, true, 'the response says a request was raised');
  assert.strictEqual(inserted.length, 1, 'exactly one request');
  assert.deepStrictEqual(inserted[0], [PRACTICE_ID, CLAIM_ID, CLAIM.client_id]);
  assert.strictEqual(refreshAudit().metadata.refund_request, 'created');
  assert.ok(audits.some((a) => a.action === 'refund_request.auto_create'),
    'the creation is separately auditable — this is money the guarantee promises back');
});

test('a front-door rejection updates the status but raises NOTHING', async () => {
  reset();
  statusResult = { status: 'denied', denial_class: 'acknowledgement_reject', raw: {} };
  const res = await handler(refreshEvent());
  const body = JSON.parse(res.body);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(body.claim.status, 'denied', 'the claim still records what the payer said');
  assert.strictEqual(body.refund_request_created, false);
  assert.strictEqual(inserted.length, 0,
    'a rejected claim is about to be corrected and resubmitted — and that resubmission charges its own fee');
  assert.strictEqual(refreshAudit().metadata.refund_request, 'not_adjudicated',
    'the audit records WHICH rule declined, not just that nothing happened');
});

test('a claim with no paid fee raises nothing, and says so', async () => {
  reset();
  feeRows = [];
  statusResult = { status: 'denied', denial_class: 'adjudicated', raw: {} };
  await handler(refreshEvent());
  assert.strictEqual(inserted.length, 0);
  assert.strictEqual(refreshAudit().metadata.refund_request, 'no_paid_fee');
});

test('a failure to raise the request does NOT fail the refresh', async () => {
  reset();
  insertShouldThrow = Object.assign(new Error('connection reset'), { code: '08006' });
  statusResult = { status: 'denied', denial_class: 'adjudicated', raw: {} };

  const res = await handler(refreshEvent());
  const body = JSON.parse(res.body);

  assert.strictEqual(res.statusCode, 200, 'the refresh still succeeds');
  assert.strictEqual(body.claim.status, 'denied',
    'THE POINT: the payer response survives even when the queue insert does not');
  assert.strictEqual(body.refund_request_created, false);
  assert.strictEqual(refreshAudit().metadata.refund_request, 'error',
    'the failure is recorded rather than looking like a clean decline');
});

test('a non-denial refresh is unaffected', async () => {
  reset();
  statusResult = { status: 'paid', raw: {} };
  const res = await handler(refreshEvent());
  const body = JSON.parse(res.body);
  assert.strictEqual(body.claim.status, 'paid');
  assert.strictEqual(inserted.length, 0);
  assert.strictEqual(refreshAudit().metadata.refund_request, 'not_denied');
});

test('an adapter with no denial_class at all is treated as not adjudicated', async () => {
  // Older adapters (claim_md, mock) return no denial_class. Absent must mean
  // "we cannot tell", never "go ahead".
  reset();
  statusResult = { status: 'denied', raw: {} };
  await handler(refreshEvent());
  assert.strictEqual(inserted.length, 0);
  assert.strictEqual(refreshAudit().metadata.refund_request, 'not_adjudicated');
});

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
