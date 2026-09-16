'use strict';

// Tests — the scheduled patient insurance-details reminder
// (backend/handlers/insurance_reminder.js + the email builder in lib/email.js).
//
// WHAT THIS PROTECTS. This is the only thing in the codebase that sends
// unattended mail to PATIENTS. A wrong send cannot be recalled, and a patient who
// marks it as spam damages the SES domain reputation every other notification
// depends on. The properties asserted here are the ones that keep that from
// happening:
//
//   1. DRY BY DEFAULT — anything other than the exact string "false" is dry.
//   2. ONE EMAIL — a successful send stamps insurance_reminder_sent_at, and the
//      stamp is conditional so two overlapping runs cannot both send.
//   3. A FAILED SEND IS NOT STAMPED — a reminder that never left must not burn
//      the single send this patient gets.
//   4. STAMP AFTER SEND, never before.
//   5. The message stays inside the PHI ceiling for patient mail.
//
// The handler's db / email / audit dependencies are replaced in the require cache
// so the loop runs for real without a database or SES.
//
//   node backend/tests/insurance_reminder.test.js

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

const BACKEND = path.join(__dirname, '..');
const DB_PATH = path.join(BACKEND, 'lib', 'db.js');
const EMAIL_PATH = path.join(BACKEND, 'lib', 'email.js');
const AUDIT_PATH = path.join(BACKEND, 'lib', 'audit.js');
const HANDLER_PATH = path.join(BACKEND, 'handlers', 'insurance_reminder.js');

// --- the email builder (loaded before the stub replaces the module) ----------

const realEmail = require(EMAIL_PATH);

{
  const m = realEmail.buildInsuranceReminderEmail({
    practiceName: 'Steady Hand Counseling',
    firstName: 'Ryan',
    setupUrl: 'https://claims.sessionably.com/card-setup?token=TOKEN',
  });

  assert.match(m.subject, /Steady Hand Counseling/, 'the subject names the practice the patient knows');
  assert.ok(m.text.includes('Hi Ryan,'), 'greets by first name');
  assert.ok(m.text.includes('https://claims.sessionably.com/card-setup?token=TOKEN'),
    'the plain-text part carries the link');
  assert.match(m.html, /card-setup\?token=TOKEN/, 'so does the HTML part');

  // PHI ceiling for patient mail. A subject line is visible on a lock screen to
  // anyone holding the phone, so it must not disclose that this is about
  // insurance or a claim.
  assert.doesNotMatch(m.subject, /insurance|claim|out.of.network|diagnos/i,
    'the SUBJECT discloses nothing clinical or financial');
  const body = m.text + ' ' + m.html;
  assert.doesNotMatch(body, /out.of.network|diagnos|member id|policy number|CPT|ICD/i,
    'the body carries no clinical or policy detail');

  // Graceful without a name.
  const anon = realEmail.buildInsuranceReminderEmail({ setupUrl: 'https://x.test/y' });
  assert.ok(anon.text.startsWith('Hi,'), 'no name -> a plain greeting, never "Hi undefined,"');
  assert.match(anon.subject, /your provider/, 'no practice name -> a generic, non-empty subject');

  // The link is HTML-escaped into the anchor.
  const quoted = realEmail.buildInsuranceReminderEmail({
    firstName: '<script>', setupUrl: 'https://x.test/?a=1&b=2',
  });
  assert.doesNotMatch(quoted.html, /<script>/, 'a hostile name cannot inject markup');
  assert.match(quoted.html, /a=1&amp;b=2/, 'the URL is escaped in the anchor');
}

// sendInsuranceReminderEmail must NEVER throw — one bad address must not end a
// run that is working through many patients.
(async () => {
  const bad = await realEmail.sendInsuranceReminderEmail({ to: 'not-an-email', setupUrl: 'x' });
  assert.deepStrictEqual(bad, { sent: false, error: 'invalid recipient' });

  const thrown = await realEmail.sendInsuranceReminderEmail(
    { to: 'ok@example.test', setupUrl: 'x' },
    { client: { send: async () => { throw new Error('SES is not verified'); } }, SendEmailCommand: class {} }
  );
  assert.strictEqual(thrown.sent, false, 'an SES failure is reported, not thrown');
  assert.match(thrown.error, /not verified/);

  let captured = null;
  const ok = await realEmail.sendInsuranceReminderEmail(
    { to: 'ok@example.test', firstName: 'Ryan', practiceName: 'P', setupUrl: 'https://x.test/y' },
    { client: { send: async (cmd) => { captured = cmd.input; return {}; } },
      SendEmailCommand: class { constructor(input) { this.input = input; } } }
  );
  assert.strictEqual(ok.sent, true);
  assert.deepStrictEqual(captured.Destination.ToAddresses, ['ok@example.test']);
  assert.strictEqual(captured.Source, realEmail.FROM_ADDRESS,
    'sent from the address the IAM ses:FromAddress condition allows');
})().then(runHandlerTests).catch(fail);

