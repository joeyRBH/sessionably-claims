'use strict';

// Password hashing via bcryptjs (pure-JS — avoids native-binary issues in Lambda),
// plus the one place the password POLICY is stated.

const bcrypt = require('bcryptjs');

const COST = 12;

// Minimum length for a password set through the change-password endpoint.
// Deliberately stated once, here, rather than repeated in a handler — but note it
// is currently enforced only on CHANGE (backend/handlers/password.js). Registration
// predates this policy and is left alone on purpose: tightening it would reject
// nothing that is already stored, but it WOULD change an existing public endpoint's
// contract, which belongs in its own change.
const MIN_LENGTH = 10;
const MAX_LENGTH = 200;   // bcrypt itself truncates past 72 bytes; refuse absurd input early

function hash(plain) {
  return bcrypt.hash(plain, COST);
}

function compare(plain, passwordHash) {
  // bcrypt.compare tolerates a null/invalid hash by resolving false.
  return bcrypt.compare(plain, passwordHash || '');
}

// validate(plain) -> null when acceptable, else a user-facing message.
// Pure and synchronous, so it unit-tests without touching bcrypt. Length only:
// composition rules (a digit, a symbol, mixed case) push people toward
// "Password1!" and are not what NIST 800-63B asks for — length is.
function validate(plain) {
  if (typeof plain !== 'string' || plain.trim() === '') {
    return 'A new password is required.';
  }
  // Do NOT trim the password itself — leading/trailing spaces are legitimate
  // characters. The emptiness check above is the only place trim() is involved.
  if (plain.length < MIN_LENGTH) {
    return `Your new password must be at least ${MIN_LENGTH} characters.`;
  }
  if (plain.length > MAX_LENGTH) {
    return `Your new password must be ${MAX_LENGTH} characters or fewer.`;
  }
  return null;
}

module.exports = { hash, compare, validate, COST, MIN_LENGTH, MAX_LENGTH };
