'use strict';

// POST /subscription/vob/activate — Vercel adapter (staff JWT), Stripe egress.
//
// The VPC-private RDS is unreachable from Vercel, so the gated DB context lives on
// the Lambda API: this adapter forwards the caller's staff Bearer token to
//   POST {LAMBDA_API_BASE}/subscription/vob/checkout-context
// which validates (admin-only; rejects founder/already-active) and returns
// { practice_id, stripe_customer_id, email }. This function then opens the Stripe
// Checkout Session (the part that needs outbound internet) and returns { checkoutUrl }.
// The webhook (Lambda: /subscription/vob/webhook) flips the plan once payment lands.

const stripe = require('../backend/lib/stripe');
const { callLambda } = require('../backend/lib/lambda_api');
const { ALLOWED_ORIGINS } = require('../backend/lib/response');

const VOB_PRICE_CENTS = 2500; // $25.00 / month
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://app.reddably.com';

function applyCors(req, res) {
  const origin = req.headers.origin;
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[ALLOWED_ORIGINS.length - 1];
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Gated DB context comes from the VPC Lambda (auth + admin/plan checks there).
  let ctxRes;
  try {
    ctxRes = await callLambda('/subscription/vob/checkout-context', {
      method: 'POST',
      token: req.headers.authorization,
      body: {},
    });
  } catch (err) {
    console.error('vob-activate (lambda) error:', err && err.message);
    return res.status(502).json({ error: 'Could not start checkout.' });
  }

  // Relay the Lambda's own 401/403/400 verbatim (unauth, non-admin, already active).
  if (ctxRes.status !== 200) {
    return res.status(ctxRes.status).json(ctxRes.data || { error: 'Could not start checkout.' });
  }
  const ctx = ctxRes.data || {};

  try {
    const params = {
      mode: 'subscription',
      success_url: `${APP_BASE_URL}/app#vob-activated`,
      cancel_url: `${APP_BASE_URL}/app#vob-cancelled`,
      // Index-keyed object → line_items[0][...] (see lib/stripe.createCheckoutSession).
      line_items: {
        0: {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: VOB_PRICE_CENTS,
            recurring: { interval: 'month' },
            product_data: {
              name: 'Reddably Instant VOB',
              description: 'Reddably Instant VOB — $25/month',
            },
          },
        },
      },
      // practice_id on both the session and the resulting subscription so either
      // webhook event can resolve the practice.
      metadata: { practice_id: ctx.practice_id },
      subscription_data: { metadata: { practice_id: ctx.practice_id } },
    };

    // Reuse the practice's Stripe customer when we have one; otherwise let Stripe
    // create one from the admin's email.
    if (ctx.stripe_customer_id) {
      params.customer = ctx.stripe_customer_id;
    } else if (ctx.email) {
      params.customer_email = ctx.email;
    }

    let session;
    try {
      session = await stripe.createCheckoutSession(params);
    } catch (err) {
      console.error('vob-activate (stripe) error:', err && err.message);
      return res.status(502).json({ error: 'Could not start checkout.' });
    }

    if (!session || !session.url) {
      return res.status(502).json({ error: 'Could not start checkout.' });
    }
    return res.status(200).json({ checkoutUrl: session.url });
  } catch (err) {
    console.error('vob-activate error:', err && err.message);
    return res.status(500).json({ error: 'Could not start checkout.' });
  }
};