// --- handler: stub the module's dependencies --------------------------------

function stub(modPath, exports) {
  const m = new Module(modPath, null);
  m.filename = modPath;
  m.loaded = true;
  m.exports = exports;
  require.cache[modPath] = m;
}

function fail(err) { console.error(err); process.exit(1); }

async function runHandlerTests() {
  const state = { updates: [], audits: [], sends: [] };

  stub(DB_PATH, {
    async query(sql, params) {
      if (/from clients c/i.test(sql) && /insurance_reminder_sent_at is null/i.test(sql)) {
        return { rows: state.candidates, rowCount: state.candidates.length };
      }
      if (/update clients/i.test(sql)) {
        state.updates.push(params[0]);
        return { rowCount: state.updateRowCount === undefined ? 1 : state.updateRowCount };
      }
      throw new Error('unexpected SQL: ' + sql);
    },
  });
  stub(EMAIL_PATH, {
    async sendInsuranceReminderEmail(opts) {
      state.sends.push(opts);
      return state.sendResult || { sent: true };
    },
  });
  stub(AUDIT_PATH, {
    async audit(event, ctx, rec) { state.audits.push({ ...rec, actorType: ctx.actorType }); },
    sanitizeFields: () => [],
  });

  process.env.JWT_SECRET = 'insurance-reminder-test-secret';
  process.env.DATABASE_URL = 'postgres://stub';
  delete process.env.DATABASE_URL_SSM_PARAM;
  delete process.env.JWT_SECRET_SSM_PARAM;

  const handler = require(HANDLER_PATH);

  // --- 1. dry by default -----------------------------------------------------
  delete process.env.INSURANCE_REMINDER_DRY_RUN;
  assert.strictEqual(handler.isDryRun(), true, 'unset -> dry');
  // Everything that is not "false" stays dry, including the near-misses somebody
  // actually types.
  for (const v of ['', 'true', 'TRUE', 'no', 'fals', 'falsey', '0', '1', 'off', 'disabled']) {
    process.env.INSURANCE_REMINDER_DRY_RUN = v;
    assert.strictEqual(handler.isDryRun(), true, `${JSON.stringify(v)} -> dry`);
  }
  // Only "false" arms it — trimmed and case-folded first, matching
  // handlers/claim_status_poll.js so the two safety switches behave identically.
  for (const v of ['false', 'FALSE', 'False ', ' false']) {
    process.env.INSURANCE_REMINDER_DRY_RUN = v;
    assert.strictEqual(handler.isDryRun(), false, `${JSON.stringify(v)} -> armed`);
  }

  // intEnv rejects nonsense rather than passing it to SQL.
  process.env.X_TEST_N = 'abc';  assert.strictEqual(handler.intEnv('X_TEST_N', 24), 24);
  process.env.X_TEST_N = '-5';   assert.strictEqual(handler.intEnv('X_TEST_N', 24), 24);
  process.env.X_TEST_N = '0';    assert.strictEqual(handler.intEnv('X_TEST_N', 24), 24);
  process.env.X_TEST_N = '48';   assert.strictEqual(handler.intEnv('X_TEST_N', 24), 48);
  delete process.env.X_TEST_N;

  const CANDIDATE = {
    id: 'c0000001-0000-4000-8000-000000000001',
    practice_id: '11111111-1111-4111-8111-111111111111',
    first_name: 'Ryan',
    preferred_name: null,
    email: 'ryan@example.test',
    practice_name: 'Steady Hand Counseling',
  };

  // --- 2. a DRY run sends nothing and writes nothing -------------------------
  state.candidates = [CANDIDATE];
  state.updates = []; state.audits = []; state.sends = [];
  process.env.INSURANCE_REMINDER_DRY_RUN = 'true';

  let out = await handler.handler();
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.summary.dry_run, true);
  assert.strictEqual(out.summary.candidates, 1);
  assert.strictEqual(out.summary.would_send, 1, 'it reports what it would have done');
  assert.strictEqual(out.summary.sent, 0);
  assert.deepStrictEqual(state.sends, [], 'no mail left the building');
  assert.deepStrictEqual(state.updates, [], 'and nothing was written');
  assert.deepStrictEqual(state.audits, []);

  // --- 3. a live run sends, stamps, and audits -------------------------------
  state.candidates = [CANDIDATE];
  state.updates = []; state.audits = []; state.sends = [];
  state.sendResult = { sent: true };
  process.env.INSURANCE_REMINDER_DRY_RUN = 'false';

  out = await handler.handler();
  assert.strictEqual(out.summary.sent, 1);
  assert.strictEqual(state.sends.length, 1);
  assert.strictEqual(state.sends[0].to, 'ryan@example.test');
  assert.strictEqual(state.sends[0].firstName, 'Ryan');
  assert.strictEqual(state.sends[0].practiceName, 'Steady Hand Counseling');

  // A FRESH token, not the original link — lib/payment_token expires in 24h, so
  // by the time this runs the SMS link is dead.
  assert.match(state.sends[0].setupUrl, /\/card-setup\?token=[\w.-]+$/);
  const token = decodeURIComponent(state.sends[0].setupUrl.split('token=')[1]);
  const verified = require(path.join(BACKEND, 'lib', 'payment_token.js')).verify(token);
  assert.strictEqual(verified.client_id, CANDIDATE.id, 'the token addresses this client');

  assert.deepStrictEqual(state.updates, [CANDIDATE.id], 'exactly one stamp, for this client');
  assert.strictEqual(state.audits.length, 1);
  assert.strictEqual(state.audits[0].action, 'client.insurance_reminder_sent');
  assert.strictEqual(state.audits[0].actorType, 'system', 'no user did this');
  assert.strictEqual(state.audits[0].resourceId, CANDIDATE.id);
  assert.strictEqual(state.audits[0].metadata, undefined, 'no metadata — nothing to say beyond who');

  // --- 4. a FAILED send is not stamped ---------------------------------------
  state.candidates = [CANDIDATE];
  state.updates = []; state.audits = []; state.sends = [];
  state.sendResult = { sent: false, error: 'SES rejected' };

  out = await handler.handler();
  assert.strictEqual(out.summary.sent, 0);
  assert.strictEqual(out.summary.failed, 1);
  assert.deepStrictEqual(state.updates, [],
    'a reminder that never left must not burn this patient\'s single send');
  assert.deepStrictEqual(state.audits, [], 'and nothing is audited as sent');

  // --- 5. preferred_name wins over first_name --------------------------------
  state.candidates = [{ ...CANDIDATE, preferred_name: 'Ry' }];
  state.updates = []; state.sends = []; state.audits = [];
  state.sendResult = { sent: true };
  await handler.handler();
  assert.strictEqual(state.sends[0].firstName, 'Ry', 'the patient is called what they asked to be called');

  // --- 6. a query failure ends the run without sending -----------------------
  const dbStub = require.cache[DB_PATH].exports;
  const realQuery = dbStub.query;
  dbStub.query = async () => { throw new Error('connection refused'); };
  state.sends = []; state.updates = [];
  out = await handler.handler();
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.message, 'candidate query failed');
  assert.deepStrictEqual(state.sends, [], 'nothing is sent when we cannot tell who to send to');
  dbStub.query = realQuery;

  runStaticChecks();
  console.log('insurance_reminder: ok');
}

