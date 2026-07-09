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

// GET counterpart to stediPost for the read-only endpoints that live outside the
// medical-network base (e.g. the payer-search API). Takes a full URL so the caller
// owns the path + query string. Reuses the exact same 15s AbortController bound and
// PHI-safe timeout message — the URL is never echoed in the error, since a query
// string could in principle carry sensitive terms.
async function stediGet(url, extraHeaders) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STEDI_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: apiKey(),
        Accept: 'application/json',
        ...(extraHeaders || {}),
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`Stedi GET request timed out after ${STEDI_TIMEOUT_MS}ms`);
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

// 837P control numbers (CLM01 patient control number, REF*6R line item control
// number) are capped at 20 characters; a longer value makes Stedi reject the claim
// (error 33). Strip to alphanumerics (payers mishandle special characters) and cap
// at 20 as a defensive backstop — the handler already mints a <=17-char value.
const MAX_CONTROL_NUMBER_LEN = 20;
function boundControlNumber(v) {
  return String(v == null ? '' : v).replace(/[^A-Za-z0-9]/g, '').slice(0, MAX_CONTROL_NUMBER_LEN);
}

// The patient control number to send. Prefer the value the claim carries (minted
// and persisted by the claims handler so it stays stable across resubmissions and
// matches 277/835 responses). Fall back to a short, deterministic id derived from
// the claim UUID so a direct adapter call never sends the raw 36-char UUID.
function patientControlNumber(claim) {
  const stored = boundControlNumber(claim && claim.patient_control_number);
  if (stored) return stored;
  return boundControlNumber(claim && claim.id).slice(0, 17) || 'CLAIM';
}

// Build the 837P submission request body from the claim context. Pure (no network)
// so it can be unit-tested; submitClaim() POSTs whatever this returns.
function buildSubmissionBody(ctx) {
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
    patientControlNumber: patientControlNumber(claim), // <=20 chars; echoed in 277CA / 835 ERA for reconciliation
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
  // Note: no line-item control number (REF*6R) is sent — nothing here is UUID-based,
  // so there is no >20-char value to bound. If one is ever added, route it through
  // boundControlNumber() so it stays within the 20-char limit like the CLM01 above.
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

  return { body, tradingPartnerServiceId, billingNpi };
}

// Pull a human-readable rejection out of a Stedi submission error body so the
// handler can surface it (e.g. error 33 "Invalid Patient Control Number ...").
// Tolerates the shapes Stedi returns — an `errors` array of { code, message /
// description / field }, a single `error` object, or an RFC7807 { title, detail }.
// Returns { code, description } or null when nothing surfaceable is present.
function parseSubmissionRejection(data) {
  if (!data || typeof data !== 'object') return null;

  const arr = Array.isArray(data.errors) ? data.errors
    : Array.isArray(data.fieldErrors) ? data.fieldErrors
      : data.error && typeof data.error === 'object' ? [data.error]
        : null;

  if (arr && arr.length) {
    const describe = (e) => {
      if (e == null) return null;
      if (typeof e === 'string') return e;
      const code = e.code != null ? e.code : e.errorCode;
      const msg = e.message || e.description || e.detail || e.error || e.title || e.field;
      if (msg == null && code == null) return null;
      return code != null ? `[${code}] ${msg != null ? msg : ''}`.trim() : String(msg);
    };
    const parts = arr.map(describe).filter(Boolean);
    if (parts.length) {
      const firstObj = arr.find((e) => e && typeof e === 'object') || {};
      const code = firstObj.code != null ? String(firstObj.code)
        : firstObj.errorCode != null ? String(firstObj.errorCode) : null;
      return { code, description: parts.join('; ') };
    }
  }

  const single = data.detail || data.title || (typeof data.error === 'string' ? data.error : data.message);
  if (single) {
    return { code: data.code != null ? String(data.code) : null, description: String(single) };
  }
  return null;
}

