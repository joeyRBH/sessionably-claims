'use strict';

// POST /api/refund-requests/:id/approve — Vercel adapter (admin JWT), Stripe egress.
//
// Approving a refund request issues a Stripe refund of the platform fee, which needs
// outbound internet the VPC-private Lambda API lacks. So the DB work stays on the
// Lambda API and this adapter owns only the Stripe call — the same split as the
// platform-fee charge (api/claims/[id]/charge-fee.js):
//
//   POST {LAMBDA_API_BASE}/refund-requests/:id/approve/context  → what to refund (guards + idempotency)
//   stripe.refunds.create(...)                                  → the actual refund (egress)
//   POST {LAMBDA_API_BASE}/refund-requests/:id/approve/record   { refund_id, status, reason }
//
// Unlike the fee charge, this is NOT best-effort: the caller waits on the result and
// the UI reflects it. Exactly-once is guaranteed on the Lambda side — `context` refuses
// to hand out a second refund target once one is recorded, and `record` flips the request
// only from the open state. `reason` is the admin's decision note; it is forwarded to
// `record` (stored on the request row, never logged here). Never logs PHI or amounts.

const stripe = require('../../../backend/lib/stripe');
const { callLambda } = require('../../../backend/lib/lambda_api');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const id = req.query && req.query.id;
  const base = `/refund-requests/${encodeURIComponent(id || '')}/approve`;
  const token = req.headers.authorization;

  // The admin's decision note travels through to `record`; parse it defensively.
  let reason = null;
  try {
    const body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
    if (body && typeof body.reason === 'string') reason = body.reason;
  } catch (_) {
    /* no/invalid body — reason stays null */
  }

  try {
    // What to refund (auth, admin-gate, practice-scoping, guards, idempotency) — all in the VPC.
    const ctxRes = await callLambda(`${base}/context`, { method: 'POST', token, body: {} });
    if (ctxRes.status !== 200) {
      return res.status(ctxRes.status).json(ctxRes.data || { error: 'Could not approve the refund.' });
    }
    const ctx = ctxRes.data || {};
    if (!ctx.refund) {
      // A legitimate skip (e.g. already refunded) — not an error.
      return res.status(200).json({ ok: true, refunded: false, reason: ctx.reason || 'nothing_to_refund' });
    }

    // Issue the Stripe refund of the platform fee ONLY. Amount + target come from the
    // Lambda (computed from the recorded paid fee), never from the browser.
    const refundParams = {
      amount: ctx.amount_cents,
      reason: ctx.reason || 'requested_by_customer',
      metadata: ctx.metadata || {},
    };
    if (ctx.charge) refundParams.charge = ctx.charge;
    else if (ctx.payment_intent) refundParams.payment_intent = ctx.payment_intent;

    let refund;
    try {
      refund = await stripe.createRefund(refundParams);
    } catch (err) {
      console.error('approve_refund (stripe) error:', (err && err.message) || 'refund failed');
      // Do NOT record — the request stays open and can be retried.
      return res.status(502).json({ ok: false, refunded: false, error: 'The refund could not be processed.' });
    }

    // Record the outcome (DB) via the Lambda API. It only marks the request approved
    // when Stripe reports success, and it is idempotent.
    const recRes = await callLambda(`${base}/record`, {
      method: 'POST',
      token,
      body: { refund_id: refund.id, status: refund.status, reason },
    });

    if (recRes.status !== 200 || !recRes.data || recRes.data.ok !== true) {
      // The refund succeeded at Stripe but recording hiccuped. Surface it so staff can
      // reconcile; the record endpoint is idempotent, so a retry is safe.
      console.error('approve_refund (record) did not confirm');
      return res.status(200).json({
        ok: false,
        refunded: true,
        recorded: false,
        error: 'The refund was issued but could not be recorded. It has been logged for reconciliation.',
      });
    }

    return res.status(200).json({ ok: true, refunded: true, recorded: true, refund_request: recRes.data.refund_request });
  } catch (err) {
    console.error('approve_refund error:', err && err.message);
    return res.status(500).json({ error: 'Could not approve the refund.' });
  }
};
