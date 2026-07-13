'use strict';

// VOB (Verification of Benefits) resource — one Lambda, one route:
//
//   POST /vob/check   → run a real-time out-of-network benefit check via Stedi.
//
// Plan gate: the Instant VOB add-on is a $25/month premium feature. A practice
// may run a check only when its plan is 'vob' (paid) or 'founder' (permanent free
// full access). A 'free' practice gets a 403 with { upgrade: true } so the UI can
// prompt the upgrade flow.
//
// Security: practice_id and plan are ALWAYS derived from the authenticated user's
// (active) row, never trusted from the body. When an insurance_record_id is passed
// it must belong to the caller's practice. Benefit data is PHI — error logs never
// include member_id, names, DOB, or the raw benefits payload.

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const { parseBody } = require('../lib/util');
const { audit } = require('../lib/audit');
const stedi = require('../lib/clearinghouse/stedi');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- request helpers ---------------------------------------------------------

function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

function cleanText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function isUUID(v) {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

// Normalize a member ID for the payer: strip ALL whitespace and drop a leading
// "(80840)" / "80840" magic-number prefix (the 271 mag-stripe ID card prefix)
// when present. Hyphens and other characters are preserved — some payers use them
// legitimately. Returns null for empty input.
function sanitizeMemberId(v) {
  if (v == null) return null;
  let s = String(v).replace(/\s+/g, '');
  s = s.replace(/^\(80840\)/, '').replace(/^80840/, '');
  return s === '' ? null : s;
}

function isValidDate(s) {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// --- practice scoping --------------------------------------------------------

// Load the caller's practice + plan (and NPI fallbacks) from their active row.
// Re-loading from the DB means a deactivated user can't act on a live token, and
// the plan gate can never be spoofed from the request body.
async function loadContext(userId) {
  const res = await db.query(
    `select u.npi          as user_npi,
            p.id           as practice_id,
            p.plan         as plan,
            p.npi          as practice_npi,
            p.name         as practice_name
       from users u
       join practices p on p.id = u.practice_id
      where u.id = $1 and u.is_active = true
      limit 1`,
    [userId]
  );
  return res.rows[0] || null;
}

// --- Stedi response normalization -------------------------------------------

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Codes 42 (Unable to Respond at Current Time) and 80 (No Response Received —
// Transaction Terminated) are transient payer-connectivity errors per Stedi docs,
// so they're safe to retry. Any other rejection code is a hard reject: no retry.
const RETRYABLE_AAA_CODES = new Set(['42', '80']);

// True only when the response is rejected AND every rejection code is retryable.
function isRetryableRejection(normalized) {
  if (!normalized || !normalized.rejected) return false;
  const codes = (normalized.rejections || []).map((r) => r && r.code);
  return codes.length > 0 && codes.every((c) => RETRYABLE_AAA_CODES.has(String(c)));
}

// Patient-level AAA rejections: 64 (Invalid/Missing Patient ID), 65 (Invalid/
// Missing Patient Name), 67 (Patient Not Found), 68 (Duplicate Patient ID). Per
// Stedi's eligibility-troubleshooting guidance, most payers can still match a
// dependent submitted AS the subscriber (patient demographics + family member ID
// in the subscriber loop), so these are the codes that trigger the fallback.
const PATIENT_LEVEL_AAA_CODES = new Set(['64', '65', '67', '68']);

// True only when the response is rejected AND every rejection code is patient-level.
// A mix of patient-level and other codes (e.g. 65 + 42) does NOT qualify.
function isPatientLevelRejection(normalized) {
  if (!normalized || !normalized.rejected) return false;
  const codes = (normalized.rejections || []).map((r) => r && r.code);
  return codes.length > 0 && codes.every((c) => PATIENT_LEVEL_AAA_CODES.has(String(c)));
}

// Nested dependent loop (data.dependents[0]) — present when the payer returns the
// patient's benefits under a dependent rather than at the subscriber level. Null-safe.
function firstDependent(data) {
  return (data && Array.isArray(data.dependents) && data.dependents[0]) || null;
}

function benefitsArray(data) {
  const top = (data && Array.isArray(data.benefitsInformation)) ? data.benefitsInformation : [];
  const dep = firstDependent(data);
  const depBenefits = (dep && Array.isArray(dep.benefitsInformation)) ? dep.benefitsInformation : [];
  // Union the dependent-loop benefits in only when present, so a response without a
  // dependent loop returns the exact same array (reference) as before.
  return depBenefits.length ? top.concat(depBenefits) : top;
}

// Plan-status entries, unioning the subscriber-level (data.planStatus) and the
// dependent-loop (data.dependents[0].planStatus) arrays. Null-safe; when no
// dependent loop is present the top-level array is returned unchanged.
function planStatusArray(data) {
  const top = (data && Array.isArray(data.planStatus)) ? data.planStatus : [];
  const dep = firstDependent(data);
  const depStatus = (dep && Array.isArray(dep.planStatus)) ? dep.planStatus : [];
  return depStatus.length ? top.concat(depStatus) : top;
}

// True when an entry is flagged out-of-network (inPlanNetworkIndicatorCode 'N').
function isOutOfNetwork(b) {
  return b && String(b.inPlanNetworkIndicatorCode || '').toUpperCase() === 'N';
}

// True when an entry is scoped to the individual (coverageLevelCode 'IND').
function isIndividual(b) {
  const c = b && String(b.coverageLevelCode || '').toUpperCase();
  return c === 'IND' || c === 'FAM' ? c === 'IND' : true; // default to individual when unspecified
}

// Find the first benefit amount for a given code (e.g. 'C' deductible, 'G' OOP)
// and time qualifier (23 = Calendar Year total, 29 = Remaining), individual scope.
function findAmount(data, code, timeQualifierCode) {
  const match = benefitsArray(data).find((b) => {
    if (!b || String(b.code) !== String(code)) return false;
    if (!isIndividual(b)) return false;
    if (timeQualifierCode != null && String(b.timeQualifierCode || '') !== String(timeQualifierCode)) {
      return false;
    }
    return b.benefitAmount != null;
  });
  return match ? num(match.benefitAmount) : null;
}

// Deductible / out-of-pocket: total from the Calendar-Year entry, met derived from
// (total − remaining) when both are present.
function amountPair(data, code) {
  const total = findAmount(data, code, '23');       // 23 = Calendar Year
  const remaining = findAmount(data, code, '29');   // 29 = Remaining
  let met = null;
  if (total != null && remaining != null) met = Math.max(0, total - remaining);
  return { individual: total, met };
}

// Normalize a percentage that may arrive as 0.6 (fraction) or 60 (percent).
function asPercent(v) {
  const n = num(v);
  if (n == null) return null;
  const pct = n <= 1 ? n * 100 : n;
  return Math.round(pct);
}

// Three-state coverage status:
//   * explicit active evidence   → true
//   * explicit inactive evidence → false
//   * neither (inconclusive 271) → null (unknown)
// Returning null for "no evidence" avoids the old bug where a payer that simply
// didn't report status was rendered as "Inactive".
function deriveActive(data) {
  // Prefer planStatus (subscriber + dependent loops); fall back to an Active
  // Coverage (code '1') benefit entry.
  const statuses = planStatusArray(data);
  if (statuses.some((s) => s && String(s.statusCode) === '1')) return true;
  const benefits = benefitsArray(data);
  if (benefits.some((b) => b && String(b.code) === '1')) return true;
  if (benefits.some((b) => b && String(b.code) === '6')) return false; // 6 = Inactive
  if (statuses.length) return false; // planStatus present, none active → inactive
  return null; // no status evidence either way → unknown
}

function firstNonEmpty(values) {
  for (const v of values) {
    if (v != null && String(v).trim() !== '') return String(v);
  }
  return null;
}

// Collect payer rejections (AAA errors) from a Stedi 271 payload. Stedi surfaces
// these in a top-level `errors` array (and can nest them under `aaaErrors`); when
// present they mean the payer refused the request, which is NOT the same as
// inactive coverage. Null-safe; capped at 5 entries. See:
// https://www.stedi.com/docs/healthcare/eligibility-troubleshooting#payer-aaa-errors
function collectRejections(data) {
  const raw = [];
  if (data && Array.isArray(data.errors)) raw.push(...data.errors);
  if (data && Array.isArray(data.aaaErrors)) raw.push(...data.aaaErrors);
  // AAA errors can also arrive nested in the subscriber loop and (for a dependent
  // check) in the dependent loop. Union them in, then dedupe identical code +
  // description pairs so the same rejection reported at two levels is shown once.
  if (data && data.subscriber && Array.isArray(data.subscriber.aaaErrors)) {
    raw.push(...data.subscriber.aaaErrors);
  }
  const dep = firstDependent(data);
  if (dep && Array.isArray(dep.aaaErrors)) raw.push(...dep.aaaErrors);
  const seen = new Set();
  const deduped = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const key = (e.code != null ? String(e.code) : '') + ' '
      + (e.description != null ? String(e.description) : '');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
  }
  return deduped
    .slice(0, 5)
    .map((e) => ({
      code: e.code != null ? String(e.code) : null,
      description: e.description != null ? String(e.description) : null,
      followupAction: e.followupAction != null ? String(e.followupAction) : null,
      possibleResolutions: e.possibleResolutions != null ? e.possibleResolutions : null,
    }));
}

// Turn a Stedi 271 payload into the compact shape the UI renders. Everything is
// best-effort and null-safe; the untouched payload is returned as `raw`.
function normalizeEligibility(data, requestMemberId) {
  const subscriber = (data && data.subscriber) || {};
  const planInformation = (data && data.planInformation) || {};
  const benefits = benefitsArray(data);

  // Payer rejection (AAA errors) short-circuits active detection: the payer never
  // told us whether coverage is active, so `active` is unknown (null), not false.
  const rejections = collectRejections(data);
  if (rejections.length) {
    const codes = rejections.map((r) => r.code).filter(Boolean).join(', ');
    const mode = (data && data.meta && data.meta.applicationMode) || 'unknown';
    console.log(`vob check rejected: AAA ${codes}, mode=${mode}`);
    return {
      active: null,
      rejected: true,
      rejections,
      planName: null,
      groupNumber: null,
      memberId: firstNonEmpty([subscriber.memberId, requestMemberId]),
      deductible: { individual: null, met: null },
      outOfPocket: { individual: null, met: null },
      oonBenefits: false,
      oonCoinsurance: null,
      raw: data,
    };
  }

  const oonCoinsurance = (function () {
    // Co-insurance is code 'A'; prefer the out-of-network entry.
    const oon = benefits.find((b) => b && String(b.code) === 'A' && isOutOfNetwork(b) && b.benefitPercent != null);
    const any = benefits.find((b) => b && String(b.code) === 'A' && b.benefitPercent != null);
    return asPercent((oon || any || {}).benefitPercent);
  })();

  return {
    active: deriveActive(data),
    planName: firstNonEmpty([
      benefits.find((b) => b && b.planCoverage)?.planCoverage,
      (Array.isArray(data.planStatus) && data.planStatus[0] && data.planStatus[0].planDetails) || null,
      planInformation.groupDescription,
      planInformation.planNumber,
    ]),
    groupNumber: firstNonEmpty([subscriber.groupNumber, planInformation.groupNumber]),
    memberId: firstNonEmpty([subscriber.memberId, requestMemberId]),
    deductible: amountPair(data, 'C'),      // C = Deductible
    outOfPocket: amountPair(data, 'G'),     // G = Out of Pocket (Stop Loss)
    oonBenefits: benefits.some((b) => isOutOfNetwork(b)),
    oonCoinsurance: oonCoinsurance,
    raw: data,
  };
}

// --- handler -----------------------------------------------------------------

async function runCheck(ctx, body, event, authCtx) {
  // Plan gate: only paid ('vob') or founder practices may run a check.
  if (ctx.plan !== 'vob' && ctx.plan !== 'founder') {
    return json(403, { error: 'VOB add-on required', upgrade: true }, event);
  }

  const memberId = sanitizeMemberId(cleanText(body.memberId));
  const payerId = cleanText(body.payerId);
  if (!memberId || !payerId) {
    return json(400, { error: 'Missing required fields: memberId, payerId' }, event);
  }

  const dateOfBirth = cleanText(body.dateOfBirth);
  if (dateOfBirth && !isValidDate(dateOfBirth)) {
    return json(400, { error: 'Invalid dateOfBirth. Expected YYYY-MM-DD.' }, event);
  }

  // Dependent support: when the patient is NOT the policyholder, the caller sends
  // patientIsSubscriber=false plus the policyholder's demographics. The body's
  // patient fields (firstName/lastName/dateOfBirth) keep their meaning — they
  // always describe the patient. Defaults to true so existing clients are
  // unaffected.
  const patientIsSubscriber = body.patientIsSubscriber !== false;
  const subscriberDateOfBirth = cleanText(body.subscriberDateOfBirth);
  if (subscriberDateOfBirth && !isValidDate(subscriberDateOfBirth)) {
    return json(400, { error: 'Invalid subscriberDateOfBirth. Expected YYYY-MM-DD.' }, event);
  }

  // If an insurance record id is supplied, it must belong to this practice.
  const insuranceRecordId = cleanText(body.insurance_record_id);
  if (insuranceRecordId && !isUUID(insuranceRecordId)) {
    return json(400, { error: 'Invalid insurance_record_id.' }, event);
  }
  if (insuranceRecordId) {
    const owned = await db.query(
      `select 1 from insurance_records
        where id = $1 and practice_id = $2 and is_hidden = false limit 1`,
      [insuranceRecordId, ctx.practice_id]
    );
    if (owned.rowCount === 0) {
      return json(400, { error: 'insurance_record_id is not a record in this practice.' }, event);
    }
  }

  // NPI: prefer the request, then the practice NPI, then the calling user's NPI.
  const npi = cleanText(body.npi) || ctx.practice_npi || ctx.user_npi || null;

  // The patient-as-subscriber request: the patient's own demographics in the
  // subscriber loop, no dependent object. This is both the default request (when
  // the patient IS the policyholder) and the shape the dependent fallback retries
  // with, so it is captured once here and reused below.
  const patientAsSubscriberRequest = {
    memberId,
    payerId,
    firstName: cleanText(body.firstName),
    lastName: cleanText(body.lastName),
    dateOfBirth,
    npi,
    organizationName: ctx.practice_name || undefined,
    serviceType: cleanText(body.serviceType) || undefined,
  };

  // When the patient is a dependent, the subscriber loop must carry the
  // policyholder (not the patient), and the patient moves into a dependent object.
  // The body's patient fields keep their meaning.
  const stediRequest = Object.assign({}, patientAsSubscriberRequest);
  if (!patientIsSubscriber) {
    stediRequest.dependent = {
      firstName: cleanText(body.firstName),
      lastName: cleanText(body.lastName),
      dateOfBirth,
    };
    stediRequest.firstName = cleanText(body.subscriberFirstName);
    stediRequest.lastName = cleanText(body.subscriberLastName);
    stediRequest.dateOfBirth = subscriberDateOfBirth;
  }

  // Try the check, retrying up to 2 more times (3s apart) when the payer returns
  // ONLY transient connectivity rejections (AAA 42 / 80). Any other outcome —
  // success, a hard reject, or a thrown transport error — stops immediately.
  const MAX_ATTEMPTS = 3;
  let stediResponse;
  let normalized;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      stediResponse = await stedi.checkEligibility(stediRequest);
    } catch (err) {
      // Never log PHI — Stedi errors can echo the request (names, member id).
      console.error('vob check (stedi) error');
      return json(502, { error: 'Could not verify benefits with the payer.' }, event);
    }
    normalized = normalizeEligibility(stediResponse, memberId);
    if (attempt < MAX_ATTEMPTS && isRetryableRejection(normalized)) {
      await sleep(3000);
      continue;
    }
    break;
  }

  // Dependent fallback: a dependent-mode check that was rejected with ONLY
  // patient-level AAA codes (64/65/67/68) is retried ONCE as patient-as-subscriber
  // (patient demographics + the family member ID in the subscriber loop, no
  // dependent object). Most payers match a dependent this way. This is separate
  // from and in addition to the transient AAA 42/80 retry loop above.
  if (!patientIsSubscriber && isPatientLevelRejection(normalized)) {
    try {
      const fallbackResponse = await stedi.checkEligibility(patientAsSubscriberRequest);
      const fallbackNormalized = normalizeEligibility(fallbackResponse, memberId);
      // Only adopt the fallback when it is NOT itself rejected; otherwise the
      // original dependent-mode result is returned unchanged.
      if (!fallbackNormalized.rejected) {
        console.log('vob dependent fallback used');
        stediResponse = fallbackResponse;
        normalized = fallbackNormalized;
        normalized.fallbackUsed = true;
      }
    } catch (err) {
      // A transport error on the fallback must not fail the request — keep the
      // original dependent-mode result. Never log PHI.
      console.error('vob dependent fallback (stedi) error');
    }
  }

  // Persist the raw benefits payload on the insurance record, if one was given.
  if (insuranceRecordId) {
    try {
      await db.query(
        `update insurance_records
            set benefits_raw = $1, benefits_checked_at = now()
          where id = $2 and practice_id = $3 and is_hidden = false`,
        [JSON.stringify(stediResponse), insuranceRecordId, ctx.practice_id]
      );
    } catch (err) {
      // Storing benefits is best-effort — a failure here must not lose the result.
      console.error('vob check (store benefits) error:', err && err.message);
    }
  }

  // Count every successful check (all plans) for analytics / metering.
  try {
    await db.query(
      `update practices
          set vob_checks_used = vob_checks_used + 1,
              vob_period_start = coalesce(vob_period_start, current_date)
        where id = $1`,
      [ctx.practice_id]
    );
  } catch (err) {
    console.error('vob check (increment usage) error:', err && err.message);
  }

  // Audit the check. payer id is a directory identifier, not PHI; result_active
  // is the coverage-status verdict (true/false/null). NEVER log member id/names.
  await audit(event, authCtx, {
    action: 'vob.check',
    resourceType: 'vob',
    resourceId: insuranceRecordId || null,
    metadata: { payer_id: payerId, result_active: normalized ? normalized.active : null },
  });

  return json(200, normalized, event);
}

// Exported for unit-style verification of the 271 normalization (no PHI, no DB).
exports.normalizeEligibility = normalizeEligibility;
exports.sanitizeMemberId = sanitizeMemberId;
exports.isPatientLevelRejection = isPatientLevelRejection;

exports.handler = async (event) => {
  const method = httpMethod(event);
  if (method === 'OPTIONS') {
    return preflight(event);
  }
  if (method !== 'POST') {
    return json(405, { error: 'Method not allowed' }, event);
  }

  let auth;
  try {
    auth = requireAuth(event);
  } catch (err) {
    return json(err.statusCode || 401, { error: 'Unauthorized' }, event);
  }

  try {
    const ctx = await loadContext(auth.user.sub);
    if (!ctx) {
      return json(401, { error: 'Unauthorized' }, event);
    }
    const body = parseBody(event);
    const authCtx = { userId: auth.user.sub, practiceId: ctx.practice_id };
    return await runCheck(ctx, body, event, authCtx);
  } catch (err) {
    console.error('vob error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
