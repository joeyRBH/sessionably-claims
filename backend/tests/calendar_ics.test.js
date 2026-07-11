'use strict';

// Unit test — the de-identified ICS calendar feed (backend/handlers/calendar.js).
// Exercises ONLY the pure rendering/token helpers (no DB, no network). The point
// of this file is to pin the HIPAA de-identification contract as a test so it can
// never silently regress:
//   * a rendered event for "Maia White" shows "M.W." and NEVER "Maia"/"White",
//   * UIDs are stable per session (edits update, not duplicate),
//   * the output is well-formed ICS (parseable after unfolding),
//   * all-day dates never shift by a timezone (run under TZ=America/Denver too),
//   * the feed token capability compares in constant time and .ics is stripped.
//
//   node backend/tests/calendar_ics.test.js
//   TZ=America/Denver node backend/tests/calendar_ics.test.js   (proves no shift)

const assert = require('node:assert');
const path = require('node:path');

const cal = require(path.join(__dirname, '..', 'handlers', 'calendar.js'));

// Unfold RFC 5545 content lines: a CRLF followed by a single space/tab is a fold.
function unfold(ics) {
  return ics.replace(/\r\n[ \t]/g, '');
}

// A fixture session for a client deliberately named "Maia White".
const SESSION = {
  session_id: '11111111-1111-1111-1111-111111111111',
  session_date: '2026-07-15',
  first_name: 'Maia',
  last_name: 'White',
  client_id: '22222222-2222-2222-2222-222222222222',
  dtstamp: '20260710T120000Z',
};

// --- 1. De-identification (the load-bearing assertion) ----------------------
{
  const ics = cal.renderCalendar([SESSION]);
  const flat = unfold(ics);

  assert.ok(flat.includes('M.W.'), 'event shows client initials "M.W."');
  assert.ok(flat.includes('Client session — M.W.'), 'summary is "Client session — M.W."');

  // The PHI constraint, encoded: the full name must appear NOWHERE in the feed.
  assert.ok(!/Maia/i.test(flat), 'client first name "Maia" must not appear anywhere');
  assert.ok(!/White/i.test(flat), 'client last name "White" must not appear anywhere');

  // Description is the deep link ONLY — no name, and it carries the client id.
  assert.ok(
    flat.includes('DESCRIPTION:https://claims.sessionably.com/app/app.html#clients/22222222-2222-2222-2222-222222222222'),
    'description is the app deep link only'
  );

  // Belt-and-suspenders: none of the other PHI-shaped fields leak.
  ['DOB', 'diagnosis', 'CPT', 'insurance', 'phone'].forEach(function (word) {
    assert.ok(!new RegExp(word, 'i').test(flat), word + ' must not appear in the feed');
  });
}

// --- 2. initials edge cases -------------------------------------------------
assert.strictEqual(cal.initials('Maia', 'White'), 'M.W.', 'Maia White -> M.W.');
assert.strictEqual(cal.initials('  jon ', 'snow'), 'J.S.', 'trims + uppercases');
assert.strictEqual(cal.initials('Cher', ''), 'C.', 'missing last name -> single initial');
assert.strictEqual(cal.initials('', ''), '', 'no name -> empty (no crash)');
assert.strictEqual(cal.initials(null, undefined), '', 'nullish names -> empty (no crash)');

// --- 3. Stable UID per session ----------------------------------------------
{
  const a = cal.renderEvent(SESSION);
  const b = cal.renderEvent(Object.assign({}, SESSION, { session_date: '2026-08-01' }));
  const uidA = unfold(a).match(/UID:(.+)/)[1].trim();
  const uidB = unfold(b).match(/UID:(.+)/)[1].trim();
  assert.strictEqual(uidA, uidB, 'UID is stable across edits to the same session (id-derived)');
  assert.strictEqual(uidA, 'session-' + SESSION.session_id + '@reddably.com', 'UID is session-<id>@domain');

  const c = cal.renderEvent(Object.assign({}, SESSION, { session_id: '33333333-3333-3333-3333-333333333333' }));
  const uidC = unfold(c).match(/UID:(.+)/)[1].trim();
  assert.notStrictEqual(uidA, uidC, 'different session -> different UID');
}

