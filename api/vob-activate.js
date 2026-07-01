'use strict';

// POST /subscription/vob/activate — Vercel serverless function, STAFF JWT-authenticated.
//
// Starts a Stripe Checkout Session for the $25/month Instant VOB add-on. It lives
// on Vercel (not Lambda) because the VPC Lambdas have no NAT egress to Stripe (see
// CLAUDE.md / lib/stripe.js), same as the other Stripe calls (setup-intent,
// charge-fee). The browser already holds the staff session JWT and forwards it as a
// Bearer token; this function verifies it with JWT_SECRET (shared lib/auth), derives
// the practice + plan from the DB, and returns { checkoutUrl } for the browser to
// redirect to. The webhook (api/vob-webhook.js) flips the plan once payment lands.
//
// Security: practice_id / plan / role come from the authenticated user's active row,
// never the body. Activation is admin-only. Never logs PHI.

const db = require('../backend/lib/db');
const stripe = require('../backend/lib/stripe');
const { requireAuth } = require('../backend/lib/auth');
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

async function loadContext(userId) {
  const r = await db.query(
    `select u.role         as role,
            u.email        as email,
            p.id           as practice_id,
            p.name         as practice_name,
            p.plan         as plan,
            p.stripe_customer_id as stripe_customer_id
       from users u
       join practices p on p.id = u.practice_id
      where u.id = $1 and u.is_active = true
      limit 1`,
    [userId]
  );
  return r.rows[0] || null;
}

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Authenticate the staff session JWT (forwarded from the browser).
  let auth;
  try {
    auth = requireAuth({ headers: req.headers });
  } catch (_) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const ctx = await loadContext(auth.user.sub);
    if (!ctx) return res.status(401).json({ error: 'Unauthorized' });

    // Billing changes are an admin action.
    if (ctx.role !== 'practice_admin') {
      return res.status(403).json({ error: 'Only a practice admin can change billing.' });
    }
    if (ctx.plan === 'founder') {
      return res.status(400).json({ error: 'Founder plan already includes Instant VOB.' });
    }
    if (ctx.plan === 'vob') {
      return res.status(400).json({ error: 'The Instant VOB add-on is already active.' });
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
