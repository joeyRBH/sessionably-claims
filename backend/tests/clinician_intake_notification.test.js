'use strict';

// Unit tests — the "client finished insurance + payment" clinician email
// (notifyClinicianIfComplete in backend/handlers/card_setup.js).
//
// Covers:
//   * insurance first, then card  -> exactly one email, sent on the card step;
//   * card first, then insurance  -> exactly one email, sent on the insurance step;
//   * only one half on file       -> no email;
//   * re-submitting a step after the email went out -> no second email;
//   * no active primary clinician -> no email;
//   * a failed send releases the claim so the next step retries;
//   * the email body stays PHI-minimal (name + chart link only).
//
// No network, no real DB: db / payment_token / the SES sender are stubbed. The
// stubbed db mirrors the claim-once SQL semantics the handler relies on.
//
//   node backend/tests/clinician_intake_notification.test.js

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

const state = { client: null, insurance: null, clinician: null, practiceEmail: null, sent: [], sendResult: { sent: true } };

function reset(overrides) {
  state.client = Object.assign(
    {
      id: CLIENT_ID,
      practice_id: PRACTICE_ID,
      first_name: 'Test',
      last_name: 'Client',
      primary_clinician_id: 'clin-1',
      status: 'awaiting_info',
      is_hidden: false,
      payment_method_id: null,
      clinician_intake_notified_at: null,
    },
    overrides || {}
  );
  state.insurance = null;
  state.clinician = { id: 'clin-1', email: 'clinician@practice.test', first_name: 'Casey', is_active: true };
  state.practiceEmail = null;
  state.sent = [];
  state.sendResult = { sent: true };
}

const notBlank = (v) => v != null && String(v).trim() !== '';

