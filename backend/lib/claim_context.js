'use strict';

// Assembling the normalized context a clearinghouse adapter needs, plus the
// status → claim_event map that goes with it.
//
// WHY ITS OWN MODULE. Two callers build this now: the staff-driven claims
// handler and the scheduled status poller. The context decides WHO the claim
// was filed for — subscriber, billing provider, rendering provider, the service
// lines — and a 276 status request has to mirror the 837 that was actually
// filed, or the payer answers about a different claim (or no claim). Two
// assemblies would be two answers to that question, diverging silently.
//
// It is NOT in lib/claims.js deliberately: five test files mock that module
// wholesale to keep the database out, and moving this there would replace the
// real context assembly with a stub in every one of them — hollowing out the
// submit-path coverage that exists precisely to catch mistakes here.
//
// Adapters never touch the database; everything they need arrives through this.

const db = require('./db');
const fieldCrypto = require('./crypto');
const { primaryInsuranceForClient, loadClaimSessions } = require('./claims');

function eventTypeForStatus(status) {
  switch (status) {
    case 'submitted': return 'submitted';
    case 'processing': return 'processing';
    case 'info_requested': return 'info_requested';
    case 'denied': return 'denied';
    case 'appealed': return 'appealed';
    case 'paid': return 'paid';
    case 'void': return 'voided';
    default: return 'note';
  }
}

async function loadSession(practiceId, sessionId) {
  const res = await db.query(
    `select * from sessions where id = $1 and practice_id = $2 and is_hidden = false limit 1`,
    [sessionId, practiceId]
  );
  return res.rows[0] || null;
}

async function loadInsuranceRecord(practiceId, recordId) {
  const res = await db.query(
    `select * from insurance_records
      where id = $1 and practice_id = $2 and is_hidden = false limit 1`,
    [recordId, practiceId]
  );
  return res.rows[0] || null;
}

async function buildClaimContext(practiceId, claim) {
  const [sessionRes, clientRes, clinicianRes, practiceRes, profileRes] = await Promise.all([
    db.query(`select * from sessions where id = $1 and practice_id = $2 limit 1`, [claim.session_id, practiceId]),
    db.query(`select * from clients where id = $1 and practice_id = $2 limit 1`, [claim.client_id, practiceId]),
    db.query(`select * from users where id = $1 and practice_id = $2 limit 1`, [claim.clinician_id, practiceId]),
    db.query(`select * from practices where id = $1 limit 1`, [practiceId]),
    db.query(
      `select * from provider_billing_profiles where practice_id = $1 and provider_user_id = $2 limit 1`,
      [practiceId, claim.clinician_id]
    ),
  ]);
  let insurance = null;
  if (claim.insurance_record_id) {
    insurance = await loadInsuranceRecord(practiceId, claim.insurance_record_id);
  }

  // The rendering clinician's billing profile decides how the 837P billing- and
  // rendering-provider loops are built (person vs organization). Decrypt the
  // person billing TIN here so the adapter stays a pure, DB-/key-free function of
  // ctx (it reads billingProfile.billing_tin as plaintext digits). A decrypt
  // failure leaves billing_tin undefined; the adapter falls back accordingly.
  let billingProfile = profileRes.rows[0] || null;
  if (billingProfile && billingProfile.billing_tin_ciphertext) {
    try {
      billingProfile = { ...billingProfile, billing_tin: fieldCrypto.decrypt(billingProfile.billing_tin_ciphertext) };
    } catch (_) {
      billingProfile = { ...billingProfile, billing_tin: null };
    }
  }

  // Every session billed on this claim, in filing order — one 837P service line
  // each. ctx.session stays the ANCHOR (claims.session_id) because the claim-LEVEL
  // fields the builder reads from it (place of service, the diagnosis set) are
  // single-valued on an 837P. A claim predating migration 022's backfill would
  // load no lines, so fall back to the anchor rather than building an empty claim.
  const lines = await loadClaimSessions(db, practiceId, claim.id);
  const anchor = sessionRes.rows[0] || null;

  return {
    claim,
    sessions: lines.length ? lines : (anchor ? [anchor] : []),
    session: anchor,
    client: clientRes.rows[0] || null,
    clinician: clinicianRes.rows[0] || null,
    practice: practiceRes.rows[0] || null,
    billingProfile,
    insurance,
    payer_id: null, // not modeled yet; the Claim.MD adapter flags this
  };
}
module.exports = {
  loadSession,
  loadInsuranceRecord,
  buildClaimContext,
  eventTypeForStatus,
};
