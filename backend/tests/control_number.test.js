'use strict';

// Unit test — PR #46's patient-control-number fix (the <=20-char CLM01 that
// replaced the raw 36-char claim UUID Stedi rejected with error 33). This test
// guards against a regression like the stale-base rebase that nearly reverted it:
// it fails loudly if the Stedi adapter ever goes back to sending String(claim.id).
// Pure (no network, no DB).
//
//   node backend/tests/control_number.test.js

const assert = require('node:assert');
const path = require('node:path');

const stedi = require(path.join(__dirname, '..', 'lib', 'clearinghouse', 'stedi.js'));
const { generatePatientControlNumber } = require(path.join(__dirname, '..', 'lib', 'claims.js'));

// A raw 36-char UUID must be bounded to <= 20 alphanumerics (never sent as-is).
const uuid = '2f1c9a3e-7b4d-4c2a-9e11-abcdef012345';
const bounded = stedi.boundControlNumber(uuid);
assert.ok(bounded.length <= 20, 'bounded control number must be <= 20 chars, got ' + bounded.length);
assert.ok(/^[A-Za-z0-9]+$/.test(bounded), 'bounded control number must be alphanumeric only (no dashes)');
assert.strictEqual(bounded.indexOf('-'), -1, 'dashes stripped');

// The adapter prefers the claim's persisted control number when present.
assert.strictEqual(
  stedi.patientControlNumber({ patient_control_number: 'ABC123XYZ', id: uuid }),
  'ABC123XYZ',
  'stored patient_control_number is used verbatim'
);

// With no stored value, it derives a <=17-char id from the UUID — NOT the raw UUID.
const derived = stedi.patientControlNumber({ id: uuid });
assert.ok(derived.length <= 17, 'derived control number <= 17 chars');
assert.notStrictEqual(derived, uuid, 'must never send the raw 36-char UUID');

// The minted control number is 17 uppercase-alphanumeric chars.
const minted = generatePatientControlNumber();
assert.ok(/^[A-Z0-9]{17}$/.test(minted), 'minted control number is 17 upper-alnum chars, got ' + minted);

// The 837P submission body carries the bounded control number as CLM01.
// buildSubmissionBody returns { body, tradingPartnerServiceId, billingNpi }.
const built = stedi.buildSubmissionBody({
  claim: { id: uuid, patient_control_number: 'PCN17CHARSSAMPLE1', billed_amount: '150.00' },
  insurance: { payer_id: '60054', carrier_name: 'Aetna' },
  practice: { name: 'Test Practice', npi: '1234567890' },
  clinician: {}, client: {}, session: { cpt_code: '90837', diagnosis_codes: ['F411'] },
});
const clm01 = built.body.claimInformation.patientControlNumber;
assert.strictEqual(clm01, 'PCN17CHARSSAMPLE1', 'CLM01 uses the stored PCN');
assert.ok(clm01.length <= 20, 'CLM01 <= 20 chars');

console.log('PASS control_number.test.js');
