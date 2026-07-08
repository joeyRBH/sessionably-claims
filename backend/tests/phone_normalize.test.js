'use strict';

// Unit test — phone normalization to E.164 (backend/lib/util.js normalizePhone).
// The staff client form and the SMS intake accept any common US format; the
// backend re-normalizes on every write (never trust the client) because Twilio
// SMS requires E.164. Pure (no network, no DB).
//
//   node backend/tests/phone_normalize.test.js

const assert = require('node:assert');
const path = require('node:path');

const { normalizePhone } = require(path.join(__dirname, '..', 'lib', 'util.js'));

// All four common formats normalize to the same E.164 value.
const EXPECTED = '+19708252499';
for (const input of ['(970) 825-2499', '970-825-2499', '9708252499', '+19708252499']) {
  const res = normalizePhone(input);
  assert.strictEqual(res.ok, true, `expected ok for "${input}"`);
  assert.strictEqual(res.value, EXPECTED, `"${input}" -> ${EXPECTED}, got ${res.value}`);
}

// Extra whitespace / dots / spaces are tolerated.
assert.strictEqual(normalizePhone('  970.825.2499 ').value, EXPECTED);
assert.strictEqual(normalizePhone('1 (970) 825-2499').value, EXPECTED, 'leading 1 country code');

// Garbage / invalid inputs are rejected (not silently coerced).
for (const bad of [
  'hello',            // no digits
  '',                 // empty
  '   ',              // whitespace only
  '12345',            // too short
  '970-825',          // too short
  '970825249',        // 9 digits
  '97082524999',      // 11 digits not starting with 1
  '0708252499',       // area code starts with 0
  '1708252499',       // area code starts with 1
  '9700252499',       // exchange starts with 0
  '9701252499',       // exchange starts with 1
  '+449708252499',    // non-US country code (12 digits)
  null,
  undefined,
]) {
  const res = normalizePhone(bad);
  assert.strictEqual(res.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
  assert.strictEqual(res.value, undefined, `rejected input carries no value: ${JSON.stringify(bad)}`);
}

console.log('phone_normalize.test.js: OK');
