'use strict';

// Unit tests — payer ERA enrollment adapter (backend/lib/clearinghouse/stedi.js)
// and handler (backend/handlers/payer_enrollments.js).
//
// Covers:
//   * adapter request shapes for ensureEnrollmentProvider / createPayerEnrollment
//     / getEnrollmentStatus (tax id digits-only; enrollment body matches the
//     documented shape exactly);
//   * handler 422 when the practice profile is missing required fields;
//   * import idempotency: the same stedi_enrollment_id seen twice → one row.
//
// No network, no real DB: global.fetch and the db/auth modules are stubbed. Tests
// run sequentially (they share global.fetch and an in-memory table).
//
//   node backend/tests/payer_enrollments.test.js

const assert = require('node:assert');
const path = require('node:path');

process.env.STEDI_API_KEY = 'test-key';

const stedi = require(path.join(__dirname, '..', 'lib', 'clearinghouse', 'stedi.js'));

const ENROLLMENTS_BASE = 'https://enrollments.us.stedi.com/2024-09-01';

// Install a fetch stub that records calls and returns `response`.
function stubFetch(response) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: response.ok !== false,
      status: response.status != null ? response.status : 200,
      json: async () => (response.body != null ? response.body : {}),
    };
  };
  return calls;
}

const CONTACT = {
  firstName: 'Ada',
  lastName: 'Admin',
  email: 'ada@practice.example',
  phone: '5551234567',
  streetAddress1: '1 Main St',
  city: 'Austin',
  state: 'TX',
  zipCode: '78701',
};

// --- handler wiring: patch auth before requiring the handler -----------------

const CALLER_ID = '11111111-1111-1111-1111-111111111111';
const PRACTICE_ID = '22222222-2222-2222-2222-222222222222';

const authLib = require(path.join(__dirname, '..', 'lib', 'auth.js'));
authLib.requireAuth = () => ({ user: { sub: CALLER_ID } });

const dbLib = require(path.join(__dirname, '..', 'lib', 'db.js'));
const stediLib = require(path.join(__dirname, '..', 'lib', 'clearinghouse', 'stedi.js'));
const handler = require(path.join(__dirname, '..', 'handlers', 'payer_enrollments.js')).handler;

// A tiny in-memory payer_enrollments table honoring ON CONFLICT
// (stedi_enrollment_id) DO NOTHING. state.practice / state.caller are per-test.
const state = { practice: null, caller: null, table: [] };
let seq = 0;