// --- static guarantees about the candidate query -----------------------------

function runStaticChecks() {
  const src = fs.readFileSync(HANDLER_PATH, 'utf8');

  // The "not done yet" test must stay identical to card_setup.js's
  // intakeCompleteness insurance_ok, or a patient gets chased for something they
  // already did.
  for (const field of ['carrier_name', 'member_id', 'payer_id']) {
    assert.ok(
      src.includes(`nullif(btrim(i.${field}), '') is not null`),
      `the completeness test checks ${field}, like intakeCompleteness does`
    );
  }
  assert.match(src, /i\.is_primary = true/, 'only the PRIMARY record counts');
  assert.match(src, /i\.is_hidden = false/, 'a soft-deleted policy does not count as complete');
  assert.match(src, /c\.is_hidden = false/, 'a soft-deleted client is never chased');
  assert.match(src, /p\.is_active = true/, 'a closed practice never mails its patients');
  assert.match(src, /c\.insurance_reminder_sent_at is null/, 'one email, then silence');
  assert.match(src, /c\.payment_link_sent_at is not null/, 'never chase someone who was never asked');

  // The conditional stamp is what makes two overlapping runs safe.
  assert.match(
    src,
    /set insurance_reminder_sent_at = now\(\)\s*\n\s*where id = \$1 and insurance_reminder_sent_at is null/,
    'the stamp is conditional, so overlapping runs cannot both send'
  );

  // Logging must never carry PHI.
  assert.doesNotMatch(src, /console\.(log|warn|error)\([^)]*client\.email/,
    'no log line prints a patient email address');
  assert.doesNotMatch(src, /console\.(log|warn|error)\([^)]*first_name/,
    'no log line prints a patient name');
  assert.doesNotMatch(src, /console\.(log|warn|error)\([^)]*setupUrl/,
    'no log line prints the tokenised link');
}
