'use strict';

// POST /setup-intent — PUBLIC Vercel serverless function (no JWT). Called by the
// patient card-capture page (public/card-setup.html).
//
// This lives on Vercel (not Lambda) so it has free outbound internet to Stripe,
// while still reaching Postgres via DATABASE_URL. It reuses the shared backend libs
// (db, stripe, payment_token) so the logic stays identical to the rest of the app.
//
// Body: { token } — short-lived signed token (lib/payment_token) carrying client_id.
// Verify it, find the client, ensure a Stripe Customer exists, and return a
// SetupIntent client_secret + publishable key for Stripe.js. No card data touches
// this function (PCI: collected by Stripe.js); never log PHI.

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

    const client = await loadClient(clientId);
    if (!client) return res.status(404).json({ error: 'Not found' });

    // Create the Stripe Customer once, then reuse it on subsequent visits.
    let customerId = client.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.createCustomer({
        name: `${client.first_name || ''} ${client.last_name || ''}`.trim() || undefined,
        email: client.email || undefined,
        metadata: { client_id: client.id, practice_id: client.practice_id },
      });
      customerId = customer.id;
      await db.query(
        `update clients set stripe_customer_id = $1 where id = $2 and is_hidden = false`,
        [customerId, client.id]
      );
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
