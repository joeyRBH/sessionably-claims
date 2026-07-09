'use strict';

// Unit test — the receiver-name fix: claim submission must never send an
// undefined receiver.organizationName, which Stedi rejects with a 400
// "Receiver: missing field organizationName". Records created through the payer
// typeahead persist a payer_id but not always a carrier_name, so the adapter
// falls back to the tradingPartnerServiceId (payer id) — Stedi matches the payer
// on that id anyway, so the receiver name only needs to be non-empty.
// Pure (no network, no DB).
//
//   node backend/tests/receiver_name.test.js

const assert = require('node:assert');
const path = require('node:path');

const stedi = require(path.join(__dirname, '..', 'lib', 'clearinghouse', 'stedi.js'));

const base = {
  claim: { id: '2f1c9a3e-7b4d-4c2a-9e11-abcdef012345', billed_amount: '150.00' },
  practice: { name: 'Test Practice', npi: '1234567890' },
  clinician: {},
  client: {},
  session: { cpt_code: '90837', diagnosis_codes: ['F411'] },
};

// With a carrier_name, the receiver name is the carrier name.
const withName = stedi.buildSubmissionBody({
  ...base,
  insurance: { payer_id: '60054', carrier_name: 'Aetna' },
});
assert.strictEqual(
  withName.body.receiver.organizationName,
  'Aetna',
  'receiver uses carrier_name when present'
);

// With NO carrier_name (the payer-typeahead case), the receiver name falls back
// to the payer id — never undefined.
const noName = stedi.buildSubmissionBody({
  ...base,
  insurance: { payer_id: '60054' },
});
assert.strictEqual(
  noName.body.receiver.organizationName,
  '60054',
  'receiver falls back to the payer id when carrier_name is missing'
);
assert.notStrictEqual(
  noName.body.receiver.organizationName,
  undefined,
  'receiver.organizationName is never undefined'
);

// An empty-string carrier_name behaves like missing — still falls back.
const blankName = stedi.buildSubmissionBody({
  ...base,
  insurance: { payer_id: '60054', carrier_name: '' },
});
assert.strictEqual(
  blankName.body.receiver.organizationName,
  '60054',
  'blank carrier_name falls back to the payer id'
);

console.log('PASS receiver_name.test.js');
