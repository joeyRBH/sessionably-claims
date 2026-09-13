'use strict';

// Unit test — reading a Stedi claim-status error, and telling OUR bug apart from
// the payer's capability (backend/lib/clearinghouse/stedi.js).
//
// WHY THIS EXISTS. On 2026-09-12 a real production status check failed and the
// only thing recoverable from CloudWatch was:
//
//     Stedi status check 400 fields: code=BAD_REQUEST
//
// Nothing else. Not the field, not the reason. The extractor had been written to
// the shape Stedi's API reference DOCUMENTS — `{code, description, errors[]}` —
// and the endpoint does not send that shape. Probing it live with synthetic data
// returned `{code, id, message}`: the reason was in `message`, the one field the
// extractor never read.
//
// So these tests pin the OBSERVED shape, not the documented one, and pin the
// distinction that decides what the user is told:
//
//   INVALID_REQUEST_BODY -> ours, stays a loud 502
//   BAD_REQUEST          -> the payer cannot be polled; not a server error
//
//   node backend/tests/claim_status_error_diagnostics.test.js

const assert = require('node:assert');
const stedi = require('../lib/clearinghouse/stedi');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- the shape that actually arrives ------------------------------------------

test('the reason in `message` is extracted — the whole point of this change', () => {
  // Verbatim from the live endpoint, 2026-09-12, synthetic request.
  const hints = stedi.statusErrorHints({
    code: 'BAD_REQUEST',
    id: 'abc123',
    message: 'Payer ZZZZZ is not configured. Please check our published payer list.',
  });
  const joined = hints.join('; ');
  assert.ok(/code=BAD_REQUEST/.test(joined), 'the code is kept');
  assert.ok(/not configured/.test(joined),
    'THE REGRESSION: without the reason, a failure like this cannot be diagnosed at all');
});

test('a schema error names the offending field', () => {
  const joined = stedi.statusErrorHints({
    code: 'INVALID_REQUEST_BODY',
    message: 'Subscriber: missing field `memberId` at line 1 column 295',
  }).join('; ');
  assert.ok(/memberId/.test(joined), 'the field name survives — that is what makes it fixable');
});

test('the documented shape still works, in case another endpoint uses it', () => {
  const joined = stedi.statusErrorHints({
    errors: [{ code: 'REQUIRED', field: 'subscriber.memberId', location: 'body' }],
  }).join('; ');
  assert.ok(/field=subscriber.memberId/.test(joined));
  assert.ok(/location=body/.test(joined));
});

// --- what must never reach a log ------------------------------------------------

test('errors[].value is NEVER logged — it echoes what we submitted', () => {
  const joined = stedi.statusErrorHints({
    errors: [{ code: 'INVALID', field: 'subscriber.memberId', value: 'W123456789' }],
  }).join('; ');
  assert.ok(/field=subscriber.memberId/.test(joined), 'the field name is useful and safe');
  assert.ok(!/W123456789/.test(joined), 'the submitted VALUE must not appear in a log line');
});

test('long digit runs are redacted wherever they appear', () => {
  // Member ids, dates of birth and SSNs are digit runs. The message field is
  // vendor text we do not control, so it is defused rather than trusted.
  [
    { code: 'BAD_REQUEST', message: 'memberId 123456789012 is invalid' },
    { code: 'BAD_REQUEST', message: 'dateOfBirth 19850914 not recognized' },
  ].forEach((body) => {
    const joined = stedi.statusErrorHints(body).join('; ');
    assert.ok(/\[redacted\]/.test(joined), 'the digit run is replaced');
    assert.ok(!/\d{6,}/.test(joined), 'no run of six or more digits survives: ' + joined);
  });
});

test('a log line is length-capped', () => {
  const joined = stedi.statusErrorHints({ code: 'X', message: 'y'.repeat(5000) }).join('; ');
  assert.ok(joined.length < 700, 'a vendor message cannot flood the log: ' + joined.length);
});

test('junk in, nothing out — never a throw', () => {
  [null, undefined, 'a string', 42, {}, { errors: 'not an array' }].forEach((bad) => {
    assert.deepStrictEqual(stedi.statusErrorHints(bad), [],
      'a diagnostic helper must never be the thing that crashes the request');
  });
});

// --- ours vs the payer's ---------------------------------------------------------

test('BAD_REQUEST is the payer, not us', () => {
  assert.strictEqual(stedi.statusErrorKind({ code: 'BAD_REQUEST' }), 'payer_unsupported');
  assert.strictEqual(stedi.statusErrorKind({ code: 'bad_request' }), 'payer_unsupported',
    'case must not decide whether a biller sees an error or an explanation');
});

test('everything else is treated as OUR bug, loudly', () => {
  // The safe default is the one that stays noisy: an unrecognized failure
  // excused as "the payer cannot do it" would hide a real regression.
  ['INVALID_REQUEST_BODY', 'UNAUTHORIZED', 'SOMETHING_NEW', '', null, undefined]
    .forEach((code) => {
      assert.strictEqual(stedi.statusErrorKind({ code }), 'request_invalid',
        String(code) + ' must not be quietly excused');
    });
  assert.strictEqual(stedi.statusErrorKind(null), 'request_invalid');
});

