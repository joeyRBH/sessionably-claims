'use strict';

// Refund-requests resource — the patient-initiated "my claim was denied, refund my
// fee" flow. One Lambda for the whole resource, routed by method + the presence of
// an {id} path parameter + the trailing action segment(s):
//
//   POST /refund-requests                        → create a request against a claim
//   GET  /refund-requests                        → the practice's queue (newest first)
//   GET  /refund-requests/{id}                   → one request
//   POST /refund-requests/{id}/deny              → deny with a reason (NO Stripe refund)
//   POST /refund-requests/{id}/approve/context   → what to refund (guards + idempotency)
//   POST /refund-requests/{id}/approve/record    → record the Stripe refund result
//
// The two approve/* endpoints exist because issuing the Stripe refund needs outbound
// egress the VPC Lambda lacks: the Vercel adapter (api/refund-requests/[id]/approve.js)
// calls `context` here, makes the refund, then calls `record` here — exactly like the
// platform-fee charge (backend/handlers/claim_fee.js). `deny`, create, and the reads
// are pure DB and are called directly.
//
// Guarantee semantics: a PAID or DEDUCTIBLE claim is a SUCCESS — only outcome_label
// = 'denied' is refundable. Applied-to-deductible is never a refund. Approval issues
// a Stripe refund of the platform fee ONLY, exactly once (DB-enforced idempotency +
// a conditional status transition). Nothing here ever auto-approves.
//
// Security: ADMIN ONLY (practice_admin) — mirrors backend/handlers/audit.js. practice_id
// is ALWAYS derived from the authenticated caller, never the body. Cross-practice / not
// found is 404. Every decision is written to the append-only audit_log. Requests and the
// claim payloads they touch are PHI-adjacent; error logs stay generic and never echo
// notes, reasons, names, or amounts.

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const { parseBody } = require('../lib/util');
const { audit } = require('../lib/audit');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OUTCOME_LABELS = ['paid', 'deductible', 'denied'];
// A refund can only be requested against a claim that actually reached the payer
// (and so had its fee charged). Drafts were never sent; void claims are dead.
const REQUESTABLE_CLAIM_STATUSES = ['submitted', 'processing', 'info_requested', 'denied', 'appealed', 'paid'];

// --- request helpers ---------------------------------------------------------

function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

function pathId(event) {
  return event && event.pathParameters ? event.pathParameters.id : undefined;
}

function queryParam(event, name) {
  return event && event.queryStringParameters ? event.queryStringParameters[name] : undefined;
}

// The path segments after /refund-requests/{id}, e.g. ['deny'] or ['approve','context'].
// Reads the HTTP API v2 routeKey template first (value-independent), falling back to
// the concrete request path.
function actionSegments(event) {
  const rk = (event && event.requestContext && event.requestContext.routeKey) || '';
  let m = rk.match(/\/refund-requests\/\{id\}\/(.+)$/i);
  if (m) return m[1].split('/').map((s) => s.toLowerCase()).filter(Boolean);
  const path =
    (event && event.requestContext && event.requestContext.http && event.requestContext.http.path) ||
    (event && event.rawPath) || '';
  m = path.match(/\/refund-requests\/[^/]+\/(.+?)\/?$/i);
  return m ? m[1].split('/').map((s) => s.toLowerCase()).filter(Boolean) : [];
}

