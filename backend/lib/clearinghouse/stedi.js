'use strict';

// Stedi clearinghouse adapter. GATED: only used when CLEARINGHOUSE=stedi and
// STEDI_API_KEY is set on the Lambda environment. Transport targets Stedi's
// Healthcare medical-network REST API:
//
//   base   : https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork
//   auth   : Authorization: <STEDI_API_KEY>   (raw key, every request)
//   submit : POST {base}/professionalclaims/v3/submission   application/json
//   status : POST {base}/claimstatus/v2                      application/json
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

// Split an insurance.subscriber_name ("First Last", "First Middle Last") into
// [firstName, lastName] on the LAST space — mirrors the client portal / insurance
// form, which stores the policyholder as a single free-text name. A single token
// (no space) is treated as a first name only, with an empty last name.
function splitSubscriberName(full) {
  const s = full == null ? '' : String(full).trim();
  if (!s) return ['', ''];
  const i = s.lastIndexOf(' ');
  if (i <= 0) return [s, ''];
  return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
}

// Map an insurance.subscriber_relationship (the patient's relationship TO the
// policyholder — allowed values self | spouse | child | other, per the insurance
// form) to the 837P dependent relationshipToSubscriberCode. 'self' never reaches
// here (it means the patient IS the subscriber — no dependent loop). Unknown /
// unrecognized values fall back to G8 (other relationship).
function relationshipToSubscriberCode(rel) {
  switch (String(rel == null ? '' : rel).trim().toLowerCase()) {
    case 'spouse':
      return '01';
    case 'child':
      return '19';
    default:
      return 'G8';
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

  // Dependent mode: when the insurance record names a subscriber relationship
  // other than 'self', the patient is a dependent on someone else's policy. The
  // 837P then wants the POLICYHOLDER in the subscriber loop and the PATIENT in a
  // singular `dependent` object (note: singular here, unlike eligibility's
  // `dependents` array). Putting the patient in the subscriber loop for a
  // dependent is what got a live claim rejected with 277CA A3/21 "invalid
  // patient/subscriber information"; Stedi now also validates the pairing at
  // submission and returns error 33 on a mismatch, so a wrong shape fails fast.
  const rel = insurance.subscriber_relationship;
  const isDependent =
    rel != null && String(rel).trim() !== '' && String(rel).trim().toLowerCase() !== 'self';

  let subscriber;
  let dependent = null;
  if (isDependent) {
    // Policyholder in the subscriber loop. We only know what the insurance record
    // carries — the policyholder name (split on the last space) and DOB — so build
    // by adding present fields only (no empty strings leak in). Gender and address
    // are unknown for the policyholder and the 837P only requires them when the
    // subscriber is the patient, so they are omitted here.
    subscriber = { paymentResponsibilityLevelCode: 'P' };
    if (insurance.member_id) subscriber.memberId = insurance.member_id;
    const [subFirst, subLast] = splitSubscriberName(insurance.subscriber_name);
    if (subFirst) subscriber.firstName = subFirst;
    if (subLast) subscriber.lastName = subLast;
    const subDob = ymd(insurance.subscriber_dob);
    if (subDob) subscriber.dateOfBirth = subDob;

    // Patient in the dependent loop: the same client sources as the subscriber
    // block below, plus the relationship code. Gender is omitted when unknown (U).
    dependent = {
      relationshipToSubscriberCode: relationshipToSubscriberCode(rel),
    };
    if (client.first_name) dependent.firstName = client.first_name;
    if (client.last_name) dependent.lastName = client.last_name;
    const depDob = ymd(client.date_of_birth);
    if (depDob) dependent.dateOfBirth = depDob;
    const depGender = genderCode(client.gender);
    if (depGender !== 'U') dependent.gender = depGender;
    dependent.address = {
      address1: client.address_line1 || undefined,
      address2: client.address_line2 || undefined,
      city: client.city || undefined,
      state: client.state || undefined,
      postalCode: client.postal_code || undefined,
    };
  } else {
    // Non-dependent (patient IS the subscriber): unchanged from the original shape.
    // Stedi auto-sets relationship code 18 (self) and no dependent loop is sent.
    subscriber = {
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
    };
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
      // Stedi matches the payer on tradingPartnerServiceId; the receiver name
      // just needs to be non-empty. Records created through the payer typeahead
      // persist a payer_id but not always a carrier_name, so fall back to the
      // trading-partner id rather than sending an undefined organizationName
      // (which Stedi rejects with 400 "Receiver: missing field organizationName").
      organizationName: insurance.carrier_name || tradingPartnerServiceId,
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
    subscriber,
    claimInformation,
  };

  // Only present in dependent mode; omitted entirely otherwise so the
  // non-dependent body stays byte-identical to the original.
  if (dependent) body.dependent = dependent;

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

// Build the real-time claim-status (276/277) request body from the claim context.
// Pure (no network) so it can be unit-tested; getStatus() POSTs whatever this
// returns. Stedi recommends a MINIMAL base request — over-specifying degrades
// matching — so we send only tradingPartnerServiceId, the encounter dates, the
// billing provider, and the subscriber.
//
// Sourcing mirrors buildSubmissionBody exactly, because the 276 must describe the
// same parties as the 837 that was filed:
//   * tradingPartnerServiceId — the payer id used at submission. Prefer the value
//     persisted on the claim at submit time (clearinghouse_payload), then the
//     insurance record's payer_id.
//   * providers[BillingProvider] — the practice (organizationName + NPI), same
//     billing loop the 837 used (persisted billing_npi, else practice/clinician).
//   * subscriber — the POLICYHOLDER, who is NOT necessarily the patient. On a
//     dependent claim the policyholder is on the insurance record; when the patient
//     IS the subscriber ('self' / no relationship) the patient (client) is used.
//     No dependent block is sent — the base request matches on the subscriber.
// Any required field that is missing throws a descriptive error naming the field.
function buildStatusBody(ctx) {
  const claim = (ctx && ctx.claim) || {};
  const insurance = (ctx && ctx.insurance) || {};
  const client = (ctx && ctx.client) || {};
  const clinician = (ctx && ctx.clinician) || {};
  const practice = (ctx && ctx.practice) || {};
  const session = (ctx && ctx.session) || {};
  const payload = claim.clearinghouse_payload || {};

  const tradingPartnerServiceId = payload.tradingPartnerServiceId || insurance.payer_id;
  if (!tradingPartnerServiceId) {
    throw new Error('Stedi status check requires tradingPartnerServiceId (payer id used at submission).');
  }

  const billingNpi = payload.billing_npi || practice.npi || clinician.npi || null;
  if (!billingNpi) {
    throw new Error('Stedi status check requires the billing provider npi.');
  }
  const organizationName = practice.name || null;
  if (!organizationName) {
    throw new Error('Stedi status check requires the billing provider organizationName (practice name).');
  }

  // Single-session claims: the beginning and end dates of service are the same day.
  const dos = ymd(session.session_date);
  if (!dos) {
    throw new Error('Stedi status check requires the session date of service.');
  }

  const rel = insurance.subscriber_relationship;
  const isDependent =
    rel != null && String(rel).trim() !== '' && String(rel).trim().toLowerCase() !== 'self';

  const memberId = insurance.member_id;
  if (!memberId) {
    throw new Error('Stedi status check requires the subscriber memberId.');
  }

  let firstName;
  let lastName;
  let dateOfBirth;
  if (isDependent) {
    [firstName, lastName] = splitSubscriberName(insurance.subscriber_name);
    dateOfBirth = ymd(insurance.subscriber_dob);
  } else {
    firstName = client.first_name || '';
    lastName = client.last_name || '';
    dateOfBirth = ymd(client.date_of_birth);
  }
  if (!firstName) throw new Error('Stedi status check requires the subscriber firstName.');
  if (!lastName) throw new Error('Stedi status check requires the subscriber lastName.');
  if (!dateOfBirth) throw new Error('Stedi status check requires the subscriber dateOfBirth.');

  const body = {
    tradingPartnerServiceId,
    encounter: {
      beginningDateOfService: dos,
      endDateOfService: dos,
    },
    providers: [
      {
        providerType: 'BillingProvider',
        organizationName,
        npi: billingNpi,
      },
    ],
    subscriber: {
      firstName,
      lastName,
      dateOfBirth,
      memberId,
    },
  };

  return { body, tradingPartnerServiceId, billingNpi };
}

// Map a 277 claimStatusCategoryCode to the Reddably claim enum. The category code
// is the authoritative lifecycle bucket (its finer statusCode is only a fallback):
//
//   F  Finalized              → paid   (F2 = Finalized/Denial → denied)
//   P  Pending                → processing
//   R  Request for more info  → info_requested
//   A1 / A2 / A5 Received/Accepted → submitted
//   A3 / A6 / A7 / A8 Rejected at acknowledgement → denied
//
// Anything else — A4 (Not Found), D0 (search unsuccessful), E (errors), unknown —
// returns null so the caller treats it as a non-fatal "no update" (the claim keeps
// its current status) rather than force-mapping it.
function mapStatusCategory(cat) {
  const c = String(cat == null ? '' : cat).trim().toUpperCase();
  if (!c) return null;
  if (c === 'F2') return 'denied';
  switch (c[0]) {
    case 'F': return 'paid';
    case 'P': return 'processing';
    case 'R': return 'info_requested';
    default: break;
  }
  if (c === 'A1' || c === 'A2' || c === 'A5') return 'submitted';
  if (c === 'A3' || c === 'A6' || c === 'A7' || c === 'A8') return 'denied';
  return null;
}

// Map a Stedi claim statusCode (numeric or descriptive) to the Reddably enum.
// Fallback only — used when a response carries a statusCode but no category code we
// recognize. Returns null for values we can't place, so the caller can treat the
// response as "no update" rather than guessing.
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
      return null;
  }
}

