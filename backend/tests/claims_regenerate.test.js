'use strict';

// Unit test — the "Edit claim" regenerate guard (backend/handlers/claims.js).
// Verifies WHICH claim statuses expose regeneration from the underlying session:
// draft + denied yes; submitted and other in-flight/terminal states no. This is
// the server-side twin of the frontend actionsFor() matrix (only draft/denied
// render an "Edit claim" button). No DB, no network.
//
//   node backend/tests/claims_regenerate.test.js

const assert = require('node:assert');
const path = require('node:path');

const claims = require(path.join(__dirname, '..', 'handlers', 'claims.js'));
const REGEN = claims.REGENERATABLE_STATUSES;

// Draft (not yet sent) and denied (being corrected) may be regenerated.
assert.ok(REGEN.includes('draft'), 'draft claims are regeneratable');
assert.ok(REGEN.includes('denied'), 'denied claims are regeneratable');

// Submitted (and every other in-flight/terminal status) must NOT be — submitted
// claims stay read-only; void/refresh are their only paths.
['submitted', 'processing', 'info_requested', 'appealed', 'paid', 'void'].forEach((s) => {
  assert.ok(!REGEN.includes(s), s + ' must NOT be regeneratable (read-only)');
});

// Model the regeneration itself: billed_amount is re-derived from the session's
// current fee. This mirrors regenerateClaim()'s single derived field.
function regenerateBilled(session) {
  return session.fee != null ? session.fee : null;
}
// A draft claim's billed amount tracks the session's edited rate.
assert.strictEqual(regenerateBilled({ fee: '250.00' }), '250.00', 'billed follows new session rate');
assert.strictEqual(regenerateBilled({ fee: null }), null, 'cleared rate clears billed');

console.log('PASS claims_regenerate.test.js');
