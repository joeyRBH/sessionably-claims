'use strict';

// Unit tests — POST /me/password (backend/handlers/password.js) and the password
// policy in backend/lib/password.js.
//
// The handler's decision layer is exported as decide(user, body, currentMatches)
// so every branch is exercised without a database or a bcrypt round. The bcrypt
// compare itself is tested separately against real hashes.
//
//   node backend/tests/change_password.test.js

const assert = require('node:assert');
const path = require('node:path');

const { decide } = require(path.join(__dirname, '..', 'handlers', 'password.js'));
const { hash, compare, validate, MIN_LENGTH } = require(path.join(__dirname, '..', 'lib', 'password.js'));

const ACTIVE = { id: 'u1', practice_id: 'p1', password_hash: '$2a$12$fake', is_active: true };
const LONG = 'a-perfectly-fine-password';

// --- policy ------------------------------------------------------------------

assert.strictEqual(validate(LONG), null, 'a long password passes');
assert.match(validate(''), /required/i, 'empty is rejected');
assert.match(validate('   '), /required/i, 'whitespace-only is rejected');
assert.match(validate(undefined), /required/i, 'missing is rejected');
assert.match(validate(123), /required/i, 'a non-string is rejected');
assert.match(validate('a'.repeat(MIN_LENGTH - 1)), /at least/i, 'one char under the minimum is rejected');
assert.strictEqual(validate('a'.repeat(MIN_LENGTH)), null, 'exactly the minimum passes');
assert.match(validate('a'.repeat(201)), /or fewer/i, 'absurd length is rejected');

// A password made only of spaces long enough to pass the length rule is still
// rejected by the emptiness check — but a password that merely CONTAINS spaces
// is fine, and must not be trimmed away.
assert.strictEqual(validate('  ' + LONG + '  '), null, 'surrounding spaces do not invalidate');

// --- decide: rejections ------------------------------------------------------

{
  const r = decide(null, { current_password: 'x', new_password: LONG }, true);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 401, 'no user row -> 401');
}
{
  const r = decide({ ...ACTIVE, is_active: false }, { current_password: 'x', new_password: LONG }, true);
  assert.strictEqual(r.status, 401, 'deactivated user -> 401');
}
{
  // OAuth-only account: cannot MINT a first password here.
  const r = decide({ ...ACTIVE, password_hash: null }, { current_password: 'x', new_password: LONG }, null);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 409);
  assert.match(r.error, /Google/i, 'explains why, without leaking anything');
}
{
  const r = decide(ACTIVE, { new_password: LONG }, null);
  assert.strictEqual(r.status, 400);
  assert.match(r.error, /current password is required/i);
}
{
  const r = decide(ACTIVE, { current_password: '', new_password: LONG }, null);
  assert.strictEqual(r.status, 400, 'an empty current password is not "supplied"');
}
{
  const r = decide(ACTIVE, { current_password: 'right', new_password: 'short' }, true);
  assert.strictEqual(r.status, 400);
  assert.match(r.error, /at least/i, 'policy failure is reported even when the current password is right');
}
{
  const r = decide(ACTIVE, { current_password: LONG, new_password: LONG }, true);
  assert.strictEqual(r.status, 400);
  assert.match(r.error, /different from your current/i);
}
{
  const r = decide(ACTIVE, { current_password: 'wrong', new_password: LONG }, false);
  assert.strictEqual(r.status, 400);
  assert.match(r.error, /current password is incorrect/i);
}

// Ordering guarantee: a request that is wrong in BOTH ways reports the new
// password's policy failure, not the current-password mismatch. That keeps the
// endpoint from being a cheap oracle that distinguishes "wrong current password"
// from "malformed new password" by which error comes back first.
{
  const r = decide(ACTIVE, { current_password: 'wrong', new_password: 'short' }, false);
  assert.match(r.error, /at least/i, 'policy is evaluated before the current-password check');
}

// --- decide: the accepting case ----------------------------------------------

{
  const r = decide(ACTIVE, { current_password: 'old-password-x', new_password: LONG }, true);
  assert.deepStrictEqual(r, { ok: true });
}

// --- the real bcrypt round ---------------------------------------------------

(async () => {
  const stored = await hash('the-original-password');
  assert.strictEqual(await compare('the-original-password', stored), true, 'correct password matches');
  assert.strictEqual(await compare('the-original-passwore', stored), false, 'a near miss does not');
  assert.strictEqual(await compare('the-original-password', null), false, 'a null hash never matches');

  // A changed password produces a different hash that the OLD password fails.
  const rotated = await hash(LONG);
  assert.notStrictEqual(rotated, stored);
  assert.strictEqual(await compare('the-original-password', rotated), false,
    'the old password no longer works after a change');
  assert.strictEqual(await compare(LONG, rotated), true, 'the new password works');

  console.log('change_password: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
