'use strict';

// Unit test — 837P usageIndicator (test 'T' vs production 'P') on the CLAIMS path.
//
// The builder previously never emitted usageIndicator at all, so every claim it
// produced relied on Stedi's implicit default and there was no way to file a test
// claim. The field is now always set explicitly, because both mistakes are silent
// and expensive:
//
//   * a 'T' that escapes to production is never adjudicated AND never rejected —
//     the practice just never gets paid, with nothing to alert anyone.
//   * a missing 'T' during testing files synthetic patient data as a real claim
//     against a real payer.
//
// So the assertions below are about DISCIPLINE, not just the happy path: the
// field is present on every shape, it is 'P' by default, it is only ever 'T' or
// 'P', and 'T' is reachable ONLY through the operator-set env gates — never from
// anything a practice user controls.
//
// Pure (no network, no DB).
//
//   node backend/tests/claim_usage_indicator.test.js

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

// Run fn with the given env vars set, then restore whatever was there before —
// including "was not set at all", which is the production shape and must not be
// left as an empty string by the test harness.
const ENV_KEYS = ['STEDI_ALLOW_TEST_SUBMISSIONS', 'STEDI_FORCE_TEST_SUBMISSIONS'];
function withEnv(vars, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = Object.prototype.hasOwnProperty.call(process.env, k)
    ? process.env[k]
    : undefined;
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const k of Object.keys(vars)) {
      if (vars[k] !== undefined) process.env[k] = vars[k];
    }
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// Guard the guard: if the ambient environment already opts into test mode, every
// "default is P" assertion below would be vacuously wrong rather than failing for
// a real reason. Fail loudly instead of quietly testing nothing.
for (const k of ENV_KEYS) {
  assert.ok(
    !process.env[k],
    `${k} must not be set while running this test — it would mask the production default`
  );
}

// --- 1. Default is production ------------------------------------------------

assert.strictEqual(
  build({}).usageIndicator,
  'P',
  'default build is a PRODUCTION claim'
);
assert.strictEqual(
  withEnv({}, () => build({})).usageIndicator,
  'P',
  'no env gates set → production'
);

// A ctx that asks for a test submission is NOT enough on its own: without the
// environment opt-in it still builds a production claim. This is the case that
// matters most — it is what stops a forged or stale `test_submission` flag from
// turning a real claim into an unadjudicated one.
assert.strictEqual(
  withEnv({}, () => build({ testSubmission: true })).usageIndicator,
  'P',
  'testSubmission alone, with no env opt-in, still builds a PRODUCTION claim'
);

// --- 2. The test path yields 'T' ---------------------------------------------

assert.strictEqual(
  withEnv({ STEDI_ALLOW_TEST_SUBMISSIONS: 'true' }, () =>
    build({ testSubmission: true })).usageIndicator,
  'T',
  'env opt-in + explicit request → TEST claim'
);

// The per-request opt-in must be exactly `true`. Anything else — a truthy string
// from a JSON body, a stray 1 — is not an explicit request.
for (const loose of ['true', 1, 'yes', {}, [], 'T']) {
  assert.strictEqual(
    withEnv({ STEDI_ALLOW_TEST_SUBMISSIONS: 'true' }, () =>
      build({ testSubmission: loose })).usageIndicator,
    'P',
    `non-boolean testSubmission (${JSON.stringify(loose)}) does not produce a test claim`
  );
}

// Env opt-in WITHOUT a request is still production: enabling the gate on a
// deployment does not turn its ordinary traffic into test claims.
assert.strictEqual(
  withEnv({ STEDI_ALLOW_TEST_SUBMISSIONS: 'true' }, () => build({})).usageIndicator,
  'P',
  'allow-gate set but nothing requested → production'
);

// --- 3. A non-production deployment can never emit a production claim ---------

assert.strictEqual(
  withEnv({ STEDI_FORCE_TEST_SUBMISSIONS: 'true' }, () => build({})).usageIndicator,
  'T',
  'forced test environment: an ordinary claim goes out as TEST'
);
assert.strictEqual(
  withEnv({ STEDI_FORCE_TEST_SUBMISSIONS: 'true' }, () =>
    build({ testSubmission: false })).usageIndicator,
  'T',
  'forced test environment: an explicit testSubmission:false cannot override it'
);

