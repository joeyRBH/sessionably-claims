'use strict';

// Card-setup resource — the DB side of the PUBLIC patient card-capture flow.
// Runs in the VPC (reaches RDS); the Stripe calls stay on the Vercel adapters
// (api/setup-intent.js, api/save-payment-method.js) which have outbound egress.
// Those adapters call these routes over HTTPS for all DB access:
//
//   POST /card-setup/context              → resolve the client behind the token
//   POST /card-setup/save-customer        → persist a newly created Stripe customer id
//   POST /card-setup/save-payment-method  → persist the display-only card summary
//   POST /card-setup/save-insurance       → persist the patient's OON insurance info
//   POST /card-setup/payer-search         → type-ahead payer lookup (Stedi) for the
//                                           patient's insurance-company field
//
// Auth: the short-lived signed payment token (lib/payment_token) carried in the
// body as { token } — the same credential the Vercel functions verified before.
// The token yields a client_id; every query is scoped to that client. This is a
// patient (non-staff) flow, so there is no requireAuth / practice JWT here.
// Never store a raw PAN/CVC (PCI); never log PHI.
//
// Intake does NOT make a client billable. It writes the patient's answers to the
// chart, but a clinician confirms them there ("Save as default" on the client
// chart) before the client becomes 'active'. This flow therefore writes NO status
// at all: a patient who finishes intake stays 'awaiting_info' until a human says
// otherwise. It used to auto-promote 'awaiting_info' → 'active' the moment the
// answers looked complete, with no one in the loop — a fuzzy self-reported form
// made someone billable. See intakeCompleteness for the readiness rule the chart's
// confirm affordance mirrors.

const db = require('../lib/db');
const paymentToken = require('../lib/payment_token');
const { json, preflight } = require('../lib/response');
const { parseBody, normalizePhone } = require('../lib/util');
const { audit } = require('../lib/audit');
const { relinkDraftClaimsToPrimaryInsurance } = require('../lib/claims');
const stedi = require('../lib/clearinghouse/stedi');
const email = require('../lib/email');

function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

// Path tail after "card-setup/" so routing is payload-format agnostic.
function subPath(event) {
  const raw =
    (event && event.rawPath) ||
    (event && event.requestContext && event.requestContext.http && event.requestContext.http.path) ||
    (event && event.path) ||
    '';
  const cleaned = String(raw).replace(/^\/+|\/+$/g, '');
  const idx = cleaned.indexOf('card-setup/');
  return idx === -1 ? '' : cleaned.slice(idx + 'card-setup/'.length);
}

// Resolve the client_id from the token, or throw. Kept separate so every route
// enforces the same token check.
function clientIdFromBody(body) {
  const { client_id: clientId } = paymentToken.verify(body.token);
  return clientId;
}

async function loadClient(clientId) {
  const r = await db.query(
    `select * from clients where id = $1 and is_hidden = false limit 1`,
    [clientId]
  );
  return r.rows[0] || null;
}

// The practice's local time zone, for the time shown in the alert emails. There is
// no practices.timezone column, so this borrows the IANA zone the calendar sync
// captured from a connected Google calendar (the clinician's own when they have one,
// else any active connection in the practice). null when nothing is connected — the
// email then says "UTC" explicitly rather than guessing. Best-effort; never throws.
async function lookupTimeZone(practiceId, clinicianId) {
  try {
    const r = await db.query(
      `select calendar_time_zone
         from calendar_connections
        where practice_id = $1 and status = 'active'
          and nullif(btrim(calendar_time_zone), '') is not null
        order by (user_id = $2) desc, created_at asc
        limit 1`,
      [practiceId, clinicianId || null]
    );
    return (r.rows[0] && r.rows[0].calendar_time_zone) || null;
  } catch (err) {
    return null;
  }
}

