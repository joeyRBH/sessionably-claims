'use strict';

// The card-setup page must name the party that actually charges the card.
//
//   node backend/tests/card_setup_disclosure.test.js
//
// WHY THIS FILE EXISTS
//
// public/card-setup.html read "Your practice will use this to securely collect
// the platform fee on your insurance claims." That was false. The practice never
// touches this money:
//
//   * There is no Stripe-Account header anywhere in this repository, and no
//     transfer_data / application_fee_amount / on_behalf_of. Stripe Connect is
//     documented in CLAUDE.md but is NOT implemented.
//   * createPaymentIntent therefore runs on Reddably's own STRIPE_SECRET_KEY,
//     so the platform fee settles in Reddably's balance.
//
// The sentence sits directly above a Stripe card field. It is the last thing a
// patient reads before handing over a card, and it named the wrong company. The
// charge then arrives on their statement as Reddably — a descriptor matching
// nothing they were told, which is how a routine fee becomes a dispute.
//
// This test does not merely pin a string. It derives the money flow from the
// code and requires the copy to agree with it. If Connect is ever implemented
// and the fee is genuinely routed to the practice, the first assertion stops
// applying and this test says so — rather than letting the page quietly
// contradict the architecture in either direction.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PAGE = path.join(ROOT, 'public', 'card-setup.html');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

/**
 * Every RUNTIME .js under a dir.
 *
 * Tests are excluded, and that exclusion is load-bearing rather than tidiness:
 * this very file contains the routing pattern as a literal, so scanning tests
 * makes the detector match itself, report Connect as implemented, and SKIP the
 * assertion below — a false green that looks identical to a pass.
 */
function jsFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'tests' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) jsFiles(full, acc);
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) acc.push(full);
  }
  return acc;
}

/** Is the platform fee routed to a connected (practice) Stripe account? */
function connectIsImplemented() {
  const ROUTING = /Stripe-Account|stripeAccount|transfer_data|application_fee|on_behalf_of/;
  for (const dir of ['backend', 'api', 'public/js']) {
    for (const f of jsFiles(path.join(ROOT, dir))) {
      if (ROUTING.test(fs.readFileSync(f, 'utf8'))) return true;
    }
  }
  return false;
}

const page = fs.readFileSync(PAGE, 'utf8');
// The visible sentence only — the explanatory HTML comment above it necessarily
// quotes the old wording, and matching that would make this test unfixable.
const visible = page.replace(/<!--[\s\S]*?-->/g, '');
const connect = connectIsImplemented();

console.log('\ncard-setup disclosure names the charging party');
console.log(`  (Stripe Connect implemented: ${connect})`);

check('the fee is not attributed to the practice while Reddably charges the card', () => {
  if (connect) {
    console.log('        [skipped] Connect routing exists — re-derive who is charged');
    return;
  }
  assert.ok(!/your practice will use this/i.test(visible),
    'the page tells the patient their PRACTICE collects the platform fee, but no '
    + 'Connect routing exists in this repo — createPaymentIntent runs on Reddably\'s '
    + 'own key, so Reddably is charged on the statement. Name the real party.');
});

check('the charging party is named, not left implicit', () => {
  if (connect) return;
  assert.match(visible, /Reddably will use this/i,
    'the disclosure above the card field must name Reddably, which is what appears '
    + 'on the patient\'s statement');
});

check('it still promises no charge now — the page is a card SETUP, not a payment', () => {
  assert.match(visible, /won'?t be charged anything now/i,
    'the "no charge now" promise was dropped; this page saves a card and must say so');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