// Only the literal string 'true' arms either gate — a var left as '', 'false',
// or '0' by a deploy template must not silently flip a whole environment.
for (const off of ['', 'false', '0', 'no', 'TRUE ']) {
  assert.strictEqual(
    withEnv({ STEDI_FORCE_TEST_SUBMISSIONS: off }, () => build({})).usageIndicator,
    off.trim().toLowerCase() === 'true' ? 'T' : 'P',
    `STEDI_FORCE_TEST_SUBMISSIONS=${JSON.stringify(off)} arms the gate only when it means true`
  );
}

// --- 4. Always present, never anything but T or P ----------------------------
// Across every builder shape, not just the ordinary one: dependent claims, the
// person and organization billing-profile branches, and a claim with no service
// line all carry the field.

const shapes = {
  ordinary: {},
  dependent: {
    insurance: { ...base.insurance, subscriber_relationship: 'child', subscriber_name: 'Alex Rivera', subscriber_dob: '1980-02-03' },
  },
  personBillingProfile: {
    billingProfile: { billing_entity_type: 'person', individual_npi: '1987654320', legal_first_name: 'Dana', legal_last_name: 'Cruz' },
  },
  orgBillingProfile: {
    billingProfile: { billing_entity_type: 'non_person_entity', individual_npi: '1987654320', legal_first_name: 'Dana', legal_last_name: 'Cruz' },
  },
  noServiceLine: { session: { session_date: '2026-06-01', diagnosis_codes: ['F411'] } },
  groupNumber: { insurance: { ...base.insurance, group_number: 'GRP-9' } },
};

for (const [label, over] of Object.entries(shapes)) {
  for (const [envLabel, vars] of Object.entries({
    production: {},
    allowed: { STEDI_ALLOW_TEST_SUBMISSIONS: 'true' },
    forced: { STEDI_FORCE_TEST_SUBMISSIONS: 'true' },
  })) {
    const body = withEnv(vars, () => build(over));
    assert.ok(
      Object.prototype.hasOwnProperty.call(body, 'usageIndicator'),
      `${label} / ${envLabel}: usageIndicator is present`
    );
    assert.ok(
      body.usageIndicator === 'T' || body.usageIndicator === 'P',
      `${label} / ${envLabel}: usageIndicator is exactly 'T' or 'P' (got ${JSON.stringify(body.usageIndicator)})`
    );
  }
}

// It is a TOP-LEVEL field (per Stedi's test-claims workflow docs), not nested on
// claimInformation — a usageIndicator in the wrong place is ignored, which means
// a claim meant as a test would quietly be filed for real.
const ordinary = build({});
assert.strictEqual(
  ordinary.claimInformation.usageIndicator,
  undefined,
  'usageIndicator is top-level, not on claimInformation'
);

// --- 5. resolveUsageIndicator in isolation -----------------------------------

assert.strictEqual(withEnv({}, () => stedi.resolveUsageIndicator(null)), 'P', 'null ctx → P');
assert.strictEqual(withEnv({}, () => stedi.resolveUsageIndicator({})), 'P', 'empty ctx → P');

// --- 6. testSubmissionsAllowed gates the handler -----------------------------
// The submit handler asks this BEFORE submitting so a test request the
// environment forbids is refused outright rather than filed as a real claim.

assert.strictEqual(
  withEnv({}, () => stedi.testSubmissionsAllowed()),
  false,
  'no env gates → test submissions are not allowed'
);
assert.strictEqual(
  withEnv({ STEDI_ALLOW_TEST_SUBMISSIONS: 'true' }, () => stedi.testSubmissionsAllowed()),
  true,
  'allow-gate → test submissions are allowed'
);
assert.strictEqual(
  withEnv({ STEDI_FORCE_TEST_SUBMISSIONS: 'true' }, () => stedi.testSubmissionsAllowed()),
  true,
  'forced test environment → test submissions are allowed'
);

// The adapters that cannot file a Stedi test claim must not claim they can.
for (const adapterName of ['mock', 'claim_md']) {
  const adapter = require(path.join(__dirname, '..', 'lib', 'clearinghouse', `${adapterName}.js`));
  assert.strictEqual(
    typeof adapter.testSubmissionsAllowed,
    'undefined',
    `${adapterName} adapter does not advertise test submissions`
  );
}

console.log('claim_usage_indicator.test.js: all assertions passed');
