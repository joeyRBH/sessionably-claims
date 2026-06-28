'use strict';

// POST /save-payment-method — PUBLIC Vercel serverless function (no JWT). Called by
// the patient card-capture page after Stripe.js confirms the SetupIntent.
//
// On Vercel for outbound access to Stripe; reaches Postgres via DATABASE_URL. Reuses
// the shared backend libs so behavior matches the rest of the app.
//
// Body: { token, paymentMethodId }. Verify the token, attach the PaymentMethod to the
// client's Stripe Customer, set it as the customer default, and persist the
// display-only card summary. NEVER store a raw PAN/CVC (PCI); never log PHI.

const db = require('../backend/lib/db');
const stripe = require('../backend/lib/stripe');
const paymentToken = require('../backend/lib/payment_token');
const { ALLOWED_ORIGINS } = require('../backend/lib/response');

function applyCors(req, res) {
  const origin = req.headers.origin;
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[ALLOWED_ORIGINS.length - 1];
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function parseBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === 'object') return req.body;
  try {
    return JSON.parse(req.body);
  } catch (_) {
    return {};
  }
}

async function loadClient(clientId) {
  const result = await db.query(
    `select * from clients where id = $1 and is_hidden = false limit 1`,
    [clientId]
  );
  return result.rows[0] || null;
}

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = parseBody(req);

    let clientId;
    try {
      ({ client_id: clientId } = paymentToken.verify(body.token));
    } catch (_) {
      return res.status(401).json({ error: 'Invalid or expired link.' });
    }

    const paymentMethodId = body.paymentMethodId;
    if (!paymentMethodId || typeof paymentMethodId !== 'string') {
      return res.status(400).json({ error: 'Missing paymentMethodId.' });
    }

    const client = await loadClient(clientId);
    if (!client) return res.status(404).json({ error: 'Not found' });
    if (!client.stripe_customer_id) {
      return res.status(409).json({ error: 'Card setup was not started. Reload the link and try again.' });
    }

    // Attach → read details → set as default.
    await stripe.attachPaymentMethod(paymentMethodId, client.stripe_customer_id);
    const pm = await stripe.retrievePaymentMethod(paymentMethodId);
    await stripe.setDefaultPaymentMethod(client.stripe_customer_id, paymentMethodId);

    const card = (pm && pm.card) || {};

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
        card.brand || null,
        card.last4 || null,
        card.exp_month != null ? card.exp_month : null,
        card.exp_year != null ? card.exp_year : null,
        client.id,
      ]
    );

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('save_payment_method error:', err && err.message);
    return res.status(500).json({ error: 'Could not save your card. Please try again.' });
  }
};
