'use strict';

// POST /api/claims/:id/charge-fee — Vercel adapter (staff JWT), Stripe egress.
//
// Triggered right after a claim submission. The VPC-private RDS is unreachable from
// Vercel, so DB work lives on the Lambda API. This adapter forwards the caller's
// staff Bearer token to
//   POST {LAMBDA_API_BASE}/claims/:id/charge-fee/context  → what to charge (or skip)
// makes the off-session Stripe PaymentIntent (the part needing outbound internet),
// then records the result via
//   POST {LAMBDA_API_BASE}/claims/:id/charge-fee/record   { intent_id, charge_id, status }
//
// Best-effort by design (the claim is already submitted; the frontend ignores the
// result). Idempotency + amount are enforced on the Lambda side. Never logs PHI.

const stripe = require('../../../backend/lib/stripe');
const { callLambda } = require('../../../backend/lib/lambda_api');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const claimId = req.query && req.query.id;
  const path = `/claims/${encodeURIComponent(claimId || '')}/charge-fee`;
  const token = req.headers.authorization;

  try {
    // What to charge (auth, practice-scoping, idempotency, amount) — all in the VPC.
    const ctxRes = await callLambda(`${path}/context`, { method: 'POST', token, body: {} });
    if (ctxRes.status !== 200) {
      return res.status(ctxRes.status).json(ctxRes.data || { error: 'Could not charge platform fee.' });
    }
    const ctx = ctxRes.data || {};
    if (!ctx.charge) {
      return res.status(200).json({ ok: true, charged: false, reason: ctx.reason || 'nothing_to_charge' });
    }

    let intent = null;
    let chargeError = null;
    try {
      intent = await stripe.createPaymentIntent({
        amount: ctx.amount_cents,
        currency: ctx.currency || 'usd',
        customer: ctx.customer,
        payment_method: ctx.payment_method,
        confirm: true,
        off_session: true,
        description: ctx.description,
        metadata: ctx.metadata || {},
      });
    } catch (err) {
      chargeError = (err && err.message) || 'Fee charge failed';
      console.error('charge_fee (stripe) error:', chargeError);
    }

    const chargeId =
      (intent && (typeof intent.latest_charge === 'string'
        ? intent.latest_charge
        : (intent.charges && intent.charges.data && intent.charges.data[0] && intent.charges.data[0].id))) || null;

    // Record the outcome (DB) via the Lambda API — the amount is recomputed there.
    try {
      await callLambda(`${path}/record`, {
        method: 'POST',
        token,
        body: {
          intent_id: intent ? intent.id : null,
          charge_id: chargeId,
          status: chargeError ? 'failed' : 'paid',
        },
      });
    } catch (recErr) {
      console.error('charge_fee (record) error:', recErr && recErr.message);
    }

    if (chargeError) {
      return res.status(200).json({ ok: false, charged: false, fee_charge_error: chargeError });
    }
    return res.status(200).json({ ok: true, charged: true, amount: ctx.amount_cents / 100 });
  } catch (err) {
    console.error('charge_fee error:', err && err.message);
    return res.status(500).json({ error: 'Could not charge platform fee.' });
  }
};
