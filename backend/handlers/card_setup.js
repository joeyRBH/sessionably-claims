'use strict';

// Card-setup resource — the DB side of the PUBLIC patient card-capture flow.
// Runs in the VPC (reaches RDS); the Stripe calls stay on the Vercel adapters
// (api/setup-intent.js, api/save-payment-method.js) which have outbound egress.
// Those adapters call these routes over HTTPS for all DB access:
//
//   POST /card-setup/context              → resolve the client behind the token
//   POST /card-setup/save-customer        → persist a newly created Stripe customer id
//   POST /card-setup/save-payment-method  → persist the display-only card summary
//
// Auth: the short-lived signed payment token (lib/payment_token) carried in the
// body as { token } — the same credential the Vercel functions verified before.
// The token yields a client_id; every query is scoped to that client. This is a
// patient (non-staff) flow, so there is no requireAuth / practice JWT here.
// Never store a raw PAN/CVC (PCI); never log PHI.

const db = require('../lib/db');
const paymentToken = require('../lib/payment_token');
const { json, preflight } = require('../lib/response');
const { parseBody } = require('../lib/util');

function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

// Path tail after "card-setup/" so routing is payload-format agnostic.
function subPath(event) {
  const raw =
    (event && event.rawPath) ||
    (event && event.requestContext && event.requestContext.http && event.requestContext.http.path) ||
    (event && event.path) ||
    '';
  const cleaned = String(raw).replace(/^\/+|\/+$/g, '');
  const idx = cleaned.indexOf('card-setup/');
  return idx === -1 ? '' : cleaned.slice(idx + 'card-setup/'.length);
}

// Resolve the client_id from the token, or throw. Kept separate so every route
// enforces the same token check.
function clientIdFromBody(body) {
  const { client_id: clientId } = paymentToken.verify(body.token);
  return clientId;
}

async function loadClient(clientId) {
  const r = await db.query(
    `select * from clients where id = $1 and is_hidden = false limit 1`,
    [clientId]
  );
  return r.rows[0] || null;
}

exports.handler = async (event) => {
  const method = httpMethod(event);
  if (method === 'OPTIONS') return preflight(event);
  if (method !== 'POST') return json(405, { error: 'Method not allowed' }, event);

  const body = parseBody(event);

  // Token is the credential for every route here.
  let clientId;
  try {
    clientId = clientIdFromBody(body);
  } catch (_) {
    return json(401, { error: 'Invalid or expired link.' }, event);
  }

  try {
    const path = subPath(event);

    if (path === 'context') {
      const client = await loadClient(clientId);
      if (!client) return json(404, { error: 'Not found' }, event);
      return json(
        200,
        {
          client_id: client.id,
          practice_id: client.practice_id,
          stripe_customer_id: client.stripe_customer_id || null,
          first_name: client.first_name || null,
          last_name: client.last_name || null,
          email: client.email || null,
        },
        event
      );
    }

    if (path === 'save-customer') {
      const customerId = body.stripe_customer_id;
      if (!customerId || typeof customerId !== 'string') {
        return json(400, { error: 'Missing stripe_customer_id.' }, event);
      }
      // Only set it if not already present (first writer wins), scoped to the token's client.
      await db.query(
        `update clients set stripe_customer_id = $1
          where id = $2 and is_hidden = false and stripe_customer_id is null`,
        [customerId, clientId]
      );
      return json(200, { ok: true }, event);
    }

    if (path === 'save-payment-method') {
      const paymentMethodId = body.paymentMethodId;
      if (!paymentMethodId || typeof paymentMethodId !== 'string') {
        return json(400, { error: 'Missing paymentMethodId.' }, event);
      }
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
          body.brand || null,
          body.last4 || null,
          body.exp_month != null ? body.exp_month : null,
          body.exp_year != null ? body.exp_year : null,
          clientId,
        ]
      );
      return json(200, { ok: true }, event);
    }

    return json(404, { error: 'Not found' }, event);
  } catch (err) {
    console.error('card_setup error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
