'use strict';

// TIN format validation + masking (backend/lib/tin.js). Format only — no
// authoritative matching. node backend/tests/tin_validation.test.js

const assert = require('node:assert');
const path = require('node:path');
const tin = require(path.join(__dirname, '..', 'lib', 'tin.js'));

// --- EIN ---------------------------------------------------------------------
let r = tin.validateEin('12-3456789');
assert.strictEqual(r.valid, true);
assert.strictEqual(r.digits, '123456789');
assert.strictEqual(r.formatted, '12-3456789', 'renders XX-XXXXXXX');

assert.strictEqual(tin.validateEin('123456789').valid, true, 'accepts undashed');
assert.strictEqual(tin.validateEin('12345').valid, false, 'too short');
assert.strictEqual(tin.validateEin('1234567890').valid, false, 'too long');
assert.strictEqual(tin.validateEin('000000000').valid, false, 'all-zeros rejected');
assert.match(tin.validateEin('000000000').error, /zero/i);

// --- SSN ---------------------------------------------------------------------
r = tin.validateSsn('123-45-6789');
assert.strictEqual(r.valid, true);
assert.strictEqual(r.digits, '123456789');
assert.strictEqual(r.formatted, '123-45-6789', 'renders XXX-XX-XXXX');

// Invalid area numbers: 000, 666, 900-999.
assert.strictEqual(tin.validateSsn('000-12-3456').valid, false, 'area 000 rejected');
assert.strictEqual(tin.validateSsn('666-12-3456').valid, false, 'area 666 rejected');
assert.strictEqual(tin.validateSsn('900-12-3456').valid, false, 'area 900 rejected');
assert.strictEqual(tin.validateSsn('999-12-3456').valid, false, 'area 999 rejected');
assert.strictEqual(tin.validateSsn('772-12-3456').valid, true, 'area 772 (valid high area) accepted');
// Invalid group (00) and serial (0000).
assert.strictEqual(tin.validateSsn('123-00-6789').valid, false, 'group 00 rejected');
assert.strictEqual(tin.validateSsn('123-45-0000').valid, false, 'serial 0000 rejected');
assert.strictEqual(tin.validateSsn('12345').valid, false, 'too short');

// --- validateTin dispatch ----------------------------------------------------
assert.strictEqual(tin.validateTin('123456789', 'EIN').valid, true);
assert.strictEqual(tin.validateTin('123456789', 'ssn').valid, true, 'type is case-insensitive');
assert.strictEqual(tin.validateTin('123456789', 'FOO').valid, false, 'unknown type rejected');

// --- masking -----------------------------------------------------------------
assert.strictEqual(tin.last4('12-3456789'), '6789');
assert.strictEqual(tin.last4('12'), null, 'too short → null');
assert.strictEqual(tin.maskFromLast4('6789', 'EIN'), '••-•••6789');
assert.strictEqual(tin.maskFromLast4('6789', 'SSN'), '•••-••-6789');
assert.strictEqual(tin.maskFromLast4(null, 'EIN'), null);

console.log('tin_validation.test.js: OK');
