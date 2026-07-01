'use strict';

// Subscription / billing resource — one Lambda, two routes:
//
//   GET  /subscription/status        → the caller's practice plan + VOB usage.
//   POST /subscription/vob/activate  → start a Stripe Checkout Session for the
//                                      $25/month Instant VOB add-on.
//
// The webhook that actually flips the plan on payment lives as a Vercel function
// (api/vob-webhook.js), because a Stripe webhook needs a public, egress-capable
// endpoint. Activation returns a checkoutUrl; the browser redirects the user there.
//
// NOTE (infra): the VPC Lambdas have no NAT egress (see CLAUDE.md / lib/stripe.js),
// so the /subscription/vob/activate call to Stripe requires a NAT gateway or an
// api.stripe.com VPC endpoint — otherwise this route must move to Vercel like the
// other Stripe calls. The handler logic is identical either way.
//
// Security: practice_id / plan / role are derived from the authenticated user's
// active row, never trusted from the body. Activation is restricted to admins.

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const stripe = require('../lib/stripe');

const VOB_PRICE_CENTS = 2500; // $25.00 / month
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://app.reddably.com';

// --- request helpers ---------------------------------------------------------

function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

// Path tail after "subscription/" so one Lambda can serve both routes regardless
// of API Gateway payload format. E.g. "status" or "vob/activate".
function subPath(event) {
  const raw =
    (event && event.rawPath) ||
    (event && event.requestContext && event.requestContext.http && event.requestContext.http.path) ||
    (event && event.path) ||
    '';
  const cleaned = String(raw).replace(/^\/+|\/+$/g, '');
  const idx = cleaned.indexOf('subscription/');
  return idx === -1 ? '' : cleaned.slice(idx + 'subscription/'.length);
}

// --- practice scoping --------------------------------------------------------

async function loadContext(userId) {
  const res = await db.query(
    `select u.role         as role,
            u.email        as email,
            u.first_name   as first_name,
            u.last_name    as last_name,
            p.id           as practice_id,
            p.name         as practice_name,
            p.plan         as plan,
            p.vob_checks_used  as vob_checks_used,
            p.vob_period_start as vob_period_start,
            p.stripe_customer_id as stripe_customer_id
       from users u
       join practices p on p.id = u.practice_id
      where u.id = $1 and u.is_active = true
      limit 1`,
    [userId]
  );
  return res.rows[0] || null;
}

// --- routes ------------------------------------------------------------------

function getStatus(ctx, event) {
  return json(
    200,
    {
      plan: ctx.plan,
      vob_checks_used: ctx.vob_checks_used,
      vob_period_start: ctx.vob_period_start,
    },
    event
  );
}

async function activateVob(ctx, event) {
  // Billing changes are an admin action.
  if (ctx.role !== 'practice_admin') {
    return json(403, { error: 'Only a practice admin can change billing.' }, event);
  }
  if (ctx.plan === 'founder') {
    return json(400, { error: 'Founder plan already includes Instant VOB.' }, event);
  }
  if (ctx.plan === 'vob') {
    return json(400, { error: 'The Instant VOB add-on is already active.' }, event);
  }

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
    console.error('subscription activate (stripe) error:', err && err.message);
    return json(502, { error: 'Could not start checkout.' }, event);
  }

  if (!session || !session.url) {
    return json(502, { error: 'Could not start checkout.' }, event);
  }
  return json(200, { checkoutUrl: session.url }, event);
}

// --- entrypoint --------------------------------------------------------------

exports.handler = async (event) => {
  const method = httpMethod(event);
  if (method === 'OPTIONS') {
    return preflight(event);
  }

  let auth;
  try {
    auth = requireAuth(event);
  } catch (err) {
    return json(err.statusCode || 401, { error: 'Unauthorized' }, event);
  }

  try {
    const ctx = await loadContext(auth.user.sub);
    if (!ctx) {
      return json(401, { error: 'Unauthorized' }, event);
    }

    const path = subPath(event);
    if (method === 'GET' && path === 'status') return getStatus(ctx, event);
    if (method === 'POST' && path === 'vob/activate') return await activateVob(ctx, event);

    return json(404, { error: 'Not found' }, event);
  } catch (err) {
    console.error('subscription error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
