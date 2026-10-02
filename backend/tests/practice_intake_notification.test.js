'use strict';

// Unit tests — the "client finished intake" email to the PRACTICE
// (notifyPracticeIfComplete / notifyIntakeComplete in backend/handlers/card_setup.js)
// and the subject/time formatting in backend/lib/email.js.
//
// Pins:
//   * it sends ONCE per client — a patient re-submitting insurance (or the card)
//     must not email the practice again (it used to fire on every save-insurance);
//   * it waits for BOTH halves (insurance + card), in either order, so the body's
//     "payment method saved + insurance provided" is always true;
//   * ONE EMAIL PER INBOX: when the clinician's alert goes to the same address as the
//     practice's, only the clinician one is sent; different addresses get one each;
//   * a failed send releases the claim so the next step retries; no practice address
//     means nothing sent and nothing claimed;
//   * the SUBJECT carries first name + last initial only (lock-screen PHI), the body
//     keeps the full name and the #clients/<id> link, and the time is plain US format
//     in the practice's calendar zone (UTC, labelled, when none is known).
//
// No network, no real DB: db / payment_token / the SES sender are stubbed; the stub
// mirrors the claim-once SQL semantics the handler relies on. Synthetic data only.
//
//   node backend/tests/practice_intake_notification.test.js

const assert = require('node:assert');
const path = require('node:path');

const CLIENT_ID = '23b84bce-0000-4000-8000-000000000001';
const PRACTICE_ID = '92b4b624-0000-4000-8000-000000000002';
const TOKEN = 'signed-payment-token';

const tokenLib = require(path.join(__dirname, '..', 'lib', 'payment_token.js'));
tokenLib.verify = (t) => {
  if (t !== TOKEN) throw new Error('bad token');
  return { client_id: CLIENT_ID };
};

const dbLib = require(path.join(__dirname, '..', 'lib', 'db.js'));
const emailLib = require(path.join(__dirname, '..', 'lib', 'email.js'));
const handler = require(path.join(__dirname, '..', 'handlers', 'card_setup.js')).handler;

const state = {};
function reset(over) {
  Object.assign(state, {
    client: Object.assign({
      id: CLIENT_ID, practice_id: PRACTICE_ID, first_name: 'Jordan', last_name: 'Rivers',
      primary_clinician_id: 'clin-1', status: 'awaiting_info', is_hidden: false,
      payment_method_id: null, clinician_intake_notified_at: null, practice_intake_notified_at: null,
    }, over || {}),
    insurance: null,
    clinician: { id: 'clin-1', email: 'clinician@practice.test', first_name: 'Casey', is_active: true },
    practiceEmail: 'owner@practice.test',
    timeZone: null,
    clinicianSent: [], practiceSent: [],
    practiceResult: { sent: true },
  });
}
const notBlank = (v) => v != null && String(v).trim() !== '';

