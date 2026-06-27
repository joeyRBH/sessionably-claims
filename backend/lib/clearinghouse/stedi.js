'use strict';

// Stedi clearinghouse adapter. GATED: only used when CLEARINGHOUSE=stedi and
// STEDI_API_KEY is set on the Lambda environment. Transport targets Stedi's
// Healthcare medical-network REST API:
//
//   base   : https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork
//   auth   : Authorization: <STEDI_API_KEY>   (raw key, every request)
//   submit : POST {base}/professionalclaims/v3/submission   application/json
//   status : POST {base}/claimstatus/v3/status              application/json
//
// Runs on Node 20+ (global fetch). The handler stores whatever submitClaim()
// returns as `raw` into claims.clearinghouse_payload, so we persist the
// tradingPartnerServiceId and billing NPI there for getStatus() to reuse.
//
// NOTE: the request/response field mappings below follow the spec and Stedi's
// published shapes but should be confirmed against a Stedi test account before
// going live. Until validated, keep CLEARINGHOUSE=mock.

const name = 'stedi';
const BASE =
  process.env.STEDI_BASE_URL ||
  'https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork';

function apiKey() {
  const k = process.env.STEDI_API_KEY;
  if (!k) {
    throw new Error('STEDI_API_KEY is not set');
  }
  return k;
}

// Format a date (pg `date` → JS Date or 'YYYY-MM-DD' string) as YYYYMMDD, or null.
function ymd(d) {
  if (d == null || d === '') return null;
  const iso = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  const digits = iso.replace(/-/g, '');
  return /^\d{8}$/.test(digits) ? digits : null;
}

// Parse a finite number out of an adjudication field, else null.
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function submitClaim(ctx) {
  const claim = (ctx && ctx.claim) || {};
  const insurance = (ctx && ctx.insurance) || {};
  const client = (ctx && ctx.client) || {};
  const clinician = (ctx && ctx.clinician) || {};
  const practice = (ctx && ctx.practice) || {};
  const session = (ctx && ctx.session) || {};

  const tradingPartnerServiceId = insurance.payer_id;
  if (!tradingPartnerServiceId) {
    throw new Error('Stedi submit requires insurance.payer_id (tradingPartnerServiceId).');
  }

  const billingNpi = practice.npi || clinician.npi || null;

  const claimInformation = {
    claimFilingCode: 'CI', // commercial / OON default
    totalClaimChargeAmount: claim.billed_amount != null ? String(claim.billed_amount) : undefined,
  };
  // Only attach a service line when we have a CPT code; otherwise omit serviceLines.
  if (session.cpt_code) {
    claimInformation.serviceLines = [
      {
        professionalService: {
          procedureIdentifier: 'HC', // HCPCS/CPT qualifier
          procedureCode: session.cpt_code,
          lineItemChargeAmount: claim.billed_amount != null ? String(claim.billed_amount) : undefined,
        },
      },
    ];
  }

  const body = {
    tradingPartnerServiceId,
    externalPatientId: claim.id, // echoed back for reconciliation
    billing: {
      npi: billingNpi || undefined,
      taxId: practice.tax_id || undefined,
      organizationName: practice.name || undefined,
    },
    subscriber: {
      memberId: insurance.member_id || undefined,
      firstName: client.first_name || undefined,
      lastName: client.last_name || undefined,
      dateOfBirth: ymd(client.date_of_birth) || undefined,
    },
    claimInformation,
  };

  const res = await fetch(`${BASE}/professionalclaims/v3/submission`, {
    method: 'POST',
    headers: {
      Authorization: apiKey(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Idempotency-Key': String(claim.id || ''),
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));

  // Stedi returns the control number on claimReference.correlationId or controlNumber.
  const ref = (data && data.claimReference) || {};
  const control = ref.correlationId || data.controlNumber || ref.controlNumber || null;

  if (!res.ok || !control) {
    throw new Error(
      `Stedi submission failed (HTTP ${res.status}): ${JSON.stringify(data)}`
    );
  }

  return {
    control_number: String(control),
    claim_number: claim.claim_number || String(control),
    status: 'submitted',
    // Persisted to claims.clearinghouse_payload — getStatus() reads these back.
    raw: {
      adapter: name,
      tradingPartnerServiceId,
      billing_npi: billingNpi,
      response: data,
    },
  };
}

// Map a Stedi claimStatus code (numeric or descriptive) to the Reddably enum.
function mapStatus(code) {
  const c = code == null ? '' : String(code).trim().toLowerCase();
  switch (c) {
    case '1':
    case 'processed as primary':
    case '2':
    case 'processed as secondary':
    case '3':
    case 'processed as tertiary':
      return 'paid';
    case '4':
    case 'denied':
      return 'denied';
    case '19':
    case 'pending':
      return 'processing';
    default:
      return 'submitted';
  }
}

// Pull the most relevant claim-status object out of Stedi's response, tolerating
// a few shapes ({ claims: [{ claimStatus }] }, { claimStatus }, flat).
function firstStatus(data) {
  if (!data) return null;
  const claims = data.claims || (data.claim ? [data.claim] : null);
  if (Array.isArray(claims) && claims.length) {
    const last = claims[claims.length - 1];
    return last.claimStatus || last.status || last;
  }
  return data.claimStatus || data.status || data;
}

async function getStatus({ control_number, claim }) {
  const payload = (claim && claim.clearinghouse_payload) || {};
  const tradingPartnerServiceId = payload.tradingPartnerServiceId || undefined;
  const billingNpi = payload.billing_npi || undefined;

  const provider = {};
  if (billingNpi) provider.npi = billingNpi;

  const res = await fetch(`${BASE}/claimstatus/v3/status`, {
    method: 'POST',
    headers: {
      Authorization: apiKey(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      tradingPartnerServiceId,
      controlNumber: control_number,
      provider,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Stedi status check failed (HTTP ${res.status}): ${JSON.stringify(data)}`);
  }

  const info = firstStatus(data) || {};
  const code =
    info.claimStatusCategoryCode != null ? info.claimStatusCategoryCode
      : info.statusCategoryCode != null ? info.statusCategoryCode
        : info.statusCode != null ? info.statusCode
          : info.code;
  const status = mapStatus(code);

  // Adjudication amounts live under a few possible keys; absent → null.
  const adj = info.adjudication || info.monetaryAmounts || info;
  const allowed = num(adj.allowedAmount);
  const reimbursed = num(adj.paidAmount != null ? adj.paidAmount : adj.reimbursedAmount);
  const patientResp = num(adj.patientResponsibilityAmount);

  const denialReason =
    status === 'denied'
      ? info.statusCategoryCodeValue || info.claimStatusCategoryCodeValue || info.description || null
      : null;

  return {
    status,
    denial_reason: denialReason,
    allowed_amount: allowed,
    reimbursed_amount: reimbursed,
    patient_responsibility: patientResp,
    raw: data,
  };
}

module.exports = { name, submitClaim, getStatus, mapStatus, firstStatus };