dbLib.query = async (text, params) => {
  const t = String(text);
  const c = state.client;

  if (/select \* from clients where id = \$1/.test(t)) return { rows: [c], rowCount: 1 };
  if (/from practices/.test(t)) return { rows: [{ recipient: null }], rowCount: 1 };

  if (/update clients\s+set payment_method_id/.test(t)) {
    c.payment_method_id = params[0];
    return { rows: [{ practice_id: c.practice_id }], rowCount: 1 };
  }
  if (/select id from insurance_records/.test(t)) {
    return state.insurance ? { rows: [{ id: 'ins_1' }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/update insurance_records set/.test(t)) {
    state.insurance.carrier_name = params[0];
    state.insurance.member_id = params[1];
    return { rows: [], rowCount: 1 };
  }
  if (/insert into insurance_records/.test(t)) {
    state.insurance = { carrier_name: params[2], member_id: params[3], is_primary: true, is_hidden: false };
    return { rows: [], rowCount: 1 };
  }

  // notifyClinicianIfComplete: claim-once + recipient lookup, mirroring the SQL.
  // Recipient rule: the clinician's own email when it is a real address, else the
  // practice notification email when THAT is a real address, else nobody.
  if (/with ready as/.test(t)) {
    // The handler passes a PostgreSQL POSIX pattern; translate [:space:] for JS.
    const RE = new RegExp(String(params[1]).replace(/\[:space:\]/g, '\\s'));
    const i = state.insurance;
    const u = state.clinician;
    const clinEmailOk = !!u && RE.test(u.email);
    const practiceOk = state.practiceEmail != null && RE.test(String(state.practiceEmail).trim());
    const ready =
      c && !c.is_hidden && c.clinician_intake_notified_at == null &&
      notBlank(c.payment_method_id) &&
      !!i && notBlank(i.carrier_name) && notBlank(i.member_id) &&
      !!u && u.is_active && u.id === c.primary_clinician_id &&
      (clinEmailOk || practiceOk);
    if (!ready) return { rows: [], rowCount: 0 };
    c.clinician_intake_notified_at = 'now';
    return {
      rows: [{
        id: c.id, first_name: c.first_name, last_name: c.last_name,
        recipient: clinEmailOk ? u.email : String(state.practiceEmail).trim(),
        to_clinician: clinEmailOk,
        clinician_first_name: u.first_name, clinician_last_name: 'Zed',
      }],
      rowCount: 1,
    };
  }
  // Release of the claim after a failed send.
  if (/set clinician_intake_notified_at = null/.test(t)) {
    c.clinician_intake_notified_at = null;
    return { rows: [], rowCount: 1 };
  }

  return { rows: [], rowCount: 0 };
};

// Capture the clinician email instead of hitting SES. (The admin email is skipped
// because the stubbed practice has no notification_email.)
const realSend = emailLib.sendClinicianIntakeCompleteEmail;
emailLib.sendClinicianIntakeCompleteEmail = async (opts) => {
  state.sent.push(opts);
  return state.sendResult;
};

function call(sub, body) {
  return handler({
    httpMethod: 'POST',
    rawPath: `/card-setup/${sub}`,
    body: JSON.stringify(Object.assign({ token: TOKEN }, body)),
  });
}
const saveCard = () => call('save-payment-method', { paymentMethodId: 'pm_test', brand: 'visa', last4: '4242' });
const saveInsurance = () =>
  call('save-insurance', { carrier_name: 'Test Carrier', member_id: 'M123', payer_id: 'P1', subscriber_relationship: 'self' });

(async () => {
  // insurance first, then card
  reset();
  assert.strictEqual((await saveInsurance()).statusCode, 200);
  assert.strictEqual(state.sent.length, 0, 'insurance alone must not notify');
  assert.strictEqual((await saveCard()).statusCode, 200);
  assert.strictEqual(state.sent.length, 1, 'card completing the pair notifies once');
  assert.strictEqual(state.sent[0].to, 'clinician@practice.test');
  assert.strictEqual(state.sent[0].clientName, 'Test Client');
  assert.strictEqual(state.sent[0].clinicianName, 'Casey');

  // re-submitting either step afterwards must not send again
  await saveCard();
  await saveInsurance();
  assert.strictEqual(state.sent.length, 1, 're-submits must not re-notify');

  // card first, then insurance
  reset();
  await saveCard();
  assert.strictEqual(state.sent.length, 0, 'card alone must not notify');
  await saveInsurance();
  assert.strictEqual(state.sent.length, 1, 'insurance completing the pair notifies once');

  // no active primary clinician
  reset({ primary_clinician_id: null });
  state.clinician = null;
  await saveCard();
  await saveInsurance();
  assert.strictEqual(state.sent.length, 0, 'no clinician, no email');
  assert.strictEqual(state.client.clinician_intake_notified_at, null, 'nothing claimed');

  // inactive clinician
  reset();
  state.clinician.is_active = false;
  await saveCard();
  await saveInsurance();
  assert.strictEqual(state.sent.length, 0, 'inactive clinician is not emailed');

  // clinician login is a username -> the practice notification email stands in
  reset();
  state.clinician.email = 'BigRedd';
  state.practiceEmail = 'owner@practice.test';
  await saveInsurance();
  await saveCard();
  assert.strictEqual(state.sent.length, 1, 'username clinician falls back to the practice address');
  assert.strictEqual(state.sent[0].to, 'owner@practice.test');
  assert.strictEqual(state.sent[0].onBehalfOf, 'Casey Zed', 'names the clinician instead of greeting them');
  const viaPractice = emailLib.buildClinicianIntakeCompleteEmail(state.sent[0]);
  assert.ok(viaPractice.text.startsWith('Hi,\n'), 'no personal greeting when the clinician is not the reader');
  assert.ok(viaPractice.text.includes('Primary clinician: Casey Zed'));

  // a real clinician email always wins over the practice address
  reset();
  state.practiceEmail = 'owner@practice.test';
  await saveInsurance();
  await saveCard();
  assert.strictEqual(state.sent[0].to, 'clinician@practice.test', 'clinician email preferred');
  assert.strictEqual(state.sent[0].onBehalfOf, null);

  // username clinician and NO usable practice address -> nothing claimed, nothing sent
  for (const practiceEmail of [null, '', '   ', 'BigRedd']) {
    reset();
    state.clinician.email = 'BigRedd';
    state.practiceEmail = practiceEmail;
    await saveInsurance();
    await saveCard();
    assert.strictEqual(state.sent.length, 0, `no deliverable address (${JSON.stringify(practiceEmail)}) -> no email`);
    assert.strictEqual(state.client.clinician_intake_notified_at, null, 'nothing claimed');
  }

  // failed send releases the claim; the next step retries
  reset();
  state.sendResult = { sent: false, error: 'ses down' };
  await saveCard();
  assert.strictEqual((await saveInsurance()).statusCode, 200, 'a failed send never fails the patient request');
  assert.strictEqual(state.sent.length, 1);
  assert.strictEqual(state.client.clinician_intake_notified_at, null, 'claim released after failed send');
  state.sendResult = { sent: true };
  await saveInsurance();
  assert.strictEqual(state.sent.length, 2, 'retried on the next step');
  assert.notStrictEqual(state.client.clinician_intake_notified_at, null, 'claim kept after success');

  // PHI-minimal body
  const built = emailLib.buildClinicianIntakeCompleteEmail({
    clientName: 'Test Client', clinicianName: 'Casey', clientId: CLIENT_ID,
  });
  // The subject shows on lock screens: first name + last initial, never the full name.
  assert.ok(built.subject.startsWith('Test C. '), `subject was: ${built.subject}`);
  assert.ok(!built.subject.includes('Test Client'), 'full name stays out of the subject');
  assert.ok(built.text.includes(`#clients/${CLIENT_ID}`), 'links to the chart');
  assert.ok(!/member|DOB|birth|diagnos|carrier|4242/i.test(built.text), 'no PHI beyond name + link');

  // invalid recipient never reaches SES
  const bad = await realSend({ to: 'BigRedd' });
  assert.strictEqual(bad.sent, false);

  console.log('clinician_intake_notification: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