function isUUID(v) {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

function cleanText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// --- caller context ----------------------------------------------------------

async function loadCaller(userId) {
  const res = await db.query(
    `select id, practice_id, role, is_active from users where id = $1 limit 1`,
    [userId]
  );
  return res.rows[0] || null;
}

async function loadClaim(practiceId, claimId) {
  const res = await db.query(
    `select * from claims where id = $1 and practice_id = $2 and is_hidden = false limit 1`,
    [claimId, practiceId]
  );
  return res.rows[0] || null;
}

async function loadRequest(practiceId, id) {
  const res = await db.query(
    `select * from refund_requests where id = $1 and practice_id = $2 limit 1`,
    [id, practiceId]
  );
  return res.rows[0] || null;
}

// The most-recent PAID platform-fee transaction for a claim, or null. This is the
// money we can refund — the fee charge is best-effort, so a claim may have none
// (charge failed / declined), in which case there is nothing to refund.
async function loadPaidFee(claimId) {
  const res = await db.query(
    `select * from transactions
      where claim_id = $1 and type = 'platform_fee' and status = 'paid'
      order by created_at desc
      limit 1`,
    [claimId]
  );
  return res.rows[0] || null;
}

// True when the claim already has any refund transaction (idempotency backstop
// independent of the request row's own stripe_refund_id).
async function claimAlreadyRefunded(claimId) {
  const res = await db.query(
    `select 1 from transactions where claim_id = $1 and type = 'refund' limit 1`,
    [claimId]
  );
  return res.rowCount > 0;
}

// --- shaping -----------------------------------------------------------------

// The request plus display-only joins (patient name + claim number/status) so the
// admin queue renders without an N+1. Admin-only response; ids/enums are non-PHI but
// client_name / patient_note / decision_reason may be — never place them in a URL or log.
function shapeRequest(r) {
  if (!r) return null;
  const clientName =
    r.client_preferred_name ||
    [r.client_first_name, r.client_last_name].filter(Boolean).join(' ').trim() ||
    null;
  return {
    id: r.id,
    practice_id: r.practice_id,
    claim_id: r.claim_id,
    client_id: r.client_id,
    client_name: clientName,
    claim_number: r.claim_number || null,
    claim_status: r.claim_status || null,
    outcome_label: r.outcome_label,
    // Provenance, so the admin can see WHAT KIND of evidence they are approving
    // against: a patient's account of an EOB, or an inference from a 277.
    source: r.source || 'patient_reported',
    status: r.status,
    patient_note: r.patient_note,
    decision_reason: r.decision_reason,
    decided_by: r.decided_by,
    decided_at: r.decided_at,
    stripe_refund_id: r.stripe_refund_id,
    // What approving this request would actually DO, decided here rather than
    // guessed at by the client:
    //   'refunded'  — the fee has already been given back; approving is a no-op.
    //   'collected' — a fee was charged and can be returned. The only refundable
    //                 state.
    //   'none'      — no platform fee was ever collected on this claim (no card
    //                 on file at submit time, or the charge failed). There is
    //                 nothing to give back, and no approval will ever succeed.
    // fee_amount is the fee in dollars, present only when state is 'collected'.
    fee_state: feeState(r),
    fee_amount: r.fee_amount != null ? Number(r.fee_amount) : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// Pure — exported for unit tests. Mirrors approveContext's guard ordering exactly:
// already-refunded wins over everything, then a positive fee with a Stripe handle
// to refund against, else nothing to refund.
function feeState(r) {
  if (!r) return 'none';
  if (r.stripe_refund_id || r.claim_has_refund === true) return 'refunded';
  const amount = r.fee_amount == null ? 0 : Number(r.fee_amount);
  if (!Number.isFinite(amount) || amount <= 0) return 'none';
  // A recorded fee with no Stripe reference cannot be refunded through Stripe,
  // which is the same 409 approveContext raises — so the queue must not present
  // it as refundable either.
  if (!r.fee_charge_id && !r.fee_intent_id) return 'none';
  return 'collected';
}

// The queue needs to know, PER ROW, whether there is actually a fee to give
// back — otherwise it offers "Approve refund" on requests that can only ever
// 409, and those requests sit Open for ever. Two lateral joins answer it without
// an N+1: the most recent PAID platform fee on the claim, and whether any refund
// transaction already exists for it. Both are the same predicates approveContext
// applies, so the queue cannot disagree with the guard it is previewing.
const SELECT_WITH_JOINS = `
  select rr.*,
         c.claim_number,
         c.status              as claim_status,
         cl.first_name         as client_first_name,
         cl.last_name          as client_last_name,
         cl.preferred_name     as client_preferred_name,
         fee.amount            as fee_amount,
         fee.stripe_charge_id  as fee_charge_id,
         fee.stripe_payment_intent_id as fee_intent_id,
         (refunded.one is not null) as claim_has_refund
    from refund_requests rr
    join claims  c  on c.id  = rr.claim_id
    join clients cl on cl.id = rr.client_id
    left join lateral (
      select t.amount, t.stripe_charge_id, t.stripe_payment_intent_id
        from transactions t
       where t.claim_id = rr.claim_id and t.type = 'platform_fee' and t.status = 'paid'
       order by t.created_at desc
       limit 1
    ) fee on true
    left join lateral (
      select 1 as one
        from transactions t
       where t.claim_id = rr.claim_id and t.type = 'refund'
       limit 1
    ) refunded on true
`;

// --- create ------------------------------------------------------------------

async function createRequest(caller, event, authCtx) {
  const practiceId = caller.practice_id;
  const body = parseBody(event) || {};

  const claimId = body.claim_id;
  if (!isUUID(claimId)) {
    return json(400, { error: 'A valid claim_id is required.' }, event);
  }

  // NOTE: `source` is NOT read from the body and must never be. This endpoint
  // creates patient-reported requests by definition; a caller able to claim
  // 'system_denial' could dress its own guess up as the clearinghouse's, and an
  // admin adjudicating the queue would have no way to tell. The only writer of
  // 'system_denial' is lib/refund_auto.js, reached from a real payer response.
  const outcome = body.outcome_label;
  if (!OUTCOME_LABELS.includes(outcome)) {
    return json(400, { error: `outcome_label must be one of: ${OUTCOME_LABELS.join(', ')}.` }, event);
  }

  const claim = await loadClaim(practiceId, claimId);
  if (!claim) return json(404, { error: 'Not found' }, event);
  if (!REQUESTABLE_CLAIM_STATUSES.includes(claim.status)) {
    return json(409, { error: 'A refund can only be requested on a submitted claim.' }, event);
  }

  // Friendly pre-check; the partial unique index is the real guard against a race.
  const open = await db.query(
    `select 1 from refund_requests where claim_id = $1 and status = 'open' limit 1`,
    [claimId]
  );
  if (open.rowCount > 0) {
    return json(409, { error: 'This claim already has an open refund request.' }, event);
  }

  let created;
  try {
    const res = await db.query(
      `insert into refund_requests
         (practice_id, claim_id, client_id, outcome_label, status, patient_note, source)
       values ($1, $2, $3, $4, 'open', $5, 'patient_reported')
       returning *`,
      [practiceId, claimId, claim.client_id, outcome, cleanText(body.patient_note)]
    );
    created = res.rows[0];
  } catch (err) {
    // 23505 = the one-open-per-claim partial unique index fired (concurrent create).
    if (err && err.code === '23505') {
      return json(409, { error: 'This claim already has an open refund request.' }, event);
    }
    throw err;
  }

  await audit(event, authCtx, {
    action: 'refund_request.create',
    resourceType: 'refund_request',
    resourceId: created.id,
    metadata: { claim_id: claimId, outcome_label: outcome },
  });

  const withJoins = await db.query(`${SELECT_WITH_JOINS} where rr.id = $1`, [created.id]);
  return json(201, { refund_request: shapeRequest(withJoins.rows[0]) }, event);
}

// --- list (queue) ------------------------------------------------------------

async function listRequests(caller, event, authCtx) {
  const practiceId = caller.practice_id;
  const params = [practiceId];
  let where = 'rr.practice_id = $1';

  const status = queryParam(event, 'status');
  if (status != null && status !== '') {
    if (!['open', 'approved', 'denied'].includes(status)) {
      return json(400, { error: 'Invalid status filter.' }, event);
    }
    params.push(status);
    where += ` and rr.status = $${params.length}`;
  }

  const res = await db.query(
    `${SELECT_WITH_JOINS} where ${where} order by rr.created_at desc, rr.id desc limit 200`,
    params
  );
  const rows = res.rows.map(shapeRequest);

  await audit(event, authCtx, {
    action: 'refund_request.list',
    resourceType: 'refund_request',
    metadata: { count: rows.length, status: status || 'all' },
  });
  return json(200, { refund_requests: rows }, event);
}

async function getRequest(caller, id, event, authCtx) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);
  const res = await db.query(`${SELECT_WITH_JOINS} where rr.id = $1 and rr.practice_id = $2`, [
    id,
    caller.practice_id,
  ]);
  const row = res.rows[0];
  if (!row) return json(404, { error: 'Not found' }, event);
  await audit(event, authCtx, {
    action: 'refund_request.view',
    resourceType: 'refund_request',
    resourceId: id,
  });
  return json(200, { refund_request: shapeRequest(row) }, event);
}

// --- deny (no Stripe) --------------------------------------------------------

async function denyRequest(caller, id, event, authCtx) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);
  const practiceId = caller.practice_id;
  const body = parseBody(event) || {};
  const reason = cleanText(body.reason);
  if (!reason) {
    return json(400, { error: 'A reason is required to deny a refund request.' }, event);
  }

  const existing = await loadRequest(practiceId, id);
  if (!existing) return json(404, { error: 'Not found' }, event);
  if (existing.status !== 'open') {
    return json(409, { error: 'This request has already been decided.' }, event);
  }

  // Conditional transition — only an OPEN request flips to denied, so a concurrent
  // decide can never overwrite a prior one. No money moves on this path.
  const res = await db.query(
    `update refund_requests
        set status = 'denied', decided_by = $1, decided_at = now(), decision_reason = $2
      where id = $3 and practice_id = $4 and status = 'open'
      returning *`,
    [caller.id, reason, id, practiceId]
  );
  if (res.rowCount === 0) {
    return json(409, { error: 'This request has already been decided.' }, event);
  }

  await audit(event, authCtx, {
    action: 'refund_request.deny',
    resourceType: 'refund_request',
    resourceId: id,
    // Non-PHI only: the reason text is NOT recorded here (it may name the patient);
    // it lives on refund_requests.decision_reason. We record only that a denial happened.
    metadata: { decision: 'denied' },
  });

  const withJoins = await db.query(`${SELECT_WITH_JOINS} where rr.id = $1`, [id]);
  return json(200, { refund_request: shapeRequest(withJoins.rows[0]) }, event);
}

