'use strict';

// Unit test — 837P coverage gaps on the CLAIMS path (buildSubmissionBody):
// place of service, diagnosis normalization + cardinality, and group number.
//
//   * Place of service (Box 24B/32) came from a hardcoded '11', so every
//     telehealth claim went out as an office visit. It now follows the session.
//   * Diagnoses (Box 21): only the first stored code was ever sent, unnormalized.
//     Codes are now normalized (dotless, uppercase, de-duplicated) and all of them
//     ride the claim as ABK + ABF. The CLAIM limit (12) and the SERVICE LINE
//     pointer limit (4) are different numbers and are enforced separately.
//   * Group number (Box 11 / SBR03) was stored on insurance_records and never
//     sent. It now rides the PRIMARY subscriber loop in both the dependent and
//     non-dependent shapes.
//
// Every optional field must be ABSENT from the built body when it has no value —
// not null, not '', not []. Pure (no network, no DB).
//
//   node backend/tests/claim_pos_diagnoses_group.test.js

const assert = require('node:assert');
const path = require('node:path');

const stedi = require(path.join(__dirname, '..', 'lib', 'clearinghouse', 'stedi.js'));

const base = {
  claim: { id: '2f1c9a3e-7b4d-4c2a-9e11-abcdef012345', billed_amount: '150.00' },
  practice: {
    name: 'Test Practice',
    npi: '1234567890',
    address_line1: '1 Main St',
    city: 'Denver',
    state: 'CO',
    postal_code: '80202',
  },
  clinician: {},
  client: {
    first_name: 'Jamie',
    last_name: 'Rivera',
    date_of_birth: '2010-08-01',
    gender: 'female',
    address_line1: '5 Elm St',
    city: 'Denver',
    state: 'CO',
    postal_code: '80203',
  },
  session: { cpt_code: '90837', session_date: '2026-06-01', diagnosis_codes: ['F411'] },
  insurance: { payer_id: '60054', carrier_name: 'Aetna', member_id: 'W123456789' },
};

const build = (over) => stedi.buildSubmissionBody({ ...base, ...over }).body;
const withSession = (s) => build({ session: { ...base.session, ...s } });
const withInsurance = (i) => build({ insurance: { ...base.insurance, ...i } });

// --- 0. REGRESSION: an ordinary claim is structurally unchanged ---------------
// Non-dependent, single diagnosis, no place_of_service, no group_number. This is
// the exact body the pre-change builder produced, asserted literally. If any of
// the three changes below leaks into the ordinary path, this fails.

assert.strictEqual(
  JSON.stringify(build({})),
  JSON.stringify({
    tradingPartnerServiceId: '60054',
    // Added by feat/claim-usage-indicator: always present, 'P' unless an
    // operator-set env gate opts this deployment/request into test mode.
    usageIndicator: 'P',
    submitter: {
      organizationName: 'Test Practice',
      contactInformation: { name: 'Test Practice', email: 'billing@reddably.com' },
    },
    receiver: { organizationName: 'Aetna' },
    billing: {
      providerType: 'BillingProvider',
      npi: '1234567890',
      organizationName: 'Test Practice',
      address: { address1: '1 Main St', city: 'Denver', state: 'CO', postalCode: '80202' },
    },
    subscriber: {
      paymentResponsibilityLevelCode: 'P',
      memberId: 'W123456789',
      firstName: 'Jamie',
      lastName: 'Rivera',
      dateOfBirth: '20100801',
      gender: 'F',
      address: { address1: '5 Elm St', city: 'Denver', state: 'CO', postalCode: '80203' },
    },
    claimInformation: {
      claimFilingCode: 'CI',
      claimFrequencyCode: '1',
      placeOfServiceCode: '11',
      claimChargeAmount: '150.00',
      patientControlNumber: '2f1c9a3e7b4d4c2a9',
      benefitsAssignmentCertificationIndicator: 'N',
      releaseInformationCode: 'Y',
      signatureIndicator: 'Y',
      planParticipationCode: 'C',
      healthCareCodeInformation: [{ diagnosisTypeCode: 'ABK', diagnosisCode: 'F411' }],
      serviceLines: [
        {
          serviceDate: '20260601',
          professionalService: {
            procedureIdentifier: 'HC',
            procedureCode: '90837',
            lineItemChargeAmount: '150.00',
            measurementUnit: 'UN',
            serviceUnitCount: '1',
            compositeDiagnosisCodePointers: { diagnosisCodePointers: ['1'] },
          },
        },
      ],
    },
  }),
  'ordinary claim body is unchanged by the POS / diagnosis / group-number work'
);

// --- 1. Place of service (Box 24B/32) ----------------------------------------

assert.strictEqual(
  build({}).claimInformation.placeOfServiceCode,
  '11',
  'no session place_of_service → office (11)'
);
assert.strictEqual(
  withSession({ place_of_service: '10' }).claimInformation.placeOfServiceCode,
  '10',
  'telehealth in the patient home (10) follows the session'
);
assert.strictEqual(
  withSession({ place_of_service: '02' }).claimInformation.placeOfServiceCode,
  '02',
  'telehealth other (02) follows the session'
);
assert.strictEqual(
  withSession({ place_of_service: '  02  ' }).claimInformation.placeOfServiceCode,
  '02',
  'stored place_of_service is trimmed'
);
for (const blank of ['', '   ', null, undefined]) {
  assert.strictEqual(
    withSession({ place_of_service: blank }).claimInformation.placeOfServiceCode,
    '11',
    `blank place_of_service (${JSON.stringify(blank)}) falls back to office (11)`
  );
}

