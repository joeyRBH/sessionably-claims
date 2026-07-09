'use strict';

// Users resource — the practice's people directory (clinicians, admins, billing
// staff). One Lambda, routed internally by HTTP method + presence of {id}:
//
//   GET   /users        → list the practice's users (any active member)
//   GET   /users/{id}    → one user, practice-scoped
//   PATCH /users/{id}    → edit a user's profile/role/active state
//
// There is no create/delete here: new users join via the invitation +
// /register (mode: invitation) flow, and accounts are deactivated (is_active=false)
// rather than deleted.
//
// Security:
//   * practice_id ALWAYS comes from the authenticated caller's own row (loaded
//     fresh from the DB so a stale token cannot widen scope); never from body/token.
//   * Every query is filtered by that practice_id; cross-practice / not-found → 404.
//   * Writes are role-gated: a practice_admin may edit anyone in the practice
//     (incl. role / is_active / fee_payer_override); a non-admin may edit ONLY
//     their own profile fields. A user can never change their own role or
//     deactivate themselves (lock-out protection — this also guarantees the
//     practice always keeps at least one active admin).
//   * password_hash / google_oauth_sub are never accepted or returned.

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const { parseBody } = require('../lib/util');
const { audit, sanitizeFields } = require('../lib/audit');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROLES = ['practice_admin', 'clinician', 'billing_staff'];
const FEE_PAYERS = ['client', 'practice'];

// Fields a non-admin may edit on their OWN row.
const SELF_PROFILE_FIELDS = ['first_name', 'last_name', 'title', 'npi', 'license_state'];
// Additional fields only a practice_admin may set (on anyone).
const ADMIN_ONLY_FIELDS = ['role', 'fee_payer_override', 'is_active'];

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

function queryParam(event, name) {
  return event && event.queryStringParameters ? event.queryStringParameters[name] : undefined;
}

// --- validation helpers ------------------------------------------------------

function cleanText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function isUUID(v) {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

function parseBool(v) {
  if (v === true || v === false) return { ok: true, value: v };
  if (v === 'true') return { ok: true, value: true };
  if (v === 'false') return { ok: true, value: false };
  return { ok: false };
}

// --- shaping -----------------------------------------------------------------

// Safe directory shape — never exposes password_hash or google_oauth_sub.
function shapeUser(r) {
  if (!r) return null;
  return {
    id: r.id,
    practice_id: r.practice_id,
    role: r.role,
    first_name: r.first_name,
    last_name: r.last_name,
    email: r.email,
    title: r.title,
    npi: r.npi,
    license_state: r.license_state,
    fee_payer_override: r.fee_payer_override,
    is_active: r.is_active,
    last_login_at: r.last_login_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
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

async function loadUser(practiceId, id) {
  const res = await db.query(
    `select * from users where id = $1 and practice_id = $2 limit 1`,
    [id, practiceId]
  );
  return res.rows[0] || null;
}

// --- handlers ----------------------------------------------------------------

async function listUsers(practiceId, event) {
  const params = [practiceId];
  let where = `practice_id = $1`;

  const role = queryParam(event, 'role');
  if (role != null && role !== '') {
    if (!ROLES.includes(role)) {
      return json(400, { error: `Invalid role. Expected one of: ${ROLES.join(', ')}.` }, event);
    }
    params.push(role);
    where += ` and role = $${params.length}`;
  }

  const active = queryParam(event, 'active');
  if (active != null && active !== '') {
    const b = parseBool(active);
    if (!b.ok) return json(400, { error: 'Invalid active. Expected true or false.' }, event);
    params.push(b.value);
    where += ` and is_active = $${params.length}`;
  }

  const res = await db.query(
    `select * from users where ${where} order by is_active desc, last_name asc, first_name asc`,
    params
  );
  return json(200, { users: res.rows.map(shapeUser) }, event);
}

async function getUser(practiceId, id, event) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);
  const user = await loadUser(practiceId, id);
  if (!user) return json(404, { error: 'Not found' }, event);
  return json(200, { user: shapeUser(user) }, event);
}

async function updateUser(caller, id, body, event, authCtx) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);

  const target = await loadUser(caller.practice_id, id);
  if (!target) return json(404, { error: 'Not found' }, event);

  const isAdmin = caller.role === 'practice_admin';
  const isSelf = caller.id === target.id;

  // Authorization: admin may edit anyone; a non-admin may edit only their own row.
  if (!isAdmin && !isSelf) {
    return json(403, { error: 'Only a practice admin can edit other users.' }, event);
  }

  // Reject privileged fields for non-admins up front.
  if (!isAdmin) {
    const attempted = ADMIN_ONLY_FIELDS.filter((f) => f in body);
    if (attempted.length) {
      return json(403, { error: 'Only a practice admin can change role, fee payer, or active status.' }, event);
    }
  }

  const sets = [];
  const params = [];
  const changes = {};
  const add = (col, val) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
    changes[col] = val;
  };

  // Profile text fields (admin on anyone, or self).
  for (const f of SELF_PROFILE_FIELDS) {
    if (f in body) {
      const val = cleanText(body[f]);
      if ((f === 'first_name' || f === 'last_name') && !val) {
        return json(400, { error: `${f} cannot be blank.` }, event);
      }
      add(f, val);
    }
  }

  // Admin-only fields.
  if ('role' in body) {
    const role = cleanText(body.role);
    if (!role || !ROLES.includes(role)) {
      return json(400, { error: `Invalid role. Expected one of: ${ROLES.join(', ')}.` }, event);
    }
    if (isSelf && role !== target.role) {
      return json(400, { error: 'You cannot change your own role.' }, event);
    }
    add('role', role);
  }

  if ('fee_payer_override' in body) {
    const fp = cleanText(body.fee_payer_override);
    if (fp !== null && !FEE_PAYERS.includes(fp)) {
      return json(400, { error: `Invalid fee_payer_override. Expected one of: ${FEE_PAYERS.join(', ')}, or empty.` }, event);
    }
    add('fee_payer_override', fp);
  }

  if ('is_active' in body) {
    const b = parseBool(body.is_active);
    if (!b.ok) return json(400, { error: 'Invalid is_active. Expected a boolean.' }, event);
    if (isSelf && b.value === false) {
      return json(400, { error: 'You cannot deactivate your own account.' }, event);
    }
    add('is_active', b.value);
  }

  if (sets.length === 0) {
    return json(400, { error: 'No updatable fields provided.' }, event);
  }

  params.push(id);
  const idParam = `$${params.length}`;
  params.push(caller.practice_id);
  const practiceParam = `$${params.length}`;

  const res = await db.query(
    `update users set ${sets.join(', ')}
      where id = ${idParam} and practice_id = ${practiceParam}
      returning *`,
    params
  );
  if (res.rowCount === 0) return json(404, { error: 'Not found' }, event);
  await audit(event, authCtx, {
    action: 'user.update',
    resourceType: 'user',
    resourceId: id,
    metadata: { fields_changed: sanitizeFields(target, changes) },
  });
  return json(200, { user: shapeUser(res.rows[0]) }, event);
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
    const body = method === 'PATCH' ? parseBody(event) : null;

    const authCtx = { userId: caller.id, practiceId: caller.practice_id };

    if (method === 'GET' && !id) return await listUsers(caller.practice_id, event);
    if (method === 'GET' && id) return await getUser(caller.practice_id, id, event);
    if (method === 'PATCH' && id) return await updateUser(caller, id, body, event, authCtx);

    return json(405, { error: 'Method not allowed' }, event);
  } catch (err) {
    console.error('users error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
