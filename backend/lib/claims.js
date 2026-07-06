'use strict';

// Shared claim-creation logic, bundled into both the claims and sessions Lambdas.
// The HTTP handler in backend/handlers/claims.js owns request parsing/validation;
// this module owns the DB-level "create a draft claim from a session" primitive so
// the auto-draft-on-completion path in the sessions handler stays byte-for-byte
// identical to POST /claims (same insurance resolution, same claim_events row).
//
// Every function takes a query runner `q` — either the `db` module (its own pool)
// or a pg client inside a transaction — so callers control the transaction scope.
// Claims carry PHI-adjacent billing data; this module never logs.

// The client's primary non-hidden insurance record, if any. Mirrors the ordering
// POST /claims uses when auto-picking coverage for a session's client.
async function primaryInsuranceForClient(q, practiceId, clientId) {
  const res = await q.query(
    `select * from insurance_records
      where practice_id = $1 and client_id = $2 and is_hidden = false
      order by is_primary desc, created_at asc
      limit 1`,
    [practiceId, clientId]
  );
  return res.rows[0] || null;
}

// True when the session already has a non-hidden claim. The idempotency guard for
// auto-draft creation: completing a session twice must not create two claims.
async function sessionHasActiveClaim(q, practiceId, sessionId) {
  const res = await q.query(
    `select 1 from claims
      where session_id = $1 and practice_id = $2 and is_hidden = false
      limit 1`,
    [sessionId, practiceId]
  );
  return res.rowCount > 0;
}

// Insert a claim_events row. `q` is a pg client (inside a transaction) or db.
async function logClaimEvent(q, e) {
  await q.query(
    `insert into claim_events
       (practice_id, claim_id, created_by, event_type, status_from, status_to, note, payload)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      e.practiceId,
      e.claimId,
      e.createdBy || null,
      e.eventType,
      e.statusFrom || null,
      e.statusTo || null,
      e.note || null,
      e.payload != null ? JSON.stringify(e.payload) : null,
    ]
  );
}

// Insert a draft claim for a session plus its 'created' claim_events row, and
// return the claim row. Must be called inside a transaction (`q` = pg client) so
// the claim and its event commit together. Replicates POST /claims exactly.
async function insertDraftClaim(q, opts) {
  const session = opts.session;
  const ins = await q.query(
    `insert into claims
       (practice_id, session_id, client_id, clinician_id, insurance_record_id,
        claim_number, status, billed_amount)
     values ($1, $2, $3, $4, $5, $6, 'draft', $7)
     returning *`,
    [
      opts.practiceId,
      session.id,
      session.client_id,
      session.clinician_id,
      opts.insuranceRecordId != null ? opts.insuranceRecordId : null,
      opts.claimNumber != null ? opts.claimNumber : null,
      opts.billedAmount != null ? opts.billedAmount : null,
    ]
  );
  const claim = ins.rows[0];
  await logClaimEvent(q, {
    practiceId: opts.practiceId,
    claimId: claim.id,
    createdBy: opts.createdBy || null,
    eventType: 'created',
    statusTo: 'draft',
    note: opts.note || 'Claim created from session.',
  });
  return claim;
}

module.exports = {
  primaryInsuranceForClient,
  sessionHasActiveClaim,
  logClaimEvent,
  insertDraftClaim,
};