// --- 2. Diagnosis normalization ----------------------------------------------

const norm = withSession({ diagnosis_codes: ['f32.9', ' F41.1 ', 'F329', '', null, 'f 43.10'] })
  .claimInformation.healthCareCodeInformation;

assert.deepStrictEqual(
  norm,
  [
    { diagnosisTypeCode: 'ABK', diagnosisCode: 'F329' },
    { diagnosisTypeCode: 'ABF', diagnosisCode: 'F411' },
    { diagnosisTypeCode: 'ABF', diagnosisCode: 'F4310' },
  ],
  'codes are uppercased, stripped of punctuation, de-duplicated, blanks dropped, order preserved'
);

// The fallback survives only when nothing usable is stored.
for (const empty of [undefined, null, [], ['', '  '], ['...'], 'not-an-array']) {
  assert.deepStrictEqual(
    withSession({ diagnosis_codes: empty }).claimInformation.healthCareCodeInformation,
    [{ diagnosisTypeCode: 'ABK', diagnosisCode: 'F329' }],
    `no usable diagnosis (${JSON.stringify(empty)}) → F329 placeholder`
  );
}

// --- 3. Claim-level cardinality: 1 ABK + up to 11 ABF -------------------------

const twelve = ['F320', 'F321', 'F322', 'F323', 'F324', 'F330', 'F331', 'F332', 'F410', 'F411', 'F429', 'F431'];
const twelveBody = withSession({ diagnosis_codes: twelve });
const hcci = twelveBody.claimInformation.healthCareCodeInformation;

assert.strictEqual(hcci.length, 12, 'all 12 diagnoses ride the claim');
assert.strictEqual(hcci[0].diagnosisTypeCode, 'ABK', 'first diagnosis is the principal (ABK)');
assert.ok(
  hcci.slice(1).every((d) => d.diagnosisTypeCode === 'ABF'),
  'every diagnosis after the first is secondary (ABF)'
);
assert.deepStrictEqual(hcci.map((d) => d.diagnosisCode), twelve, 'stored order is preserved');

// --- 4. No silent truncation: >12 diagnoses is rejected, not trimmed ----------

assert.throws(
  () => withSession({ diagnosis_codes: [...twelve, 'F432'] }),
  /13 diagnoses but the 837P allows at most 12/,
  'a 13th diagnosis rejects claim construction rather than silently dropping it'
);

// De-duplication happens BEFORE the limit, so 13 stored codes that collapse to 12
// distinct ones are fine — the clinician is only stopped by real overflow.
assert.strictEqual(
  withSession({ diagnosis_codes: [...twelve, 'f32.0'] }).claimInformation.healthCareCodeInformation.length,
  12,
  'a duplicate of an existing code does not push the claim over the limit'
);

// --- 5. Service-line pointers use the SMALLER line limit (4), not 12 ----------

const pointersFor = (codes) =>
  withSession({ diagnosis_codes: codes })
    .claimInformation.serviceLines[0].professionalService
    .compositeDiagnosisCodePointers.diagnosisCodePointers;

assert.deepStrictEqual(pointersFor(['F411']), ['1'], 'one diagnosis → one pointer');
assert.deepStrictEqual(pointersFor(['F411', 'F329']), ['1', '2'], 'two diagnoses → two pointers');
assert.deepStrictEqual(
  pointersFor(['F411', 'F329', 'F431', 'F900']),
  ['1', '2', '3', '4'],
  'four diagnoses → four pointers'
);
assert.deepStrictEqual(
  pointersFor(twelve),
  ['1', '2', '3', '4'],
  'twelve claim diagnoses still yield at most FOUR line pointers (SV107 holds 4)'
);
assert.deepStrictEqual(
  pointersFor([]),
  ['1'],
  'no stored diagnoses → a single pointer at the placeholder principal'
);

// --- 6. Group number (Box 11 / SBR03) on the PRIMARY subscriber ---------------

assert.strictEqual(
  withInsurance({ group_number: 'GRP12345' }).subscriber.groupNumber,
  'GRP12345',
  'non-dependent: group number rides the primary subscriber loop'
);

const depWithGroup = withInsurance({
  group_number: 'GRP12345',
  subscriber_relationship: 'child',
  subscriber_name: 'Pat Rivera',
  subscriber_dob: '1965-02-10',
});
assert.strictEqual(
  depWithGroup.subscriber.groupNumber,
  'GRP12345',
  'dependent: group number rides the POLICYHOLDER subscriber loop'
);

// It must never land on the coordination-of-benefits loop, which describes a
// different payer entirely.
assert.ok(
  !('otherSubscriberInformation' in depWithGroup),
  'group number does not introduce an otherSubscriberInformation (COB) loop'
);

assert.strictEqual(
  withInsurance({ group_number: '  GRP12345  ' }).subscriber.groupNumber,
  'GRP12345',
  'stored group number is trimmed'
);

// --- 7. OMISSION: unset optional fields are absent, not null / '' -------------

for (const blank of [undefined, null, '', '   ']) {
  const sub = withInsurance({ group_number: blank }).subscriber;
  assert.ok(
    !('groupNumber' in sub),
    `blank group_number (${JSON.stringify(blank)}) is absent from the subscriber, not ${JSON.stringify(blank)}`
  );
}

// The same holds through JSON serialization — what actually goes on the wire.
const wire = JSON.parse(JSON.stringify(withInsurance({ group_number: null })));
assert.ok(!('groupNumber' in wire.subscriber), 'no groupNumber key on the serialized wire body');

console.log('claim_pos_diagnoses_group.test.js: all assertions passed');
