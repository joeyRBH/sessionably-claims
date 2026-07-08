'use strict';

// Unit test — a date-only value (date of birth) must round-trip UNCHANGED through
// the whole pipeline, in a non-UTC process timezone, with no off-by-one shift.
//
// The historical bug: node-postgres parses a `date` column into a JS Date at local
// midnight, and JSON-serializing that (toISOString) then shifts it by the process
// timezone — so "1999-10-14" reached the browser as "1999-10-13" in Mountain time.
// The fix (backend/lib/db.js) registers a pg type parser for OID 1082 (date) that
// returns the raw 'YYYY-MM-DD' string, so DOB is a plain string end to end. This
// test asserts the two ends of that contract under TZ=America/Denver:
//   * the DATE type parser returns the raw string (no Date, no shift), and
//   * the frontend-equivalent display formatting keeps the same calendar day.
//
//   TZ=America/Denver node backend/tests/dob_roundtrip.test.js

const assert = require('node:assert');
const path = require('node:path');

const DOB = '1999-10-14';

// 1. The DATE (OID 1082) type parser installed by lib/db.js returns the raw
//    'YYYY-MM-DD' string — never a Date — so serialization can't shift it. We read
//    the parser straight from pg after requiring db.js (which installs it).
require(path.join(__dirname, '..', 'lib', 'db.js'));
const pgTypes = require('pg').types;
const dateParser = pgTypes.getTypeParser(1082 /* DATE */);
const shaped = dateParser(DOB);
assert.strictEqual(typeof shaped, 'string', 'date column parses to a string, not a Date');
assert.strictEqual(shaped, DOB, `date parser returns the raw string unchanged (got ${shaped})`);

// 2. JSON round-trip (what shapeClient -> response.json does) keeps it identical.
const serialized = JSON.parse(JSON.stringify({ date_of_birth: shaped })).date_of_birth;
assert.strictEqual(serialized, DOB, `survives JSON serialization unchanged (got ${serialized})`);

// 3. Display formatting must land on the SAME calendar day (Oct 14, not Oct 13),
//    even under a negative-offset timezone. Mirrors views.js fmtDate's date-only
//    branch (parse the parts as a LOCAL date, never new Date("YYYY-MM-DD") as UTC).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDateOnly(s) {
  const p = s.split('-');
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}
assert.strictEqual(fmtDateOnly(serialized), 'Oct 14, 1999', 'displays the entered day, no off-by-one');

// Guard-rail: prove the OLD path WOULD have shifted under this TZ, so this test is
// meaningful (and only in a negative-offset zone like America/Denver).
if (/Denver/.test(process.env.TZ || '')) {
  const badDay = new Date(DOB).getDate(); // new Date("1999-10-14") == UTC midnight
  assert.strictEqual(badDay, 13, 'sanity: the naive new Date(dob) path shifts to the 13th in Denver');
}

console.log('dob_roundtrip.test.js: OK');
