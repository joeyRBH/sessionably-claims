'use strict';

// POST /clients/:id/send-payment-link — Vercel adapter (staff JWT), Twilio egress.
//
// The VPC-private RDS is unreachable from Vercel, so all DB work lives on the Lambda
// API: this adapter forwards the caller's staff Bearer token to
//   POST {LAMBDA_API_BASE}/clients/:id/payment-link
// which loads the client + practice, signs the card-setup token, records
// payment_link_sent_at, and returns { to, body }. This function then only sends that
// SMS via Twilio (the one thing that needs outbound internet). Never logs PHI.

const { callLambda } = require('../../../backend/lib/lambda_api');
const { ALLOWED_ORIGINS, DEFAULT_ORIGIN } = require('../../../backend/lib/response');

function applyCors(req, res) {
  const origin = req.headers.origin;
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : DEFAULT_ORIGIN;
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const id = req.query && req.query.id;

  // DB work + message assembly happen in the VPC Lambda (auth is enforced there).
  let prep;
  try {
    prep = await callLambda(`/clients/${encodeURIComponent(id || '')}/payment-link`, {
      method: 'POST',
      token: req.headers.authorization,
      body: {},
    });
  } catch (err) {
    console.error('send_payment_link (lambda) error:', err && err.message);
    return res.status(502).json({ error: 'Service is temporarily unavailable. Please try again.' });
  }

  // Relay the Lambda's own 401/404/400 verbatim (auth failure, no client, no phone).
  if (prep.status !== 200) {
    return res.status(prep.status).json(prep.data || { error: 'Could not send the payment link.' });
  }

  const { to, body } = prep.data || {};
  if (!to || !body) {
    return res.status(502).json({ error: 'Could not build the message. Please try again.' });
  }

  try {
    await sendSms(to, body);
  } catch (smsErr) {
    console.error('send_payment_link (twilio) error:', smsErr && smsErr.message);
    return res.status(502).json({ error: 'Could not send the text message. Check the phone number and try again.' });
  }

  return res.status(200).json({ ok: true });
};
