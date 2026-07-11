'use strict';

// Unit test — the shared SES email helper (backend/lib/email.js). Uses a mocked
// SES client + command constructor injected via `deps`, so no AWS SDK and no
// network are exercised. Verifies:
//   * the SES SendEmail input carries the right FROM (Source) and recipient,
//   * intake-completion content stays PHI-minimal (name + link only),
//   * a send failure is swallowed (graceful degradation) so the caller's request
//     — the patient's intake — still succeeds.
//
//   node backend/tests/email.test.js

const assert = require('node:assert');
const path = require('node:path');

const email = require(path.join(__dirname, '..', 'lib', 'email.js'));

// A fake command class that just captures its input, plus a client whose send()
// records the command it was handed (and optionally throws).
function makeMock(behavior) {
  const captured = { commands: [] };
  function FakeSendEmailCommand(input) { this.input = input; }
  const client = {
    send: async (cmd) => {
      captured.commands.push(cmd.input);
      if (behavior === 'throw') throw new Error('SES not verified (mock)');
      return { MessageId: 'mock-message-id' };
    },
  };
  return { deps: { client, SendEmailCommand: FakeSendEmailCommand }, captured };
}

// --- 1. buildSendEmailInput shape -------------------------------------------
const input = email.buildSendEmailInput({
  to: 'admin@practice.test',
  subject: 'Hello',
  text: 'body text',
});
assert.strictEqual(input.Source, 'notifications@claims.sessionably.com', 'default FROM address');
assert.deepStrictEqual(input.Destination.ToAddresses, ['admin@practice.test'], 'recipient');
assert.strictEqual(input.Message.Subject.Data, 'Hello');
assert.strictEqual(input.Message.Body.Text.Data, 'body text');

// --- 2. sendEmail passes the built input to the (mocked) client -------------
(async () => {
  const okMock = makeMock('ok');
  await email.sendEmail(
    { to: 'admin@practice.test', subject: 'Hi', text: 'x' },
    okMock.deps
  );
  assert.strictEqual(okMock.captured.commands.length, 1, 'client.send called once');
  assert.strictEqual(okMock.captured.commands[0].Source, 'notifications@claims.sessionably.com');
  assert.deepStrictEqual(okMock.captured.commands[0].Destination.ToAddresses, ['admin@practice.test']);

  // --- 3. intake-completion email: correct FROM + recipient, PHI-minimal ----
  const okMock2 = makeMock('ok');
  const res = await email.sendIntakeCompletionEmail(
    {
      to: 'owner@practice.test',
      clientId: 'client-uuid-123',
      clientName: 'Jordan Rivers',
      completedAt: '2026-07-07T12:00:00.000Z',
    },
    okMock2.deps
  );
  assert.strictEqual(res.sent, true, 'reports sent=true on success');
  const sent = okMock2.captured.commands[0];
  assert.strictEqual(sent.Source, 'notifications@claims.sessionably.com', 'FROM is the notifications address');
  assert.deepStrictEqual(sent.Destination.ToAddresses, ['owner@practice.test'], 'recipient is the admin');
  const bodyText = sent.Message.Body.Text.Data;
  assert.ok(bodyText.includes('Jordan Rivers'), 'body includes the client name');
  // The chart link must be the exact production URL shape (host + /app/app.html#…),
  // or every email's link 404s.
  const EXPECTED_CHART_URL = 'https://reddably.com/app/app.html#clients/client-uuid-123';
  assert.ok(bodyText.includes(EXPECTED_CHART_URL), `body links to ${EXPECTED_CHART_URL}, got:\n${bodyText}`);
  assert.ok(
    sent.Message.Body.Html.Data.includes(EXPECTED_CHART_URL),
    'html body links to the exact chart URL too'
  );
  // PHI-minimal: no DOB / member id patterns in the body.
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(bodyText.replace('2026-07-07', '')), 'no extra date-of-birth-like values');

  // --- 4. graceful degradation: a throwing send does NOT reject -------------
  const throwMock = makeMock('throw');
  const failRes = await email.sendIntakeCompletionEmail(
    { to: 'owner@practice.test', clientId: 'c1', clientName: 'Test Client' },
    throwMock.deps
  );
  assert.strictEqual(failRes.sent, false, 'reports sent=false when SES throws');
  assert.ok(failRes.error, 'carries an error message');
  // The key guarantee: it resolved (did not throw), so the caller's intake succeeds.

  // --- 5. no recipient -> no-op (still resolves) ---------------------------
  const noneRes = await email.sendIntakeCompletionEmail({ to: '' }, makeMock('throw').deps);
  assert.strictEqual(noneRes.sent, false, 'no recipient -> sent=false');

  // --- 6. a non-email recipient (login username) is NEVER handed to SES -----
  // Production regression: the recipient resolved to a practice_admin login
  // ("BigRedd"), and SES rejected it with "Missing final '@domain'". The helper
  // must now skip the send entirely and log the exact configuration line, so a
  // username can never reach SES.
  const warnLines = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnLines.push(args.join(' ')); };
  const usernameMock = makeMock('ok');
  let usernameRes;
  try {
    usernameRes = await email.sendIntakeCompletionEmail(
      { to: 'BigRedd', clientId: 'c9', clientName: 'Test Client' },
      usernameMock.deps
    );
  } finally {
    console.warn = origWarn;
  }
  assert.strictEqual(usernameRes.sent, false, 'username recipient -> sent=false');
  assert.strictEqual(usernameMock.captured.commands.length, 0, 'SES send() is NEVER called for a username');
  assert.ok(
    warnLines.some((l) => l.includes('notification email not configured')),
    'logs the exact "notification email not configured" line'
  );

  // isValidEmail accepts real addresses, rejects usernames / malformed values.
  assert.strictEqual(email.isValidEmail('owner@practice.test'), true);
  assert.strictEqual(email.isValidEmail('BigRedd'), false);
  assert.strictEqual(email.isValidEmail('a@b'), false, 'needs a dotted domain');
  assert.strictEqual(email.isValidEmail(''), false);
  assert.strictEqual(email.isValidEmail(null), false);

  console.log('email.test.js: OK');
})().catch((err) => {
  console.error('email.test.js: FAIL', err);
  process.exit(1);
});
