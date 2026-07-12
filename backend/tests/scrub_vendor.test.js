'use strict';

// Unit test — scrubVendor() white-label helper (public/app/views.js).
//
// The clearinghouse vendor must be invisible to app users: any clearinghouse-
// originated text (e.g. an enrollment's status_reason) is passed through
// scrubVendor() before display. This test extracts the function from views.js (a
// browser IIFE that can't be require()d under Node) and exercises brand-name and
// URL replacement.
//
//   node backend/tests/scrub_vendor.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const viewsSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'app', 'views.js'),
  'utf8'
);

// Pull just the scrubVendor function body out of the IIFE (2-space indented, so
// its closing brace is the first `\n  }` after the declaration).
const start = viewsSrc.indexOf('function scrubVendor(');
assert.ok(start !== -1, 'scrubVendor is defined in public/app/views.js');
const end = viewsSrc.indexOf('\n  }', start);
assert.ok(end !== -1, 'found the end of scrubVendor');
const src = viewsSrc.slice(start, end + 4);

// Wrap as an expression so eval returns the function (a bare function
// declaration under strict-mode eval would not escape the eval scope).
// eslint-disable-next-line no-eval
const scrubVendor = eval('(' + src + ')');

// Brand name → generic phrase (case-insensitive).
assert.strictEqual(scrubVendor('Submitted to Stedi for review'),
  'Submitted to the clearinghouse for review');
assert.strictEqual(scrubVendor('STEDI needs your signature'),
  'the clearinghouse needs your signature');
assert.strictEqual(scrubVendor('Contact stedi support'),
  'Contact the clearinghouse support');

// Vendor URL → enrollment-contact pointer (no clickable vendor link survives).
assert.strictEqual(
  scrubVendor('Enroll at https://www.stedi.com/app/enrollments now'),
  'Enroll at (see your enrollment contact) now'
);
assert.strictEqual(scrubVendor('See stedi.com for details'),
  'See (see your enrollment contact) for details');
assert.ok(!/stedi/i.test(scrubVendor('Visit https://stedi.com/help')),
  'no vendor token remains after scrubbing a URL');

// Null-safe.
assert.strictEqual(scrubVendor(null), '');
assert.strictEqual(scrubVendor(undefined), '');

// Non-vendor text passes through untouched.
assert.strictEqual(scrubVendor('Aetna approved your enrollment.'),
  'Aetna approved your enrollment.');

console.log('PASS scrub_vendor.test.js');