// Fire the "patient submitted their information" email to the PRACTICE's
// notification address once the patient's submission is complete (insurance record
// AND a saved card on file — the same condition the clinician alert uses, so the
// "payment method saved + insurance provided" line in the message is always true).
// This is a REVIEW request: the client is not billable until a clinician confirms
// on the chart.
//
// ONCE PER CLIENT, enforced by the database: practice_intake_notified_at is claimed
// with a single UPDATE ... WHERE ... IS NULL, so concurrent requests and a patient
// re-opening the link cannot double-send (before this it fired on every
// save-insurance call). If the send does not go out, the claim is released so a
// later step retries.
//
// ONE EMAIL PER INBOX: when the primary clinician's alert goes to the very same
// address (a solo practice whose admin is also the clinician, or a clinician whose
// login is a username so their alert falls back to this address), the practice copy
// is not sent — the clinician one already tells that person everything. The column
// is still claimed so it is not re-evaluated on every later step.
//
// RECIPIENT: practices.notification_email ONLY. There is deliberately no fallback to
// a staff login — a practice_admin's `email` may be a username (e.g. "BigRedd"), and
// handing that to SES fails with "Missing final '@domain'". register now defaults the
// column to the founding admin's address when it is a real one.
//
// Best-effort and fully non-blocking: any failure (SES not verified yet, no
// recipient, send error) is logged and swallowed so the patient's request still
// succeeds. PHI-minimal — only the client's name + a chart link are sent.
async function notifyPracticeIfComplete(clientId) {
  let claimed = false;
  try {
    const r = await db.query(
      `select c.id, c.practice_id, c.first_name, c.last_name, c.primary_clinician_id,
              (c.practice_intake_notified_at is not null) as already_notified,
              nullif(btrim(coalesce(p.notification_email, '')), '') as practice_to,
              (u.id is not null and u.is_active = true) as clinician_active,
              nullif(btrim(coalesce(u.email, '')), '') as clinician_email
         from clients c
         join practices p on p.id = c.practice_id
         left join users u on u.id = c.primary_clinician_id
        where c.id = $1
          and c.is_hidden = false
          and nullif(btrim(coalesce(c.payment_method_id, '')), '') is not null
          and exists (
            select 1 from insurance_records i
             where i.client_id = c.id and i.is_primary = true and i.is_hidden = false
               and nullif(btrim(coalesce(i.carrier_name, '')), '') is not null
               and nullif(btrim(coalesce(i.member_id, '')), '') is not null)
        limit 1`,
      [clientId]
    );
    const row = r.rows[0];
    if (!row || row.already_notified) return;
    const to = row.practice_to && email.isValidEmail(row.practice_to) ? row.practice_to : null;
    if (!to) return;   // nowhere to send; claim nothing so a later-added address still works

    // Where the clinician's alert goes: their own address when it is real, else the
    // practice address (the same rule notifyClinicianIfComplete applies in SQL). No
    // active primary clinician means no clinician alert, so nothing to dedupe against.
    const clinicianTo = row.clinician_active
      ? (row.clinician_email && email.isValidEmail(row.clinician_email) ? row.clinician_email : to)
      : null;
    const sameInbox = !!clinicianTo && clinicianTo.toLowerCase() === to.toLowerCase();

    const claim = await db.query(
      `update clients
          set practice_intake_notified_at = now()
        where id = $1 and practice_intake_notified_at is null
        returning id`,
      [clientId]
    );
    if (claim.rowCount === 0) return;   // a concurrent request got there first
    claimed = true;
    if (sameInbox) return;              // covered by the clinician alert; stay claimed

    const timeZone = await lookupTimeZone(row.practice_id, row.primary_clinician_id);
    const result = await email.sendIntakeCompletionEmail({
      to,
      clientId: row.id,
      clientName: [row.first_name, row.last_name].filter(Boolean).join(' ').trim(),
      completedAt: new Date().toISOString(),
      timeZone,
    });
    if (!result || result.sent !== true) {
      claimed = false;
      await db.query(
        `update clients set practice_intake_notified_at = null where id = $1`,
        [clientId]
      );
    }
  } catch (err) {
    console.warn('card_setup notifyPracticeIfComplete failed:', err && err.message);
    if (claimed) {
      try {
        await db.query(
          `update clients set practice_intake_notified_at = null where id = $1`,
          [clientId]
        );
      } catch (e) { /* the claim stays; better silent than a duplicate */ }
    }
  }
}

