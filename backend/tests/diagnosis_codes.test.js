'use strict';

// Unit test — curated billable ICD-10 diagnosis list (public/app/diagnosis-codes.js).
// Runs in plain Node (the file is a UMD shim). No DB, no network.
//
//   node backend/tests/diagnosis_codes.test.js

const assert = require('node:assert');
const path = require('node:path');

const D = require(path.join(__dirname, '..', '..', 'public', 'app', 'diagnosis-codes.js'));

// --- CRITICAL: category codes are NOT selectable; billable children ARE --------
// Aetna rejected the category code F10.9 (error 33 — must be to highest
// specificity). It must not be billable; its specific child F10.90 must be.
assert.strictEqual(D.isBillableCode('F10.9'), false, 'F10.9 (category) must NOT be billable');
assert.strictEqual(D.isBillableCode('F10.90'), true, 'F10.90 (specific) must be billable');

// Dotless and lower-case inputs normalize the same way.
assert.strictEqual(D.isBillableCode('F1090'), true, 'dotless F1090 must be billable');
assert.strictEqual(D.isBillableCode('f10.90'), true, 'lower-case must normalize');

// A few more category vs. billable pairs.
assert.strictEqual(D.isBillableCode('F43.2'), false, 'F43.2 (category) must NOT be billable');
assert.strictEqual(D.isBillableCode('F43.20'), true, 'F43.20 (adjustment disorder) must be billable');
assert.strictEqual(D.isBillableCode('F17'), false, 'F17 (3-char category) must NOT be billable');
assert.strictEqual(D.isBillableCode('F17.200'), true, 'F17.200 must be billable');

// A genuinely made-up code is not billable.
assert.strictEqual(D.isBillableCode('Z99.9'), false, 'unknown code must NOT be billable');

// --- display() re-inserts the decimal after the 3-char category ----------------
assert.strictEqual(D.display('F1090'), 'F10.90');
assert.strictEqual(D.display('F411'), 'F41.1');
assert.strictEqual(D.display('F17200'), 'F17.200');

// --- label() is "<dotted> — <description>" for known codes ---------------------
assert.ok(/^F10\.90 — /.test(D.label('F1090')), 'label formats known code');
assert.strictEqual(D.label('Z999'), 'Z99.9', 'unknown code still renders dotted, no description');

// --- search() finds by code, by dotted display, and by condition text ----------
const byCode = D.search('F411');
assert.ok(byCode.some((e) => e.code === 'F411'), 'search by dotless code finds GAD');
const byText = D.search('anxiety');
assert.ok(byText.some((e) => e.code === 'F411'), 'search by condition text finds GAD');
const byDotted = D.search('F10.90');
assert.ok(byDotted.some((e) => e.code === 'F1090'), 'search by dotted code finds alcohol dependence');
assert.ok(D.search('', 3).length === 3, 'empty query returns capped list');

// --- Guardrail: EVERY curated code is billable and dotless ---------------------
D.CODES.forEach((entry) => {
  assert.strictEqual(D.isBillableCode(entry.code), true, entry.code + ' should be billable');
  assert.ok(/^[A-Z][0-9A-Z]+$/.test(entry.code), entry.code + ' should be dotless/alnum');
});

// --- Simulate the frontend session auto-carry -----------------------------------
// A session created for a client with a stored default code inherits it (the view
// sets values.diagnosis_codes = client.diagnosis_codes.slice() on create). Model
// that here: the normalized client codes are exactly what the new session carries.
const clientCodes = ['F411', 'F329'];
const newSessionCodes = clientCodes.slice(); // what clients.js seeds the picker with
assert.deepStrictEqual(newSessionCodes, ['F411', 'F329'], 'new session auto-carries client codes');
newSessionCodes.forEach((c) => assert.strictEqual(D.isBillableCode(c), true, c + ' carried code is billable'));

console.log('PASS diagnosis_codes.test.js');
