'use strict';

// Unit test — backend/lib/billing_fields.js.
//
// This module was extracted from backend/handlers/sessions.js because clients
// now hold per-client DEFAULTS for the same billable fields, so the same values
// are validated on two routes. A second copy of the rules would be a second,
// silently divergent definition of what a valid place of service or procedure
// modifier is — and one of those copies decides what rides the 837P.
//
// Covers the extracted parsers (their behaviour must be identical to what the
// sessions handler enforced before the move — place_of_service.test.js and
// session_procedure_modifiers.test.js guard the handler side) and the seeding
// rule that makes calendar promotion useful.
//
//   node backend/tests/billing_fields.test.js

const assert = require('node:assert');
const BF = require('../lib/billing_fields');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- the column map -----------------------------------------------------------

test('the column map covers exactly the five defaultable fields', () => {
  assert.deepStrictEqual(Object.keys(BF.CLIENT_DEFAULT_COLUMNS).sort(),
    ['cpt_code', 'diagnosis_codes', 'fee', 'place_of_service', 'procedure_modifiers']);
  // diagnosis_codes maps to itself: it predates the others (migration 008) and
  // kept its column name rather than being renamed for symmetry.
  assert.strictEqual(BF.CLIENT_DEFAULT_COLUMNS.diagnosis_codes, 'diagnosis_codes');
  assert.strictEqual(BF.CLIENT_DEFAULT_COLUMNS.fee, 'default_session_fee');
});

test('the map is frozen — it is a definition, not a scratchpad', () => {
  assert.throws(() => { 'use strict'; BF.CLIENT_DEFAULT_COLUMNS.cpt_code = 'nope'; });
});

// --- seeding ------------------------------------------------------------------

test('a blank field takes the client default', () => {
  const out = BF.applyClientDefaults(
    { cpt_code: null, place_of_service: null, fee: null },
    { default_cpt_code: '90837', default_place_of_service: '10', default_session_fee: 175 }
  );
  assert.strictEqual(out.cpt_code, '90837');
  assert.strictEqual(out.place_of_service, '10');
  assert.strictEqual(out.fee, 175);
});

test('a supplied value always wins over the default', () => {
  const out = BF.applyClientDefaults(
    { cpt_code: '90834', fee: 90 },
    { default_cpt_code: '90837', default_session_fee: 175 }
  );
  assert.strictEqual(out.cpt_code, '90834', 'the request wins');
  assert.strictEqual(out.fee, 90);
});

test('a zero fee is a supplied value, not a blank', () => {
  // The bug this guards: a truthiness test would treat a free session as unset
  // and silently bill the client's default rate for it.
  const out = BF.applyClientDefaults({ fee: 0 }, { default_session_fee: 175 });
  assert.strictEqual(out.fee, 0, 'a deliberate zero must survive');
});

test('a client with no defaults changes nothing', () => {
  const input = { cpt_code: null, fee: null };
  const out = BF.applyClientDefaults(input, { id: 'c-1' });
  assert.strictEqual(out.cpt_code, null);
  assert.strictEqual(out.fee, null);
});

test('a null client is tolerated and changes nothing', () => {
  const out = BF.applyClientDefaults({ cpt_code: null }, null);
  assert.strictEqual(out.cpt_code, null);
});

test('neither argument is mutated', () => {
  const input = { cpt_code: null };
  const client = { default_cpt_code: '90837' };
  const out = BF.applyClientDefaults(input, client);
  assert.strictEqual(input.cpt_code, null, 'input untouched');
  assert.strictEqual(client.default_cpt_code, '90837', 'client untouched');
  assert.strictEqual(out.cpt_code, '90837');
});

// --- the extracted parsers ----------------------------------------------------

test('parseMoney: blank is null, negatives and junk are rejected', () => {
  assert.deepStrictEqual(BF.parseMoney(null), { ok: true, value: null });
  assert.deepStrictEqual(BF.parseMoney(''), { ok: true, value: null });
  assert.deepStrictEqual(BF.parseMoney('175.50'), { ok: true, value: 175.5 });
  assert.deepStrictEqual(BF.parseMoney(0), { ok: true, value: 0 });
  assert.strictEqual(BF.parseMoney(-1).ok, false);
  assert.strictEqual(BF.parseMoney('abc').ok, false);
});

