'use strict';

// NPPES lookup: normalizer, entity-type guardrail, and the verifyNpi transport
// (with a stubbed global.fetch). Pure logic — no network, no DB.
//
//   node backend/tests/verify_npi.test.js

const assert = require('node:assert');
const path = require('node:path');
const nppes = require(path.join(__dirname, '..', 'lib', 'nppes.js'));

// Canned NPPES payloads mirroring the real v2.1 response shape.
const NPI1 = {
  enumeration_type: 'NPI-1',
  number: '1033791652',
  basic: {
    first_name: 'JOSEPH',
    last_name: 'HOLUB',
    credential: 'MHA, LAC, CAS',
    sole_proprietor: 'YES',
    status: 'A',
  },
  taxonomies: [
    { code: '101YA0400X', desc: 'Counselor, Addiction (Substance Use Disorder)', license: 'ACC.0020957', primary: true, state: 'CO' },
    { code: '101YA0400X', desc: 'Counselor, Addiction (Substance Use Disorder)', license: 'BBH-LAC', primary: false, state: 'MT' },
  ],
};
const NPI2 = {
  enumeration_type: 'NPI-2',
  number: '1234567893',
  basic: { organization_name: 'BUFFALO PSYCHIATRIC CENTER', status: 'A' },
  taxonomies: [{ code: '283Q00000X', desc: 'Psychiatric Hospital', license: '003406-1', primary: true, state: 'NY' }],
};

// --- 1. normalizeNppes (person / NPI-1) --------------------------------------
const n1 = nppes.normalizeNppes(NPI1);
assert.strictEqual(n1.enumerationType, 'NPI-1');
assert.strictEqual(n1.entityType, 'person');
assert.strictEqual(n1.name.firstName, 'JOSEPH');
assert.strictEqual(n1.name.lastName, 'HOLUB');
assert.strictEqual(n1.name.credential, 'MHA, LAC, CAS');
assert.strictEqual(n1.soleProprietor, true);
assert.strictEqual(n1.active, true);
assert.deepStrictEqual(n1.primaryTaxonomy, {
  code: '101YA0400X',
  desc: 'Counselor, Addiction (Substance Use Disorder)',
  license: 'ACC.0020957',
  state: 'CO',
}, 'picks the primary taxonomy only');

// --- 2. normalizeNppes (organization / NPI-2) --------------------------------
const n2 = nppes.normalizeNppes(NPI2);
assert.strictEqual(n2.enumerationType, 'NPI-2');
assert.strictEqual(n2.entityType, 'non_person_entity');
assert.strictEqual(n2.name.organizationName, 'BUFFALO PSYCHIATRIC CENTER');
assert.strictEqual(n2.soleProprietor, false, 'no sole_proprietor field → false');
assert.strictEqual(n2.primaryTaxonomy.code, '283Q00000X');

// --- 3. Entity-type guardrail ------------------------------------------------
// Matching selections pass.
assert.strictEqual(nppes.checkEntityTypeGuardrail('person', n1).ok, true);
assert.strictEqual(nppes.checkEntityTypeGuardrail('individual', n1).ok, true);
assert.strictEqual(nppes.checkEntityTypeGuardrail('organization', n2).ok, true);
assert.strictEqual(nppes.checkEntityTypeGuardrail('non_person_entity', n2).ok, true);

// Self-verify (c): selecting "organization" with an individual (NPI-1) is blocked
// with the individual/organization mismatch message.
const gc = nppes.checkEntityTypeGuardrail('organization', n1);
assert.strictEqual(gc.ok, false);
assert.match(gc.message, /registered to an individual/i);
assert.match(gc.message, /JOSEPH HOLUB/);
assert.match(gc.message, /Type-2 NPI/);

// Converse: selecting "individual" with an organization (NPI-2) is blocked.
const gi = nppes.checkEntityTypeGuardrail('individual', n2);
assert.strictEqual(gi.ok, false);
assert.match(gi.message, /registered to an organization/i);
assert.match(gi.message, /Type-1 NPI/);

// --- 4. NPI format + checksum ------------------------------------------------
assert.strictEqual(nppes.isValidNpiFormat('1033791652'), true);
assert.strictEqual(nppes.isValidNpiFormat('123'), false);
assert.strictEqual(nppes.isValidNpiFormat('abcdefghij'), false);
assert.strictEqual(nppes.hasValidNpiChecksum('1033791652'), true, 'real NPI passes the Luhn check');
assert.strictEqual(nppes.hasValidNpiChecksum('1033791653'), false, 'wrong check digit fails');

// --- 5. verifyNpi over a stubbed fetch ---------------------------------------
(async () => {
  const realFetch = global.fetch;

  // 5a. Found NPI-1.
  global.fetch = async () => ({ ok: true, json: async () => ({ result_count: 1, results: [NPI1] }) });
  let r = await nppes.verifyNpi('1033791652');
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.enumerationType, 'NPI-1');
  assert.strictEqual(r.entityType, 'person');

  // 5b. Found NPI-2.
  global.fetch = async () => ({ ok: true, json: async () => ({ result_count: 1, results: [NPI2] }) });
  r = await nppes.verifyNpi('1234567893');
  assert.strictEqual(r.entityType, 'non_person_entity');

  // 5c. Reachable, no match (result_count 0).
  global.fetch = async () => ({ ok: true, json: async () => ({ result_count: 0, results: [] }) });
  r = await nppes.verifyNpi('1111111111');
  assert.strictEqual(r.found, false);

  // 5d. Bad format never hits the network.
  await assert.rejects(() => nppes.verifyNpi('123'), /10 digits/i);

  // 5e. Transport failure → NppesUnreachableError (retryable), not a "not found".
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(() => nppes.verifyNpi('1033791652'), (e) => e.name === 'NppesUnreachableError' && e.retryable === true);

  // 5f. 5xx from NPPES is an outage, not a not-found.
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(() => nppes.verifyNpi('1033791652'), (e) => e.name === 'NppesUnreachableError');

  global.fetch = realFetch;
  console.log('verify_npi.test.js: OK');
})().catch((err) => {
  console.error('verify_npi.test.js: FAIL', err);
  process.exit(1);
});
