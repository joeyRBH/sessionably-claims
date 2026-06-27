'use strict';

// Invitations resource — tokenized invites for new staff to join a practice.
// One Lambda, routed internally by HTTP method + presence of {id}:
//
//   POST   /invitations        → create an invite (admin only); returns the row + link
//   GET    /invitations         → list the practice's invitations (any active member)
//   DELETE /invitations/{id}    → revoke a pending invite (admin only)
//
// New staff accept an invite via /invite.html?invite=<token>, which drives the
// /register (mode: invitation) flow. There is no PATCH here — invitations are
// immutable once created; their only mutations are auto-expiry and revoke.
//
// Security:
//   * practice_id ALWAYS comes from the authenticated caller's own row (loaded
//     fresh from the DB so a stale token cannot widen scope); never from body/token.
//   * Every query is filtered by that practice_id; cross-practice / not-found → 404.
//   * Create and revoke are gated to practice_admin; listing is open to any active
//     member of the practice.
//   * The raw token is only ever returned in the create response (as part of the
//     link); it is never echoed by list/revoke.

const crypto = require('crypto');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const { normalizeEmail, parseBody } = require('../lib/util');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROLES = ['practice_admin', 'clinician', 'billing_staff'];

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://reddably.com';

// --- request helpers ---------------------------------------------------------

function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

function pathId(event) {
  return event && event.pathParameters ? event.pathParameters.id : undefined;
}

function isUUID(v) {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

// --- shaping -----------------------------------------------------------------

// Safe shape — never exposes the raw token (only the create response carries it,
// embedded in the registration link).
function shapeInvitation(row) {
  return {
    id: row.id,
    practice_id: row.practice_id,
    invited_by: row.invited_by,
    email: row.email,
    role: row.role,
    status: row.status,
    expires_at: row.expires_at,
    accepted_at: row.accepted_at,
    accepted_user_id: row.accepted_user_id,
    created_at: row.created_at,
  };
}

// --- caller context ----------------------------------------------------------

// Load the caller's own row for authoritative practice_id + role + active state.
async function loadCaller(userId) {
  const res = await db.query(
    `select id, practice_id, role, is_active from users where id = $1 limit 1`,
    [userId]
  );
  return res.rows[0] || null;
}

// --- handlers ----------------------------------------------------------------

async function createInvitation(caller, body, event) {
  const email = normalizeEmail(body && body.email);
  if (!email) {
    return json(400, { error: 'Email is required.' }, event);
  }

  const role = body && body.role ? String(body.role).trim() : '';
  if (!ROLES.includes(role)) {
    return json(400, { error: `Invalid role. Expected one of: ${ROLES.join(', ')}.` }, event);
  }

  // Expiry window: integer days, default 7, clamped to 1–30.
  let expiresInDays = 7;
  if (body && body.expires_in_days != null && body.expires_in_days !== '') {
    const parsed = parseInt(body.expires_in_days, 10);
    if (isNaN(parsed)) {
      return json(400, { error: 'expires_in_days must be an integer.' }, event);
    }
    expiresInDays = Math.min(30, Math.max(1, parsed));
  }

  const token = crypto.randomBytes(32).toString('hex');

  const res = await db.query(
    `insert into invitations
       (practice_id, invited_by, email, role, token, status, expires_at)
     values
       ($1, $2, $3, $4, $5, 'pending', now() + ($6 || ' days')::interval)
     returning *`,
    [caller.practice_id, caller.id, email, role, token, expiresInDays]
  );

  const row = res.rows[0];
  const link = `${APP_BASE_URL}/invite.html?invite=${row.token}`;
  return json(201, { invitation: shapeInvitation(row), link }, event);
}

async function listInvitations(caller, event) {
  // Auto-expire stale pending rows so the list reflects reality without a cron.
  await db.query(
    `update invitations
        set status = 'expired'
      where practice_id = $1
        and status = 'pending'
        and expires_at < now()`,
    [caller.practice_id]
  );

  const res = await db.query(
    `select * from invitations
      where practice_id = $1
      order by created_at desc`,
    [caller.practice_id]
  );
  return json(200, { invitations: res.rows.map(shapeInvitation) }, event);
}

async function revokeInvitation(caller, id, event) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);

  const found = await db.query(
    `select * from invitations where id = $1 and practice_id = $2 limit 1`,
    [id, caller.practice_id]
  );
  const row = found.rows[0];
  if (!row) return json(404, { error: 'Not found' }, event);

  if (row.status !== 'pending') {
    return json(409, { error: 'Only pending invitations can be revoked.' }, event);
  }

  const res = await db.query(
    `update invitations set status = 'revoked'
      where id = $1 and practice_id = $2
      returning *`,
    [id, caller.practice_id]
  );
  return json(200, { invitation: shapeInvitation(res.rows[0]) }, event);
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

    const id = pathId(event);

    // Create and revoke are admin-only; listing is open to any active member.
    if ((method === 'POST' || method === 'DELETE') && caller.role !== 'practice_admin') {
      return json(403, { error: 'Only a practice admin can manage invitations.' }, event);
    }

    if (method === 'POST' && !id) {
      return await createInvitation(caller, parseBody(event), event);
    }
    if (method === 'GET' && !id) return await listInvitations(caller, event);
    if (method === 'DELETE' && id) return await revokeInvitation(caller, id, event);

    return json(405, { error: 'Method not allowed' }, event);
  } catch (err) {
    console.error('invitations error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