// Run after EITHER intake step (card saved, insurance saved): whichever completes the
// pair sends, the other is a no-op. Clinician first, then the practice copy, which
// skips itself when it would land in the same inbox.
async function notifyIntakeComplete(clientId) {
  await notifyClinicianIfComplete(clientId);
  await notifyPracticeIfComplete(clientId);
}

// Tell the client's primary clinician once BOTH halves of the patient's submission
// are on file: an insurance record (carrier + member id) AND a saved card. The
// patient can finish them in either order, so this runs after each step and only the
// call that completes the pair sends.
//
// Recipient: the clinician's own login email when it is a real address. A login can
// be a plain username (e.g. "BigRedd"), which is not deliverable; in that case the
// practice's notification email (Settings > Notifications) receives it instead, and
// the message says whose client it is. If neither is a real address, nothing is
// claimed and nothing is sent.
//
// "Once" is enforced by the database, not by this code: the guard column is claimed
// with a single UPDATE ... WHERE clinician_intake_notified_at IS NULL, so concurrent
// requests and a patient re-opening the link cannot double-send. If the send does not
// go out, the claim is released so a later step can retry. Best-effort and fully
// non-blocking, like notifyIntakeComplete; PHI-minimal (name + chart link only).

// Same shape lib/email.js isValidEmail accepts, expressed as a PostgreSQL POSIX
// regex so the recipient is decided BEFORE the once-only claim is taken.
const EMAIL_SQL_RE = '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]{2,}$';

async function notifyClinicianIfComplete(clientId) {
  let claimed = false;
  try {
    const r = await db.query(
      `with ready as (
         select c.id
           from clients c
           join users u on u.id = c.primary_clinician_id and u.is_active = true
           join practices p on p.id = c.practice_id
          where c.id = $1
            and c.is_hidden = false
            and c.clinician_intake_notified_at is null
            and nullif(btrim(c.payment_method_id), '') is not null
            and exists (
              select 1 from insurance_records i
               where i.client_id = c.id and i.is_primary = true and i.is_hidden = false
                 and nullif(btrim(i.carrier_name), '') is not null
                 and nullif(btrim(i.member_id), '') is not null)
            and (u.email ~ $2 or btrim(coalesce(p.notification_email, '')) ~ $2)
       ), claimed as (
         update clients
            set clinician_intake_notified_at = now()
          where id in (select id from ready) and clinician_intake_notified_at is null
        returning id, first_name, last_name, primary_clinician_id, practice_id
       )
       select cl.id, cl.first_name, cl.last_name, cl.practice_id, cl.primary_clinician_id,
              case when u.email ~ $2 then u.email
                   else btrim(p.notification_email) end as recipient,
              (u.email ~ $2) as to_clinician,
              u.first_name as clinician_first_name,
              u.last_name as clinician_last_name
         from claimed cl
         join users u on u.id = cl.primary_clinician_id
         join practices p on p.id = cl.practice_id`,
      [clientId, EMAIL_SQL_RE]
    );
    const row = r.rows[0];
    if (!row) return;
    claimed = true;
    const result = await email.sendClinicianIntakeCompleteEmail({
      to: row.recipient,
      clientId: row.id,
      clientName: [row.first_name, row.last_name].filter(Boolean).join(' ').trim(),
      clinicianName: row.clinician_first_name,
      // Set only when the practice address is standing in for the clinician, so the
      // message can name the clinician instead of greeting them.
      onBehalfOf: row.to_clinician
        ? null
        : [row.clinician_first_name, row.clinician_last_name].filter(Boolean).join(' ').trim(),
      completedAt: new Date().toISOString(),
      timeZone: await lookupTimeZone(row.practice_id, row.primary_clinician_id),
    });
    if (!result || result.sent !== true) {
      claimed = false;
      await db.query(
        `update clients set clinician_intake_notified_at = null where id = $1`,
        [clientId]
      );
    }
  } catch (err) {
    console.warn('card_setup notifyClinicianIfComplete failed:', err && err.message);
    if (claimed) {
      try {
        await db.query(
          `update clients set clinician_intake_notified_at = null where id = $1`,
          [clientId]
        );
      } catch (_) { /* best-effort release */ }
    }
  }
}