// --- approve: context (what to refund) ---------------------------------------

async function approveContext(caller, id, event) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);
  const practiceId = caller.practice_id;

  const rr = await loadRequest(practiceId, id);
  if (!rr) return json(404, { error: 'Not found' }, event);
  if (rr.status !== 'open') {
    return json(409, { error: 'This request has already been decided.' }, event);
  }
  // Only a denial refunds. A PAID or DEDUCTIBLE outcome is a success, not a refund.
  if (rr.outcome_label !== 'denied') {
    return json(409, { error: 'Only a denied claim is refundable — a paid or deductible outcome is a success.' }, event);
  }

  // Idempotency: never issue a second refund for the same claim/request.
  if (rr.stripe_refund_id || (await claimAlreadyRefunded(rr.claim_id))) {
    return json(200, { refund: false, reason: 'already_refunded' }, event);
  }

  const fee = await loadPaidFee(rr.claim_id);
  if (!fee) {
    // No platform fee was ever successfully charged — there is nothing to refund.
    // The queue now shows this state up front (shapeRequest's fee_state) and
    // offers "Close — nothing to refund" instead of Approve, so reaching this
    // guard means a stale page or a direct call. Say what to do about it rather
    // than leaving the request stuck open.
    return json(409, {
      error: 'No platform fee was charged for this claim, so there is nothing to refund. ' +
        'Close the request instead — it records the decision without moving money.',
      code: 'no_fee_collected',
    }, event);
  }

  const amountCents = Math.round(Number(fee.amount) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return json(409, {
      error: 'The recorded platform fee has no positive amount to refund. Close the request instead.',
      code: 'no_fee_collected',
    }, event);
  }

  const target = {};
  if (fee.stripe_charge_id) target.charge = fee.stripe_charge_id;
  else if (fee.stripe_payment_intent_id) target.payment_intent = fee.stripe_payment_intent_id;
  else {
    return json(409, {
      error: 'The platform-fee charge has no Stripe reference to refund against. Close the request instead.',
      code: 'no_fee_collected',
    }, event);
  }

  return json(
    200,
    {
      refund: true,
      ...target,
      amount_cents: amountCents,
      currency: fee.currency || 'usd',
      reason: 'requested_by_customer',
      metadata: {
        refund_request_id: rr.id,
        claim_id: rr.claim_id,
        client_id: rr.client_id,
        practice_id: practiceId,
      },
    },
    event
  );
}

