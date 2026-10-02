'use strict';

// Unit test — Task 3 (DOB moved to the client).
//   * missingSubscriberField (claims handler): a client with no date_of_birth is
//     caught BEFORE the clearinghouse call, so claim submission returns a clean
//     422 rather than a 500/502.
//   * The clients handler creates a client with NO date_of_birth (staff no longer
//     enter it) → 201. Exercised end-to-end with a mocked db + a real JWT.
//
//   node backend/tests/claim_dob.test.js

const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

// --- Part A: missingSubscriberField is a pure guard -------------------------
const claims = require(path.join(__dirname, '..', 'handlers', 'claims.js'));

assert.strictEqual(
  claims.missingSubscriberField({ date_of_birth: '1990-04-12' }),
  null,
  'a client with a DOB passes'
);
assert.strictEqual(claims.missingSubscriberField({ date_of_birth: null }), 'date_of_birth');
assert.strictEqual(claims.missingSubscriberField({ date_of_birth: '' }), 'date_of_birth');
assert.strictEqual(claims.missingSubscriberField({}), 'date_of_birth');
assert.strictEqual(claims.missingSubscriberField(null), 'date_of_birth');

// --- Part B: client creation without DOB succeeds (201) ---------------------
// Mock lib/db BEFORE requiring the clients handler so its top-level require picks
// up the fake. The fake answers the two queries createClient makes: the practice
// lookup and the INSERT ... RETURNING *.
process.env.JWT_SECRET = 'test-secret-for-unit-only';

const dbPath = require.resolve(path.join(__dirname, '..', 'lib', 'db.js'));
const fakeDb = {
  query: async (sql) => {
    if (/from users where id/i.test(sql)) {
      return { rows: [{ practice_id: 'practice-1' }], rowCount: 1 };
    }
    if (/insert into clients/i.test(sql)) {
      return {
        rows: [{
          id: 'client-1',
          practice_id: 'practice-1',
          first_name: 'Alex',
          last_name: 'Doe',
          date_of_birth: null,
          status: 'awaiting_info',
        }],
        rowCount: 1,
      };
    }
    throw new Error('unexpected query in test: ' + sql);
  },
};
require.cache[dbPath] = new Module(dbPath, module);
require.cache[dbPath].filename = dbPath;
require.cache[dbPath].loaded = true;
require.cache[dbPath].exports = fakeDb;

const { sign } = require(path.join(__dirname, '..', 'lib', 'jwt.js'));
const clients = require(path.join(__dirname, '..', 'handlers', 'clients.js'));

(async () => {
  const token = sign({ id: 'user-1', practice_id: 'practice-1', role: 'practice_admin' });
  const event = {
    httpMethod: 'POST',
    headers: { authorization: `Bearer ${token}` },
    pathParameters: null,
    // No date_of_birth — staff no longer collect it on the New client form.
    body: JSON.stringify({ first_name: 'Alex', last_name: 'Doe', gender: 'unknown' }),
  };

  const res = await clients.handler(event);
  assert.strictEqual(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${res.body}`);
  const parsed = JSON.parse(res.body);
  assert.ok(parsed.client, 'returns the created client');
  assert.strictEqual(parsed.client.date_of_birth, null, 'client created without a DOB');

  console.log('claim_dob.test.js: OK');
})().catch((err) => {
  console.error('claim_dob.test.js: FAIL', err);
  process.exit(1);
});