// Pull the most relevant claim-status object out of Stedi's response, tolerating a
// few shapes ({ claims: [{ claimStatus }] }, { claimStatus }, a bare claim object).
// Returns null when there is no claim-status object at all — a no-match 200 carries
// an empty (or absent) claims array, and returning `data` itself here would make
// that no-match look like a real status. The caller reads null as "no update".
function firstStatus(data) {
  if (!data || typeof data !== 'object') return null;
  const claims = Array.isArray(data.claims) ? data.claims : (data.claim ? [data.claim] : null);
  if (Array.isArray(claims) && claims.length) {
    const last = claims[claims.length - 1];
    return last.claimStatus || last.status || last;
  }
  if (data.claimStatus && typeof data.claimStatus === 'object') return data.claimStatus;
  if (data.status && typeof data.status === 'object') return data.status;
  return null;
}

async function getStatus({ control_number, claim, ctx }) {
  // Prefer the assembled context (subscriber / provider / DOS) the handler passes
  // so the 276 mirrors the 837 that was filed; fall back to a claim-only ctx for
  // direct callers. buildStatusBody throws (naming the field) on missing data.
  const { body } = buildStatusBody(ctx || { claim });

  const res = await stediPost('/claimstatus/v2', body);

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Never echo the response body — it can carry PHI (member id, name, DOB).
    throw new Error(`Stedi status check failed (HTTP ${res.status})`);
  }

  // Status is derived from the response body, NEVER the HTTP status: a no-match
  // comes back HTTP 200. When no claim-status object is present, or its category
  // is one we don't map (Not Found, etc.), report a non-fatal "no update" so the
  // claim keeps its current status.
  const info = firstStatus(data);
  if (!info) return { no_update: true, raw: data };

  const category =
    info.claimStatusCategoryCode != null ? info.claimStatusCategoryCode
      : info.statusCategoryCode != null ? info.statusCategoryCode
        : null;
  const statusCode =
    info.statusCode != null ? info.statusCode
      : info.claimStatusCode != null ? info.claimStatusCode
        : info.code != null ? info.code
          : null;

  let status = mapStatusCategory(category);
  if (status == null && statusCode != null) status = mapStatus(statusCode);
  if (status == null) return { no_update: true, raw: data };

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