// --- what the biller actually sees ------------------------------------------------
//
// The bug was not only that we could not diagnose it. A payer that cannot be
// polled was reported to the biller as HTTP 502 "Clearinghouse status check
// failed" — which reads as "this system is broken", invites retrying forever,
// and hides the one fact that would let them act: this claim will never answer a
// status check, so chase it another way.

const path = require('node:path');
function mock(rel, exports) {
  const resolved = require.resolve(path.join(__dirname, '..', rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const PRACTICE = '11111111-1111-4111-8111-111111111111';
const CLAIM_ID = '2f1c9a3e-7b4d-4c2a-9e11-abcdef012345';
const CLAIM_ROW = {
  id: CLAIM_ID, practice_id: PRACTICE, client_id: '44444444-4444-4444-8444-444444444444',
  status: 'submitted', control_number: 'CN-1', is_hidden: false,
};

let thrown = null;
const audits = [];

mock('lib/db.js', {
  query: async () => ({ rowCount: 1, rows: [CLAIM_ROW] }),
  withTransaction: async (fn) => fn({ query: async () => ({ rowCount: 1, rows: [CLAIM_ROW] }) }),
});
mock('lib/audit.js', { audit: async (e, c, entry) => { audits.push(entry); }, sanitizeFields: (x) => x });
mock('lib/claims.js', {
  primaryInsuranceForClient: async () => null, logClaimEvent: async () => {},
  logClaimAcknowledgment: async () => {}, loadClaimSessions: async () => [],
  ensurePatientControlNumber: async () => 'PCN1',
});
mock('lib/claim_context.js', {
  buildClaimContext: async () => ({ claim: CLAIM_ROW }),
  eventTypeForStatus: () => 'denied', loadSession: async () => null, loadInsuranceRecord: async () => null,
});
mock('lib/clearinghouse/index.js', {
  getClearinghouse: () => ({ name: 'stedi', getStatus: async () => { throw thrown; } }),
});
mock('lib/auth.js', {
  requireAuth: () => ({ user: { sub: '33333333-3333-4333-8333-333333333333', practice_id: PRACTICE, role: 'practice_admin' } }),
  AuthError: class extends Error {},
});

const { handler } = require('../handlers/claims.js');

function refreshEvent() {
  return {
    version: '2.0', routeKey: 'POST /claims/{id}/refresh',
    rawPath: `/claims/${CLAIM_ID}/refresh`, pathParameters: { id: CLAIM_ID },
    headers: { authorization: 'Bearer t' }, body: '{}',
    requestContext: { http: { method: 'POST', path: `/claims/${CLAIM_ID}/refresh`, sourceIp: '127.0.0.1' }, requestId: 't' },
  };
}

const asyncTests = [];
function atest(name, fn) { asyncTests.push({ name, fn }); }

atest('an unpollable payer is 422 with something actionable — not a 502', async () => {
  audits.length = 0;
  thrown = Object.assign(new Error('Payer does not support automated status checks.'),
    { isStatusUnsupported: true });

  const res = await handler(refreshEvent());
  const body = JSON.parse(res.body);

  assert.strictEqual(res.statusCode, 422, 'not 502 — nothing here is broken');
  assert.strictEqual(body.outcome, 'payer_unsupported');
  assert.ok(/does not support automated status checks/i.test(body.error));
  assert.ok(/payer directly|remittance/i.test(body.error),
    'it tells the biller what to do instead, which is the point');
  assert.ok(!/stedi/i.test(body.error), 'the clearinghouse is never named to a user');
  assert.ok(audits.some((a) => a.metadata && a.metadata.outcome === 'payer_unsupported'),
    'the outcome is auditable — "we asked and could not" is a fact worth keeping');
});

atest('a genuine upstream failure is STILL a loud 502', async () => {
  thrown = new Error('Stedi status check failed (HTTP 500)');
  const res = await handler(refreshEvent());
  assert.strictEqual(res.statusCode, 502,
    'the quiet path must not swallow real breakage');
  assert.ok(!/stedi/i.test(JSON.parse(res.body).error), 'still never names the vendor');
});

atest('a schema rejection is OUR bug and stays a 502', async () => {
  // statusErrorKind maps INVALID_REQUEST_BODY to request_invalid, so the adapter
  // does not flag it, so it lands here. Asserted end-to-end rather than trusting
  // the mapping in isolation.
  thrown = new Error('Stedi status check failed (HTTP 400)');
  const res = await handler(refreshEvent());
  assert.strictEqual(res.statusCode, 502);
});

// --- runner -----------------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { t.fn(); console.log('  ok  ' + t.name); }
    catch (err) { failed++; console.error('FAIL  ' + t.name + '\n      ' + (err && err.message)); }
  }
  for (const t of asyncTests) {
    try { await t.fn(); console.log('  ok  ' + t.name); }
    catch (err) { failed++; console.error('FAIL  ' + t.name + '\n      ' + (err && err.message)); }
  }
  const total = tests.length + asyncTests.length;
  console.log('\n' + (total - failed) + '/' + total + ' passed');
  process.exit(failed ? 1 : 0);
})();
