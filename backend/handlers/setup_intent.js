'use strict';

// POST /setup-intent — PUBLIC (no JWT). Called by the patient card-capture page.
//
// Body: { token } — the short-lived signed token (lib/payment_token) carrying the
// client_id. We verify it, find the client, ensure a Stripe Customer exists, and
// return a SetupIntent client_secret + the publishable key so Stripe.js can collect
// the card in the browser. No card data ever touches this Lambda (PCI: handled by
// Stripe.js); we never log PHI.

const db = require('../lib/db');
const { json, preflight } = require('../lib/response');
const { parseBody } = require('../lib/util');
const paymentToken = require('../lib/payment_token');
const stripe = require('../lib/stripe');

function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

async function loadClient(clientId) {
  const res = await db.query(
    `select * from clients where id = $1 and is_hidden = false limit 1`,
    [clientId]
  );
  return res.rows[0] || null;
}

exports.handler = async (event) => {
  const method = httpMethod(event);
  if (method === 'OPTIONS') return preflight(event);
  if (method !== 'POST') return json(405, { error: 'Method not allowed' }, event);

  try {
    const body = parseBody(event);

    let clientId;
    try {
      ({ client_id: clientId } = paymentToken.verify(body.token));
    } catch (_) {
      return json(401, { error: 'Invalid or expired link.' }, event);
    }

    const client = await loadClient(clientId);
    if (!client) return json(404, { error: 'Not found' }, event);

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

    return json(
      200,
      { clientSecret: setupIntent.client_secret, publishableKey: stripe.publishableKey() },
      event
    );
  } catch (err) {
    console.error('setup_intent error:', err && err.message);
    return json(500, { error: 'Could not start card setup.' }, event);
  }
};
