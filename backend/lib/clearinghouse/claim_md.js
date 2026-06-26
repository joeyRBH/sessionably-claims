'use strict';

// Claim.MD clearinghouse adapter. GATED: only used when CLEARINGHOUSE=claim_md and
// CLAIMMD_ACCOUNT_KEY is set on the Lambda environment. Transport below is verified
// against the Claim.MD REST API (https://api.claim.md/):
//
//   submit : POST {BASE}/upload/    multipart/form-data  AccountKey + File(JSON claim)
//   status : POST {BASE}/response/  x-www-form-urlencoded AccountKey + ResponseID [+ ClaimID]
//   Accept: application/json on both.
//
// Runs on Node 20 (global fetch / FormData / Blob / URLSearchParams).
//
// THREE THINGS MUST BE VALIDATED AGAINST YOUR TEST ACCOUNT BEFORE GOING LIVE:
//   1. JSON claim field schema — buildClaimFile() is a STARTING POINT, not a verified
//      837P mapping. Use the official example + field list:
//        https://www.claim.md/ClaimMD_Professional_Claims_Example.json
//        https://www.claim.md/Claim.MD_Field_List.xlsx
//   2. payer_id — Claim.MD requires a numeric `payerid`. insurance_records has no
//      payer_id column yet; resolve via POST /services/payerlist/ or add a column.
//   3. mapStatus() — conservative text match; refine using
//        https://docs.claim.md/docs/claim-status-codes
// Until validated, keep CLEARINGHOUSE=mock.

const name = 'claim_md';
const BASE = process.env.CLAIMMD_BASE_URL || 'https://svc.claim.md/services';

function accountKey() {
  const k = process.env.CLAIMMD_ACCOUNT_KEY;
  if (!k) {
    throw new Error('CLAIMMD_ACCOUNT_KEY is not set');
  }
  return k;
}

// Pull the most relevant <claim> object out of a Claim.MD JSON result, tolerating
// both { result: { claim: [...] } } and { claim: {...} } shapes.
function firstClaim(data) {
  if (!data) return null;
  const r = data.result || data;
  const c = r && r.claim;
  if (Array.isArray(c)) return c.length ? c[c.length - 1] : null;
  return c || null;
}

// TODO(validate): map our normalized ctx to Claim.MD's professional-claim JSON.
// This is a minimal placeholder; confirm field names against the example file above.
function buildClaimFile(ctx) {
  const claim = ctx.claim || {};
  const insurance = ctx.insurance || {};
  const practice = ctx.practice || {};
  const clinician = ctx.clinician || {};
  return JSON.stringify({
    claim: [
      {
        remote_claimid: claim.id, // echoed back by Claim.MD for reconciliation
        bill_npi: practice.npi || clinician.npi || '',
        bill_taxid: practice.tax_id || '',
        payerid: ctx.payer_id || '', // TODO: resolve real Claim.MD payerid
        ins_number: insurance.member_id || '',
        total_charge: claim.billed_amount != null ? String(claim.billed_amount) : '',
        // ... patient demographics + charge lines per the field list. PLACEHOLDER.
      },
    ],
  });
}

async function submitClaim(ctx) {
  const form = new FormData();
  form.append('AccountKey', accountKey());
  const blob = new Blob([buildClaimFile(ctx)], { type: 'application/json' });
  form.append('File', blob, 'claim.json');

  const res = await fetch(`${BASE}/upload/`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Claim.MD upload failed: HTTP ${res.status}`);
  }
  const claim = firstClaim(data);
  const control = claim && (claim.claimmd_id || claim.claimid);
  if (!control) {
    throw new Error('Claim.MD upload returned no claim id');
  }
  return {
    control_number: String(control),
    claim_number: claim.claimid ? String(claim.claimid) : null,
    status: 'submitted',
    raw: data,
  };
}

async function getStatus({ control_number }) {
  const body = new URLSearchParams({
    AccountKey: accountKey(),
    ResponseID: '0',
    ClaimID: String(control_number),
  });
  const res = await fetch(`${BASE}/response/`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Claim.MD status poll failed: HTTP ${res.status}`);
  }
  return {
    status: mapStatus(firstClaim(data)),
    denial_reason: null, // TODO: parse from messages on denial
    allowed_amount: null, // TODO: source paid/allowed amounts from ERA (/eralist/ + /eradata/)
    reimbursed_amount: null,
    patient_responsibility: null,
    raw: data,
  };
}

// TODO(validate): refine against Claim.MD claim status codes.
function mapStatus(claim) {
  if (!claim) return 'submitted';
  const blob = JSON.stringify(claim).toLowerCase();
  if (blob.includes('denied') || blob.includes('rejected')) return 'denied';
  if (blob.includes('paid') || blob.includes('finalized/payment')) return 'paid';
  if (blob.includes('acknowledged') || claim.status === 'A') return 'processing';
  return 'submitted';
}

module.exports = { name, submitClaim, getStatus, buildClaimFile, mapStatus, firstClaim };