// Trim to a string, capping length. Returns '' for non-strings / null.
const MAX_FIELD_LEN = 200;
function cleanField(v) {
  if (typeof v !== 'string') return '';
  return v.trim();
}

// --- intake readiness ---------------------------------------------------------
//
// This is the DEFINITION of "the patient has given us everything a claim needs".
// It no longer changes anything on its own: it used to back an auto-promotion to
// 'active' that ran with no human in the loop, and that promotion is gone. It
// stays as the single written statement of the rule — the client chart's "Save as
// default" affordance mirrors it to decide when to offer the confirm.

// Is this client claim-ready? True only when intake has produced everything an
// 837P needs FROM THE PATIENT:
//   * demographics — date of birth + a full address (details step), and
//   * insurance — carrier, member id, and a real payer_id.
// The payer_id is what routes the claim, and it only exists when the patient picked
// a directory match; a free-typed carrier name can't be routed. A card on file is
// deliberately NOT part of this — a practice can bill a client who never saved one.
//
// Read back from the DB rather than trusting the just-posted body: a patient who
// re-opens the link and re-submits a single step is then judged on the row's actual
// state, not on the one step in front of us.
async function intakeCompleteness(clientId) {
  const r = await db.query(
    `select
        (c.date_of_birth is not null
          and nullif(btrim(c.address_line1), '') is not null
          and nullif(btrim(c.city), '') is not null
          and nullif(btrim(c.state), '') is not null
          and nullif(btrim(c.postal_code), '') is not null)   as demographics_ok,
        (i.id is not null
          and nullif(btrim(i.carrier_name), '') is not null
          and nullif(btrim(i.member_id), '') is not null
          and nullif(btrim(i.payer_id), '') is not null)      as insurance_ok
       from clients c
       left join lateral (
         select id, carrier_name, member_id, payer_id
           from insurance_records
          where client_id = c.id and is_primary = true and is_hidden = false
          order by created_at asc
          limit 1
       ) i on true
      where c.id = $1 and c.is_hidden = false`,
    [clientId]
  );
  const row = r.rows[0];
  if (!row) return { demographicsOk: false, insuranceOk: false };
  return {
    demographicsOk: row.demographics_ok === true,
    insuranceOk: row.insurance_ok === true,
  };
}

// NOTE: activateIfIntakeComplete used to live here and promoted 'awaiting_info' →
// 'active' from both intake steps. It is deliberately GONE, not merely unwired: a
// helper whose whole job is to make a client billable without a human is one call
// site away from coming back. Confirmation is now a staff action on the client
// chart, which goes through the ordinary authenticated PATCH /clients/{id} and is
// audited there like any other staff status change.

