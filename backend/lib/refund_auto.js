'use strict';

// Turning a clearinghouse denial into a refund request the practice admin can
// act on — without the patient having to notice, phone their clinician, and have
// someone type it in.
//
// MONEY-PATH, but one step removed from it. Nothing here moves money or decides
// anything: it creates an OPEN request that a human still adjudicates. The
// Stripe refund lives in handlers/refund_requests.js behind an explicit approve,
// and that stays true — "nothing here ever auto-approves" is the guarantee this
// module must not quietly erode by making approval feel automatic.
//
// What it can get wrong, and what that costs:
//
//   * a request raised that should not have been → the admin denies it. Cheap,
//     but not free: every wrong request is noise in a queue whose whole value is
//     that its contents deserve attention.
//   * a denial missed → the patient is out a fee they were promised back, and
//     nobody knows. Expensive, and invisible.
//
// The rules below are therefore deliberately CONSERVATIVE about raising one, and
// the missed-denial case is handled by the queue being re-checkable rather than
// by guessing. See claim_acknowledgments in db/schema.sql: every payload is
// stored verbatim, so a denial this module declined to act on is still on record
// and a later, better rule can find it.

// The 5% platform fee is charged at SUBMIT (public/js/api-client.js chains
// chargeClaimFee onto a successful submit), so by the time a denial arrives the
// money has normally already moved. "Normally" is doing work: the charge is
// best-effort and can fail or decline, and a claim with no paid fee has nothing
// to refund.
const FEE_TYPE = 'platform_fee';

// Every reason we decline, as a stable code. Returned rather than logged from
// inside, so the caller decides what to record — and so the tests can assert on
// the REASON, not just on the refusal.
const DECLINE = {
  NOT_DENIED: 'not_denied',
  NO_TRANSITION: 'no_transition',
  NOT_ADJUDICATED: 'not_adjudicated',
  NO_PAID_FEE: 'no_paid_fee',
  ALREADY_REFUNDED: 'already_refunded',
  REQUEST_ALREADY_OPEN: 'request_already_open',
};

// The whole decision, as a pure function. No DB, no HTTP, no logging.
//
//   status            the claim's status AFTER this refresh
//   statusChanged     whether this refresh MOVED it there
//   denialClass       'adjudicated' | 'acknowledgement_reject' | null, from the
//                     clearinghouse adapter
//   paidFeeAmount     the platform fee actually collected, or null
//   alreadyRefunded   a refund transaction already exists for this claim
//   hasOpenRequest    an open refund request already exists for this claim
//
// -> { create: true } | { create: false, reason: <DECLINE code> }
function evaluateAutoRefund(input) {
  const i = input || {};

  if (i.status !== 'denied') return { create: false, reason: DECLINE.NOT_DENIED };

  // TRANSITION ONLY, and this is the rule that keeps the queue usable. A claim
  // sits in 'denied' indefinitely, and staff refresh claims freely. Acting on
  // the STATE would re-raise a request every time somebody clicked refresh on a
  // denied claim — including claims whose request an admin has already
  // considered and denied, since the one-open-per-claim index only blocks
  // duplicates while the first is still open. Acting on the EDGE raises it once.
  //
  // A genuine second denial (denied → appealed → denied) is a real edge and
  // correctly raises a second request.
  if (!i.statusChanged) return { create: false, reason: DECLINE.NO_TRANSITION };

  // The distinction this whole feature turns on. 'acknowledgement_reject' is a
  // claim rejected at the payer's front door: never adjudicated, fixable, and
  // about to be corrected and resubmitted — and that resubmission charges its
  // own fee. Refunding here would hand back a fee for a claim that is coming
  // straight back. null means we could not tell, which is treated exactly like
  // "not adjudicated": we do not raise money questions on evidence we cannot
  // read. See denialClass() in lib/clearinghouse/stedi.js.
  if (i.denialClass !== 'adjudicated') return { create: false, reason: DECLINE.NOT_ADJUDICATED };

  const fee = Number(i.paidFeeAmount);
  if (!Number.isFinite(fee) || fee <= 0) return { create: false, reason: DECLINE.NO_PAID_FEE };

  if (i.alreadyRefunded) return { create: false, reason: DECLINE.ALREADY_REFUNDED };

  // Belt to the partial unique index's braces. The index is the real guard
  // against a race; this just avoids provoking it in the common case.
  if (i.hasOpenRequest) return { create: false, reason: DECLINE.REQUEST_ALREADY_OPEN };

  return { create: true };
}