// --- approve: record (persist the refund) ------------------------------------

async function approveRecord(caller, id, event, authCtx) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);
  const practiceId = caller.practice_id;
  const body = parseBody(event) || {};
  const reason = cleanText(body.reason);

  // Only a genuinely succeeded Stripe refund is recorded. Anything else leaves the
  // request OPEN so it can be retried — we never mark a refund that did not happen.
  if (!body.refund_id || body.status !== 'succeeded') {
    return json(200, { ok: false, recorded: false, reason: 'refund_not_succeeded' }, event);
  }

  const recorded = await db.withTransaction(async (client) => {
    // Flip the request to approved ONLY if it is still an open, denied-outcome request.
    // This conditional update is the exactly-once guard: a concurrent record loses the
    // race (0 rows) and inserts no transaction.
    const upd = await client.query(
      `update refund_requests
          set status = 'approved', decided_by = $1, decided_at = now(),
              decision_reason = $2, stripe_refund_id = $3
        where id = $4 and practice_id = $5 and status = 'open' and outcome_label = 'denied'
        returning *`,
      [caller.id, reason, body.refund_id, id, practiceId]
    );
    if (upd.rowCount === 0) return null;
    const rr = upd.rows[0];

    // Record the money movement as its own transactions row (double-entry style;
    // the original platform_fee row is left intact). Amount mirrors the fee refunded.
    const fee = await client.query(
      `select * from transactions
        where claim_id = $1 and type = 'platform_fee' and status = 'paid'
        order by created_at desc limit 1`,
      [rr.claim_id]
    );
    const feeRow = fee.rows[0] || {};
    await client.query(
      `insert into transactions
         (practice_id, client_id, claim_id, type, description, amount, currency, fee_payer,
          stripe_payment_intent_id, stripe_charge_id, stripe_refund_id, status)
       values ($1, $2, $3, 'refund', $4, $5, $6, 'client', $7, $8, $9, 'refunded')`,
      [
        practiceId,
        rr.client_id,
        rr.claim_id,
        'Refund of platform fee — denied claim',
        feeRow.amount != null ? feeRow.amount : 0,
        feeRow.currency || 'usd',
        feeRow.stripe_payment_intent_id || null,
        feeRow.stripe_charge_id || null,
        body.refund_id,
      ]
    );
    return rr;
  });

  if (!recorded) {
    // Lost the race or no longer eligible — treat as already handled, not an error.
    return json(200, { ok: false, recorded: false, reason: 'already_recorded' }, event);
  }

  await audit(event, authCtx, {
    action: 'refund_request.approve',
    resourceType: 'refund_request',
    resourceId: id,
    // Non-PHI only. The reason text stays on the row (may name the patient), not here.
    metadata: { decision: 'approved', refunded: true },
  });

  const withJoins = await db.query(`${SELECT_WITH_JOINS} where rr.id = $1`, [id]);
  return json(200, { ok: true, recorded: true, refund_request: shapeRequest(withJoins.rows[0]) }, event);
}

