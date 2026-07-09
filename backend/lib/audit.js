'use strict';

// HIPAA application-level audit log (45 CFR 164.312(b)).
//
// One INSERT per audited event into the append-only `audit_log` table. The log
// records WHO did WHAT to WHICH resource WHEN — actor id, action, resource
// type/id, ip, user-agent, request id — and NEVER PHI. metadata is for non-PHI
// context ONLY: changed field NAMES (not values), a row count, a status string.
// Do not pass patient names, DOB, member ids, or diagnosis codes to audit().
//
// Failure policy: audit() catches its own errors and never throws, so a failed
// audit write can never block or fail the request it is recording.
//
//   const { audit, sanitizeFields } = require('../lib/audit');
//   await audit(event, { userId, practiceId }, {
//     action: 'client.update',
//     resourceType: 'client',
//     resourceId: id,
//     metadata: { fields_changed: sanitizeFields(before, changes) },
//   });

const db = require('./db');

// --- request-context extraction ----------------------------------------------

// Source IP from the API Gateway event. HTTP API v2 carries it at
// requestContext.http.sourceIp; fall back to the v1 identity shape and finally
// the X-Forwarded-For header (first hop).
function sourceIp(event) {
  const ctx = (event && event.requestContext) || {};
  if (ctx.http && ctx.http.sourceIp) return ctx.http.sourceIp;
  if (ctx.identity && ctx.identity.sourceIp) return ctx.identity.sourceIp;
  const headers = (event && event.headers) || {};
  const xff = headers['x-forwarded-for'] || headers['X-Forwarded-For'];
  if (xff) return String(xff).split(',')[0].trim() || null;
  return null;
}

function userAgent(event) {
  const headers = (event && event.headers) || {};
  return headers['user-agent'] || headers['User-Agent'] || null;
}

function requestId(event) {
  const ctx = (event && event.requestContext) || {};
  return ctx.requestId || null;
}

// --- actor resolution --------------------------------------------------------

// The authenticated user id, from whatever shape the caller passes. Staff
// handlers carry it as auth.user.sub; we accept a few aliases so callers can
// hand us their existing context object directly.
function pickUserId(authCtx) {
  if (!authCtx) return null;
  return authCtx.userId || authCtx.user_id || authCtx.id || authCtx.sub || null;
}

function pickPracticeId(authCtx) {
  if (!authCtx) return null;
  return authCtx.practiceId || authCtx.practice_id || null;
}

// actor_type: an explicit override wins (the patient card-setup flow passes
// 'patient_link'); otherwise 'user' when a user id exists, else 'system' (e.g. a
// pre-auth login failure).
function resolveActorType(authCtx, userId) {
  if (authCtx && authCtx.actorType) return authCtx.actorType;
  return userId ? 'user' : 'system';
}

// --- entry builder (pure; exported for tests) --------------------------------

// Shape the row to insert. Pure and side-effect free so it can be unit-tested
// without a DB. Returns column → value; metadata stays an object (JSON-encoded
// at insert time).
function buildAuditEntry(event, authCtx, entry) {
  const e = entry || {};
  const userId = pickUserId(authCtx);
  return {
    practice_id: pickPracticeId(authCtx),
    actor_user_id: userId,
    actor_type: resolveActorType(authCtx, userId),
    action: e.action || null,
    resource_type: e.resourceType || null,
    resource_id: e.resourceId || null,
    ip_address: sourceIp(event),
    user_agent: userAgent(event),
    request_id: requestId(event),
    metadata: e.metadata != null ? e.metadata : null,
  };
}

// --- write -------------------------------------------------------------------

// Single INSERT. Never throws, never blocks the request: on any failure it logs
// a terse marker (action + request id, no PHI) and returns.
async function audit(event, authCtx, entry) {
  const row = buildAuditEntry(event, authCtx, entry);
  try {
    await db.query(
      `insert into audit_log
         (practice_id, actor_user_id, actor_type, action, resource_type, resource_id,
          ip_address, user_agent, request_id, metadata)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        row.practice_id,
        row.actor_user_id,
        row.actor_type,
        row.action,
        row.resource_type,
        row.resource_id,
        row.ip_address,
        row.user_agent,
        row.request_id,
        row.metadata != null ? JSON.stringify(row.metadata) : null,
      ]
    );
  } catch (err) {
    // Deliberately swallow — never surface an audit failure to the caller.
    console.error('audit write failed', row.action, row.request_id);
  }
}

// --- field-change diff (for update events) -----------------------------------

// Value-equality tolerant of the shapes pg returns: numeric columns come back as
// strings ("150.00"), dates as 'YYYY-MM-DD', arrays as JS arrays. Compares by
// value, never exposing the values themselves to the caller.
function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (Array.isArray(a) || Array.isArray(b) || typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  const na = Number(a);
  const nb = Number(b);
  if (String(a).trim() !== '' && String(b).trim() !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) {
    return na === nb;
  }
  return String(a) === String(b);
}

// sanitizeFields(before, after) -> array of the field NAMES whose value changed.
// Only the keys present in `after` are considered (so a full row passed as
// `before` never leaks unrelated columns), and ONLY names are returned — never
// values — so the result is always PHI-free and safe for metadata.fields_changed.
function sanitizeFields(before, after) {
  const b = before || {};
  const a = after || {};
  const changed = [];
  Object.keys(a).forEach((key) => {
    if (!valuesEqual(b[key], a[key])) changed.push(key);
  });
  return changed;
}

module.exports = { audit, buildAuditEntry, sanitizeFields };
