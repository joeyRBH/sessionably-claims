'use strict';

// POST /save-payment-method — PUBLIC Vercel adapter (no JWT), Stripe egress. Called
// by the patient card-capture page after Stripe.js confirms the SetupIntent.
//
// The VPC-private RDS is unreachable from Vercel, so DB access lives on the Lambda
// API. This adapter resolves the client behind the signed token via
//   POST {LAMBDA_API_BASE}/card-setup/context   { token }
// attaches the PaymentMethod to the client's Stripe Customer and sets it default
// (Stripe egress), then persists the display-only card summary via
//   POST {LAMBDA_API_BASE}/card-setup/save-payment-method { token, paymentMethodId, ... }
// NEVER store a raw PAN/CVC (PCI); never log PHI.

const stripe = require('../backend/lib/stripe');
const { callLambda } = require('../backend/lib/lambda_api');
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

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = parseBody(req);
    const token = body.token;

    const paymentMethodId = body.paymentMethodId;
    if (!paymentMethodId || typeof paymentMethodId !== 'string') {
      return res.status(400).json({ error: 'Missing paymentMethodId.' });
    }

    // Resolve the client (DB) via the Lambda API; it verifies the token.
    const ctxRes = await callLambda('/card-setup/context', { method: 'POST', body: { token } });
    if (ctxRes.status !== 200) {
      return res.status(ctxRes.status).json(ctxRes.data || { error: 'Could not save your card. Please try again.' });
    }
    const client = ctxRes.data || {};
    if (!client.stripe_customer_id) {
      return res.status(409).json({ error: 'Card setup was not started. Reload the link and try again.' });
    }

    // Attach → read details → set as default (Stripe egress).
    await stripe.attachPaymentMethod(paymentMethodId, client.stripe_customer_id);
    const pm = await stripe.retrievePaymentMethod(paymentMethodId);
    await stripe.setDefaultPaymentMethod(client.stripe_customer_id, paymentMethodId);

    const card = (pm && pm.card) || {};

    // Persist the display-only summary via the Lambda API.
    const saveRes = await callLambda('/card-setup/save-payment-method', {
      method: 'POST',
      body: {
        token,
        paymentMethodId,
        brand: card.brand || null,
        last4: card.last4 || null,
        exp_month: card.exp_month != null ? card.exp_month : null,
        exp_year: card.exp_year != null ? card.exp_year : null,
      },
    });
    if (saveRes.status !== 200) {
      return res.status(saveRes.status).json(saveRes.data || { error: 'Could not save your card. Please try again.' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('save_payment_method error:', err && err.message);
    return res.status(500).json({ error: 'Could not save your card. Please try again.' });
  }
};
