'use strict';

// Unit test — getClaim's claim-detail shaper (PART B). shapeClaimDetail must be
// strictly ADDITIVE over shapeClaim: every pre-existing top-level claim key is
// identical to shapeClaim's output, and it only appends the read-only `patient`
// and `insurance` blocks. Guards against a regression that changes or drops a
// top-level field, or leaks PHI shape changes into other claim paths. Pure (no
// DB / network).
//
//   node backend/tests/claim_detail_shape.test.js

const assert = require('node:assert');
const path = require('node:path');

const claims = require(path.join(__dirname, '..', 'handlers', 'claims.js'));
const { shapeClaim, shapeClaimDetail } = claims;

// A representative claims.* row plus the aliased join columns loadClaimDetail adds.
const baseClaimRow = {
  id: '1de66cd7-0000-0000-0000-000000000000',
  practice_id: 'p-1',
  session_id: 's-1',
  client_id: 'c-1',
  clinician_id: 'u-1',
  insurance_record_id: 'ir-1',
  claim_number: 'CLM-100',
  control_number: 'CTRL-9',
  patient_control_number: 'PCN17CHARSSAMPLE1',
  clearinghouse: 'stedi',
  status: 'draft',
  billed_amount: '150.00',
  allowed_amount: null,
  reimbursed_amount: null,
  patient_responsibility: null,
  denial_reason: null,
  submitted_at: null,
  is_hidden: false,
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
};

// --- 1. Row with client + insurance fields present → blocks populated ---------
const fullRow = Object.assign({}, baseClaimRow, {
  client_first_name: 'Alexander',
  client_last_name: 'Gard',
  client_preferred_name: null,
  client_date_of_birth: '1990-05-02',
  client_gender: 'male',
  client_address_line1: '1 Main St',
  client_address_line2: null,
  client_city: 'Austin',
  client_state: 'TX',
  client_postal_code: '78701',
  ins_member_id: 'M-123',
  ins_carrier_name: 'Aetna',
  ins_payer_id: '60054',
  ins_subscriber_relationship: 'child',
  ins_subscriber_name: 'Jamie Gard',
  ins_subscriber_dob: '1985-03-10',
});

const full = shapeClaimDetail(fullRow);

// Additive check: every top-level key shapeClaim emits is byte-identical.
const plain = shapeClaim(fullRow);
Object.keys(plain).forEach(function (k) {
  assert.deepStrictEqual(full[k], plain[k],
    'top-level claim key "' + k + '" must be unchanged vs shapeClaim');
});
// Only `patient` and `insurance` are added on top of shapeClaim's keys.
const added = Object.keys(full).filter(function (k) { return !(k in plain); });
assert.deepStrictEqual(added.sort(), ['insurance', 'patient'],
  'shapeClaimDetail adds exactly patient + insurance');

assert.deepStrictEqual(full.patient, {
  first_name: 'Alexander',
  last_name: 'Gard',
  preferred_name: null,
  date_of_birth: '1990-05-02',
  gender: 'male',
  address_line1: '1 Main St',
  address_line2: null,
  city: 'Austin',
  state: 'TX',
  postal_code: '78701',
}, 'patient block populated from client columns');

assert.deepStrictEqual(full.insurance, {
  member_id: 'M-123',
  carrier_name: 'Aetna',
  payer_id: '60054',
  subscriber_relationship: 'child',
  subscriber_name: 'Jamie Gard',
  subscriber_dob: '1985-03-10',
}, 'insurance block populated when insurance_record_id is set');

// --- 2. Row with no client demographics → patient keys all null ---------------
const nullRow = Object.assign({}, baseClaimRow, { insurance_record_id: null });
const nulled = shapeClaimDetail(nullRow);
Object.keys(nulled.patient).forEach(function (k) {
  assert.strictEqual(nulled.patient[k], null, 'patient.' + k + ' is null when absent');
});
// No insurance_record_id → insurance is null (not a block of nulls).
assert.strictEqual(nulled.insurance, null,
  'insurance is null when the claim has no insurance_record_id');

// --- 3. Null row → null (mirrors shapeClaim) ----------------------------------
assert.strictEqual(shapeClaimDetail(null), null, 'null row → null');

console.log('PASS claim_detail_shape.test.js');
