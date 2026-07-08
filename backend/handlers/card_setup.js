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

const db = require('../lib/db');
const paymentToken = require('../lib/payment_token');
const { json, preflight } = require('../lib/response');
const { parseBody, normalizePhone } = require('../lib/util');
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

// Resolve the practice's notification recipient for intake alerts: the explicit
// practices.notification_email ONLY. There is deliberately no fallback to a staff
// login — a practice_admin's `email` may be a username (e.g. "BigRedd"), and
// handing that to SES fails with "Missing final '@domain'". Returns null when
// no notification_email is set (the caller then simply skips the email); the
// email helper independently rejects any non-email value. Best-effort; never
// throws to the request path.
async function resolveNotificationEmail(practiceId) {
  try {
    const r = await db.query(
      `select nullif(notification_email, '') as recipient
         from practices
        where id = $1
        limit 1`,
      [practiceId]
    );
    const recipient = r.rows[0] && r.rows[0].recipient;
    return recipient && String(recipient).trim() !== '' ? String(recipient).trim() : null;
  } catch (err) {
    console.warn('card_setup resolveNotificationEmail failed:', err && err.message);
    return null;
  }
}

// Fire the "intake completed" admin email after the final intake step (insurance
// saved). Best-effort and fully non-blocking: any failure (SES not verified yet,
// no recipient, send error) is logged and swallowed so the patient's request
// still succeeds. PHI-minimal — only the client's name + a chart link are sent.
async function notifyIntakeComplete(client) {
  try {
    const to = await resolveNotificationEmail(client.practice_id);
    if (!to) return;
    const clientName = [client.first_name, client.last_name].filter(Boolean).join(' ').trim();
    await email.sendIntakeCompletionEmail({
      to,
      clientId: client.id,
      clientName,
      completedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('card_setup notifyIntakeComplete failed:', err && err.message);
  }
}

// Trim to a string, capping length. Returns '' for non-strings / null.
const MAX_FIELD_LEN = 200;
function cleanField(v) {
  if (typeof v !== 'string') return '';
  return v.trim();
}

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
      await db.query(
        `update clients
            set payment_method_id = $1,
                payment_method_brand = $2,
                payment_method_last4 = $3,
                payment_method_exp_month = $4,
                payment_method_exp_year = $5,
                payment_method_set_at = now()
          where id = $6 and is_hidden = false`,
        [
          paymentMethodId,
          body.brand || null,
          body.last4 || null,
          body.exp_month != null ? body.exp_month : null,
          body.exp_year != null ? body.exp_year : null,
          clientId,
        ]
      );
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
      // Patient-supplied demographics needed to build a claim: date of birth +
      // current address. Persisted to the clients row (columns already exist —
      // db/migrations/002). All optional individually; a blank field never nulls
      // out existing data (coalesce(nullif(...))). No card/PCI data here.
      const dateOfBirth = cleanField(body.date_of_birth);
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
            address_line1 = coalesce(nullif($2, ''), address_line1),
            address_line2 = coalesce(nullif($3, ''), address_line2),
            city          = coalesce(nullif($4, ''), city),
            state         = coalesce(nullif($5, ''), state),
            postal_code   = coalesce(nullif($6, ''), postal_code),
            phone         = coalesce(nullif($7, ''), phone)
          where id = $8 and is_hidden = false`,
        [dateOfBirth, addressLine1, addressLine2, city, state, postalCode, phone, clientId]
      );
      if (result.rowCount === 0) return json(404, { error: 'Not found' }, event);
      return json(200, { ok: true }, event);
    }

    if (path === 'save-insurance') {
      // Patient-supplied OON insurance info. Required: carrier_name, member_id.
      // Optional: group_number, subscriber_relationship, subscriber_name,
      // subscriber_dob, payer_id. Trim everything; reject anything over 200 chars.
      const carrierName = cleanField(body.carrier_name);
      const memberId = cleanField(body.member_id);
      const groupNumber = cleanField(body.group_number);
      const subscriberRelationship = cleanField(body.subscriber_relationship);
      const subscriberName = cleanField(body.subscriber_name);
      const subscriberDob = cleanField(body.subscriber_dob);
      // payer_id maps to insurance_records.payer_id varchar(50). Optional — a
      // patient who free-types a carrier that isn't matched submits none.
      const payerId = cleanField(body.payer_id);

      if (!carrierName) return json(400, { error: 'Insurance company is required.' }, event);
      if (!memberId) return json(400, { error: 'Member ID is required.' }, event);

      for (const v of [carrierName, memberId, groupNumber, subscriberRelationship, subscriberName, subscriberDob]) {
        if (v.length > MAX_FIELD_LEN) return json(400, { error: 'One of the fields is too long.' }, event);
      }
      if (payerId.length > 50) return json(400, { error: 'One of the fields is too long.' }, event);
      if (subscriberRelationship && !['self', 'spouse', 'child', 'other'].includes(subscriberRelationship)) {
        return json(400, { error: 'Invalid policyholder relationship.' }, event);
      }
      if (subscriberDob && !/^\d{4}-\d{2}-\d{2}$/.test(subscriberDob)) {
        return json(400, { error: 'Date of birth must be YYYY-MM-DD.' }, event);
      }

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
        // existing data. coalesce(nullif($n, ''), col) keeps the current value
        // when the incoming field is blank.
        await db.query(
          `update insurance_records set
              carrier_name            = coalesce(nullif($1, ''), carrier_name),
              member_id               = coalesce(nullif($2, ''), member_id),
              group_number            = coalesce(nullif($3, ''), group_number),
              subscriber_relationship = coalesce(nullif($4, ''), subscriber_relationship),
              subscriber_name         = coalesce(nullif($5, ''), subscriber_name),
              subscriber_dob          = coalesce(nullif($6, '')::date, subscriber_dob),
              payer_id                = coalesce(nullif($7, ''), payer_id)
            where id = $8`,
          [carrierName, memberId, groupNumber, subscriberRelationship, subscriberName, subscriberDob, payerId, existing.rows[0].id]
        );
      } else {
        await db.query(
          `insert into insurance_records
             (practice_id, client_id, carrier_name, member_id, group_number,
              subscriber_relationship, subscriber_name, subscriber_dob, payer_id, is_primary)
           values ($1, $2, $3, $4, nullif($5, ''), nullif($6, ''), nullif($7, ''), nullif($8, '')::date, nullif($9, ''), true)`,
          [
            client.practice_id,
            clientId,
            carrierName,
            memberId,
            groupNumber,
            subscriberRelationship,
            subscriberName,
            subscriberDob,
            payerId,
          ]
        );
      }

      // Insurance is the final intake step: card + demographics + insurance are
      // now on file. Notify the practice admin. Non-blocking — a send failure
      // (SES not verified yet, etc.) never fails the patient's request.
      await notifyIntakeComplete(client);

      return json(200, { ok: true }, event);
    }

    return json(404, { error: 'Not found' }, event);
  } catch (err) {
    console.error('card_setup error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
