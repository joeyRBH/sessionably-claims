'use strict';

// Remembering which payers refuse an automated claim-status (276) inquiry.
//
// The adapter can already tell a payer's refusal (BAD_REQUEST) from our own bad
// request (INVALID_REQUEST_BODY) — see lib/clearinghouse/stedi.js statusErrorKind.
// This module is the memory of that answer, so the same hopeless payer is not
// re-asked every six hours forever.
//
// WHAT THIS IS NOT. Not a configuration switch and not an authorization gate. No
// human sets it, nothing reads it to decide what a caller MAY do, and a stale or
// wrong row costs at most one extra probe. It is a cache of an observation, and
// every write is the result of a real probe.
//
// THE ASYMMETRY THAT SHAPES IT. A wasted probe on a payer that cannot answer is
// cheap. A SKIPPED probe on a payer that can is expensive and invisible: that
// claim's denial is never detected, so the patient never gets the fee back they
// were promised. Every rule here therefore leans towards probing:
//
//   * only an explicit refusal is recorded as unsupported — never a timeout, a
//     network error, or an unrecognized failure;
//   * a refusal expires after REPROBE_AFTER_DAYS and is tried again;
//   * any success clears it immediately;
//   * a failure to READ the memory means "probe anyway", never "skip".

const db = require('./db');

// How long a refusal is honoured before the payer is probed once more.
// Clearinghouses add payers; a permanent blocklist would go stale in silence and
// nothing would ever say so. 30 days is long enough to stop the 6-hourly waste
// (120 wasted probes become 1) and short enough that new support is noticed
// within a billing cycle.
const REPROBE_AFTER_DAYS = 30;

// recordProbe({ practiceId, payerId, supported, errorCode }) — upsert what we
// just learned. Never throws: this is bookkeeping about our own outreach, and it
// must not fail the status check that produced it.
//
// consecutive_refusals counts only refusals and resets on any success, so it
// reads as "how long has this payer been saying no" rather than a lifetime total.
async function recordProbe({ practiceId, payerId, supported, errorCode }, deps) {
  const client = (deps && deps.db) || db;
  if (!practiceId || !payerId) return { recorded: false };
  try {
    await client.query(
      `insert into payer_status_capability
         (practice_id, payer_id, supports_claim_status, last_probed_at,
          last_error_code, consecutive_refusals)
       values ($1, $2, $3, now(), $4, case when $3 then 0 else 1 end)
       on conflict (practice_id, payer_id) do update
         set supports_claim_status = excluded.supports_claim_status,
             last_probed_at        = now(),
             last_error_code       = excluded.last_error_code,
             consecutive_refusals  = case
               when excluded.supports_claim_status then 0
               else payer_status_capability.consecutive_refusals + 1
             end`,
      [practiceId, payerId, supported === true, supported === true ? null : (errorCode || null)]
    );
    return { recorded: true };
  } catch (err) {
    // Name the operation, never the row. A failure here means we will simply
    // probe again next time, which is the safe direction.
    console.error('payer_capability: could not record probe result');
    return { recorded: false };
  }
}

// unsupportedPayerIds(practiceId) -> Set of payer ids to SKIP right now, i.e.
// refused and still inside the re-probe window. One query per run rather than one
// per claim.
//
// On any error this returns an EMPTY set — "skip nobody". A database problem must
// degrade into doing more work, never into silently polling less.
async function unsupportedPayerIds(practiceId, deps) {
  const client = (deps && deps.db) || db;
  try {
    const res = await client.query(
      `select payer_id
         from payer_status_capability
        where practice_id = $1
          and supports_claim_status = false
          and last_probed_at > now() - ($2 || ' days')::interval`,
      [practiceId, String(REPROBE_AFTER_DAYS)]
    );
    return new Set(res.rows.map((r) => r.payer_id));
  } catch (err) {
    console.error('payer_capability: could not read capability cache — probing all payers');
    return new Set();
  }
}

// isUnsupported({ practiceId, payerId }) -> boolean, for a single claim (the
// claim detail's warning). Same "errors mean probe anyway" rule.
async function isUnsupported({ practiceId, payerId }, deps) {
  const client = (deps && deps.db) || db;
  if (!practiceId || !payerId) return false;
  try {
    const res = await client.query(
      `select 1
         from payer_status_capability
        where practice_id = $1
          and payer_id = $2
          and supports_claim_status = false
          and last_probed_at > now() - ($3 || ' days')::interval
        limit 1`,
      [practiceId, payerId, String(REPROBE_AFTER_DAYS)]
    );
    return res.rowCount > 0;
  } catch (err) {
    console.error('payer_capability: could not read capability for a claim');
    return false;
  }
}

// The payer id a status inquiry would actually use, mirroring the adapter's own
// precedence (lib/clearinghouse/stedi.js buildStatusBody): the id the claim was
// SUBMITTED with wins over whatever the insurance record says now, because the
// payer being asked is the one that received the 837.
function payerIdForStatus(claim, insurance) {
  const payload = (claim && claim.clearinghouse_payload) || {};
  const submitted = payload.tradingPartnerServiceId;
  if (submitted) return String(submitted);
  const current = insurance && insurance.payer_id;
  return current ? String(current) : null;
}

module.exports = {
  REPROBE_AFTER_DAYS,
  recordProbe,
  unsupportedPayerIds,
  isUnsupported,
  payerIdForStatus,
};
