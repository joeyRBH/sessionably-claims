'use strict';

// Unit tests for backend/lib/audit.js — pure, no DB, no network.
//
//   node backend/tests/audit.test.js
//
// Covers:
//   (a) sanitizeFields returns changed field NAMES only, never values;
//   (b) the audit entry builder derives the correct actor_type for user vs
//       patient_link vs system contexts (and pulls ip / ua / request id);
//   (c) audit() swallows a thrown insert error without rethrowing (stubbed db).

const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const AUDIT_PATH = path.join(__dirname, '..', 'lib', 'audit.js');
const DB_PATH = path.join(__dirname, '..', 'lib', 'db.js');

// --- load audit.js with a stubbed db module ----------------------------------
// The db stub is controllable per-test: set dbStub.query to whatever behavior a
// test needs. We inject it into the require cache before requiring audit.js so
// audit.js's `require('./db')` resolves to the stub.

const dbStub = {
  calls: [],
  query: async function () { return { rowCount: 0, rows: [] }; },
};
require.cache[DB_PATH] = new Module(DB_PATH);
require.cache[DB_PATH].exports = dbStub;
require.cache[DB_PATH].loaded = true;

const { audit, buildAuditEntry, sanitizeFields } = require(AUDIT_PATH);

// A representative API Gateway HTTP API v2 event.
const EVENT = {
  requestContext: {
    requestId: 'req-abc-123',
    http: { sourceIp: '203.0.113.9', method: 'GET' },
  },
  headers: { 'user-agent': 'Mozilla/5.0 (audit-test)' },
};

// --- (a) sanitizeFields returns names only, never values ---------------------

(function testSanitizeFieldsNamesOnly() {
  const before = {
    first_name: 'Jane',
    last_name: 'Doe',
    date_of_birth: '1990-01-01',
    gender: 'female',
    billed_amount: '150.00',
    diagnosis_codes: ['F411'],
  };
  const after = {
    first_name: 'Jane',            // unchanged
    date_of_birth: '1988-05-05',   // changed
    gender: 'male',                // changed
    billed_amount: 150,            // numerically equal -> NOT changed
    diagnosis_codes: ['F411', 'F329'], // changed
  };

  const changed = sanitizeFields(before, after);

  // Only changed NAMES, and only keys present in `after`.
  assert.deepStrictEqual(
    changed.slice().sort(),
    ['date_of_birth', 'diagnosis_codes', 'gender'],
    'should return exactly the changed field names'
  );

  // Never leak values: every element is a key of `after`, and no PHI value appears.
  const serialized = JSON.stringify(changed);
  ['Jane', 'Doe', '1988-05-05', '1990-01-01', 'F411', 'F329', '150'].forEach(function (v) {
    assert.ok(serialized.indexOf(v) === -1, 'result must not contain the value ' + v);
  });
  changed.forEach(function (name) {
    assert.ok(Object.prototype.hasOwnProperty.call(after, name), name + ' must be a field name');
  });

  // Empty / identical inputs -> no changes.
  assert.deepStrictEqual(sanitizeFields({}, {}), []);
  assert.deepStrictEqual(sanitizeFields({ a: 1 }, { a: 1 }), []);
  // Null before (row absent) -> every provided field counts as changed.
  assert.deepStrictEqual(sanitizeFields(null, { a: 'x', b: 'y' }).sort(), ['a', 'b']);

  console.log('ok - sanitizeFields returns changed field names only, never values');
})();

// --- (b) actor_type resolution + request-context extraction ------------------

