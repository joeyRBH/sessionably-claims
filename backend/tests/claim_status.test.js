'use strict';

// Unit test — real-time claim status (276/277) request build + response parsing.
//
// Covers the getStatus() path that POST /claims/{id}/refresh drives:
//   * buildStatusBody() posts to /claimstatus/v2 with a MINIMAL, correctly shaped
//     body — YYYYMMDD begin/end dates of service, a BillingProvider, and the
//     subscriber;
//   * subscriber = the POLICYHOLDER, not the patient: a dependent claim sources the
//     subscriber from the insurance record (policyholder), not the client;
//   * a required field that is missing throws a descriptive error naming the field;
//   * a "no matching claim" HTTP 200 is a non-fatal "no update" (not an error, and
//     the claim keeps its status), while a finalized response maps to a status.
//
// The build is pure; the response cases stub global.fetch (no network).
//
//   node backend/tests/claim_status.test.js

const assert = require('node:assert');
const path = require('node:path');

const stedi = require(path.join(__dirname, '..', 'lib', 'clearinghouse', 'stedi.js'));

// --- fixtures ----------------------------------------------------------------
const practice = { name: 'Ink & Oxblood Group', npi: '1234567890' };
const clinician = { npi: '9998887770' };

// Non-dependent: the patient IS the subscriber. The payer id + billing npi are
// persisted on the claim at submit time (clearinghouse_payload) — the same values
// the 837 filed with.
const selfCtx = {
  claim: {
    control_number: 'ABC123',
    billed_amount: '135.00',
    clearinghouse_payload: { tradingPartnerServiceId: '60054', billing_npi: '1234567890' },
  },
  practice,
  clinician,
  client: { first_name: 'Jordan', last_name: 'Lee', date_of_birth: '1988-03-04', gender: 'male' },
  insurance: { payer_id: '60054', member_id: 'M100', subscriber_relationship: 'self' },
  session: { session_date: '2026-06-15' },
};

// --- 1. Self claim: correct path body, subscriber = patient, ±7-day DOS window,
//        M/F gender (required when subscriber=patient + DOB), and submittedAmount.
// DOS 2026-06-15 → begin 06-08, end 06-22 (end < today, so not capped).
const selfBuilt = stedi.buildStatusBody(selfCtx);
assert.deepStrictEqual(
  selfBuilt.body,
  {
    tradingPartnerServiceId: '60054',
    encounter: {
      beginningDateOfService: '20260608',
      endDateOfService: '20260622',
      submittedAmount: '135.00',
    },
    providers: [
      { providerType: 'BillingProvider', organizationName: 'Ink & Oxblood Group', npi: '1234567890' },
    ],
    subscriber: {
      firstName: 'Jordan', lastName: 'Lee', dateOfBirth: '19880304', memberId: 'M100', gender: 'M',
    },
  },
  'self claim: subscriber=patient; ±7-day YYYYMMDD window; gender M; submittedAmount; BillingProvider only'
);
// No dependent block ever — the base request matches on the subscriber loop.
assert.ok(!('dependent' in selfBuilt.body), 'no dependent block on a status request');

// Gender is OMITTED (not 'U') when the client gender is missing/unmappable, and
// dateOfBirth is still sent.
const noGenderBuilt = stedi.buildStatusBody({
  ...selfCtx,
  client: { first_name: 'Jordan', last_name: 'Lee', date_of_birth: '1988-03-04' },
});
assert.ok(!('gender' in noGenderBuilt.body.subscriber), 'unknown gender → gender key omitted');
assert.strictEqual(noGenderBuilt.body.subscriber.dateOfBirth, '19880304', 'dateOfBirth kept when gender omitted');
// submittedAmount is omitted when the claim carries no billed amount.
const noAmountBuilt = stedi.buildStatusBody({ ...selfCtx, claim: { ...selfCtx.claim, billed_amount: null } });
assert.ok(!('submittedAmount' in noAmountBuilt.body.encounter), 'no billed amount → submittedAmount omitted');