// -----------------------------------------------------------------------------
// ERA enrollment (Enrollments API) — per-practice payer enrollment for electronic
// remittance. Powers handlers/payer_enrollments.js. This API lives on its OWN host
// (not the medical-network base), but authenticates with the same raw STEDI_API_KEY.
//
//   base : https://enrollments.us.stedi.com/2024-09-01
//   auth : Authorization: <STEDI_API_KEY>
//
// No PHI ever crosses these calls — the payloads are practice/payer trading-partner
// data (name, NPI, tax id, business contact, payer id), so on failure we still keep
// error messages terse and never echo the request/response body.
// -----------------------------------------------------------------------------
const ENROLLMENTS_BASE =
  process.env.STEDI_ENROLLMENTS_BASE_URL ||
  'https://enrollments.us.stedi.com/2024-09-01';

// Shared transport for the enrollments API: any method, JSON body when present,
// optional query object, same 15s AbortController bound as the other calls. The
// path/URL is never echoed in the timeout error (defensive, matches the others).
async function enrollmentsFetch(method, path, body, query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STEDI_TIMEOUT_MS);
  let url = `${ENROLLMENTS_BASE}${path}`;
  if (query) {
    const qs = Object.keys(query)
      .filter((k) => query[k] != null && query[k] !== '')
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
      .join('&');
    if (qs) url += `?${qs}`;
  }
  try {
    const opts = {
      method,
      headers: { Authorization: apiKey(), Accept: 'application/json' },
      signal: controller.signal,
    };
    if (body != null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return await fetch(url, opts);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`Stedi enrollments request to ${path} timed out after ${STEDI_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Tax ids must be digits only (no dashes) on the enrollments API.
function digitsOnly(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

// Build the enrollments contact block from a normalized contact object. Only
// present fields are sent (no empty strings), matching the rest of the adapter.
function enrollmentContact(contact) {
  const c = contact || {};
  const out = {};
  if (c.firstName) out.firstName = c.firstName;
  if (c.lastName) out.lastName = c.lastName;
  if (c.email) out.email = c.email;
  if (c.phone) out.phone = c.phone;
  if (c.streetAddress1) out.streetAddress1 = c.streetAddress1;
  if (c.city) out.city = c.city;
  if (c.state) out.state = c.state;
  if (c.zipCode) out.zipCode = c.zipCode;
  return out;
}

// ensureEnrollmentProvider(practice, contact) -> providerId.
// A provider must exist (one per practice TIN) before any enrollment. When the
// practice already carries a stedi_provider_id, reuse it (no network). Otherwise
// POST /providers and return the new id for the caller to persist. NPI + taxId
// pairs are unique on Stedi's side, so a re-create for the same pair 409s — the
// caller persists the id the first time so this stays a one-time cost.
async function ensureEnrollmentProvider(practice, contact) {
  const p = practice || {};
  if (p.stedi_provider_id) return p.stedi_provider_id;

  const body = {
    name: p.name || undefined,
    npi: p.npi || undefined,
    taxIdType: 'EIN',
    taxId: digitsOnly(p.tax_id),
    contacts: [enrollmentContact(contact)],
  };

  const res = await enrollmentsFetch('POST', '/providers', body);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data || !data.id) {
    throw new Error(`Stedi provider creation failed (HTTP ${res.status})`);
  }
  return data.id;
}

// createPayerEnrollment({ providerId, payerIdOrAlias, contact, userEmail })
//   -> { id, status }. Submits an ERA (claimPayment) enrollment immediately with
// status STEDI_ACTION_REQUIRED (DRAFT would be "not yet submitted" — unused in v1).
async function createPayerEnrollment({ providerId, payerIdOrAlias, contact, userEmail }) {
  const body = {
    transactions: { claimPayment: { enroll: true } },
    primaryContact: enrollmentContact(contact),
    userEmail: userEmail || undefined,
    payer: { idOrAlias: String(payerIdOrAlias == null ? '' : payerIdOrAlias) },
    provider: { id: providerId },
    status: 'STEDI_ACTION_REQUIRED',
  };

  const res = await enrollmentsFetch('POST', '/enrollments', body);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data || !data.id) {
    throw new Error(`Stedi enrollment creation failed (HTTP ${res.status})`);
  }
  return { id: data.id, status: data.status || 'STEDI_ACTION_REQUIRED' };
}

// getEnrollmentStatus(stediEnrollmentId) -> { status, reason }. GET a single
// enrollment; `reason` is populated when the payer/Stedi needs manual action.
async function getEnrollmentStatus(stediEnrollmentId) {
  const res = await enrollmentsFetch(
    'GET',
    `/enrollments/${encodeURIComponent(String(stediEnrollmentId))}`
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Stedi enrollment status check failed (HTTP ${res.status})`);
  }
  return { status: data.status || null, reason: data.reason || null };
}