(function testBuildEntryActorTypes() {
  // A user context -> actor_type 'user', ids carried through.
  const userEntry = buildAuditEntry(EVENT, { userId: 'user-1', practiceId: 'prac-1' }, {
    action: 'client.view', resourceType: 'client', resourceId: 'client-9',
  });
  assert.strictEqual(userEntry.actor_type, 'user');
  assert.strictEqual(userEntry.actor_user_id, 'user-1');
  assert.strictEqual(userEntry.practice_id, 'prac-1');
  assert.strictEqual(userEntry.action, 'client.view');
  assert.strictEqual(userEntry.resource_type, 'client');
  assert.strictEqual(userEntry.resource_id, 'client-9');
  // Request context is extracted from the event.
  assert.strictEqual(userEntry.ip_address, '203.0.113.9');
  assert.strictEqual(userEntry.user_agent, 'Mozilla/5.0 (audit-test)');
  assert.strictEqual(userEntry.request_id, 'req-abc-123');

  // An explicit patient_link actor -> 'patient_link' even with no user id.
  const linkEntry = buildAuditEntry(EVENT, { actorType: 'patient_link', practiceId: 'prac-1' }, {
    action: 'patient_link.save_details', resourceType: 'client', resourceId: 'client-9',
  });
  assert.strictEqual(linkEntry.actor_type, 'patient_link');
  assert.strictEqual(linkEntry.actor_user_id, null);

  // No user id and no override -> 'system' (e.g. a pre-auth login failure).
  const systemEntry = buildAuditEntry(EVENT, {}, {
    action: 'auth.login_failure', resourceType: 'auth', metadata: { email: 'x@y.com' },
  });
  assert.strictEqual(systemEntry.actor_type, 'system');
  assert.strictEqual(systemEntry.actor_user_id, null);
  assert.strictEqual(systemEntry.practice_id, null);

  // Aliases: a raw auth.user shape (sub / practice_id) also resolves.
  const aliasEntry = buildAuditEntry(EVENT, { sub: 'user-2', practice_id: 'prac-2' }, { action: 'x' });
  assert.strictEqual(aliasEntry.actor_type, 'user');
  assert.strictEqual(aliasEntry.actor_user_id, 'user-2');
  assert.strictEqual(aliasEntry.practice_id, 'prac-2');

  console.log('ok - buildAuditEntry derives actor_type for user / patient_link / system');
})();

// --- (c) audit() swallows a thrown insert error without rethrowing -----------

(async function testAuditSwallowsErrors() {
  // Make the stubbed insert throw.
  let called = false;
  const originalError = console.error;
  const errorLogs = [];
  console.error = function () { errorLogs.push(Array.prototype.slice.call(arguments)); };
  dbStub.query = async function () {
    called = true;
    throw new Error('connection refused');
  };

  let threw = false;
  try {
    const result = await audit(EVENT, { userId: 'user-1', practiceId: 'prac-1' }, {
      action: 'client.view', resourceType: 'client', resourceId: 'client-9',
    });
    assert.strictEqual(result, undefined, 'audit() resolves to undefined');
  } catch (e) {
    threw = true;
  } finally {
    console.error = originalError;
  }

  assert.strictEqual(called, true, 'the insert was attempted');
  assert.strictEqual(threw, false, 'audit() must never rethrow an insert error');
  assert.ok(
    errorLogs.some(function (a) { return String(a[0]).indexOf('audit write failed') === 0; }),
    'audit() logs a terse failure marker'
  );

  // And a success path performs exactly one INSERT with the expected columns.
  const inserts = [];
  dbStub.query = async function (text, params) { inserts.push({ text, params }); return { rowCount: 1 }; };
  await audit(EVENT, { userId: 'user-1', practiceId: 'prac-1' }, {
    action: 'client.create', resourceType: 'client', resourceId: 'client-9',
    metadata: { count: 3 },
  });
  assert.strictEqual(inserts.length, 1, 'exactly one INSERT');
  assert.ok(/insert into audit_log/i.test(inserts[0].text), 'inserts into audit_log');
  assert.strictEqual(inserts[0].params.length, 10, 'binds all 10 columns');
  // metadata is JSON-encoded (last param).
  assert.strictEqual(inserts[0].params[9], JSON.stringify({ count: 3 }));

  console.log('ok - audit() swallows insert errors and performs a single INSERT on success');
})().then(function () {
  console.log('audit.test.js: all passed');
}).catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