// --- 2. Dependent claim: subscriber = policyholder (from the insurance record) --
const depCtx = {
  ...selfCtx,
  claim: {
    control_number: 'DEP1',
    clearinghouse_payload: { tradingPartnerServiceId: '60054', billing_npi: '1234567890' },
  },
  // The patient (client) is a child; the policyholder lives on the insurance record.
  client: { first_name: 'Kiddo', last_name: 'Lee', date_of_birth: '2015-09-09' },
  insurance: {
    payer_id: '60054',
    member_id: 'M200',
    subscriber_relationship: 'child',
    subscriber_name: 'Parent Lee',
    subscriber_dob: '1980-01-02',
  },
};
const depBuilt = stedi.buildStatusBody(depCtx);
assert.deepStrictEqual(
  depBuilt.body.subscriber,
  { firstName: 'Parent', lastName: 'Lee', dateOfBirth: '19800102', memberId: 'M200' },
  'dependent claim: subscriber carries the POLICYHOLDER, not the patient'
);
assert.notStrictEqual(depBuilt.body.subscriber.firstName, 'Kiddo', 'patient is not used as the subscriber');
assert.ok(!('dependent' in depBuilt.body), 'dependent claim still sends no dependent block');

// --- 3. Missing required fields throw a descriptive, field-named error ----------
assert.throws(
  () => stedi.buildStatusBody({ ...selfCtx, session: {} }),
  /date of service/i,
  'missing DOS → descriptive error naming the field'
);
assert.throws(
  () => stedi.buildStatusBody({ ...selfCtx, insurance: { payer_id: '60054', subscriber_relationship: 'self' } }),
  /memberId/i,
  'missing member id → descriptive error naming the field'
);
assert.throws(
  () => stedi.buildStatusBody({
    ...depCtx,
    insurance: {
      payer_id: '60054', member_id: 'M2',
      subscriber_relationship: 'child', subscriber_name: 'Parent Lee',
    },
  }),
  /dateOfBirth/i,
  'dependent missing policyholder DOB → descriptive error'
);
assert.throws(
  () => stedi.buildStatusBody({
    claim: {}, practice: {}, clinician: {}, client: {}, insurance: {}, session: { session_date: '2026-06-15' },
  }),
  /tradingPartnerServiceId/i,
  'missing payer id → descriptive error naming the field'
);

// --- 4 & 5. Response parsing (stub global.fetch — no network) --------------------
const realFetch = global.fetch;
const hadKey = Object.prototype.hasOwnProperty.call(process.env, 'STEDI_API_KEY');
const realKey = process.env.STEDI_API_KEY;
process.env.STEDI_API_KEY = 'test-key';

function stubFetch(body, ok, statusNum) {
  global.fetch = async () => ({
    ok: ok === undefined ? true : ok,
    status: statusNum === undefined ? 200 : statusNum,
    json: async () => body,
  });
}

(async () => {
  const call = () => stedi.getStatus({ control_number: 'ABC123', claim: selfCtx.claim, ctx: selfCtx });

  // 4a. Empty claims array (HTTP 200) → no update, not an error.
  stubFetch({ claims: [] });
  let r = await call();
  assert.strictEqual(r.no_update, true, 'empty claims (HTTP 200) → no_update, not an error');

  // 4b. Explicit "Not Found" category (A4) → no update, not an error.
  stubFetch({ claims: [{ claimStatus: { statusCategoryCode: 'A4', statusCategoryCodeValue: 'Not Found' } }] });
  r = await call();
  assert.strictEqual(r.no_update, true, 'A4 not-found category → no_update');

  // 5a. Finalized/Denial (F2) → denied, derived from the category code.
  stubFetch({ claims: [{ claimStatus: { statusCategoryCode: 'F2', statusCategoryCodeValue: 'Finalized/Denial' } }] });
  r = await call();
  assert.strictEqual(r.status, 'denied', 'F2 finalized/denial → denied');
  assert.ok(!r.no_update, 'a real status is not a no_update');

  // 5b. Finalized/Payment (F1) → paid.
  stubFetch({ claims: [{ claimStatus: { statusCategoryCode: 'F1', statusCategoryCodeValue: 'Finalized/Payment' } }] });
  r = await call();
  assert.strictEqual(r.status, 'paid', 'F1 finalized/payment → paid');

  // 5c. Pending (P1) → processing.
  stubFetch({ claims: [{ claimStatus: { statusCategoryCode: 'P1', statusCategoryCodeValue: 'Pending' } }] });
  r = await call();
  assert.strictEqual(r.status, 'processing', 'P1 pending → processing');

  // 6. A genuine upstream failure (non-2xx) still throws — the handler maps it to 502.
  stubFetch({ error: 'boom' }, false, 500);
  await assert.rejects(call, /status check failed/i, 'HTTP 500 → throws (handler returns 502)');

  global.fetch = realFetch;
  if (hadKey) process.env.STEDI_API_KEY = realKey; else delete process.env.STEDI_API_KEY;

  console.log('PASS claim_status.test.js');
})().catch((err) => {
  global.fetch = realFetch;
  console.error(err);
  process.exit(1);
});
