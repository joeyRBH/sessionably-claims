'use strict';

// The 837P builder reads the per-clinician billing profile to construct the
// billing- and rendering-provider loops — no hardcoded entity type.
//   * person            → billing = individual (name + NPI + TIN); no rendering.
//   * non_person_entity → billing = organization (practice); rendering = individual.
//   * no profile        → legacy organizational billing from the practice.
//
//   node backend/tests/billing_profile_claim.test.js

const assert = require('node:assert');
const path = require('node:path');
const stedi = require(path.join(__dirname, '..', 'lib', 'clearinghouse', 'stedi.js'));

const practice = {
  name: 'Ink & Oxblood Group',
  npi: '1902330049',                 // (org) NPI-2 in production; value only matters as a string here
  tax_id: '84-1234567',
  address_line1: '75 Manhattan Dr',
  city: 'Boulder', state: 'CO', postal_code: '80303',
};
const clinician = { npi: '1033791652', first_name: 'Joseph', last_name: 'Holub' };
const client = { first_name: 'Alex', last_name: 'Doe', date_of_birth: '1990-04-12', gender: 'male' };
const insurance = { payer_id: '60054', carrier_name: 'Aetna', member_id: 'M100', subscriber_relationship: 'self' };
const session = { session_date: '2026-06-15', cpt_code: '90837', diagnosis_codes: ['F411'] };
const claim = { id: 'claim-1', billed_amount: '150.00' };

function baseCtx(billingProfile) {
  return { claim, insurance, client, clinician, practice, session, billingProfile };
}

// --- 1. Person billing profile → individual billing provider, no rendering ---
const personProfile = {
  billing_entity_type: 'person',
  individual_npi: '1033791652',
  legal_first_name: 'Joseph',
  legal_last_name: 'Holub',
  billing_tin: '861234567',
  billing_tin_type: 'EIN',
};
const person = stedi.buildSubmissionBody(baseCtx(personProfile));
assert.strictEqual(person.body.billing.providerType, 'BillingProvider');
assert.strictEqual(person.body.billing.npi, '1033791652', 'person billing NPI = individual NPI');
assert.strictEqual(person.body.billing.firstName, 'Joseph');
assert.strictEqual(person.body.billing.lastName, 'Holub');
assert.strictEqual(person.body.billing.employerId, '861234567', 'EIN → employerId (digits only)');
assert.ok(!('organizationName' in person.body.billing), 'person billing has no organizationName');
assert.ok(!('rendering' in person.body), 'person mode sends NO rendering provider');
assert.strictEqual(person.billingNpi, '1033791652');

// Person with an SSN → ssn field instead of employerId.
const ssnPerson = stedi.buildSubmissionBody(baseCtx({ ...personProfile, billing_tin: '078051120', billing_tin_type: 'SSN' }));
assert.strictEqual(ssnPerson.body.billing.ssn, '078051120', 'SSN → ssn field');
assert.ok(!('employerId' in ssnPerson.body.billing), 'SSN person has no employerId');

// --- 2. Organization profile → org billing provider + rendering loop ---------
const orgProfile = {
  billing_entity_type: 'non_person_entity',
  individual_npi: '1033791652',
  legal_first_name: 'Joseph',
  legal_last_name: 'Holub',
  rendering_provider_required: true,
};
const org = stedi.buildSubmissionBody(baseCtx(orgProfile));
assert.strictEqual(org.body.billing.organizationName, 'Ink & Oxblood Group', 'org billing = practice name');
assert.strictEqual(org.body.billing.npi, '1902330049', 'org billing NPI = practice NPI');
assert.strictEqual(org.body.billing.employerId, '84-1234567', 'org billing EIN = practice tax_id');
assert.ok(!('firstName' in org.body.billing), 'org billing provider has no person name');
assert.ok(org.body.rendering, 'org mode sends a rendering provider');
assert.strictEqual(org.body.rendering.providerType, 'RenderingProvider');
assert.strictEqual(org.body.rendering.npi, '1033791652', 'rendering NPI = individual clinician NPI');
assert.strictEqual(org.body.rendering.firstName, 'Joseph');
assert.strictEqual(org.body.rendering.lastName, 'Holub');

// --- 3. No profile → legacy organizational billing (unchanged behavior) ------
const legacy = stedi.buildSubmissionBody(baseCtx(null));
assert.strictEqual(legacy.body.billing.organizationName, 'Ink & Oxblood Group');
assert.strictEqual(legacy.body.billing.npi, '1902330049', 'legacy billing NPI = practice.npi');
assert.ok(!('rendering' in legacy.body), 'legacy mode sends no rendering provider');

// --- 4. Status body mirrors the same billing provider ------------------------
const statusPerson = stedi.buildStatusBody(baseCtx(personProfile));
assert.strictEqual(statusPerson.body.providers[0].npi, '1033791652');
assert.strictEqual(statusPerson.body.providers[0].lastName, 'Holub', 'person status provider carries the name');
assert.ok(!('organizationName' in statusPerson.body.providers[0]), 'person status provider has no org name');

const statusOrg = stedi.buildStatusBody(baseCtx(orgProfile));
assert.strictEqual(statusOrg.body.providers[0].organizationName, 'Ink & Oxblood Group', 'org status provider = org name');
assert.strictEqual(statusOrg.body.providers[0].npi, '1902330049');

console.log('billing_profile_claim.test.js: OK');