// listEnrollments({ npi, taxId }) -> array of raw enrollment objects for the
// practice's provider, used to import enrollments created outside the app. Filters
// server-side by provider NPI + tax id when supported; the caller additionally
// de-dupes against locally-stored stedi_enrollment_ids for idempotency.
async function listEnrollments({ npi, taxId } = {}) {
  // Filters are plural array params on the List Enrollments API; a single value
  // each is accepted. providerNpis / providerTaxIds (NOT the singular forms).
  const query = {};
  if (npi) query.providerNpis = digitsOnly(npi);
  if (taxId) query.providerTaxIds = digitsOnly(taxId);

  const res = await enrollmentsFetch('GET', '/enrollments', null, query);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Stedi enrollment list failed (HTTP ${res.status})`);
  }
  if (Array.isArray(data)) return data;
  if (Array.isArray(data && data.items)) return data.items;
  return [];
}

module.exports = {
  name,
  submitClaim,
  getStatus,
  checkEligibility,
  searchPayers,
  mapStatus,
  mapStatusCategory,
  firstStatus,
  // ERA enrollment (Enrollments API).
  ensureEnrollmentProvider,
  createPayerEnrollment,
  getEnrollmentStatus,
  listEnrollments,
  // Exposed for unit testing (pure, no network).
  buildSubmissionBody,
  buildStatusBody,
  parseSubmissionRejection,
  patientControlNumber,
  boundControlNumber,
};
