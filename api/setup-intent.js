'use strict';

// POST /setup-intent — PUBLIC Vercel adapter (no JWT), Stripe egress. Called by the
// patient card-capture page (public/card-setup.html).
//
// The VPC-private RDS is unreachable from Vercel, so DB access lives on the Lambda
// API. This adapter resolves the client behind the signed token via
//   POST {LAMBDA_API_BASE}/card-setup/context   { token }
// ensures a Stripe Customer exists (creating one on Stripe and persisting it via
//   POST {LAMBDA_API_BASE}/card-setup/save-customer  { token, stripe_customer_id }),
// then returns a SetupIntent client_secret + publishable key for Stripe.js.
// No card data touches this function (PCI: collected by Stripe.js); never log PHI.

const stripe = require('../backend/lib/stripe');
const { callLambda } = require('../backend/lib/lambda_api');
const { ALLOWED_ORIGINS, DEFAULT_ORIGIN } = require('../backend/lib/response');

function applyCors(req, res) {
  const origin = req.headers.origin;
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : DEFAULT_ORIGIN;
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

    // Resolve the client (DB) via the Lambda API; it verifies the token.
    const ctxRes = await callLambda('/card-setup/context', { method: 'POST', body: { token } });
    if (ctxRes.status !== 200) {
      return res.status(ctxRes.status).json(ctxRes.data || { error: 'Could not start card setup.' });
    }
    const client = ctxRes.data || {};

    // Create the Stripe Customer once, then reuse it on subsequent visits.
    let customerId = client.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.createCustomer({
        name: `${client.first_name || ''} ${client.last_name || ''}`.trim() || undefined,
        email: client.email || undefined,
        metadata: { client_id: client.client_id, practice_id: client.practice_id },
      });
      customerId = customer.id;
      // Persist via the Lambda API (first-writer-wins on the client row).
      await callLambda('/card-setup/save-customer', {
        method: 'POST',
        body: { token, stripe_customer_id: customerId },
      });
    }

    const setupIntent = await stripe.createSetupIntent({ customer: customerId });

    return res.status(200).json({
      clientSecret: setupIntent.client_secret,
      publishableKey: stripe.publishableKey(),
    });
  } catch (err) {
    console.error('setup_intent error:', err && err.message);
    return res.status(500).json({ error: 'Could not start card setup.' });
  }
};