function installDbStub() {
  dbLib.query = async (text, params) => {
    const t = String(text);
    if (/from users where id = \$1/.test(t)) {
      return { rows: state.caller ? [state.caller] : [], rowCount: state.caller ? 1 : 0 };
    }
    if (/from practices where id = \$1/.test(t)) {
      return { rows: state.practice ? [state.practice] : [], rowCount: state.practice ? 1 : 0 };
    }
    if (/select 1 from payer_enrollments/.test(t)) {
      const [pid, payerId, txn] = params;
      const hit = state.table.some(
        (r) => r.practice_id === pid && r.payer_id === payerId && r.transaction_type === txn
      );
      return { rows: hit ? [{}] : [], rowCount: hit ? 1 : 0 };
    }
    if (/insert into payer_enrollments/.test(t)) {
      const stediId = params[4];
      const conflict = /on conflict/.test(t);
      if (conflict && stediId && state.table.some((r) => r.stedi_enrollment_id === stediId)) {
        return { rows: [], rowCount: 0 }; // DO NOTHING
      }
      const row = {
        id: `row_${++seq}`,
        practice_id: params[0],
        payer_id: params[1],
        payer_name: params[2],
        transaction_type: params[3],
        stedi_enrollment_id: stediId,
        status: params[5],
        status_reason: params.length > 6 ? params[6] : null,
        last_synced_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      };
      state.table.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (/select \* from payer_enrollments where practice_id = \$1/.test(t)) {
      const rows = state.table.filter((r) => r.practice_id === params[0]);
      return { rows, rowCount: rows.length };
    }
    if (/update practices set stedi_provider_id/.test(t)) {
      if (state.practice) state.practice.stedi_provider_id = params[0];
      return { rows: [], rowCount: 1 };
    }
    if (/insert into audit_log/.test(t)) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
}

const postEvent = (body) => ({ requestContext: { http: { method: 'POST' } }, body: JSON.stringify(body) });
const getEvent = () => ({ requestContext: { http: { method: 'GET' } } });

// --- tests -------------------------------------------------------------------

async function testEnsureProvider() {
  const calls = stubFetch({ status: 201, body: { id: 'prov_123' } });
  const practice = {
    name: 'Riverstone Behavioral',
    npi: '1234567890',
    tax_id: '12-3456789',      // dashed on purpose — must be stripped
    stedi_provider_id: null,
  };
  const id = await stedi.ensureEnrollmentProvider(practice, CONTACT);

  assert.strictEqual(id, 'prov_123');
  assert.strictEqual(calls.length, 1, 'one POST /providers call');
  assert.strictEqual(calls[0].url, `${ENROLLMENTS_BASE}/providers`);
  assert.strictEqual(calls[0].opts.method, 'POST');
  assert.strictEqual(calls[0].opts.headers.Authorization, 'test-key');

  const body = JSON.parse(calls[0].opts.body);
  assert.strictEqual(body.name, 'Riverstone Behavioral');
  assert.strictEqual(body.npi, '1234567890');
  assert.strictEqual(body.taxIdType, 'EIN');
  assert.strictEqual(body.taxId, '123456789', 'tax id digits only (dashes stripped)');
  assert.strictEqual(body.contacts.length, 1);
  assert.deepStrictEqual(body.contacts[0], CONTACT, 'contact matches documented shape');
  console.log('PASS ensureEnrollmentProvider (POST /providers shape)');
}

async function testEnsureProviderReuse() {
  let called = false;
  global.fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };
  const id = await stedi.ensureEnrollmentProvider(
    { stedi_provider_id: 'prov_existing', npi: '1', tax_id: '2' }, CONTACT
  );
  assert.strictEqual(id, 'prov_existing');
  assert.strictEqual(called, false, 'no network call when provider id already present');
  console.log('PASS ensureEnrollmentProvider (reuse existing id)');
}

async function testCreateEnrollment() {
  const calls = stubFetch({ status: 201, body: { id: 'enr_555', status: 'STEDI_ACTION_REQUIRED' } });
  const out = await stedi.createPayerEnrollment({
    providerId: 'prov_123',
    payerIdOrAlias: '60054',
    contact: CONTACT,
    userEmail: 'ada@practice.example',
  });

  assert.deepStrictEqual(out, { id: 'enr_555', status: 'STEDI_ACTION_REQUIRED' });
  assert.strictEqual(calls[0].url, `${ENROLLMENTS_BASE}/enrollments`);
  assert.strictEqual(calls[0].opts.method, 'POST');

  const body = JSON.parse(calls[0].opts.body);
  assert.deepStrictEqual(body, {
    transactions: { claimPayment: { enroll: true } },
    primaryContact: CONTACT,
    userEmail: 'ada@practice.example',
    payer: { idOrAlias: '60054' },
    provider: { id: 'prov_123' },
    status: 'STEDI_ACTION_REQUIRED',
  }, 'enrollment body matches the documented shape exactly');
  console.log('PASS createPayerEnrollment (POST /enrollments shape)');
}

async function testGetStatus() {
  const calls = stubFetch({
    status: 200,
    body: { status: 'PROVIDER_ACTION_REQUIRED', reason: 'Complete the payer form.' },
  });
  const out = await stedi.getEnrollmentStatus('enr_555');
  assert.deepStrictEqual(out, { status: 'PROVIDER_ACTION_REQUIRED', reason: 'Complete the payer form.' });
  assert.strictEqual(calls[0].url, `${ENROLLMENTS_BASE}/enrollments/enr_555`);
  assert.strictEqual(calls[0].opts.method, 'GET');
  console.log('PASS getEnrollmentStatus (GET /enrollments/{id})');
}

async function testHandler422() {
  installDbStub();
  state.table = [];
  state.caller = {
    id: CALLER_ID, practice_id: PRACTICE_ID, role: 'practice_admin',
    first_name: 'Ada', last_name: 'Admin', email: 'ada@practice.example', is_active: true,
  };
  state.practice = { id: PRACTICE_ID, name: 'Riverstone', is_active: true }; // missing npi/tax_id/address

  const res = await handler(postEvent({ payer_id: '60054', payer_name: 'Aetna' }));
  assert.strictEqual(res.statusCode, 422, '422 when practice profile incomplete');
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.missing_fields), 'missing_fields listed');
  assert.ok(body.missing_fields.includes('NPI'), 'NPI flagged');
  assert.ok(body.missing_fields.includes('Tax ID (EIN)'), 'Tax ID flagged');
  assert.ok(body.missing_fields.includes('Practice address'), 'address flagged');
  console.log('PASS handler 422 (missing practice fields)');
}

// A List Enrollments item shaped per the spec: payer.submittedPayerIdOrAlias /
// stediPayerId / name, provider.npi / taxId, transactions.claimPayment.enroll.
function remoteItem(overrides) {
  return Object.assign({
    id: 'ENR_AETNA',
    status: 'PROVISIONING',
    reason: null,
    payer: { submittedPayerIdOrAlias: '60054', stediPayerId: 'AETNA', name: 'Aetna' },
    provider: { npi: '1234567890', taxId: '123456789' },
    transactions: { claimPayment: { enroll: true } },
  }, overrides || {});
}

