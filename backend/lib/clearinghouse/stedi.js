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

// Submitter contact (837P loop 1000A). Reddably is the submitter/clearinghouse
// intermediary, so this is a platform constant rather than per-practice data.
// Stedi requires at least one of phone / email / fax on the submitter contact.
const SUBMITTER_CONTACT_EMAIL =
  process.env.STEDI_SUBMITTER_EMAIL || 'billing@reddably.com';

function apiKey() {
  const k = process.env.STEDI_API_KEY;
  if (!k) {
    throw new Error('STEDI_API_KEY is not set');
  }
  return k;
}

// Bound every Stedi call with a hard timeout. global fetch has no default
// timeout, so a network-path failure (e.g. no egress route to the public API)
// leaves the socket hanging until the Lambda is killed — ~10s of dead air that
// surfaces to the user as an opaque 502. An AbortController fails fast instead,
// with a clear "timed out" error the handler can log. All three Stedi endpoints
// share the same POST + raw-key-auth shape, so they route through here.
const STEDI_TIMEOUT_MS = Number(process.env.STEDI_TIMEOUT_MS || 15000);

async function stediPost(path, body, extraHeaders) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STEDI_TIMEOUT_MS);
  try {
    return await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: apiKey(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(extraHeaders || {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      // Never include the request body — it can carry PHI (member id, name, DOB).
      throw new Error(`Stedi request to ${path} timed out after ${STEDI_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Format a date (pg `date` → JS Date or 'YYYY-MM-DD' string) as YYYYMMDD, or null.
function ymd(d) {
  if (d == null || d === '') return null;
  const iso = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  const digits = iso.replace(/-/g, '');
  return /^\d{8}$/.test(digits) ? digits : null;
}

// Map a clients.gender value to the 837 demographic code (M / F / U).
function genderCode(g) {
  switch (g) {
    case 'female':
      return 'F';
    case 'male':
      return 'M';
    default:
      return 'U';
  }
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
    claimFilingCode: 'CI',           // commercial / OON default
    claimFrequencyCode: '1',         // original claim
    placeOfServiceCode: '11',        // office (default; can be overridden per session)
    claimChargeAmount: claim.billed_amount != null ? String(claim.billed_amount) : undefined,
    patientControlNumber: String(claim.id), // echoed back in 277CA / 835 ERA for reconciliation
    benefitsAssignmentCertificationIndicator: 'N',
    releaseInformationCode: 'Y',
    signatureIndicator: 'Y',         // provider signature on file
    planParticipationCode: 'C',      // not assigned — OON: payer reimburses the client directly
    // Diagnosis code — required by Stedi. Use the ICD-10 code from the session if present,
    // otherwise fall back to a placeholder so the adapter doesn't hard-fail on missing data.
    healthCareCodeInformation: [
      {
        diagnosisTypeCode: 'ABK', // principal diagnosis
        diagnosisCode: session.diagnosis_codes?.[0] || 'F329', // F329 = unspecified depressive episode
      },
    ],
  };

  // Only attach a service line when we have a CPT code; otherwise omit serviceLines.
  if (session.cpt_code) {
    claimInformation.serviceLines = [
      {
        serviceDate: ymd(session.session_date) || undefined,
        professionalService: {
          procedureIdentifier: 'HC',
          procedureCode: session.cpt_code,
          lineItemChargeAmount: claim.billed_amount != null ? String(claim.billed_amount) : undefined,
          measurementUnit: 'UN',     // units of service
          serviceUnitCount: '1',     // one unit per claim line (standard for OON psychotherapy CPT codes)
          // Point this service line at the principal diagnosis declared above (index 1).
          compositeDiagnosisCodePointers: { diagnosisCodePointers: ['1'] },
        },
      },
    ];
  }

  const body = {
    tradingPartnerServiceId,
    submitter: {
      organizationName: practice.name || undefined,
      contactInformation: {
        name: practice.name || undefined,
        email: SUBMITTER_CONTACT_EMAIL,
      },
    },
    receiver: {
      organizationName: insurance.carrier_name || undefined,
    },
    billing: {
      providerType: 'BillingProvider',
      npi: billingNpi || undefined,
      employerId: practice.tax_id || undefined,   // was taxId — Stedi field is employerId
      organizationName: practice.name || undefined,
      address: {
        address1: practice.address_line1 || undefined,
        address2: practice.address_line2 || undefined,
        city: practice.city || undefined,
        state: practice.state || undefined,
        postalCode: practice.postal_code || undefined,
      },
    },
    subscriber: {
      paymentResponsibilityLevelCode: 'P',        // primary payer
      memberId: insurance.member_id || undefined,
      firstName: client.first_name || undefined,
      lastName: client.last_name || undefined,
      dateOfBirth: ymd(client.date_of_birth) || undefined,
      gender: genderCode(client.gender),          // 837 requires demographics when patient is subscriber
      address: {
        address1: client.address_line1 || undefined,
        address2: client.address_line2 || undefined,
        city: client.city || undefined,
        state: client.state || undefined,
        postalCode: client.postal_code || undefined,
      },
    },
    claimInformation,
  };

  const res = await stediPost('/professionalclaims/v3/submission', body, {
    'Idempotency-Key': String(claim.id || ''),
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

  const res = await stediPost('/claimstatus/v3/status', {
    tradingPartnerServiceId,
    controlNumber: control_number,
    provider,
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

// -----------------------------------------------------------------------------
// Eligibility / VOB (270/271) — real-time benefit check. Powers the Instant VOB
// add-on (handlers/vob.js). Same base + raw-key auth as submitClaim; the endpoint
// is {base}/eligibility/v3. Returns Stedi's parsed 271 response verbatim; the
// handler normalizes it for the UI and keeps the full payload as `raw`.
// -----------------------------------------------------------------------------
async function checkEligibility(params) {
  const p = params || {};

  const tradingPartnerServiceId = p.payerId;
  if (!tradingPartnerServiceId) {
    throw new Error('Stedi eligibility requires payerId (tradingPartnerServiceId).');
  }

  // Provider: Stedi requires an organizationName or a first/last name, plus the NPI.
  const provider = {};
  if (p.organizationName) provider.organizationName = p.organizationName;
  if (p.npi) provider.npi = p.npi;

  const body = {
    tradingPartnerServiceId,
    provider,
    subscriber: {
      memberId: p.memberId || undefined,
      firstName: p.firstName || undefined,
      lastName: p.lastName || undefined,
      dateOfBirth: ymd(p.dateOfBirth) || undefined,
    },
    // Service type 30 = Health Benefit Plan Coverage (general benefits) by default.
    encounter: {
      serviceTypeCodes: [p.serviceType ? String(p.serviceType) : '30'],
    },
  };

  const res = await stediPost('/eligibility/v3', body);

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Stedi eligibility failed (HTTP ${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

module.exports = { name, submitClaim, getStatus, checkEligibility, mapStatus, firstStatus };
