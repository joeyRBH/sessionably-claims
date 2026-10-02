'use strict';

// Unit test — POST /register (new_practice) defaults practices.notification_email to
// the founding admin's own address, so the intake-complete alert works from day one.
//
// Only a REAL address qualifies: a login can be a plain username, and handing that
// to SES fails with "Missing final '@domain'". An invalid value is stored as NULL,
// never as a username.
//
//   node backend/tests/register_notification_email.test.js

const assert = require('node:assert');
const path = require('node:path');

process.env.JWT_SECRET = 'test-secret-for-unit-only';

const dbLib = require(path.join(__dirname, '..', 'lib', 'db.js'));
let practiceInsert = null;
dbLib.withTransaction = async (fn) => fn({
  query: async (sql, params) => {
    const t = String(sql).replace(/\s+/g, ' ');
    if (/^savepoint|^release savepoint|^rollback to savepoint/i.test(t)) return { rows: [], rowCount: 0 };
    if (/^insert into practices/i.test(t)) {
      practiceInsert = { sql: t, params };
      return { rows: [{ id: 'practice-1' }], rowCount: 1 };
    }
    if (/^insert into users/i.test(t)) {
      return { rows: [{ id: 'user-1', practice_id: 'practice-1', role: 'practice_admin',
        first_name: params[1], last_name: params[2], email: params[3] }], rowCount: 1 };
    }
    throw new Error('unexpected query: ' + t);
  },
});
const auditLib = require(path.join(__dirname, '..', 'lib', 'audit.js'));
auditLib.audit = async () => {};

const { handler } = require(path.join(__dirname, '..', 'handlers', 'register.js'));

const register = (email) => handler({
  httpMethod: 'POST',
  body: JSON.stringify({ mode: 'new_practice', practice_name: 'Stone Ridge', first_name: 'Pat',
    last_name: 'Lee', email, password: 'correct-horse-battery' }),
});

(async () => {
  practiceInsert = null;
  let res = await register('Pat@Stoneridge.Example');
  assert.strictEqual(res.statusCode, 201, res.body);
  assert.ok(/notification_email/.test(practiceInsert.sql), 'the practice insert sets notification_email');
  assert.strictEqual(practiceInsert.params[2], 'pat@stoneridge.example',
    "defaults to the admin's (normalized) email");

  practiceInsert = null;
  res = await register('BigRedd');
  assert.strictEqual(res.statusCode, 201, res.body);
  assert.strictEqual(practiceInsert.params[2], null, 'a username login is never stored as an alert address');

  console.log('register_notification_email.test.js: OK');
})().catch((e) => { console.error('register_notification_email.test.js: FAIL', e); process.exit(1); });