test('parsePlaceOfService: only real two-character CMS codes', () => {
  assert.deepStrictEqual(BF.parsePlaceOfService('11'), { ok: true, value: '11' });
  assert.deepStrictEqual(BF.parsePlaceOfService(''), { ok: true, value: null });
  // The literal value that got a live claim rejected by the payer.
  assert.strictEqual(BF.parsePlaceOfService('office').ok, false);
  assert.strictEqual(BF.parsePlaceOfService('99').ok, false);
});

test('parseProcedureModifiers: normalized, de-duplicated, capped', () => {
  assert.deepStrictEqual(BF.parseProcedureModifiers(['95']), { ok: true, value: ['95'] });
  assert.deepStrictEqual(BF.parseProcedureModifiers(['gt', 'GT']),
    { ok: true, value: ['GT'] }, 'uppercased and de-duplicated');
  assert.deepStrictEqual(BF.parseProcedureModifiers([]), { ok: true, value: null },
    'an empty list clears the column');
  assert.deepStrictEqual(BF.parseProcedureModifiers(['95', '']), { ok: true, value: ['95'] },
    'blanks are dropped');
  assert.strictEqual(BF.parseProcedureModifiers(['toolong']).ok, false,
    'a malformed code is a hard failure, never a silent drop');
  assert.strictEqual(
    BF.parseProcedureModifiers(['95', 'GT', 'HO', 'HN', 'AJ']).ok, false,
    'more than four DISTINCT modifiers is a failure, never a truncation'
  );
  assert.strictEqual(BF.parseProcedureModifiers('95').ok, false, 'must be an array');
});

// --- practice-wide defaults (migration 030) ----------------------------------

test('a blank field falls back to the PRACTICE default when the client has none', () => {
  const out = BF.applyClientDefaults(
    { cpt_code: null, place_of_service: null, fee: null, procedure_modifiers: null },
    { default_cpt_code: null },
    { default_cpt_code: '90837', default_place_of_service: '11', default_session_fee: '175.00',
      default_procedure_modifiers: ['95'] }
  );
  assert.strictEqual(out.cpt_code, '90837');
  assert.strictEqual(out.place_of_service, '11');
  assert.strictEqual(out.fee, '175.00');
  assert.deepStrictEqual(out.procedure_modifiers, ['95']);
});

test('precedence is request > client > practice, field by field', () => {
  const out = BF.applyClientDefaults(
    { cpt_code: '90791', fee: null, place_of_service: null },
    { default_cpt_code: '90834', default_session_fee: 120, default_place_of_service: null },
    { default_cpt_code: '90837', default_session_fee: 175, default_place_of_service: '11' }
  );
  assert.strictEqual(out.cpt_code, '90791', 'the request wins over both');
  assert.strictEqual(out.fee, 120, 'the client wins over the practice');
  assert.strictEqual(out.place_of_service, '11', 'the practice fills what the client lacks');
});

test('a client fee of 0 is a real client default and beats the practice fee', () => {
  const out = BF.applyClientDefaults({}, { default_session_fee: 0 }, { default_session_fee: 175 });
  assert.strictEqual(out.fee, 0);
});

test('the practice supplies no diagnosis (that stays per-client)', () => {
  assert.strictEqual(BF.PRACTICE_DEFAULT_COLUMNS.diagnosis_codes, undefined);
  const out = BF.applyClientDefaults({}, {}, { diagnosis_codes: ['F411'] });
  assert.strictEqual(out.diagnosis_codes, undefined);
});

test('practice defaults apply even when there is no client row', () => {
  const out = BF.applyClientDefaults({}, null, { default_cpt_code: '90837' });
  assert.strictEqual(out.cpt_code, '90837');
});

