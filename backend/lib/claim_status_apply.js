'use strict';

// Applying a clearinghouse status result to a claim — the SOLE place that
// happens, for both callers.
//
// WHY IT LIVES HERE. Two things now learn a claim's fate from the payer: a staff
// member clicking refresh (handlers/claims.js) and the scheduled poller
// (handlers/claim_status_poll.js). What they do with the answer must be
// identical, because that answer moves money: it sets `denied`, which raises a
// refund request, which an admin approves into a Stripe refund. A second copy of
// this logic would not fail loudly — it would drift, and the drift would show up
// as a patient refunded on one path and not the other, months later, with no
// error anywhere.
//
// The two callers differ ONLY in what surrounds this: HTTP shaping and audit
// context. Neither belongs here.
//
// Transaction boundary is deliberate and is the same one refreshClaim always
// had:
//   IN  the transaction — the status update, the claim_event, the verbatim
//       acknowledgment. These describe one fact and must land together.
//   OUT of it, best-effort — the refund request. A request that fails to be
//       raised is recoverable (the acknowledgment is stored, the claim reads
//       'denied', an admin can file it by hand); rolling the status back
//       because a queue insert failed would throw away the only record of what
//       the payer said.

const { maybeCreateForDenial } = require('./refund_auto');

// Optional money: absent/blank/invalid → null, so `coalesce` keeps what's there.
function money(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function cleanText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// applyStatusResult(db, {...}) -> { updated, changed, autoRefund }
//
//   db            the db module (or anything with .query/.withTransaction)
//   practiceId    scoping, always from the caller's own context
//   claim         the claim row BEFORE this update
//   statusResult  the adapter's normalized result ({ status, denial_class, ... })
//   actor         { userId } | { actorType: 'system' } — who is doing this
//   deps          { logEvent, logAck, eventTypeForStatus } from lib/claims.js and
//                 the handler, injected so this module does not reach across the
//                 handler boundary to get them
//
// `updated` is null when the claim vanished under us (hidden/deleted between the
// read and the write) — the caller turns that into its own 404 / skip.
async function applyStatusResult(db, params) {
  const p = params || {};
  const claim = p.claim;
  const status = p.statusResult;
  const newStatus = status.status;
  const changed = newStatus !== claim.status;
  const deps = p.deps || {};

  // A poller acts as 'system' and has no user; a staff refresh has a user and no
  // partner credential. claim_events enforces the exclusivity (migration 024).
  const actorCols = p.actor && p.actor.userId
    ? { createdBy: p.actor.userId, createdByPartnerCredentialId: null }
    : { createdBy: null, createdByPartnerCredentialId: null };

  const updated = await db.withTransaction(async (client) => {
    const res = await client.query(
      `update claims
          set status = $1,
              allowed_amount = coalesce($2, allowed_amount),
              reimbursed_amount = coalesce($3, reimbursed_amount),
              patient_responsibility = coalesce($4, patient_responsibility),
              denial_reason = coalesce($5, denial_reason)
        where id = $6 and practice_id = $7 and is_hidden = false
        returning *`,
      [
        newStatus,
        money(status.allowed_amount),
        money(status.reimbursed_amount),
        money(status.patient_responsibility),
        cleanText(status.denial_reason),
        claim.id,
        p.practiceId,
      ]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];

    if (changed) {
      await deps.logEvent(client, {
        practiceId: p.practiceId,
        claimId: row.id,
        ...actorCols,
        actorType: p.actor && p.actor.actorType ? p.actor.actorType : 'user',
        eventType: deps.eventTypeForStatus(newStatus),
        statusFrom: claim.status,
        statusTo: newStatus,
        note: p.note || 'Status updated from payer response.',
        payload: status.raw,
      });
    }

    // Every claim-status payload we receive, verbatim, whether or not it moved
    // our status — the passive dataset. Stored, not acted on.
    await deps.logAck(client, {
      practiceId: p.practiceId,
      claimId: row.id,
      source: p.adapterName,
      kind: 'status',
      controlNumber: claim.control_number,
      payload: status.raw,
    });
    return row;
  });

  if (!updated) return { updated: null, changed: false, autoRefund: null };

  // OUTSIDE the transaction, and swallowed. See the note at the top of the file.
  let autoRefund = null;
  try {
    autoRefund = await maybeCreateForDenial(db, {
      claim: updated,
      status: newStatus,
      statusChanged: changed,
      denialClass: status.denial_class || null,
    });
  } catch (err) {
    // Never the reason, which could echo payer text, and never claim content.
    console.error('claim status apply: auto refund-request creation failed');
    autoRefund = null;
  }

  return { updated, changed, autoRefund };
}

// The one-word summary of what the refund rule did, for an audit metadata field.
// 'error' is distinct from every decline reason on purpose: "we tried and it
// broke" must never read like "we looked and decided not to".
function refundOutcomeCode(autoRefund) {
  if (!autoRefund) return 'error';
  return autoRefund.created ? 'created' : autoRefund.reason;
}

module.exports = { applyStatusResult, refundOutcomeCode };
