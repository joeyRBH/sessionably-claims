'use strict';

// Unit test — 837P dependent support on the CLAIMS path (mirrors the VOB
// dependent fix in vob_dependents.test.js, but for buildSubmissionBody).
//
// A live claim (Gard/Surest) was rejected with 277CA A3/21 "invalid
// patient/subscriber information" because buildSubmissionBody always put the
// patient in the `subscriber` object. When the patient is a dependent on someone
// else's policy, the 837P wants the POLICYHOLDER in `subscriber` and the PATIENT
// in a singular `dependent` object. This exercises both shapes:
//
//   * non-dependent (relationship self / absent) → body byte-identical to the
//     original shape, no `dependent` key;
//   * dependent (relationship child) → policyholder in subscriber, patient in
//     dependent with relationshipToSubscriberCode 19, no empty-string fields;
//   * relationship mapping spouse → '01', unknown value → 'G8'.
//
// Pure (no network, no DB).
//
//   node backend/tests/claims_dependent.test.js

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
};

// --- 1. Non-dependent: body identical to the current shape, no `dependent` -----

// Baseline "current shape": build with an insurance record that has no
// subscriber_relationship at all — this is exactly the pre-fix behavior.
const legacyInsurance = { payer_id: '60054', carrier_name: 'Aetna', member_id: 'W123456789' };
const legacy = stedi.buildSubmissionBody({ ...base, insurance: legacyInsurance });

assert.ok(!('dependent' in legacy.body), 'no dependent key when relationship is absent');
assert.deepStrictEqual(
  legacy.body.subscriber,
  {
    paymentResponsibilityLevelCode: 'P',
    memberId: 'W123456789',
    firstName: 'Jamie',
    lastName: 'Rivera',
    dateOfBirth: '20100801',
    gender: 'F',
    address: {
      address1: '5 Elm St',
      address2: undefined,
      city: 'Denver',
      state: 'CO',
      postalCode: '80203',
    },
  },
  'subscriber carries the patient demographics unchanged'
);

// relationship 'self' must produce a body byte-identical to the no-relationship
// baseline (self means the patient IS the subscriber).
const selfBody = stedi.buildSubmissionBody({
  ...base,
  insurance: { ...legacyInsurance, subscriber_relationship: 'self' },
});
assert.ok(!('dependent' in selfBody.body), "relationship 'self' → no dependent key");
assert.strictEqual(
  JSON.stringify(selfBody.body),
  JSON.stringify(legacy.body),
  "relationship 'self' body is byte-identical to the no-relationship baseline"
);

// --- 2. Dependent (child): policyholder in subscriber, patient in dependent ----

const depBody = stedi.buildSubmissionBody({
  ...base,
  insurance: {
    payer_id: '60054',
    carrier_name: 'Surest',
    member_id: 'W123456789',
    subscriber_relationship: 'child',
    subscriber_name: 'Pat Rivera',
    subscriber_dob: '1965-02-10',
  },
});

// Policyholder in the subscriber loop — only known fields, no gender/address.
assert.deepStrictEqual(
  depBody.body.subscriber,
  {
    paymentResponsibilityLevelCode: 'P',
    memberId: 'W123456789',
    firstName: 'Pat',
    lastName: 'Rivera',
    dateOfBirth: '19650210',
  },
  'subscriber carries the policyholder demographics only'
);

// Patient in the dependent loop, relationship child → 19.
assert.deepStrictEqual(
  depBody.body.dependent,
  {
    relationshipToSubscriberCode: '19',
    firstName: 'Jamie',
    lastName: 'Rivera',
    dateOfBirth: '20100801',
    gender: 'F',
    address: {
      address1: '5 Elm St',
      address2: undefined,
      city: 'Denver',
      state: 'CO',
      postalCode: '80203',
    },
  },
  'patient moves into a singular dependent object with relationship code 19'
);

// No empty-string fields leaked into either loop (top level).
Object.values(depBody.body.subscriber).forEach((v) =>
  assert.notStrictEqual(v, '', 'no empty string in subscriber')
);
Object.values(depBody.body.dependent).forEach((v) =>
  assert.notStrictEqual(v, '', 'no empty string in dependent')
);

// --- 3. Relationship mapping: spouse → '01', unknown → 'G8' --------------------

const spouseBody = stedi.buildSubmissionBody({
  ...base,
  insurance: {
    payer_id: '60054',
    member_id: 'W1',
    subscriber_relationship: 'spouse',
    subscriber_name: 'Pat Rivera',
    subscriber_dob: '1965-02-10',
  },
});
assert.strictEqual(
  spouseBody.body.dependent.relationshipToSubscriberCode,
  '01',
  'spouse → 01'
);

const otherBody = stedi.buildSubmissionBody({
  ...base,
  insurance: {
    payer_id: '60054',
    member_id: 'W1',
    subscriber_relationship: 'other',
    subscriber_name: 'Pat Rivera',
    subscriber_dob: '1965-02-10',
  },
});
assert.strictEqual(
  otherBody.body.dependent.relationshipToSubscriberCode,
  'G8',
  "unrecognized relationship ('other') → G8"
);

// A single-token policyholder name → firstName only, no lastName key.
const singleName = stedi.buildSubmissionBody({
  ...base,
  insurance: {
    payer_id: '60054',
    member_id: 'W1',
    subscriber_relationship: 'child',
    subscriber_name: 'Cher',
    subscriber_dob: '1965-02-10',
  },
});
assert.strictEqual(singleName.body.subscriber.firstName, 'Cher', 'single token → firstName');
assert.ok(!('lastName' in singleName.body.subscriber), 'single token → no lastName key');

// Gender omitted from the dependent when the patient's gender is unknown.
const unknownGender = stedi.buildSubmissionBody({
  ...base,
  client: { ...base.client, gender: 'unknown' },
  insurance: {
    payer_id: '60054',
    member_id: 'W1',
    subscriber_relationship: 'child',
    subscriber_name: 'Pat Rivera',
    subscriber_dob: '1965-02-10',
  },
});
assert.ok(!('gender' in unknownGender.body.dependent), 'unknown gender → no gender key on dependent');

console.log('PASS claims_dependent.test.js');