const IMPORT_PRACTICE = {
  id: PRACTICE_ID, name: 'Riverstone', is_active: true,
  npi: '1234567890', tax_id: '12-3456789',   // dashed; digits match provider.taxId
  address_line1: '1 Main St', city: 'Austin', state: 'TX', postal_code: '78701',
  stedi_provider_id: 'prov_123',
};

function resetImportState(practice) {
  installDbStub();
  state.table = [];
  state.caller = {
    id: CALLER_ID, practice_id: PRACTICE_ID, role: 'practice_admin',
    first_name: 'Ada', last_name: 'Admin', email: 'ada@practice.example', is_active: true,
  };
  state.practice = practice || IMPORT_PRACTICE;
  stediLib.getEnrollmentStatus = async () => ({ status: 'PROVISIONING', reason: null });
}

// The adapter's real listEnrollments builds the query string; assert it uses the
// plural param names. Runs before the import tests overwrite the module function.
async function testListEnrollmentsUrl() {
  const calls = stubFetch({ status: 200, body: { items: [] } });
  await stedi.listEnrollments({ npi: '1234567890', taxId: '12-3456789' });
  assert.strictEqual(calls.length, 1);
  const url = calls[0].url;
  assert.ok(/[?&]providerNpis=1234567890(&|$)/.test(url), 'providerNpis in query: ' + url);
  assert.ok(/[?&]providerTaxIds=123456789(&|$)/.test(url), 'providerTaxIds (digits) in query: ' + url);
  assert.strictEqual(calls[0].opts.method, 'GET');
  console.log('PASS listEnrollments (providerNpis / providerTaxIds query)');
}

async function testImportIdempotency() {
  resetImportState();
  stediLib.listEnrollments = async () => ([remoteItem()]);

  const first = await handler(getEvent());
  assert.strictEqual(first.statusCode, 200);
  const firstBody = JSON.parse(first.body);
  assert.strictEqual(firstBody.payer_enrollments.length, 1, 'imported once');
  assert.strictEqual(firstBody.payer_enrollments[0].payer_id, '60054', 'payer id from submittedPayerIdOrAlias');
  assert.strictEqual(firstBody.payer_enrollments[0].payer_name, 'Aetna', 'payer name from payer.name');
  assert.strictEqual(firstBody.sync_error, false, 'no sync error');

  const second = await handler(getEvent());
  const secondBody = JSON.parse(second.body);
  assert.strictEqual(secondBody.payer_enrollments.length, 1, 'still one row (idempotent import)');
  assert.strictEqual(state.table.length, 1, 'in-memory table has exactly one row');
  console.log('PASS handler import idempotency (same stedi_enrollment_id → one row)');
}

async function testImportProviderMismatchSkipped() {
  resetImportState();
  // Same practice, but the remote enrollment belongs to a DIFFERENT provider NPI.
  stediLib.listEnrollments = async () => ([
    remoteItem({ id: 'ENR_OTHER', provider: { npi: '9999999999', taxId: '123456789' } }),
  ]);

  const res = await handler(getEvent());
  const body = JSON.parse(res.body);
  assert.strictEqual(body.payer_enrollments.length, 0, 'mismatched-provider enrollment is NOT imported');
  assert.strictEqual(state.table.length, 0, 'identity guard blocks the cross-import');
  console.log('PASS handler import skips provider-NPI mismatch (no cross-import)');
}

async function testImportNonClaimPaymentSkipped() {
  resetImportState();
  // Matching provider, but not an ERA (claimPayment) enrollment.
  stediLib.listEnrollments = async () => ([
    remoteItem({ id: 'ENR_STATUS', transactions: { claimStatus: { enroll: true } } }),
    remoteItem({ id: 'ENR_FALSE', transactions: { claimPayment: { enroll: false } } }),
  ]);

  const res = await handler(getEvent());
  const body = JSON.parse(res.body);
  assert.strictEqual(body.payer_enrollments.length, 0, 'non-claimPayment enrollments are NOT imported');
  assert.strictEqual(state.table.length, 0, 'only ERA enrollments import');
  console.log('PASS handler import skips non-claimPayment enrollments');
}

(async function main() {
  await testEnsureProvider();
  await testEnsureProviderReuse();
  await testCreateEnrollment();
  await testGetStatus();
  await testHandler422();
  await testListEnrollmentsUrl();
  await testImportIdempotency();
  await testImportProviderMismatchSkipped();
  await testImportNonClaimPaymentSkipped();
  console.log('PASS payer_enrollments.test.js');
})().catch((err) => {
  console.error('FAIL payer_enrollments.test.js');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