test('omitting the practice is exactly the pre-030 behavior', () => {
  const out = BF.applyClientDefaults({ fee: null }, { default_session_fee: 90 });
  assert.strictEqual(out.fee, 90);
});

test('applyClientDefaults never copies practice values onto anything but the new session', () => {
  const practice = { default_cpt_code: '90837' };
  const client = { default_cpt_code: null };
  BF.applyClientDefaults({}, client, practice);
  assert.strictEqual(client.default_cpt_code, null, 'the client row is not mutated: blank stays blank (= inherit)');
  assert.strictEqual(BF.seedClientDefaultsFromPractice, undefined, 'the copy-on-create helper is gone');
});

// --- explicit "None" ------------------------------------------------------------

test('parsers: "none" is an explicit choice, distinct from blank', () => {
  assert.deepStrictEqual(BF.parsePlaceOfService('none'), { ok: true, value: null, none: true });
  assert.deepStrictEqual(BF.parsePlaceOfService(' None '), { ok: true, value: null, none: true });
  assert.deepStrictEqual(BF.parsePlaceOfService(''), { ok: true, value: null }, 'blank is just blank');
  assert.deepStrictEqual(BF.parseProcedureModifiers(['NONE']), { ok: true, value: null, none: true });
  assert.deepStrictEqual(BF.parseProcedureModifiers(['none']), { ok: true, value: null, none: true });
  assert.deepStrictEqual(BF.parseProcedureModifiers([]), { ok: true, value: null }, '[] still just clears');
  assert.strictEqual(BF.parseProcedureModifiers(['NONE', '95']).ok, false, 'None plus a real modifier is contradictory');
});

test('practice modifier 95 + request "None" = no modifier', () => {
  const out = BF.applyClientDefaults({ procedure_modifiers: [] }, {}, { default_procedure_modifiers: ['95'] });
  assert.strictEqual(out.procedure_modifiers, null);
});

test('practice modifier 95 + client "None" = no modifier; a request value still beats the client None', () => {
  const practice = { default_procedure_modifiers: ['95'] };
  const client = { default_procedure_modifiers: [] };
  assert.strictEqual(BF.applyClientDefaults({}, client, practice).procedure_modifiers, null);
  assert.deepStrictEqual(BF.applyClientDefaults({ procedure_modifiers: ['GT'] }, client, practice).procedure_modifiers, ['GT']);
});

test('place of service: client / request "none" override the practice and never survive as a value', () => {
  const practice = { default_place_of_service: '11' };
  assert.strictEqual(BF.applyClientDefaults({}, { default_place_of_service: 'none' }, practice).place_of_service, null);
  assert.strictEqual(BF.applyClientDefaults({ place_of_service: 'none' }, { default_place_of_service: '10' }, practice).place_of_service, null);
  assert.strictEqual(BF.applyClientDefaults({ place_of_service: '12' }, { default_place_of_service: 'none' }, practice).place_of_service, '12');
});

test('blank still inherits (null is not None)', () => {
  const practice = { default_procedure_modifiers: ['95'], default_place_of_service: '11' };
  const out = BF.applyClientDefaults({}, { default_procedure_modifiers: null, default_place_of_service: null }, practice);
  assert.deepStrictEqual(out.procedure_modifiers, ['95']);
  assert.strictEqual(out.place_of_service, '11');
});

test('parseDurationMinutes: blank → null, whole minutes 1..600, nothing else', () => {
  assert.deepStrictEqual(BF.parseDurationMinutes(''), { ok: true, value: null });
  assert.deepStrictEqual(BF.parseDurationMinutes('50'), { ok: true, value: 50 });
  for (const bad of [0, -5, 2.5, 'abc', 601]) {
    assert.strictEqual(BF.parseDurationMinutes(bad).ok, false, String(bad));
  }
});

// --- runner -------------------------------------------------------------------

let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log('  ok  ' + t.name);
  } catch (err) {
    failed++;
    console.error('FAIL  ' + t.name + '\n      ' + (err && err.message));
  }
}
console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
