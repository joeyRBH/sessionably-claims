'use strict';

// POST /clients/{id}/send-payment-link — JWT-authenticated (staff only).
//
// Generates a short-lived signed token for the client, builds the patient
// card-capture URL (APP_BASE_URL/card-setup?token=...), and texts it to the
// client's phone via Twilio. The client never logs in — this SMS is how they reach
// the card-capture page. practice_id is always derived from the caller; the client
// must belong to the caller's practice. Never logs PHI.
//
// NOTE: sending requires outbound HTTPS to api.twilio.com. The auth Lambdas run in
// a VPC without NAT egress (see CLAUDE.md) — reaching Twilio needs a NAT gateway /
// VPC endpoint or moving this to a Vercel function. Flagged for infra follow-up.

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const paymentToken = require('../lib/payment_token');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

function pathId(event) {
  return event && event.pathParameters ? event.pathParameters.id : undefined;
}

function isUUID(v) {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

async function loadPracticeId(userId) {
  const res = await db.query(
    `select practice_id from users where id = $1 and is_active = true limit 1`,
    [userId]
  );
  return res.rows[0] ? res.rows[0].practice_id : null;
}

// Send an SMS via the Twilio REST API (basic auth, form-encoded). Throws on failure.
async function sendSms(to, bodyText) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    throw new Error('Twilio is not configured');
  }

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const form = new URLSearchParams({ To: to, From: from, Body: bodyText }).toString();

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form,
    }
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // data.message is Twilio's error text (no PHI); safe to surface generically.
    const err = new Error((data && data.message) || `Twilio HTTP ${res.status}`);
    err.statusCode = res.status;
    throw err;
  }
  return data;
}

exports.handler = async (event) => {
  const method = httpMethod(event);
  if (method === 'OPTIONS') return preflight(event);

  let auth;
  try {
    auth = requireAuth(event);
  } catch (err) {
    return json(err.statusCode || 401, { error: 'Unauthorized' }, event);
  }

  if (method !== 'POST') return json(405, { error: 'Method not allowed' }, event);

  try {
    const practiceId = await loadPracticeId(auth.user.sub);
    if (!practiceId) return json(401, { error: 'Unauthorized' }, event);

    const id = pathId(event);
    if (!isUUID(id)) return json(404, { error: 'Not found' }, event);

    const clientRes = await db.query(
      `select * from clients where id = $1 and practice_id = $2 and is_hidden = false limit 1`,
      [id, practiceId]
    );
    const client = clientRes.rows[0];
    if (!client) return json(404, { error: 'Not found' }, event);

    if (!client.phone || String(client.phone).trim() === '') {
      return json(400, { error: 'This client has no phone number on file.' }, event);
    }

    const practiceRes = await db.query(`select name from practices where id = $1 limit 1`, [practiceId]);
    const practiceName = (practiceRes.rows[0] && practiceRes.rows[0].name) || 'Your practice';

    const appBaseUrl = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
    if (!appBaseUrl) {
      console.error('send_payment_link error: APP_BASE_URL is not set');
      return json(500, { error: 'Messaging is not configured.' }, event);
    }

    const token = paymentToken.sign(client.id);
    const url = `${appBaseUrl}/card-setup?token=${encodeURIComponent(token)}`;

    const message =
      `Hi ${client.first_name || 'there'}, ${practiceName} has invited you to securely ` +
      `save a payment method for your insurance claim submissions. Tap here to add your card:\n` +
      `${url}\n\n` +
      `This link expires in 24 hours. Reply STOP to opt out.`;

    try {
      await sendSms(String(client.phone).trim(), message);
    } catch (smsErr) {
      console.error('send_payment_link (twilio) error:', smsErr && smsErr.message);
      return json(502, { error: 'Could not send the text message. Check the phone number and try again.' }, event);
    }

    await db.query(
      `update clients set payment_link_sent_at = now() where id = $1 and practice_id = $2 and is_hidden = false`,
      [client.id, practiceId]
    );

    return json(200, { ok: true }, event);
  } catch (err) {
    console.error('send_payment_link error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
