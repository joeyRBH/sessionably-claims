'use strict';

// POST /save-payment-method — PUBLIC (no JWT). Called by the patient card-capture
// page after Stripe.js confirms the SetupIntent.
//
// Body: { token, paymentMethodId }. We verify the token, attach the PaymentMethod
// to the client's Stripe Customer, set it as the customer default, and persist the
// display-only card summary (brand / last4 / exp) on the client. We NEVER store a
// raw PAN/CVC (PCI) and never log PHI.

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

    const paymentMethodId = body.paymentMethodId;
    if (!paymentMethodId || typeof paymentMethodId !== 'string') {
      return json(400, { error: 'Missing paymentMethodId.' }, event);
    }

    const client = await loadClient(clientId);
    if (!client) return json(404, { error: 'Not found' }, event);
    if (!client.stripe_customer_id) {
      return json(409, { error: 'Card setup was not started. Reload the link and try again.' }, event);
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

    return json(200, { ok: true }, event);
  } catch (err) {
    console.error('save_payment_method error:', err && err.message);
    return json(500, { error: 'Could not save your card. Please try again.' }, event);
  }
};
