'use strict';

// Unit test — the clinician invitation email + create/expiry helpers
// (backend/lib/email.js + backend/handlers/invitations.js). No DB, no network
// (SES is injected as a mock). Verifies:
//   * the invite email is PHI-free and carries the practice name + accept link,
//   * a send failure is swallowed so the admin's create still succeeds,
//   * the expiry window is parsed + clamped to [1, 30] with a default of 7,
//   * only known roles are accepted.
//
//   node backend/tests/invitations_email.test.js

const assert = require('node:assert');
const path = require('node:path');

const email = require(path.join(__dirname, '..', 'lib', 'email.js'));
const invitations = require(path.join(__dirname, '..', 'handlers', 'invitations.js'));

// --- 1. Invitation email content (PHI-free; practice name + link) ------------
{
  const content = email.buildInvitationEmail({
    practiceName: 'Riverstone Behavioral',
    inviteUrl: 'https://claims.sessionably.com/invite.html?invite=abc123',
    role: 'clinician',
    invitedName: 'Dana Lee',
  });

  assert.ok(/Riverstone Behavioral/.test(content.subject), 'subject names the practice');
  assert.ok(content.text.includes('https://claims.sessionably.com/invite.html?invite=abc123'),
    'text body carries the accept link');
  assert.ok(content.text.includes('Riverstone Behavioral'), 'text body names the practice');
  assert.ok(/Clinician/.test(content.text), 'text body states the role');
  assert.ok(content.text.includes('Dana Lee'), 'greeting uses the invited name');
  assert.ok(/single-use/i.test(content.text), 'text notes the link is single-use');
  assert.ok(content.html.includes('abc123'), 'html body carries the link');

  // No PHI shapes anywhere in the invite.
  ['DOB', 'diagnosis', 'CPT', 'member id', 'insurance', 'patient'].forEach(function (w) {
    assert.ok(!new RegExp(w, 'i').test(content.text), w + ' must not appear in the invite');
  });
}

// --- 2. Missing invited name -> generic greeting, no crash -------------------
{
  const content = email.buildInvitationEmail({
    practiceName: 'Solo Practice',
    inviteUrl: 'https://claims.sessionably.com/invite.html?invite=x',
    role: 'billing_staff',
  });
  assert.ok(/^Hi,/.test(content.text), 'no name -> generic "Hi," greeting');
  assert.ok(/Billing Staff/.test(content.text), 'humanizes billing_staff role');
}

// --- 3. Send is non-fatal (SES sandbox / failure is swallowed) ---------------
function makeMock(behavior) {
  const captured = { commands: [] };
  function FakeSendEmailCommand(input) { this.input = input; }
  const client = {
    send: async (cmd) => {
      captured.commands.push(cmd.input);
      if (behavior === 'throw') throw new Error('SES not verified (mock)');
      return { MessageId: 'mock' };
    },
  };
  return { deps: { client, SendEmailCommand: FakeSendEmailCommand }, captured };
}

(async () => {
  const ok = makeMock('ok');
  const okRes = await email.sendInvitationEmail(
    { to: 'dana@practice.test', practiceName: 'P', inviteUrl: 'https://claims.sessionably.com/invite.html?invite=t', role: 'clinician' },
    ok.deps
  );
  assert.deepStrictEqual(okRes, { sent: true }, 'successful send reports sent:true');
  assert.strictEqual(ok.captured.commands[0].Source, 'notifications@claims.sessionably.com', 'FROM is the notifications address');
  assert.deepStrictEqual(ok.captured.commands[0].Destination.ToAddresses, ['dana@practice.test'], 'recipient set');

  const fail = makeMock('throw');
  const failRes = await email.sendInvitationEmail(
    { to: 'dana@practice.test', practiceName: 'P', inviteUrl: 'https://claims.sessionably.com/invite.html?invite=t', role: 'clinician' },
    fail.deps
  );
  assert.strictEqual(failRes.sent, false, 'a send failure is swallowed (sent:false), never thrown');

  const badRecipient = await email.sendInvitationEmail(
    { to: 'not-an-email', practiceName: 'P', inviteUrl: 'https://x', role: 'clinician' },
    ok.deps
  );
  assert.strictEqual(badRecipient.sent, false, 'a malformed recipient is never handed to SES');

  // --- 4. Expiry parse + clamp ----------------------------------------------
  assert.deepStrictEqual(invitations.parseExpiryDays(undefined), { days: 7 }, 'default is 7 days');
  assert.deepStrictEqual(invitations.parseExpiryDays(''), { days: 7 }, 'blank -> default 7');
  assert.deepStrictEqual(invitations.parseExpiryDays('14'), { days: 14 }, 'parses a string int');
  assert.deepStrictEqual(invitations.parseExpiryDays(0), { days: 1 }, 'clamps below 1 -> 1');
  assert.deepStrictEqual(invitations.parseExpiryDays(999), { days: 30 }, 'clamps above 30 -> 30');
  assert.ok(invitations.parseExpiryDays('abc').error, 'non-integer -> error');

  // --- 5. Role allowlist -----------------------------------------------------
  assert.deepStrictEqual(invitations.ROLES, ['practice_admin', 'clinician', 'billing_staff'],
    'the three staff roles');
  assert.ok(invitations.ROLES.indexOf('owner') === -1, 'no ad-hoc roles');

  console.log('invitations_email.test.js: OK');
})().catch((err) => { console.error(err); process.exit(1); });
