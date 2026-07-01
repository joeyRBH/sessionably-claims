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

function benefitsArray(data) {
  return (data && Array.isArray(data.benefitsInformation)) ? data.benefitsInformation : [];
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

function deriveActive(data) {
  // Prefer planStatus; fall back to an Active Coverage (code '1') benefit entry.
  const statuses = (data && Array.isArray(data.planStatus)) ? data.planStatus : [];
  if (statuses.some((s) => s && String(s.statusCode) === '1')) return true;
  const benefits = benefitsArray(data);
  if (benefits.some((b) => b && String(b.code) === '1')) return true;
  if (benefits.some((b) => b && String(b.code) === '6')) return false; // 6 = Inactive
  if (statuses.length) return false;
  return false;
}

function firstNonEmpty(values) {
  for (const v of values) {
    if (v != null && String(v).trim() !== '') return String(v);
  }
  return null;
}

// Turn a Stedi 271 payload into the compact shape the UI renders. Everything is
// best-effort and null-safe; the untouched payload is returned as `raw`.
function normalizeEligibility(data, requestMemberId) {
  const subscriber = (data && data.subscriber) || {};
  const planInformation = (data && data.planInformation) || {};
  const benefits = benefitsArray(data);

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

async function runCheck(ctx, body, event) {
  // Plan gate: only paid ('vob') or founder practices may run a check.
  if (ctx.plan !== 'vob' && ctx.plan !== 'founder') {
    return json(403, { error: 'VOB add-on required', upgrade: true }, event);
  }

  const memberId = cleanText(body.memberId);
  const payerId = cleanText(body.payerId);
  if (!memberId || !payerId) {
    return json(400, { error: 'Missing required fields: memberId, payerId' }, event);
  }

  const dateOfBirth = cleanText(body.dateOfBirth);
  if (dateOfBirth && !isValidDate(dateOfBirth)) {
    return json(400, { error: 'Invalid dateOfBirth. Expected YYYY-MM-DD.' }, event);
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

  let stediResponse;
  try {
    stediResponse = await stedi.checkEligibility({
      memberId,
      payerId,
      firstName: cleanText(body.firstName),
      lastName: cleanText(body.lastName),
      dateOfBirth,
      npi,
      organizationName: ctx.practice_name || undefined,
      serviceType: cleanText(body.serviceType) || undefined,
    });
  } catch (err) {
    // Never log PHI — Stedi errors can echo the request (names, member id).
    console.error('vob check (stedi) error');
    return json(502, { error: 'Could not verify benefits with the payer.' }, event);
  }

  const normalized = normalizeEligibility(stediResponse, memberId);

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

  return json(200, normalized, event);
}

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
    return await runCheck(ctx, body, event);
  } catch (err) {
    console.error('vob error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
