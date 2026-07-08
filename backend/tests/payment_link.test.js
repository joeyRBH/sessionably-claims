'use strict';

// Unit test — the payment-link handler's phone handling
// (backend/handlers/payment_link.js). Mocks auth, db, and the payment token via
// the require cache so no JWT, DB, or network is exercised. Verifies the SMS path
// the Twilio adapter depends on:
//   * an already-normalized stored number (+1XXXXXXXXXX) -> 200, To in E.164,
//   * a legacy raw stored number ("(970) 825-2499") -> normalized -> 200,
//   * an un-normalizable legacy number ("970-825-2499 x12") -> a clear 400
//     (the send is rejected loudly, never silently), and
//   * a missing number -> 400.
//
//   node backend/tests/payment_link.test.js

const assert = require('node:assert');
const path = require('node:path');

// Replace a lib module in the require cache BEFORE the handler requires it.
function mock(rel, exports) {
  const resolved = require.resolve(path.join(__dirname, '..', rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

mock('lib/auth.js', { requireAuth: () => ({ user: { sub: 'user-1' } }) });
mock('lib/payment_token.js', { sign: () => 'signed-token', verify: () => ({}) });

let clientRow = null;
mock('lib/db.js', {
  query: async (sql) => {
    if (/from users/i.test(sql)) return { rows: [{ practice_id: 'p1' }], rowCount: 1 };
    if (/from clients/i.test(sql)) return { rows: clientRow ? [clientRow] : [], rowCount: clientRow ? 1 : 0 };
    if (/from practices/i.test(sql)) return { rows: [{ name: 'Test Practice' }], rowCount: 1 };
    if (/^update\s+clients/i.test(sql.trim())) return { rowCount: 1 };
    return { rows: [], rowCount: 0 };
  },
});

const { handler } = require(path.join(__dirname, '..', 'handlers', 'payment_link.js'));

const UUID = '11111111-1111-4111-8111-111111111111';
function event() {
  return { httpMethod: 'POST', pathParameters: { id: UUID }, headers: { Authorization: 'Bearer x' } };
}

(async () => {
  // 1. Already-normalized stored number -> 200, To carried in E.164.
  clientRow = { id: 'c1', phone: '+19708252499', first_name: 'Jo' };
  let res = await handler(event());
  assert.strictEqual(res.statusCode, 200, 'normalized number -> 200');
  assert.strictEqual(JSON.parse(res.body).to, '+19708252499', 'To is E.164');

  // 2. Legacy raw stored number -> normalized to E.164 -> 200.
  clientRow = { id: 'c2', phone: '(970) 825-2499', first_name: 'Jo' };
  res = await handler(event());
  assert.strictEqual(res.statusCode, 200, 'legacy raw number -> 200');
  assert.strictEqual(JSON.parse(res.body).to, '+19708252499', 'legacy raw normalized to E.164');

  // 3. Un-normalizable legacy number -> clear 400 (never a silent failure).
  clientRow = { id: 'c3', phone: '970-825-2499 x12', first_name: 'Jo' };
  res = await handler(event());
  assert.strictEqual(res.statusCode, 400, 'un-normalizable number -> 400');
  assert.ok(/valid US number/i.test(JSON.parse(res.body).error), 'clear, actionable error message');

  // 4. No number on file -> 400.
  clientRow = { id: 'c4', phone: '', first_name: 'Jo' };
  res = await handler(event());
  assert.strictEqual(res.statusCode, 400, 'no phone -> 400');

  console.log('payment_link.test.js: OK');
})().catch((err) => {
  console.error('payment_link.test.js: FAIL', err);
  process.exit(1);
});
