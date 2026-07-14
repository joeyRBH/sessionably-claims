'use strict';

// Handler-level tests for the billing-profile PUT, with a mocked lib/db, a
// stubbed NPPES fetch, and a real JWT. Covers the self-verify checklist:
//   (c) saving as an ORGANIZATION with an individual (NPI-1) NPI is BLOCKED with
//       the individual/organization mismatch message;
//   (d) the founder person flow completes: entity=person, NPI-1 verified, TIN
//       stored ENCRYPTED (never plaintext) with a masked last-4 returned.
//
//   node backend/tests/billing_profile_handler.test.js

const assert = require('node:assert');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const Module = require('node:module');

process.env.JWT_SECRET = 'test-secret-for-unit-only';
process.env.FIELD_ENCRYPTION_KEY = nodeCrypto.randomBytes(32).toString('base64');

// Canned NPPES NPI-1 (Joseph Holub) — returned for any lookup in this test.
const NPI1 = {
  enumeration_type: 'NPI-1',
  number: '1033791652',
  basic: { first_name: 'JOSEPH', last_name: 'HOLUB', credential: 'MHA, LAC, CAS', sole_proprietor: 'YES', status: 'A' },
  taxonomies: [{ code: '101YA0400X', desc: 'Counselor, Addiction (Substance Use Disorder)', license: 'ACC.0020957', primary: true, state: 'CO' }],
};

// --- mock lib/db BEFORE requiring the handler --------------------------------
let capturedUpsert = null;
function userRow() {
  return { id: 'user-1', practice_id: 'practice-1', role: 'practice_admin', first_name: 'Joseph', last_name: 'Holub', npi: '1033791652', is_active: true };
}
function practiceRow() {
  return { id: 'practice-1', name: 'BigRedd / Reddere', npi: null, tax_id: null };
}
function rowFromUpsert(p) {
  return {
    id: 'profile-1', practice_id: p[0], provider_user_id: p[1], billing_entity_type: p[2], individual_npi: p[3],
    legal_first_name: p[4], legal_last_name: p[5], billing_tin_ciphertext: p[6], billing_tin_last4: p[7], billing_tin_type: p[8],
    npi_verified: p[9], npi_verified_at: p[9] ? '2026-07-13T00:00:00Z' : null, npi_enumeration_type: p[10], sole_proprietor: p[11],
    primary_taxonomy_code: p[12], primary_taxonomy_desc: p[13], primary_taxonomy_license: p[14], primary_taxonomy_state: p[15],
    rendering_provider_required: p[16],
  };
}
const fakeClient = {
  query: async (sql, params) => {
    if (/update practices set/i.test(sql)) return { rows: [], rowCount: 1 };
    if (/insert into provider_billing_profiles/i.test(sql)) {
      capturedUpsert = params;
      return { rows: [rowFromUpsert(params)], rowCount: 1 };
    }
    throw new Error('unexpected tx query: ' + sql);
  },
};
const fakeDb = {
  query: async (sql) => {
    if (/is_active = true/i.test(sql)) return { rows: [{ practice_id: 'practice-1', role: 'practice_admin' }], rowCount: 1 };
    if (/select \* from users where id/i.test(sql)) return { rows: [userRow()], rowCount: 1 };
    if (/from practices where id/i.test(sql)) return { rows: [practiceRow()], rowCount: 1 };
    if (/from provider_billing_profiles/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/insert into audit_log/i.test(sql)) return { rows: [], rowCount: 1 };
    throw new Error('unexpected query: ' + sql);
  },
  withTransaction: async (fn) => fn(fakeClient),
};
const dbPath = require.resolve(path.join(__dirname, '..', 'lib', 'db.js'));
require.cache[dbPath] = new Module(dbPath, module);
require.cache[dbPath].filename = dbPath;
require.cache[dbPath].loaded = true;
require.cache[dbPath].exports = fakeDb;

const { sign } = require(path.join(__dirname, '..', 'lib', 'jwt.js'));
const providers = require(path.join(__dirname, '..', 'handlers', 'providers.js'));

function putEvent(body) {
  const token = sign({ id: 'user-1', practice_id: 'practice-1', role: 'practice_admin' });
  return {
    httpMethod: 'PUT',
    headers: { authorization: `Bearer ${token}` },
    pathParameters: { userId: 'user-1' },
    rawPath: '/providers/user-1/billing-profile',
    body: JSON.stringify(body),
  };
}

(async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ result_count: 1, results: [NPI1] }) });

  // (c) Organization + an individual (NPI-1) NPI → 422 guardrail block.
  const blocked = await providers.handler(putEvent({
    billing_entity_type: 'non_person_entity',
    individual_npi: '1033791652',
    org_npi: '1033791652',
  }));
  assert.strictEqual(blocked.statusCode, 422, `expected 422, got ${blocked.statusCode}: ${blocked.body}`);
  assert.match(JSON.parse(blocked.body).error, /registered to an individual/i, 'individual/organization mismatch message');
  assert.strictEqual(capturedUpsert, null, 'nothing persisted on a blocked save');

  // (d) Person flow completes: NPI-1 verified, TIN encrypted + masked.
  const ok = await providers.handler(putEvent({
    billing_entity_type: 'person',
    individual_npi: '1033791652',
    billing_tin: '86-1234567',
    billing_tin_type: 'EIN',
  }));
  assert.strictEqual(ok.statusCode, 200, `expected 200, got ${ok.statusCode}: ${ok.body}`);
  const prof = JSON.parse(ok.body).billing_profile;
  assert.strictEqual(prof.billing_entity_type, 'person');
  assert.strictEqual(prof.npi_verified, true, 'NPI-1 verified against NPPES');
  assert.strictEqual(prof.npi_enumeration_type, 'NPI-1');
  assert.strictEqual(prof.sole_proprietor, true);
  assert.strictEqual(prof.primary_taxonomy.code, '101YA0400X');
  assert.strictEqual(prof.billing_tin_last4, '4567', 'masked last-4 returned');
  assert.strictEqual(prof.billing_tin_masked, '••-•••4567');
  assert.ok(!('billing_tin' in prof) && !('billing_tin_ciphertext' in prof), 'raw/ciphertext never returned');

  // The stored TIN is ciphertext, not the plaintext digits.
  assert.ok(capturedUpsert, 'the profile was persisted');
  const storedCipher = capturedUpsert[6];
  assert.ok(storedCipher && storedCipher.startsWith('v1.'), 'TIN stored as versioned ciphertext');
  assert.ok(!storedCipher.includes('1234567'), 'plaintext TIN digits never stored');
  assert.strictEqual(capturedUpsert[7], '4567', 'last-4 persisted for display');

  global.fetch = realFetch;
  console.log('billing_profile_handler.test.js: OK');
})().catch((err) => {
  console.error('billing_profile_handler.test.js: FAIL', err);
  process.exit(1);
});
