'use strict';

// POST /subscription/vob/webhook — Stripe webhook, Vercel serverless function.
//
// Runs on Vercel (not Lambda) so Stripe can reach it and so it has DB access via
// DATABASE_URL. It flips a practice's plan in response to subscription lifecycle:
//
//   checkout.session.completed    → plan = 'vob', vob_period_start = now(),
//                                    persist the Stripe customer + subscription ids.
//   customer.subscription.deleted → plan = 'free' (only for practices currently on
//                                    'vob'; founders and free practices are untouched).
//
// The signature is verified against STRIPE_VOB_WEBHOOK_SECRET using the raw body
// (bodyParser is disabled below), reimplementing Stripe's scheme with crypto so we
// stay SDK-free like the rest of the codebase. Never logs PHI or the raw payload.

const crypto = require('crypto');
const db = require('../backend/lib/db');

const SIGNATURE_TOLERANCE_SECONDS = 60 * 5;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Parse a "t=...,v1=...,v1=..." Stripe-Signature header.
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

// Verify per Stripe's scheme: HMAC-SHA256(secret, `${t}.${rawBody}`) hex must equal
// one of the v1 signatures, within a timestamp tolerance. Returns true/false.
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
  // Only downgrade a practice that is actually on the paid add-on — never a founder.
  await db.query(
    `update practices set plan = 'free', stripe_subscription_id = null
      where stripe_customer_id = $1 and plan = 'vob'`,
    [customerId]
  );
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (_) {
    return res.status(400).json({ error: 'Could not read request body.' });
  }

  const signature = req.headers['stripe-signature'];
  if (!verifySignature(rawBody, signature, process.env.STRIPE_VOB_WEBHOOK_SECRET)) {
    return res.status(400).json({ error: 'Invalid signature.' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (_) {
    return res.status(400).json({ error: 'Invalid payload.' });
  }

  try {
    const object = (event && event.data && event.data.object) || {};
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(object);
        break;
      default:
        // Ignore unrelated events; acknowledge so Stripe stops retrying.
        break;
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    // 500 tells Stripe to retry; never log PHI or the payload.
    console.error('vob-webhook error:', err && err.message);
    return res.status(500).json({ error: 'Webhook handler failed.' });
  }
};

// Vercel: disable the body parser so the signature check sees the exact raw bytes.
// Must be set AFTER the handler assignment above (which replaces module.exports).
module.exports.config = { api: { bodyParser: false } };