dbLib.query = async (text, params) => {
  const t = String(text).replace(/\s+/g, ' ');
  const c = state.client;

  if (/select \* from clients where id = \$1/.test(t)) return { rows: [c], rowCount: 1 };
  if (/update clients set payment_method_id/.test(t)) {
    c.payment_method_id = params[0];
    return { rows: [{ practice_id: c.practice_id }], rowCount: 1 };
  }
  if (/select id from insurance_records/.test(t)) {
    return state.insurance ? { rows: [{ id: 'ins_1' }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/update insurance_records set/.test(t)) return { rows: [], rowCount: 1 };
  if (/insert into insurance_records/.test(t)) {
    state.insurance = { carrier_name: params[2], member_id: params[3], is_primary: true, is_hidden: false };
    return { rows: [], rowCount: 1 };
  }

  // time zone lookup
  if (/from calendar_connections/.test(t)) {
    return state.timeZone
      ? { rows: [{ calendar_time_zone: state.timeZone }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  // clinician alert: claim-once + recipient (same rule as the real SQL)
  if (/with ready as/.test(t)) {
    const RE = new RegExp(String(params[1]).replace(/\[:space:\]/g, '\\s'));
    const i = state.insurance; const u = state.clinician;
    const clinOk = !!u && RE.test(u.email);
    const practiceOk = notBlank(state.practiceEmail) && RE.test(String(state.practiceEmail).trim());
    const ready = !c.is_hidden && c.clinician_intake_notified_at == null && notBlank(c.payment_method_id) &&
      !!i && notBlank(i.carrier_name) && notBlank(i.member_id) &&
      !!u && u.is_active && u.id === c.primary_clinician_id && (clinOk || practiceOk);
    if (!ready) return { rows: [], rowCount: 0 };
    c.clinician_intake_notified_at = 'now';
    return { rows: [{
      id: c.id, first_name: c.first_name, last_name: c.last_name, practice_id: c.practice_id,
      primary_clinician_id: c.primary_clinician_id,
      recipient: clinOk ? u.email : String(state.practiceEmail).trim(), to_clinician: clinOk,
      clinician_first_name: u.first_name, clinician_last_name: 'Zed',
    }], rowCount: 1 };
  }
  if (/set clinician_intake_notified_at = null/.test(t)) { c.clinician_intake_notified_at = null; return { rows: [], rowCount: 1 }; }

  // practice alert: readiness read
  if (/select c\.id, c\.practice_id, c\.first_name/.test(t)) {
    const i = state.insurance; const u = state.clinician;
    const ready = !c.is_hidden && notBlank(c.payment_method_id) && !!i && notBlank(i.carrier_name) && notBlank(i.member_id);
    if (!ready) return { rows: [], rowCount: 0 };
    return { rows: [{
      id: c.id, practice_id: c.practice_id, first_name: c.first_name, last_name: c.last_name,
      primary_clinician_id: c.primary_clinician_id,
      already_notified: c.practice_intake_notified_at != null,
      practice_to: notBlank(state.practiceEmail) ? String(state.practiceEmail).trim() : null,
      clinician_active: !!u && u.is_active && u.id === c.primary_clinician_id,
      clinician_email: u ? u.email : null,
    }], rowCount: 1 };
  }
  // practice alert: claim-once and release
  if (/update clients set practice_intake_notified_at = now\(\)/.test(t)) {
    if (c.practice_intake_notified_at != null) return { rows: [], rowCount: 0 };
    c.practice_intake_notified_at = 'now';
    return { rows: [{ id: c.id }], rowCount: 1 };
  }
  if (/set practice_intake_notified_at = null/.test(t)) { c.practice_intake_notified_at = null; return { rows: [], rowCount: 1 }; }

  return { rows: [], rowCount: 0 };   // audit inserts, relink, etc.
};

emailLib.sendClinicianIntakeCompleteEmail = async (opts) => { state.clinicianSent.push(opts); return { sent: true }; };
emailLib.sendIntakeCompletionEmail = async (opts) => { state.practiceSent.push(opts); return state.practiceResult; };

const call = (sub, body) => handler({
  httpMethod: 'POST', rawPath: `/card-setup/${sub}`,
  body: JSON.stringify(Object.assign({ token: TOKEN }, body)),
});
const saveCard = () => call('save-payment-method', { paymentMethodId: 'pm_test', brand: 'visa', last4: '4242' });
const saveInsurance = () => call('save-insurance',
  { carrier_name: 'Test Carrier', member_id: 'M123', payer_id: 'P1', subscriber_relationship: 'self' });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('sends once when the pair completes (insurance then card), to the practice address', async () => {
  reset();
  await saveInsurance();
  assert.strictEqual(state.practiceSent.length, 0, 'insurance alone is not "intake done"');
  await saveCard();
  assert.strictEqual(state.practiceSent.length, 1);
  assert.strictEqual(state.practiceSent[0].to, 'owner@practice.test');
  assert.strictEqual(state.practiceSent[0].clientName, 'Jordan Rivers');
  assert.strictEqual(state.clinicianSent.length, 1, 'and the clinician, at a different address');
});

test('card first, then insurance: still exactly one practice email', async () => {
  reset();
  await saveCard();
  assert.strictEqual(state.practiceSent.length, 0);
  await saveInsurance();
  assert.strictEqual(state.practiceSent.length, 1);
});

test('re-submitting insurance (or the card) never emails the practice again', async () => {
  reset();
  await saveCard();
  await saveInsurance();
  for (let n = 0; n < 3; n++) { await saveInsurance(); await saveCard(); }
  assert.strictEqual(state.practiceSent.length, 1, 'once per client, not once per save-insurance');
  assert.strictEqual(state.clinicianSent.length, 1);
});

test('same inbox: when the clinician alert goes to the practice address, only that one is sent', async () => {
  reset();
  state.clinician.email = 'owner@practice.test';          // solo practice: admin == clinician
  await saveCard();
  await saveInsurance();
  assert.strictEqual(state.clinicianSent.length, 1);
  assert.strictEqual(state.practiceSent.length, 0, 'no second email to the same person');
  await saveInsurance();
  assert.strictEqual(state.practiceSent.length, 0, 'and it stays deduped on re-submits');
  assert.notStrictEqual(state.client.practice_intake_notified_at, null, 'claimed so it is not re-evaluated');
});

test('same inbox is case-insensitive', async () => {
  reset();
  state.clinician.email = 'Owner@Practice.test';
  await saveCard();
  await saveInsurance();
  assert.strictEqual(state.practiceSent.length, 0);
});

test('a username clinician falls back to the practice address: one email, not two', async () => {
  reset();
  state.clinician.email = 'BigRedd';
  await saveCard();
  await saveInsurance();
  assert.strictEqual(state.clinicianSent.length, 1, 'the clinician alert goes to the practice address');
  assert.strictEqual(state.clinicianSent[0].to, 'owner@practice.test');
  assert.strictEqual(state.practiceSent.length, 0, 'so the practice copy is skipped');
});

test('no active primary clinician: the practice still hears about it', async () => {
  reset({ primary_clinician_id: null });
  state.clinician = null;
  await saveCard();
  await saveInsurance();
  assert.strictEqual(state.clinicianSent.length, 0);
  assert.strictEqual(state.practiceSent.length, 1);
});

test('no usable practice address: nothing sent and nothing claimed (a later address still works)', async () => {
  for (const v of [null, '', '   ', 'BigRedd']) {
    reset();
    state.practiceEmail = v;
    await saveCard();
    await saveInsurance();
    assert.strictEqual(state.practiceSent.length, 0, JSON.stringify(v));
    assert.strictEqual(state.client.practice_intake_notified_at, null);
  }
});

test('a failed send releases the claim, so the next step retries; success keeps it', async () => {
  reset();
  state.practiceResult = { sent: false, error: 'ses down' };
  await saveCard();
  assert.strictEqual((await saveInsurance()).statusCode, 200, 'a failed send never fails the patient request');
  assert.strictEqual(state.practiceSent.length, 1);
  assert.strictEqual(state.client.practice_intake_notified_at, null, 'claim released');
  state.practiceResult = { sent: true };
  await saveInsurance();
  assert.strictEqual(state.practiceSent.length, 2, 'retried');
  assert.notStrictEqual(state.client.practice_intake_notified_at, null);
});

test('the practice time zone comes from a connected calendar when there is one', async () => {
  reset();
  state.timeZone = 'America/Denver';
  await saveCard();
  await saveInsurance();
  assert.strictEqual(state.practiceSent[0].timeZone, 'America/Denver');
  assert.strictEqual(state.clinicianSent[0].timeZone, 'America/Denver');
  reset();
  await saveCard();
  await saveInsurance();
  assert.strictEqual(state.practiceSent[0].timeZone, null, 'unknown zone is passed as null, never guessed');
});

// --- the email itself ---------------------------------------------------------

test('subject: first name + last initial only; body keeps the full name and the chart link', () => {
  const m = emailLib.buildIntakeCompletionEmail({
    clientName: 'Jordan Rivers', clientId: CLIENT_ID, completedAt: '2026-10-02T21:04:11.337Z',
  });
  assert.strictEqual(m.subject, 'Jordan R. submitted their information');
  assert.ok(!m.subject.includes('Rivers'));
  assert.ok(m.text.includes('Jordan Rivers'));
  assert.ok(m.text.includes(`https://claims.sessionably.com/app/app.html#clients/${CLIENT_ID}`));
  assert.ok(m.html.includes(`#clients/${CLIENT_ID}`));
  const c = emailLib.buildClinicianIntakeCompleteEmail({ clientName: 'Jordan Rivers', clientId: CLIENT_ID });
  assert.strictEqual(c.subject, 'Jordan R. added their insurance and payment method');
});

test('abbreviateName handles one name, middle names and blanks', () => {
  assert.strictEqual(emailLib.abbreviateName('Jordan Rivers'), 'Jordan R.');
  assert.strictEqual(emailLib.abbreviateName('Mary Jane Watson'), 'Mary W.');
  assert.strictEqual(emailLib.abbreviateName('Cher'), 'Cher');
  assert.strictEqual(emailLib.abbreviateName('  '), '');
  assert.strictEqual(emailLib.abbreviateName(null), '');
});

test('time is plain US format in the practice zone, UTC (labelled) otherwise — never raw ISO', () => {
  const iso = '2026-10-02T21:04:11.337Z';
  assert.strictEqual(emailLib.formatUsDateTime(iso, 'America/Denver'), 'Oct 2, 2026, 3:04 PM MDT');
  assert.strictEqual(emailLib.formatUsDateTime(iso, null), 'Oct 2, 2026, 9:04 PM UTC');
  assert.strictEqual(emailLib.formatUsDateTime(iso, 'Not/AZone'), 'Oct 2, 2026, 9:04 PM UTC',
    'a bad zone name cannot break the email');
  assert.strictEqual(emailLib.formatUsDateTime('garbage', 'America/Denver'), '');
  const m = emailLib.buildIntakeCompletionEmail({ clientName: 'A B', completedAt: iso, timeZone: 'America/Denver' });
  assert.ok(m.text.includes('Time: Oct 2, 2026, 3:04 PM MDT'));
  assert.ok(!m.text.includes('2026-10-02T'), 'no raw ISO timestamp');
  assert.ok(m.html.includes('Oct 2, 2026, 3:04 PM MDT'));
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('  ok  ' + t.name); }
    catch (err) { failed++; console.error('FAIL  ' + t.name + '\n      ' + (err && err.stack || err)); }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