// --- entrypoint --------------------------------------------------------------

exports.handler = async (event) => {
  const method = httpMethod(event);
  if (method === 'OPTIONS') return preflight(event);

  let auth;
  try {
    auth = requireAuth(event);
  } catch (err) {
    return json(err.statusCode || 401, { error: 'Unauthorized' }, event);
  }

  try {
    const caller = await loadCaller(auth.user.sub);
    if (!caller || caller.is_active === false) {
      return json(401, { error: 'Unauthorized' }, event);
    }
    // ADMIN ONLY — mirrors backend/handlers/audit.js. Adjudicating refunds and
    // moving money is a practice-owner action.
    if (caller.role !== 'practice_admin') {
      return json(403, { error: 'Only a practice admin can manage refund requests.' }, event);
    }

    const authCtx = { userId: caller.id, practiceId: caller.practice_id };
    const id = pathId(event);
    const segs = actionSegments(event);

    // Collection routes: /refund-requests
    if (!id) {
      if (method === 'POST') return await createRequest(caller, event, authCtx);
      if (method === 'GET') return await listRequests(caller, event, authCtx);
      return json(405, { error: 'Method not allowed' }, event);
    }

    // Item + action routes: /refund-requests/{id}[/...]
    if (segs.length === 0) {
      if (method === 'GET') return await getRequest(caller, id, event, authCtx);
      return json(405, { error: 'Method not allowed' }, event);
    }
    if (method !== 'POST') return json(405, { error: 'Method not allowed' }, event);
    if (segs.length === 1 && segs[0] === 'deny') return await denyRequest(caller, id, event, authCtx);
    if (segs.length === 2 && segs[0] === 'approve' && segs[1] === 'context') {
      return await approveContext(caller, id, event);
    }
    if (segs.length === 2 && segs[0] === 'approve' && segs[1] === 'record') {
      return await approveRecord(caller, id, event, authCtx);
    }
    return json(404, { error: 'Not found' }, event);
  } catch (err) {
    console.error('refund_requests error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};

// Pure helper, exported so the queue's refundability projection can be unit
// tested against the same rows the guard sees. Not part of the HTTP surface.
exports.feeState = feeState;