// Gather the three facts evaluateAutoRefund needs from the database. One query
// each, all narrow, all scoped by claim.
async function gatherFacts(db, claimId) {
  const [fee, refunded, open] = await Promise.all([
    db.query(
      `select amount from transactions
        where claim_id = $1 and type = $2 and status = 'paid'
        order by created_at desc limit 1`,
      [claimId, FEE_TYPE]
    ),
    db.query(
      `select 1 from transactions
        where claim_id = $1 and (type = 'refund' or status = 'refunded') limit 1`,
      [claimId]
    ),
    db.query(
      `select 1 from refund_requests where claim_id = $1 and status = 'open' limit 1`,
      [claimId]
    ),
  ]);
  return {
    paidFeeAmount: fee.rowCount ? Number(fee.rows[0].amount) : null,
    alreadyRefunded: refunded.rowCount > 0,
    hasOpenRequest: open.rowCount > 0,
  };
}

// Create the request, or explain why not.
//
// BEST-EFFORT BY CONTRACT. The caller (handlers/claims.js refreshClaim) runs
// this AFTER its status transaction has committed, and must not let anything
// here fail the refresh: a denial that is recorded but raises no request is a
// recoverable gap (the acknowledgment is stored, the claim reads 'denied', a
// human can still file the request by hand), whereas losing the status update
// itself throws away what the payer told us.
//
// -> { created: true, request } | { created: false, reason }
async function maybeCreateForDenial(db, params) {
  const p = params || {};
  const claim = p.claim || {};

  // Cheap checks first — the common case is "not a denial", and it should cost
  // nothing. Only then touch the database.
  const preflight = evaluateAutoRefund({
    status: p.status,
    statusChanged: p.statusChanged,
    denialClass: p.denialClass,
    // Not yet known; the fee/refund/open checks run below against real facts.
    paidFeeAmount: 1,
    alreadyRefunded: false,
    hasOpenRequest: false,
  });
  if (!preflight.create) return { created: false, reason: preflight.reason };

  const facts = await gatherFacts(db, claim.id);
  const verdict = evaluateAutoRefund({
    status: p.status,
    statusChanged: p.statusChanged,
    denialClass: p.denialClass,
    paidFeeAmount: facts.paidFeeAmount,
    alreadyRefunded: facts.alreadyRefunded,
    hasOpenRequest: facts.hasOpenRequest,
  });
  if (!verdict.create) return { created: false, reason: verdict.reason };

  try {
    const res = await db.query(
      `insert into refund_requests
         (practice_id, claim_id, client_id, outcome_label, status, source)
       values ($1, $2, $3, 'denied', 'open', 'system_denial')
       returning *`,
      [claim.practice_id, claim.id, claim.client_id]
    );
    return { created: true, request: res.rows[0] };
  } catch (err) {
    // 23505 = the one-open-per-claim partial unique index. Two refreshes racing
    // on the same claim is a normal thing for staff to do, and the loser of that
    // race has nothing to report: the request it wanted already exists.
    if (err && err.code === '23505') {
      return { created: false, reason: DECLINE.REQUEST_ALREADY_OPEN };
    }
    throw err;
  }
}

module.exports = {
  DECLINE,
  evaluateAutoRefund,
  maybeCreateForDenial,
};
