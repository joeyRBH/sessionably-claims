'use strict';

// Unit test — VOB dependent support + three-state coverage status.
//
//   * checkEligibility() request shape: patient-as-subscriber (unchanged from the
//     original) vs. patient-as-dependent (policyholder in `subscriber`, patient in
//     `dependents`).
//   * deriveActive() three states, exercised through the exported
//     normalizeEligibility(): active → true, explicit inactive → false, and an
//     inconclusive 271 → null (the bug fix — was previously false).
//
// Pure-ish: no DB. checkEligibility POSTs, so we stub global.fetch to capture the
// request body instead of hitting the network.
//
//   node backend/tests/vob_dependents.test.js

const assert = require('node:assert');
const path = require('node:path');

const stedi = require(path.join(__dirname, '..', 'lib', 'clearinghouse', 'stedi.js'));
const vob = require(path.join(__dirname, '..', 'handlers', 'vob.js'));

// --- checkEligibility request shape ------------------------------------------

async function captureRequest(params) {
  const prevKey = process.env.STEDI_API_KEY;
  const prevFetch = global.fetch;
  process.env.STEDI_API_KEY = 'test-key';
  let captured = null;
  global.fetch = async (_url, opts) => {
    captured = JSON.parse(opts.body);
    return { ok: true, json: async () => ({}) };
  };
  try {
    await stedi.checkEligibility(params);
  } finally {
    global.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.STEDI_API_KEY;
    else process.env.STEDI_API_KEY = prevKey;
  }
  return captured;
}

(async () => {
  // Patient IS the subscriber → no `dependents`, patient demographics in subscriber.
  const asSubscriber = await captureRequest({
    payerId: '60054',
    memberId: 'W123456789',
    firstName: 'Jamie',
    lastName: 'Rivera',
    dateOfBirth: '1990-05-04',
  });
  assert.ok(!('dependents' in asSubscriber), 'no dependents when patient is subscriber');
  assert.deepStrictEqual(asSubscriber.subscriber, {
    memberId: 'W123456789',
    firstName: 'Jamie',
    lastName: 'Rivera',
    dateOfBirth: '19900504',
  }, 'subscriber carries the patient demographics unchanged');

  // Patient is a DEPENDENT → policyholder in subscriber, patient in dependents.
  const asDependent = await captureRequest({
    payerId: '60054',
    memberId: 'W123456789',
    firstName: 'Pat',            // policyholder
    lastName: 'Rivera',
    dateOfBirth: '1965-02-10',
    dependent: { firstName: 'Jamie', lastName: 'Rivera', dateOfBirth: '2010-08-01' },
  });
  assert.deepStrictEqual(asDependent.subscriber, {
    memberId: 'W123456789',
    firstName: 'Pat',
    lastName: 'Rivera',
    dateOfBirth: '19650210',
  }, 'subscriber carries the policyholder demographics');
  assert.deepStrictEqual(asDependent.dependents, [
    { firstName: 'Jamie', lastName: 'Rivera', dateOfBirth: '20100801' },
  ], 'patient moves into a one-element dependents array with DOB');
  // No empty-string fields leaked into either loop.
  Object.values(asDependent.subscriber).forEach((v) => assert.notStrictEqual(v, ''));
  Object.values(asDependent.dependents[0]).forEach((v) => assert.notStrictEqual(v, ''));

  // A dependent object with only empty fields is treated as absent (no dependents).
  const emptyDep = await captureRequest({
    payerId: '60054',
    memberId: 'W1',
    firstName: 'Jamie',
    lastName: 'Rivera',
    dateOfBirth: '1990-05-04',
    dependent: { firstName: '', lastName: '', dateOfBirth: '' },
  });
  assert.ok(!('dependents' in emptyDep), 'all-empty dependent → no dependents key');

  // --- deriveActive three states (via normalizeEligibility) ------------------

  // Active evidence → true.
  assert.strictEqual(
    vob.normalizeEligibility({ planStatus: [{ statusCode: '1' }] }, 'M1').active,
    true, 'planStatus 1 → active true'
  );
  // Explicit inactive evidence (planStatus present, none active) → false.
  assert.strictEqual(
    vob.normalizeEligibility({ planStatus: [{ statusCode: '6' }] }, 'M1').active,
    false, 'planStatus present, none active → false'
  );
  // Inconclusive 271 (no status either way) → null (the fix).
  assert.strictEqual(
    vob.normalizeEligibility({}, 'M1').active,
    null, 'empty payload → null (unknown), not false'
  );

  console.log('vob_dependents.test.js: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
