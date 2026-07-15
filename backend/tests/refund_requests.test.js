'use strict';

// Unit test — the refund-requests handler (backend/handlers/refund_requests.js).
// Mocks auth, db, and audit via the require cache so no JWT, DB, or network runs.
// Covers the flow the guarantee depends on:
//   * create a refund request against a claim -> 201,
//   * a second OPEN request for the same claim -> 409 (duplicate rejection),
//   * deny moves NO money (never touches transactions),
//   * approve/context only hands out a refund target for a DENIED outcome
//     (a paid/deductible outcome is a success -> 409), and refuses once refunded,
//   * approve/record inserts EXACTLY ONE refund transaction and only from open.
//
//   node backend/tests/refund_requests.test.js

const assert = require('node:assert');
const path = require('node:path');

function mock(rel, exports) {
  const resolved = require.resolve(path.join(__dirname, '..', rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const CLAIM_ID = '11111111-1111-4111-8111-111111111111';
const REQ_ID = '22222222-2222-4222-8222-222222222222';
const CLIENT_ID = '33333333-3333-4333-8333-333333333333';

// Mutable scenario state the db mock reads. Each test sets what it needs.
const state = {
  claim: null,
  openExists: false,
  insertThrows: null,
  request: null,
  paidFee: null,
  alreadyRefunded: false,
  approveUpdateRows: null, // rows returned by the "set status='approved'" update
  denyUpdateRows: null,    // rows returned by the "set status='denied'" update
};
// Observable side effects.
const counters = { refundInserts: 0, feeChargeInserts: 0 };

function joinedRow(overrides) {
  return Object.assign(
    {
      id: REQ_ID, practice_id: 'p1', claim_id: CLAIM_ID, client_id: CLIENT_ID,
      outcome_label: 'denied', status: 'open', patient_note: null, decision_reason: null,
      decided_by: null, decided_at: null, stripe_refund_id: null,
      created_at: '2026-07-15T00:00:00Z', updated_at: '2026-07-15T00:00:00Z',
      claim_number: 'CLM-1', claim_status: 'denied',
      client_first_name: 'Pat', client_last_name: 'Doe', client_preferred_name: null,
    },
    overrides || {}
  );
}

function route(sql, params) {
  const s = String(sql);

  if (/from users/i.test(s)) {
    return { rows: [{ id: 'user-1', practice_id: 'p1', role: 'practice_admin', is_active: true }], rowCount: 1 };
  }
  if (/from claims/i.test(s) && /where id/i.test(s)) {
    return { rows: state.claim ? [state.claim] : [], rowCount: state.claim ? 1 : 0 };
  }
  if (/select 1 from refund_requests/i.test(s)) {
    return { rows: state.openExists ? [{ '?column?': 1 }] : [], rowCount: state.openExists ? 1 : 0 };
  }
  if (/^\s*insert into refund_requests/i.test(s)) {
    if (state.insertThrows) throw state.insertThrows;
    return { rows: [joinedRow({ status: 'open' })], rowCount: 1 };
  }
  if (/from refund_requests rr/i.test(s)) {
    // SELECT_WITH_JOINS (list/get/after-write reads)
    return { rows: state.request ? [joinedRow(state.request)] : [joinedRow()], rowCount: 1 };
  }
  if (/select \* from refund_requests where id/i.test(s)) {
    return { rows: state.request ? [state.request] : [], rowCount: state.request ? 1 : 0 };
  }
  if (/from transactions/i.test(s) && /type = 'refund'/i.test(s) && /select 1/i.test(s)) {
    return { rows: state.alreadyRefunded ? [{ '?column?': 1 }] : [], rowCount: state.alreadyRefunded ? 1 : 0 };
  }
  if (/from transactions/i.test(s) && /'platform_fee'/i.test(s)) {
    return { rows: state.paidFee ? [state.paidFee] : [], rowCount: state.paidFee ? 1 : 0 };
  }
  if (/update refund_requests/i.test(s) && /status = 'denied'/i.test(s)) {
    const rows = state.denyUpdateRows == null ? [{ id: REQ_ID }] : state.denyUpdateRows;
    return { rows, rowCount: rows.length };
  }
  if (/update refund_requests/i.test(s) && /status = 'approved'/i.test(s)) {
    const rows = state.approveUpdateRows == null ? [{ id: REQ_ID, claim_id: CLAIM_ID, client_id: CLIENT_ID }] : state.approveUpdateRows;
    return { rows, rowCount: rows.length };
  }
  if (/^\s*insert into transactions/i.test(s)) {
    if (/'refund'/i.test(s)) counters.refundInserts += 1;
    else counters.feeChargeInserts += 1;
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

mock('lib/auth.js', { requireAuth: () => ({ user: { sub: 'user-1' } }) });
mock('lib/audit.js', { audit: async () => {}, sanitizeFields: () => [] });
mock('lib/db.js', {
  query: async (sql, params) => route(sql, params),
  withTransaction: async (fn) => fn({ query: async (sql, params) => route(sql, params) }),
});

const { handler } = require(path.join(__dirname, '..', 'handlers', 'refund_requests.js'));

function evt(opts) {
  return {
    httpMethod: opts.method,
    requestContext: { routeKey: opts.routeKey },
    pathParameters: opts.id ? { id: opts.id } : undefined,
    headers: { Authorization: 'Bearer x' },
    body: opts.body != null ? opts.body : undefined,
  };
}

function reset() {
  state.claim = null; state.openExists = false; state.insertThrows = null;
  state.request = null; state.paidFee = null; state.alreadyRefunded = false;
  state.approveUpdateRows = null; state.denyUpdateRows = null;
  counters.refundInserts = 0; counters.feeChargeInserts = 0;
}

(async () => {
  // 1. Create a refund request against a submitted claim -> 201.
  reset();
  state.claim = { id: CLAIM_ID, practice_id: 'p1', client_id: CLIENT_ID, status: 'submitted' };
  let res = await handler(evt({
    method: 'POST', routeKey: 'POST /refund-requests',
    body: { claim_id: CLAIM_ID, outcome_label: 'denied', patient_note: 'EOB attached' },
  }));
  assert.strictEqual(res.statusCode, 201, 'create -> 201');
  assert.ok(JSON.parse(res.body).refund_request, 'create returns the request');

  // 2a. Duplicate open request rejected by the app-level pre-check -> 409.
  reset();
  state.claim = { id: CLAIM_ID, practice_id: 'p1', client_id: CLIENT_ID, status: 'submitted' };
  state.openExists = true;
  res = await handler(evt({
    method: 'POST', routeKey: 'POST /refund-requests',
    body: { claim_id: CLAIM_ID, outcome_label: 'denied' },
  }));
  assert.strictEqual(res.statusCode, 409, 'duplicate (pre-check) -> 409');

  // 2b. Duplicate that races past the pre-check hits the unique index -> 409.
  reset();
  state.claim = { id: CLAIM_ID, practice_id: 'p1', client_id: CLIENT_ID, status: 'submitted' };
  state.insertThrows = Object.assign(new Error('duplicate key'), { code: '23505' });
  res = await handler(evt({
    method: 'POST', routeKey: 'POST /refund-requests',
    body: { claim_id: CLAIM_ID, outcome_label: 'denied' },
  }));
  assert.strictEqual(res.statusCode, 409, 'duplicate (unique index) -> 409');

  // 3. Deny moves NO money: 200, and zero transaction inserts of any kind.
  reset();
  state.request = { id: REQ_ID, practice_id: 'p1', claim_id: CLAIM_ID, client_id: CLIENT_ID, status: 'open', outcome_label: 'denied' };
  res = await handler(evt({
    method: 'POST', routeKey: 'POST /refund-requests/{id}/deny', id: REQ_ID,
    body: { reason: 'Patient was actually reimbursed.' },
  }));
  assert.strictEqual(res.statusCode, 200, 'deny -> 200');
  assert.strictEqual(counters.refundInserts, 0, 'deny issues no refund');
  assert.strictEqual(counters.feeChargeInserts, 0, 'deny inserts no transaction at all');

  // 4a. approve/context refuses a DEDUCTIBLE outcome (success, not a refund) -> 409.
  reset();
  state.request = { id: REQ_ID, practice_id: 'p1', claim_id: CLAIM_ID, client_id: CLIENT_ID, status: 'open', outcome_label: 'deductible' };
  res = await handler(evt({ method: 'POST', routeKey: 'POST /refund-requests/{id}/approve/context', id: REQ_ID, body: {} }));
  assert.strictEqual(res.statusCode, 409, 'deductible outcome is not refundable -> 409');

  // 4b. approve/context on a DENIED outcome with a paid fee -> refund:true + target.
  reset();
  state.request = { id: REQ_ID, practice_id: 'p1', claim_id: CLAIM_ID, client_id: CLIENT_ID, status: 'open', outcome_label: 'denied' };
  state.paidFee = { amount: '12.50', currency: 'usd', stripe_charge_id: 'ch_1', stripe_payment_intent_id: 'pi_1' };
  res = await handler(evt({ method: 'POST', routeKey: 'POST /refund-requests/{id}/approve/context', id: REQ_ID, body: {} }));
  let ctx = JSON.parse(res.body);
  assert.strictEqual(res.statusCode, 200, 'denied + paid fee -> 200');
  assert.strictEqual(ctx.refund, true, 'hands out a refund target');
  assert.strictEqual(ctx.charge, 'ch_1', 'targets the fee charge');
  assert.strictEqual(ctx.amount_cents, 1250, 'refund amount = the charged fee');

  // 4c. approve/context is idempotent: once refunded, refund:false (no error).
  reset();
  state.request = { id: REQ_ID, practice_id: 'p1', claim_id: CLAIM_ID, client_id: CLIENT_ID, status: 'open', outcome_label: 'denied' };
  state.alreadyRefunded = true;
  res = await handler(evt({ method: 'POST', routeKey: 'POST /refund-requests/{id}/approve/context', id: REQ_ID, body: {} }));
  ctx = JSON.parse(res.body);
  assert.strictEqual(res.statusCode, 200, 'already refunded -> 200');
  assert.strictEqual(ctx.refund, false, 'already refunded -> no new target');

  // 5a. approve/record on an open request inserts EXACTLY ONE refund transaction.
  reset();
  state.paidFee = { amount: '12.50', currency: 'usd', stripe_charge_id: 'ch_1', stripe_payment_intent_id: 'pi_1' };
  res = await handler(evt({
    method: 'POST', routeKey: 'POST /refund-requests/{id}/approve/record', id: REQ_ID,
    body: { refund_id: 're_1', status: 'succeeded', reason: 'denied per EOB' },
  }));
  assert.strictEqual(res.statusCode, 200, 'record -> 200');
  assert.strictEqual(JSON.parse(res.body).recorded, true, 'record confirms');
  assert.strictEqual(counters.refundInserts, 1, 'exactly one refund transaction');

  // 5b. approve/record when the conditional update matches nothing (already decided /
  //     lost the race) records NOTHING — no second refund can ever be written.
  reset();
  state.approveUpdateRows = []; // update touched 0 rows
  state.paidFee = { amount: '12.50', currency: 'usd', stripe_charge_id: 'ch_1' };
  res = await handler(evt({
    method: 'POST', routeKey: 'POST /refund-requests/{id}/approve/record', id: REQ_ID,
    body: { refund_id: 're_1', status: 'succeeded' },
  }));
  assert.strictEqual(JSON.parse(res.body).recorded, false, 'no re-record');
  assert.strictEqual(counters.refundInserts, 0, 'no second refund transaction');

  // 5c. approve/record ignores a non-succeeded Stripe status (records nothing).
  reset();
  state.paidFee = { amount: '12.50', currency: 'usd', stripe_charge_id: 'ch_1' };
  res = await handler(evt({
    method: 'POST', routeKey: 'POST /refund-requests/{id}/approve/record', id: REQ_ID,
    body: { refund_id: 're_1', status: 'failed' },
  }));
  assert.strictEqual(counters.refundInserts, 0, 'failed refund records nothing');

  // 6. Non-admins are refused (server-side boundary).
  reset();
  const savedUsersRoute = route;
  // temporarily flip the users row to a non-admin by wrapping the db mock
  const resolved = require.resolve(path.join(__dirname, '..', 'lib', 'db.js'));
  require.cache[resolved].exports.query = async (sql, params) => {
    if (/from users/i.test(String(sql))) {
      return { rows: [{ id: 'user-1', practice_id: 'p1', role: 'clinician', is_active: true }], rowCount: 1 };
    }
    return savedUsersRoute(sql, params);
  };
  res = await handler(evt({ method: 'GET', routeKey: 'GET /refund-requests' }));
  assert.strictEqual(res.statusCode, 403, 'non-admin -> 403');

  console.log('refund_requests.test.js: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
