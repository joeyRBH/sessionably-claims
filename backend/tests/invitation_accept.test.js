'use strict';

// Unit test — the invitation-acceptance guard (backend/handlers/register.js).
// Pure logic, no DB: proves the server-side enforcement of
//   * single-use  (a non-'pending' invite — accepted/revoked/expired — is dead),
//   * expiry      (a past or missing expires_at is rejected),
//   * email match (the token can't be used to claim a different email),
// and that a valid, pending, unexpired, matching invite passes so the caller can
// assign the invited ROLE. The role assignment itself is a straight column copy
// (users.role := invitations.role) in the handler; this test locks the gate that
// guards it.
//
//   node backend/tests/invitation_accept.test.js

const assert = require('node:assert');
const path = require('node:path');

const register = require(path.join(__dirname, '..', 'handlers', 'register.js'));
const validate = register.validateInvitationForAccept;

const NOW = Date.parse('2026-07-10T00:00:00Z');
const FUTURE = new Date(NOW + 3 * 24 * 3600 * 1000).toISOString(); // +3 days
const PAST = new Date(NOW - 1 * 24 * 3600 * 1000).toISOString();   // -1 day

function invite(overrides) {
  return Object.assign({
    id: 'inv-1',
    practice_id: 'prac-1',
    role: 'clinician',
    email: 'dana@practice.test',
    status: 'pending',
    expires_at: FUTURE,
  }, overrides || {});
}

// --- valid path -------------------------------------------------------------
{
  const r = validate(invite(), 'dana@practice.test', NOW);
  assert.strictEqual(r.ok, true, 'a pending, unexpired, matching invite is accepted');
}

// --- single-use: a non-pending invite is dead -------------------------------
['accepted', 'revoked', 'expired'].forEach(function (status) {
  const r = validate(invite({ status: status }), 'dana@practice.test', NOW);
  assert.strictEqual(r.ok, false, status + ' invite is rejected (single-use)');
  assert.strictEqual(r.code, 'invalid', status + ' -> code "invalid"');
});

// A missing invite (bad/unknown token -> no row) is rejected.
assert.strictEqual(validate(null, 'dana@practice.test', NOW).ok, false, 'no invite row -> rejected');
assert.strictEqual(validate(undefined, 'dana@practice.test', NOW).ok, false, 'undefined invite -> rejected');

// --- expiry -----------------------------------------------------------------
{
  const past = validate(invite({ expires_at: PAST }), 'dana@practice.test', NOW);
  assert.strictEqual(past.ok, false, 'an expired invite is rejected');
  assert.strictEqual(past.code, 'expired', 'past expiry -> code "expired"');

  const atBoundary = validate(invite({ expires_at: new Date(NOW).toISOString() }), 'dana@practice.test', NOW);
  assert.strictEqual(atBoundary.ok, false, 'expiry exactly at now is rejected (<=)');

  const missing = validate(invite({ expires_at: null }), 'dana@practice.test', NOW);
  assert.strictEqual(missing.ok, false, 'missing expires_at is rejected');
}

// --- email must match the invited address -----------------------------------
{
  const mismatch = validate(invite(), 'someone.else@evil.test', NOW);
  assert.strictEqual(mismatch.ok, false, 'a different email is rejected');
  assert.strictEqual(mismatch.code, 'email_mismatch', 'mismatch -> code "email_mismatch"');
  assert.ok(/different email/i.test(mismatch.clientMessage), 'carries a user-facing message');

  // Case/whitespace-insensitive match (mirrors normalizeEmail).
  const normalized = validate(invite({ email: 'Dana@Practice.Test' }), '  dana@practice.test ', NOW);
  assert.strictEqual(normalized.ok, true, 'email match is normalized (case/whitespace)');
}

// --- role assignment: the invited role rides through unchanged ---------------
// validate() gates acceptance; the handler then inserts users.role := invite.role.
// Assert the guard passes for every allowed role so none is silently dropped.
['practice_admin', 'clinician', 'billing_staff'].forEach(function (role) {
  const r = validate(invite({ role: role }), 'dana@practice.test', NOW);
  assert.strictEqual(r.ok, true, 'invite with role ' + role + ' is acceptable');
});

console.log('invitation_accept.test.js: OK');
