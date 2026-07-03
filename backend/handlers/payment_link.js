'use strict';

// Payment-link resource — the DB side of the "text the patient a card-setup link"
// action. Runs in the VPC (reaches RDS); the Twilio send stays on the Vercel
// adapter (api/clients/[id]/send-payment-link.js), which has outbound egress.
//
//   POST /clients/{id}/payment-link → build the SMS the adapter should send
//
// It loads the client + practice (practice-scoped to the caller), signs the
// short-lived card-setup token, records payment_link_sent_at, and returns
// { to, body } — the recipient number and the ready-to-send message. The Vercel
// adapter forwards the caller's staff Bearer token here and only performs the
// Twilio call. Clients are PHI — error logs never include names or contact info.

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const paymentToken = require('../lib/payment_token');
const { json, preflight } = require('../lib/response');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// card-setup.html is served by the Vercel project at reddably.com/card-setup (it
// 404s on app.reddably.com), so default to reddably.com — matching the adapter.
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://reddably.com').replace(/\/+$/, '');

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
  const r = await db.query(
    `select practice_id from users where id = $1 and is_active = true limit 1`,
    [userId]
  );
  return r.rows[0] ? r.rows[0].practice_id : null;
}

exports.handler = async (event) => {
  const method = httpMethod(event);
  if (method === 'OPTIONS') return preflight(event);
  if (method !== 'POST') return json(405, { error: 'Method not allowed' }, event);

  let auth;
  try {
    auth = requireAuth(event);
  } catch (err) {
    return json(err.statusCode || 401, { error: 'Unauthorized' }, event);
  }

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

    const token = paymentToken.sign(client.id);
    const url = `${APP_BASE_URL}/card-setup?token=${encodeURIComponent(token)}`;

    const messageBody =
      `Hi ${client.first_name || 'there'}, ${practiceName} has invited you to securely ` +
      `save a payment method and your insurance information for your claim submissions. ` +
      `Tap here to get started:\n` +
      `${url}\n\n` +
      `This link expires in 24 hours. Reply STOP to opt out.`;

    // Record the attempt now (the adapter only performs the outbound send next).
    await db.query(
      `update clients set payment_link_sent_at = now() where id = $1 and practice_id = $2 and is_hidden = false`,
      [client.id, practiceId]
    );

    return json(200, { to: String(client.phone).trim(), body: messageBody }, event);
  } catch (err) {
    console.error('payment_link error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
