'use strict';

// POST /clients/:id/send-payment-link — JWT-authenticated Vercel function (staff).
//
// On Vercel for outbound access to Twilio; reaches Postgres via DATABASE_URL. Mirrors
// the path the app already calls (api-client.js → clients.sendPaymentLink). Generates
// a short-lived signed token, builds APP_BASE_URL/card-setup?token=..., and texts it
// to the client. practice_id is always derived from the caller; the client must
// belong to that practice. Never logs PHI.

const db = require('../../../backend/lib/db');
const { requireAuth } = require('../../../backend/lib/auth');
const paymentToken = require('../../../backend/lib/payment_token');
const { ALLOWED_ORIGINS } = require('../../../backend/lib/response');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function applyCors(req, res) {
  const origin = req.headers.origin;
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[ALLOWED_ORIGINS.length - 1];
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function isUUID(v) {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

async function loadPracticeId(userId) {
  const result = await db.query(
    `select practice_id from users where id = $1 and is_active = true limit 1`,
    [userId]
  );
  return result.rows[0] ? result.rows[0].practice_id : null;
}

// Send an SMS via the Twilio REST API (basic auth, form-encoded). Throws on failure.
async function sendSms(to, bodyText) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) throw new Error('Twilio is not configured');

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const form = new URLSearchParams({ To: to, From: from, Body: bodyText }).toString();

  const resp = await fetch(
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

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error((data && data.message) || `Twilio HTTP ${resp.status}`);
    err.statusCode = resp.status;
    throw err;
  }
  return data;
}

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  let auth;
  try {
    auth = requireAuth({ headers: req.headers });
  } catch (_) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const practiceId = await loadPracticeId(auth.user.sub);
    if (!practiceId) return res.status(401).json({ error: 'Unauthorized' });

    const id = req.query && req.query.id;
    if (!isUUID(id)) return res.status(404).json({ error: 'Not found' });

    const clientRes = await db.query(
      `select * from clients where id = $1 and practice_id = $2 and is_hidden = false limit 1`,
      [id, practiceId]
    );
    const client = clientRes.rows[0];
    if (!client) return res.status(404).json({ error: 'Not found' });

    if (!client.phone || String(client.phone).trim() === '') {
      return res.status(400).json({ error: 'This client has no phone number on file.' });
    }

    const practiceRes = await db.query(`select name from practices where id = $1 limit 1`, [practiceId]);
    const practiceName = (practiceRes.rows[0] && practiceRes.rows[0].name) || 'Your practice';

    const appBaseUrl = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
    if (!appBaseUrl) {
      console.error('send_payment_link error: APP_BASE_URL is not set');
      return res.status(500).json({ error: 'Messaging is not configured.' });
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
      return res.status(502).json({ error: 'Could not send the text message. Check the phone number and try again.' });
    }

    await db.query(
      `update clients set payment_link_sent_at = now() where id = $1 and practice_id = $2 and is_hidden = false`,
      [client.id, practiceId]
    );

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('send_payment_link error:', err && err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
