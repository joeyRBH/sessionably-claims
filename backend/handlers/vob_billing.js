'use strict';

// VOB billing resource — the parts of the Instant VOB add-on that need the DB.
//
//   POST /subscription/vob/checkout-context → gated context for Stripe Checkout
//   POST /subscription/vob/webhook          → Stripe subscription-lifecycle webhook
//
// checkout-context runs in the VPC and returns the (validated, admin-only) data the
// Vercel adapter (api/vob-activate.js) needs to open a Checkout Session on Stripe —
// the Stripe call itself stays on Vercel (egress). The webhook, by contrast, needs
// NO outbound (its signature check is local HMAC), so it moved here in full: point
// the Stripe endpoint at api.claimsub.com/subscription/vob/webhook.
//
// The webhook verifies STRIPE_VOB_WEBHOOK_SECRET (Lambda env, hydrated from SSM)
// against the exact raw body, reimplementing Stripe's scheme with crypto (SDK-free).
// Never logs PHI or the raw payload.

const crypto = require('crypto');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');

const SIGNATURE_TOLERANCE_SECONDS = 60 * 5;

function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

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

// --- checkout-context (staff, admin-only) ------------------------------------

async function loadContext(userId) {
  const r = await db.query(
    `select u.role               as role,
            u.email              as email,
            p.id                 as practice_id,
            p.name               as practice_name,
            p.plan               as plan,
            p.stripe_customer_id as stripe_customer_id
       from users u
       join practices p on p.id = u.practice_id
      where u.id = $1 and u.is_active = true
      limit 1`,
    [userId]
  );
  return r.rows[0] || null;
}

async function handleCheckoutContext(event) {
  let auth;
  try {
    auth = requireAuth(event);
  } catch (err) {
    return json(err.statusCode || 401, { error: 'Unauthorized' }, event);
  }

  const ctx = await loadContext(auth.user.sub);
  if (!ctx) return json(401, { error: 'Unauthorized' }, event);

  if (ctx.role !== 'practice_admin') {
    return json(403, { error: 'Only a practice admin can change billing.' }, event);
  }
  if (ctx.plan === 'founder') {
    return json(400, { error: 'Founder plan already includes Instant VOB.' }, event);
  }
  if (ctx.plan === 'vob') {
    return json(400, { error: 'The Instant VOB add-on is already active.' }, event);
  }

  return json(
    200,
    {
      practice_id: ctx.practice_id,
      practice_name: ctx.practice_name,
      stripe_customer_id: ctx.stripe_customer_id || null,
      email: ctx.email || null,
    },
    event
  );
}

// --- webhook (Stripe signature) ----------------------------------------------

function rawBodyBuffer(event) {
  const body = event && event.body != null ? event.body : '';
  return event && event.isBase64Encoded
    ? Buffer.from(body, 'base64')
    : Buffer.from(body, 'utf8');
}

function parseSignatureHeader(header) {
  const out = { t: null, v1: [] };
  String(header || '')
    .split(',')
    .forEach((part) => {
      const [k, v] = part.split('=');
      if (k === 't') out.t = v;
      else if (k === 'v1') out.v1.push(v);
    });
  return out;
}

function verifySignature(rawBody, header, secret) {
  if (!secret) return false;
  const parsed = parseSignatureHeader(header);
  if (!parsed.t || !parsed.v1.length) return false;

  const timestamp = Number(parsed.t);
  if (!Number.isFinite(timestamp)) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parsed.t}.${rawBody.toString('utf8')}`)
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');

  return parsed.v1.some((sig) => {
    const sigBuf = Buffer.from(String(sig), 'utf8');
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });
}

async function handleCheckoutCompleted(session) {
  const practiceId = session && session.metadata && session.metadata.practice_id;
  if (!practiceId) return;
  await db.query(
    `update practices
        set plan = 'vob',
            vob_period_start = now(),
            stripe_customer_id = coalesce($2, stripe_customer_id),
            stripe_subscription_id = coalesce($3, stripe_subscription_id)
      where id = $1
        and plan <> 'founder'`,
    [practiceId, session.customer || null, session.subscription || null]
  );
}

async function handleSubscriptionDeleted(subscription) {
  const customerId = subscription && subscription.customer;
  if (!customerId) return;
  await db.query(
    `update practices set plan = 'free', stripe_subscription_id = null
      where stripe_customer_id = $1 and plan = 'vob'`,
    [customerId]
  );
}

async function handleWebhook(event) {
  const rawBody = rawBodyBuffer(event);
  const headers = (event && event.headers) || {};
  const signature = headers['stripe-signature'] || headers['Stripe-Signature'];

  if (!verifySignature(rawBody, signature, process.env.STRIPE_VOB_WEBHOOK_SECRET)) {
    return json(400, { error: 'Invalid signature.' }, event);
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody.toString('utf8'));
  } catch (_) {
    return json(400, { error: 'Invalid payload.' }, event);
  }

  try {
    const object = (stripeEvent && stripeEvent.data && stripeEvent.data.object) || {};
    switch (stripeEvent.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(object);
        break;
      default:
        break;
    }
    return json(200, { received: true }, event);
  } catch (err) {
    // 500 tells Stripe to retry; never log PHI or the payload.
    console.error('vob-webhook error:', err && err.message);
    return json(500, { error: 'Webhook handler failed.' }, event);
  }
}

// --- entrypoint --------------------------------------------------------------

exports.handler = async (event) => {
  const method = httpMethod(event);
  if (method === 'OPTIONS') return preflight(event);
  if (method !== 'POST') return json(405, { error: 'Method not allowed' }, event);

  const path = subPath(event);
  if (path === 'vob/checkout-context') return handleCheckoutContext(event);
  if (path === 'vob/webhook') return handleWebhook(event);
  return json(404, { error: 'Not found' }, event);
};
