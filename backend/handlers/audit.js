'use strict';

// Audit-log read endpoint — the query side of the HIPAA audit trail.
//
//   GET /audit-log   → the caller's practice's audit events, newest-first.
//
// READ-ONLY. There is deliberately no POST/PATCH/DELETE: the log is append-only
// (writes happen via backend/lib/audit.js inside the instrumented handlers), and
// examining activity is a HIPAA requirement (45 CFR 164.312(b)), so this endpoint
// exists only to read it.
//
// Security:
//   * practice_id ALWAYS comes from the authenticated caller's own row (loaded
//     fresh from the DB so a stale token cannot widen scope); never from the query.
//   * ADMIN ONLY — a non-admin (clinician / billing_staff) gets 403. Mirrors the
//     role-gating pattern in users.js.
//   * Every query is filtered by that practice_id; a practice can only read its
//     own trail.
//
// Query params (all optional): from, to (ISO date/datetime bounds on occurred_at),
// action (exact), resource_type (exact), resource_id (uuid), actor_user_id (uuid),
// limit (default 50, max 200), before (occurred_at cursor for "load more").

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Accept an ISO date ('2026-07-09') or datetime ('2026-07-09T12:34:56[.sss][Z|±hh:mm]').
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const RESOURCE_TYPES = [
  'client', 'insurance_record', 'session', 'claim', 'vob',
  'user', 'practice', 'invitation', 'auth', 'payer_enrollment', 'refund_request',
];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// --- request helpers ---------------------------------------------------------

function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

function queryParam(event, name) {
  return event && event.queryStringParameters ? event.queryStringParameters[name] : undefined;
}

function isUUID(v) {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

// --- caller context ----------------------------------------------------------

async function loadCaller(userId) {
  const res = await db.query(
    `select id, practice_id, role, is_active from users where id = $1 limit 1`,
    [userId]
  );
  return res.rows[0] || null;
}

// --- shaping -----------------------------------------------------------------

// The row plus a display-only actor label joined from users (staff name/email —
// not patient PHI). The audit_log columns themselves never hold PHI.
function shapeRow(r) {
  return {
    id: r.id,
    occurred_at: r.occurred_at,
    practice_id: r.practice_id,
    actor_user_id: r.actor_user_id,
    actor_type: r.actor_type,
    actor_name: r.actor_first_name || r.actor_last_name
      ? [r.actor_first_name, r.actor_last_name].filter(Boolean).join(' ').trim()
      : null,
    actor_email: r.actor_email || null,
    action: r.action,
    resource_type: r.resource_type,
    resource_id: r.resource_id,
    ip_address: r.ip_address,
    user_agent: r.user_agent,
    request_id: r.request_id,
    metadata: r.metadata,
  };
}

// --- handler -----------------------------------------------------------------

async function listAudit(practiceId, event) {
  const params = [practiceId];
  let where = `a.practice_id = $1`;

  const from = queryParam(event, 'from');
  if (from != null && from !== '') {
    if (!ISO_INSTANT_RE.test(from)) {
      return json(400, { error: 'Invalid from. Expected an ISO date or datetime.' }, event);
    }
    params.push(from);
    where += ` and a.occurred_at >= $${params.length}::timestamptz`;
  }

  const to = queryParam(event, 'to');
  if (to != null && to !== '') {
    if (!ISO_INSTANT_RE.test(to)) {
      return json(400, { error: 'Invalid to. Expected an ISO date or datetime.' }, event);
    }
    params.push(to);
    where += ` and a.occurred_at <= $${params.length}::timestamptz`;
  }

  const action = queryParam(event, 'action');
  if (action != null && action !== '') {
    if (String(action).length > 100) {
      return json(400, { error: 'Invalid action.' }, event);
    }
    params.push(action);
    where += ` and a.action = $${params.length}`;
  }

  const resourceType = queryParam(event, 'resource_type');
  if (resourceType != null && resourceType !== '') {
    if (!RESOURCE_TYPES.includes(resourceType)) {
      return json(400, { error: `Invalid resource_type. Expected one of: ${RESOURCE_TYPES.join(', ')}.` }, event);
    }
    params.push(resourceType);
    where += ` and a.resource_type = $${params.length}`;
  }

  const resourceId = queryParam(event, 'resource_id');
  if (resourceId != null && resourceId !== '') {
    if (!isUUID(resourceId)) {
      return json(400, { error: 'Invalid resource_id.' }, event);
    }
    params.push(resourceId);
    where += ` and a.resource_id = $${params.length}`;
  }

  const actorUserId = queryParam(event, 'actor_user_id');
  if (actorUserId != null && actorUserId !== '') {
    if (!isUUID(actorUserId)) {
      return json(400, { error: 'Invalid actor_user_id.' }, event);
    }
    params.push(actorUserId);
    where += ` and a.actor_user_id = $${params.length}`;
  }

  // Cursor for "load more": rows strictly older than the last one seen.
  const before = queryParam(event, 'before');
  if (before != null && before !== '') {
    if (!ISO_INSTANT_RE.test(before)) {
      return json(400, { error: 'Invalid before cursor.' }, event);
    }
    params.push(before);
    where += ` and a.occurred_at < $${params.length}::timestamptz`;
  }

  let limit = DEFAULT_LIMIT;
  const limitParam = queryParam(event, 'limit');
  if (limitParam != null && limitParam !== '') {
    const n = parseInt(limitParam, 10);
    if (Number.isNaN(n) || n < 1) {
      return json(400, { error: 'Invalid limit. Expected a positive integer.' }, event);
    }
    limit = Math.min(MAX_LIMIT, n);
  }
  params.push(limit);
  const limitPlaceholder = `$${params.length}`;

  const res = await db.query(
    `select a.*,
            u.first_name as actor_first_name,
            u.last_name  as actor_last_name,
            u.email      as actor_email
       from audit_log a
       left join users u on u.id = a.actor_user_id
      where ${where}
      order by a.occurred_at desc, a.id desc
      limit ${limitPlaceholder}`,
    params
  );

  const rows = res.rows.map(shapeRow);
  // Next cursor: the oldest occurred_at in this page (pass as ?before= to page).
  const nextBefore = rows.length === limit ? rows[rows.length - 1].occurred_at : null;
  return json(200, { audit_log: rows, next_before: nextBefore }, event);
}

// --- entrypoint --------------------------------------------------------------

exports.handler = async (event) => {
  const method = httpMethod(event);
  if (method === 'OPTIONS') {
    return preflight(event);
  }

  let auth;
  try {
    auth = requireAuth(event);
  } catch (err) {
    return json(err.statusCode || 401, { error: 'Unauthorized' }, event);
  }

  try {
    const caller = await loadCaller(auth.user.sub);
    if (!caller || caller.is_active === false) {
      return json(401, { error: 'Unauthorized' }, event);
    }
    if (caller.role !== 'practice_admin') {
      return json(403, { error: 'Only a practice admin can view the audit log.' }, event);
    }

    if (method === 'GET') return await listAudit(caller.practice_id, event);

    return json(405, { error: 'Method not allowed' }, event);
  } catch (err) {
    console.error('audit error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