async function submitClaim(ctx) {
  const claim = (ctx && ctx.claim) || {};
  const { body, tradingPartnerServiceId, billingNpi } = buildSubmissionBody(ctx);

  const res = await stediPost('/professionalclaims/v3/submission', body, {
    'Idempotency-Key': String(claim.id || ''),
  });

  const data = await res.json().catch(() => ({}));

  // Stedi returns the control number on claimReference.correlationId or controlNumber.
  const ref = (data && data.claimReference) || {};
  const control = ref.correlationId || data.controlNumber || ref.controlNumber || null;

  if (!res.ok || !control) {
    // A structured payer/validation rejection (error 33, etc.) carries a reason we
    // want the user to see: throw a flagged error the handler turns into a 422.
    const rejection = parseSubmissionRejection(data);
    if (rejection) {
      const e = new Error(rejection.description);
      e.isRejection = true;
      e.rejection = rejection;
      throw e;
    }
    // Otherwise fail generically — never include the response body, which can
    // echo submitted PHI (member id, name, DOB).
    throw new Error(`Stedi submission failed (HTTP ${res.status})`);
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

  // Dependent mode: when the patient is a dependent on someone else's policy (no
  // unique member id of their own), the subscriber loop carries the POLICYHOLDER
  // (memberId + policyholder demographics when known) and the patient goes in a
  // `dependents` array. Many payers error without the dependent's DOB, so include
  // it. When p.dependent is absent (or has no non-empty field) the request is
  // built exactly as before: patient demographics in the subscriber loop.
  const dep = p.dependent || null;
  const depHasValue = !!dep && [dep.firstName, dep.lastName, dep.dateOfBirth]
    .some((v) => v != null && String(v).trim() !== '');

  const subscriber = { memberId: p.memberId || undefined };
  if (p.firstName) subscriber.firstName = p.firstName;
  if (p.lastName) subscriber.lastName = p.lastName;
  if (ymd(p.dateOfBirth)) subscriber.dateOfBirth = ymd(p.dateOfBirth);

  const body = {
    tradingPartnerServiceId,
    provider,
    subscriber,
    // Service type 30 = Health Benefit Plan Coverage (general benefits) by default.
    encounter: {
      serviceTypeCodes: [p.serviceType ? String(p.serviceType) : '30'],
    },
  };

  if (depHasValue) {
    const dependent = {};
    if (dep.firstName) dependent.firstName = dep.firstName;
    if (dep.lastName) dependent.lastName = dep.lastName;
    if (ymd(dep.dateOfBirth)) dependent.dateOfBirth = ymd(dep.dateOfBirth);
    body.dependents = [dependent];
  }

  const res = await stediPost('/eligibility/v3', body);

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Stedi eligibility failed (HTTP ${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

// -----------------------------------------------------------------------------
// Payer search — type-ahead lookup against Stedi's payer directory. Powers the
// payer picker in the Verify Benefits / insurance forms (handlers/payers.js).
// This endpoint lives at the healthcare API root, NOT under the medical-network
// base, so it carries its own URL. No PHI: the only input is a free-text payer
// name fragment and the response is public payer-directory data.
// -----------------------------------------------------------------------------
const SEARCH_URL =
  process.env.STEDI_SEARCH_URL ||
  'https://healthcare.us.stedi.com/2024-04-01/payers/search';

async function searchPayers(query) {
  const q = query == null ? '' : String(query);
  const url =
    `${SEARCH_URL}?query=${encodeURIComponent(q)}` +
    '&eligibilityCheck=SUPPORTED&pageSize=10';

  const res = await stediGet(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // No PHI in a payer-name search; keep the message terse regardless.
    throw new Error(`Stedi payer search failed (HTTP ${res.status})`);
  }

  const items = Array.isArray(data && data.items) ? data.items : [];
  return items
    .map((it) => {
      // Stedi wraps each hit as { score, payer: {...} }; tolerate a flat shape too.
      const p = (it && it.payer) || it || {};
      return {
        name: p.displayName || null,
        payer_id: p.primaryPayerId || null,
        stedi_id: p.stediId || null,
      };
    })
    .filter((p) => p.payer_id);
}

module.exports = {
  name,
  submitClaim,
  getStatus,
  checkEligibility,
  searchPayers,
  mapStatus,
  firstStatus,
  // Exposed for unit testing (pure, no network).
  buildSubmissionBody,
  parseSubmissionRejection,
  patientControlNumber,
  boundControlNumber,
};