exports.handler = async (event) => {
  const method = httpMethod(event);
  if (method === 'OPTIONS') return preflight(event);
  if (method !== 'POST') return json(405, { error: 'Method not allowed' }, event);

  const body = parseBody(event);

  // Token is the credential for every route here.
  let clientId;
  try {
    clientId = clientIdFromBody(body);
  } catch (_) {
    return json(401, { error: 'Invalid or expired link.' }, event);
  }

  try {
    const path = subPath(event);

    if (path === 'context') {
      const client = await loadClient(clientId);
      if (!client) return json(404, { error: 'Not found' }, event);
      await audit(event, { actorType: 'patient_link', practiceId: client.practice_id }, {
        action: 'patient_link.access',
        resourceType: 'client',
        resourceId: client.id,
      });
      return json(
        200,
        {
          client_id: client.id,
          practice_id: client.practice_id,
          stripe_customer_id: client.stripe_customer_id || null,
          first_name: client.first_name || null,
          last_name: client.last_name || null,
          email: client.email || null,
        },
        event
      );
    }

    if (path === 'save-customer') {
      const customerId = body.stripe_customer_id;
      if (!customerId || typeof customerId !== 'string') {
        return json(400, { error: 'Missing stripe_customer_id.' }, event);
      }
      // Only set it if not already present (first writer wins), scoped to the token's client.
      await db.query(
        `update clients set stripe_customer_id = $1
          where id = $2 and is_hidden = false and stripe_customer_id is null`,
        [customerId, clientId]
      );
      return json(200, { ok: true }, event);
    }

    if (path === 'save-payment-method') {
      const paymentMethodId = body.paymentMethodId;
      if (!paymentMethodId || typeof paymentMethodId !== 'string') {
        return json(400, { error: 'Missing paymentMethodId.' }, event);
      }
      const pmRes = await db.query(
        `update clients
            set payment_method_id = $1,
                payment_method_brand = $2,
                payment_method_last4 = $3,
                payment_method_exp_month = $4,
                payment_method_exp_year = $5,
                payment_method_set_at = now()
          where id = $6 and is_hidden = false
          returning practice_id`,
        [
          paymentMethodId,
          body.brand || null,
          body.last4 || null,
          body.exp_month != null ? body.exp_month : null,
          body.exp_year != null ? body.exp_year : null,
          clientId,
        ]
      );
      await audit(
        event,
        { actorType: 'patient_link', practiceId: pmRes.rows[0] ? pmRes.rows[0].practice_id : null },
        { action: 'patient_link.save_payment_method', resourceType: 'client', resourceId: clientId }
      );
      // If insurance was already submitted, this card completes the pair.
      await notifyIntakeComplete(clientId);
      return json(200, { ok: true }, event);
    }

    // Type-ahead payer lookup for the patient's insurance-company field. The
    // token is the credential (verified above); no requireAuth. The only input
    // is a free-text payer-name fragment (a payer-name fragment is not PHI) and
    // the response is public payer-directory data, so nothing is persisted here.
    if (path === 'payer-search') {
      const q = cleanField(body.q);
      if (q.length < 2 || q.length > 200) {
        return json(400, { error: 'Query must be between 2 and 200 characters.' }, event);
      }
      try {
        const payers = await stedi.searchPayers(q);
        return json(200, { payers }, event);
      } catch (err) {
        // No PHI in a payer-name search; log only the message.
        console.error('card_setup payer-search error:', err && err.message);
        return json(502, { error: 'Could not search payers.' }, event);
      }
    }

    if (path === 'save-details') {
      // Patient-supplied demographics needed to build a claim: date of birth,
      // biological sex, and current address. Persisted to the clients row (columns already exist —
      // db/migrations/002). All optional individually; a blank field never nulls
      // out existing data (coalesce(nullif(...))). No card/PCI data here.
      const dateOfBirth = cleanField(body.date_of_birth);
      // Patient's biological sex — the 837P subscriber demographic required when the
      // patient IS the subscriber ('self'). Same female|male|unknown vocabulary the
      // clients_gender_check CHECK enforces; lower-cased before validating.
      const gender = cleanField(body.gender).toLowerCase();
      const addressLine1 = cleanField(body.address_line1);
      const addressLine2 = cleanField(body.address_line2);
      const city = cleanField(body.city);
      const state = cleanField(body.state);
      const postalCode = cleanField(body.postal_code);
      const phoneRaw = cleanField(body.phone);

      for (const v of [addressLine1, addressLine2, city, state, postalCode]) {
        if (v.length > MAX_FIELD_LEN) return json(400, { error: 'One of the fields is too long.' }, event);
      }
      if (dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
        return json(400, { error: 'Date of birth must be YYYY-MM-DD.' }, event);
      }
      if (gender && !['female', 'male', 'unknown'].includes(gender)) {
        return json(400, { error: 'Invalid biological sex.' }, event);
      }

      // Optional phone: normalize to E.164 (Twilio SMS requires it). Blank is
      // fine — a blank never nulls the existing value (coalesce below). A
      // non-blank value that can't normalize is a clear 400, not stored garbage.
      let phone = '';
      if (phoneRaw !== '') {
        const res = normalizePhone(phoneRaw);
        if (!res.ok) {
          return json(400, { error: 'Please enter a valid US phone number.' }, event);
        }
        phone = res.value;
      }

      const result = await db.query(
        `update clients set
            date_of_birth = coalesce(nullif($1, '')::date, date_of_birth),
            gender        = coalesce(nullif($2, ''), gender),
            address_line1 = coalesce(nullif($3, ''), address_line1),
            address_line2 = coalesce(nullif($4, ''), address_line2),
            city          = coalesce(nullif($5, ''), city),
            state         = coalesce(nullif($6, ''), state),
            postal_code   = coalesce(nullif($7, ''), postal_code),
            phone         = coalesce(nullif($8, ''), phone)
          where id = $9 and is_hidden = false
          returning practice_id`,
        [dateOfBirth, gender, addressLine1, addressLine2, city, state, postalCode, phone, clientId]
      );
      if (result.rowCount === 0) return json(404, { error: 'Not found' }, event);
      await audit(
        event,
        { actorType: 'patient_link', practiceId: result.rows[0] ? result.rows[0].practice_id : null },
        { action: 'patient_link.save_details', resourceType: 'client', resourceId: clientId }
      );

      // No status write here. Demographics landing on the chart does not make the
      // client billable — a clinician confirms on the chart.
      return json(200, { ok: true }, event);
    }

    if (path === 'save-insurance') {
      // Patient-supplied OON insurance info. Required: carrier_name, member_id, and
      // payer_id — UNLESS payer_not_listed is set (see below). Optional:
      // group_number, subscriber_relationship, subscriber_name, subscriber_dob.
      // Trim everything; reject anything over 200 chars.
      const carrierName = cleanField(body.carrier_name);
      const memberId = cleanField(body.member_id);
      const groupNumber = cleanField(body.group_number);
      const subscriberRelationship = cleanField(body.subscriber_relationship);
      const subscriberName = cleanField(body.subscriber_name);
      const subscriberDob = cleanField(body.subscriber_dob);
      // Policyholder (dependent-subscriber) demographics — CMS-1500 Box 7 / 11a.
      // Only meaningful when the patient is NOT the policyholder; cleared on 'self'
      // (see subscriberIsSelf below). Gender is lower-cased and validated against
      // the same female|male|unknown vocabulary the DB CHECK enforces.
      const subscriberGender = cleanField(body.subscriber_gender).toLowerCase();
      const subscriberAddress1 = cleanField(body.subscriber_address_line1);
      const subscriberAddress2 = cleanField(body.subscriber_address_line2);
      const subscriberCity = cleanField(body.subscriber_city);
      const subscriberState = cleanField(body.subscriber_state);
      const subscriberPostal = cleanField(body.subscriber_postal_code);
      // payer_id maps to insurance_records.payer_id varchar(50). It exists only when
      // the patient PICKED a payer-directory match — free text never yields one.
      const payerId = cleanField(body.payer_id);

      // Escape hatch: the patient explicitly said they can't find their insurance
      // company in the directory. Saves whatever they have with a null payer_id and
      // leaves the client on 'awaiting_info' for staff follow-up. Deliberately an
      // explicit boolean flag, so it can only ever be a chosen path — never the
      // silent default that an absent payer_id used to be.
      const payerNotListed = body.payer_not_listed === true;

      if (!carrierName) return json(400, { error: 'Insurance company is required.' }, event);
      if (!memberId) return json(400, { error: 'Member ID is required.' }, event);

      // The claim can't be routed without a payer id, so a picked match is required.
      // Enforced HERE and not only in the page: client-side gating is a prompt, not a
      // gate — this route is reachable with nothing but the signed link token.
      if (!payerId && !payerNotListed) {
        return json(
          400,
          { error: 'Please choose the insurance company from the list of matches.' },
          event
        );
      }

      for (const v of [
        carrierName, memberId, groupNumber, subscriberRelationship, subscriberName, subscriberDob,
        subscriberAddress1, subscriberAddress2, subscriberCity, subscriberState, subscriberPostal,
      ]) {
        if (v.length > MAX_FIELD_LEN) return json(400, { error: 'One of the fields is too long.' }, event);
      }
      if (payerId.length > 50) return json(400, { error: 'One of the fields is too long.' }, event);
      if (subscriberRelationship && !['self', 'spouse', 'child', 'other'].includes(subscriberRelationship)) {
        return json(400, { error: 'Invalid policyholder relationship.' }, event);
      }
      if (subscriberDob && !/^\d{4}-\d{2}-\d{2}$/.test(subscriberDob)) {
        return json(400, { error: 'Date of birth must be YYYY-MM-DD.' }, event);
      }
      if (subscriberGender && !['female', 'male', 'unknown'].includes(subscriberGender)) {
        return json(400, { error: 'Invalid policyholder gender.' }, event);
      }

      // When the patient IS the policyholder, no dependent-subscriber demographics
      // apply. Clear them (below) rather than coalescing, so a patient who first
      // said "child" and then corrected to "self" doesn't leave stale policyholder
      // PHI on the record. The relationship select on the page always sends a value,
      // so an explicit 'self' is a reliable trigger.
      const subscriberIsSelf = subscriberRelationship === 'self';

      // Authoritative either way — the id the patient picked, or an explicit null when
      // they used the escape hatch. Deliberately NOT coalesced onto the existing value:
      // an id left over from an earlier pick would no longer match the carrier name
      // being saved now, and a stale payer id routes the claim to the wrong payer.
      const payerIdOrNull = payerNotListed ? null : payerId;

      const client = await loadClient(clientId);
      if (!client) return json(404, { error: 'Not found' }, event);

      // Find an existing primary (non-hidden) record to update in place.
      const existing = await db.query(
        `select id from insurance_records
          where client_id = $1 and is_primary = true and is_hidden = false
          order by created_at asc limit 1`,
        [clientId]
      );

      if (existing.rows[0]) {
        // Update only the fields the patient actually provided — never null out
        // existing data with a blank. coalesce(nullif($n, ''), col) keeps the
        // current value when the incoming field is blank. EXCEPTION: when the
        // patient is the policyholder ($5 subscriberIsSelf), every dependent-
        // subscriber column is force-cleared to NULL — a coalesce would otherwise
        // preserve stale policyholder PHI (name/DOB/gender/address) that then leaks
        // if the relationship later flips back to a dependent value.
        await db.query(
          `update insurance_records set
              carrier_name             = coalesce(nullif($1, ''), carrier_name),
              member_id                = coalesce(nullif($2, ''), member_id),
              group_number             = coalesce(nullif($3, ''), group_number),
              subscriber_relationship  = coalesce(nullif($4, ''), subscriber_relationship),
              subscriber_name          = case when $5::boolean then null else coalesce(nullif($6, ''), subscriber_name) end,
              subscriber_dob           = case when $5::boolean then null else coalesce(nullif($7, '')::date, subscriber_dob) end,
              subscriber_gender        = case when $5::boolean then null else coalesce(nullif($8, ''), subscriber_gender) end,
              subscriber_address_line1 = case when $5::boolean then null else coalesce(nullif($9, ''), subscriber_address_line1) end,
              subscriber_address_line2 = case when $5::boolean then null else coalesce(nullif($10, ''), subscriber_address_line2) end,
              subscriber_city          = case when $5::boolean then null else coalesce(nullif($11, ''), subscriber_city) end,
              subscriber_state         = case when $5::boolean then null else coalesce(nullif($12, ''), subscriber_state) end,
              subscriber_postal_code   = case when $5::boolean then null else coalesce(nullif($13, ''), subscriber_postal_code) end,
              payer_id                 = $14
            where id = $15`,
          [
            carrierName, memberId, groupNumber, subscriberRelationship, subscriberIsSelf,
            subscriberName, subscriberDob, subscriberGender,
            subscriberAddress1, subscriberAddress2, subscriberCity, subscriberState, subscriberPostal,
            payerIdOrNull, existing.rows[0].id,
          ]
        );
      } else {
        // No primary record yet — insert. On 'self' the policyholder columns are
        // stored NULL (blanked in JS below), matching the update's clear semantics.
        const insName = subscriberIsSelf ? '' : subscriberName;
        const insDob = subscriberIsSelf ? '' : subscriberDob;
        const insGender = subscriberIsSelf ? '' : subscriberGender;
        const insAddr1 = subscriberIsSelf ? '' : subscriberAddress1;
        const insAddr2 = subscriberIsSelf ? '' : subscriberAddress2;
        const insCity = subscriberIsSelf ? '' : subscriberCity;
        const insState = subscriberIsSelf ? '' : subscriberState;
        const insPostal = subscriberIsSelf ? '' : subscriberPostal;
        await db.query(
          `insert into insurance_records
             (practice_id, client_id, carrier_name, member_id, group_number,
              subscriber_relationship, subscriber_name, subscriber_dob,
              subscriber_gender, subscriber_address_line1, subscriber_address_line2,
              subscriber_city, subscriber_state, subscriber_postal_code, payer_id, is_primary)
           values ($1, $2, $3, $4, nullif($5, ''),
                   nullif($6, ''), nullif($7, ''), nullif($8, '')::date,
                   nullif($9, ''), nullif($10, ''), nullif($11, ''),
                   nullif($12, ''), nullif($13, ''), nullif($14, ''), $15, true)`,
          [
            client.practice_id,
            clientId,
            carrierName,
            memberId,
            groupNumber,
            subscriberRelationship,
            insName,
            insDob,
            insGender,
            insAddr1,
            insAddr2,
            insCity,
            insState,
            insPostal,
            payerIdOrNull,
          ]
        );
      }

      // Draft claims created before this insurance existed carry no coverage and
      // could never be submitted. Attach it now. Non-blocking: the patient's save
      // has already succeeded, so a failure is logged (name only, no PHI), not raised.
      let relinkedClaimIds = [];
      try {
        relinkedClaimIds = await relinkDraftClaimsToPrimaryInsurance(db, client.practice_id, clientId);
      } catch (err) {
        console.error('claim insurance relink failed:', err && err.name);
      }
      for (const claimId of relinkedClaimIds) {
        await audit(event, { actorType: 'patient_link', practiceId: client.practice_id }, {
          action: 'claim.insurance_relink',
          resourceType: 'claim',
          resourceId: claimId,
          metadata: { trigger: 'patient_intake' },
        });
      }

      // If a card was already saved, this insurance completes the pair: the clinician
      // and the practice are each told ONCE (a re-submit sends nothing more), and not
      // twice at the same address. Non-blocking — a send failure (SES not verified
      // yet, etc.) never fails the patient's request.
      await notifyIntakeComplete(clientId);

      await audit(event, { actorType: 'patient_link', practiceId: client.practice_id }, {
        action: 'patient_link.save_insurance',
        resourceType: 'client',
        resourceId: client.id,
      });

      // No status write here either. The client stays 'awaiting_info' — on the
      // practice's follow-up list — until a clinician confirms on the chart.
      return json(200, { ok: true }, event);
    }

    return json(404, { error: 'Not found' }, event);
  } catch (err) {
    console.error('card_setup error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