// --- 4. Valid ICS structure (parse via strict assertions after unfolding) ----
{
  const ics = cal.renderCalendar([SESSION, Object.assign({}, SESSION, {
    session_id: '44444444-4444-4444-4444-444444444444',
  })]);

  // CRLF line endings throughout.
  assert.ok(/\r\n/.test(ics), 'uses CRLF line endings');
  assert.ok(!/[^\r]\n/.test(ics), 'no bare LF (every LF is preceded by CR)');

  const flat = unfold(ics);
  const lines = flat.split('\r\n');

  assert.strictEqual(lines[0], 'BEGIN:VCALENDAR', 'starts with BEGIN:VCALENDAR');
  assert.ok(lines.includes('VERSION:2.0'), 'declares VERSION:2.0');
  assert.ok(lines.some((l) => l.indexOf('PRODID:') === 0), 'has a PRODID');
  assert.strictEqual(lines.filter((l) => l === 'END:VCALENDAR').length, 1, 'exactly one END:VCALENDAR');

  // Balanced VEVENT begin/end, one per session.
  assert.strictEqual(flat.match(/BEGIN:VEVENT/g).length, 2, 'two VEVENTs rendered');
  assert.strictEqual(flat.match(/END:VEVENT/g).length, 2, 'two VEVENTs closed');

  // Every physical line is <= 75 octets (folding correctness).
  ics.split('\r\n').forEach((line) => {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, 'line within 75 octets: ' + line);
  });

  // All-day DATE values present and well-formed.
  assert.ok(/DTSTART;VALUE=DATE:20260715/.test(flat), 'DTSTART is an all-day DATE');
  assert.ok(/DTEND;VALUE=DATE:20260716/.test(flat), 'DTEND is the exclusive next day');
}

// --- 5. Date handling never shifts by timezone ------------------------------
// The whole point of PR #49: date-only values must not move under a negative-offset
// process TZ. Assert the pure formatters regardless of TZ, and shout if we ever see
// a shift (which is what naive new Date('YYYY-MM-DD') would cause in Denver).
assert.strictEqual(cal.toIcsDate('2026-07-15'), '20260715', 'toIcsDate: pure string surgery');
assert.strictEqual(cal.nextIcsDate('2026-07-15'), '20260716', 'nextIcsDate: +1 day');
assert.strictEqual(cal.nextIcsDate('2026-07-31'), '20260801', 'nextIcsDate: crosses month');
assert.strictEqual(cal.nextIcsDate('2026-12-31'), '20270101', 'nextIcsDate: crosses year');
assert.strictEqual(cal.nextIcsDate('2028-02-28'), '20280229', 'nextIcsDate: leap day');
if (/Denver/.test(process.env.TZ || '')) {
  // Under America/Denver, the event must STILL be Jul 15 -> Jul 16, not Jul 14/15.
  const flat = unfold(cal.renderEvent(SESSION));
  assert.ok(/DTSTART;VALUE=DATE:20260715/.test(flat), 'no off-by-one under America/Denver');
}

// --- 6. Token capability ----------------------------------------------------
assert.strictEqual(cal.stripIcsSuffix('abc.ics'), 'abc', 'strips a trailing .ics');
assert.strictEqual(cal.stripIcsSuffix('abc.ICS'), 'abc', 'case-insensitive .ics strip');
assert.strictEqual(cal.stripIcsSuffix('abc'), 'abc', 'no suffix -> unchanged');

const TOK = 'a'.repeat(64);
assert.ok(cal.timingSafeTokenEqual(TOK, TOK), 'equal tokens compare true');
assert.ok(!cal.timingSafeTokenEqual(TOK, 'b'.repeat(64)), 'different tokens compare false');
assert.ok(!cal.timingSafeTokenEqual(TOK, 'a'.repeat(63)), 'different length compares false');
assert.ok(!cal.timingSafeTokenEqual(TOK, null), 'non-string compares false (no throw)');

// --- 7. RFC 5545 text escaping ----------------------------------------------
assert.strictEqual(cal.escapeText('a,b;c\\d'), 'a\\,b\\;c\\\\d', 'escapes comma, semicolon, backslash');
assert.strictEqual(cal.escapeText('line1\nline2'), 'line1\\nline2', 'escapes newline');

console.log('calendar_ics.test.js: OK');
