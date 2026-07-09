'use strict';

// Practice resource — the caller's own practice (the top-level tenant).
//
//   GET  /practice   → the authenticated user's practice (settings summary)
//   PUT  /practice   → update the practice's identity + billing address
//   PATCH /practice  → alias of PUT (partial update)
//
// Security: practice_id is ALWAYS derived from the authenticated user (loaded
// from the users row), never taken from the request body or token — a user can
// only ever read or modify their own practice. Editing is limited to
// practice_admin / billing_staff; clinicians get 403. tax_id is PHI-adjacent, so
// error logs stay generic and never echo field values.
//
// The billing address captured here (address_line1/2, city, state, postal_code)
// feeds the Stedi 837P Billing.address block; without it a claim submission is
// blocked with a 422 (see handlers/claims.js) rather than failing at the payer.

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const { parseBody } = require('../lib/util');
const { audit, sanitizeFields } = require('../lib/audit');
const { isValidEmail } = require('../lib/email');

const EDIT_ROLES = ['practice_admin', 'billing_staff'];

// --- request helpers ---------------------------------------------------------

function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

// Trim to a string capped at `max` chars; blank/non-string → null.
function cleanText(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '') return null;
  return max ? s.slice(0, max) : s;
}

// --- shaping -----------------------------------------------------------------

function shapePractice(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    npi: r.npi,
    tax_id: r.tax_id,
    address_line1: r.address_line1,
    address_line2: r.address_line2,
    city: r.city,
    state: r.state,
    postal_code: r.postal_code,
    country: r.country,
    default_fee_payer: r.default_fee_payer,
    platform_fee_percent: r.platform_fee_percent,
    plan: r.plan,
    notification_email: r.notification_email,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// --- practice scoping --------------------------------------------------------

// The caller's practice_id + role, loaded fresh so a deactivated user (or a
// role change) can't act on a stale token.
async function loadPrincipal(userId) {
  const res = await db.query(
    `select practice_id, role from users where id = $1 and is_active = true limit 1`,
    [userId]
  );
  return res.rows[0] || null;
}

async function loadPractice(practiceId) {
  const res = await db.query(
    `select * from practices where id = $1 and is_active = true limit 1`,
    [practiceId]
  );
  return res.rows[0] || null;
}

// --- handlers ----------------------------------------------------------------

async function getPractice(practiceId, event) {
  const practice = await loadPractice(practiceId);
  if (!practice) return json(404, { error: 'Not found' }, event);
  return json(200, { practice: shapePractice(practice) }, event);
}

async function updatePractice(practiceId, role, body, event, authCtx) {
  if (!EDIT_ROLES.includes(role)) {
    return json(403, { error: 'Only a practice admin can edit practice settings.' }, event);
  }

  // Snapshot before the update so the audit records WHICH fields changed (names
  // only — tax_id changes appear as the field name, never the value).
  const before = await loadPractice(practiceId);

  const sets = [];
  const params = [];
  const changes = {};
  const add = (col, val) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
    changes[col] = val;
  };

  // Name, when provided, must be non-empty (a practice always has a name).
  if ('name' in body) {
    const name = cleanText(body.name, 200);
    if (!name) return json(400, { error: 'Practice name cannot be empty.' }, event);
    add('name', name);
  }

  // Identity + billing address. All optional; blank clears the column.
  const textFields = {
    npi: 20,
    tax_id: 20,
    address_line1: 200,
    address_line2: 200,
    city: 100,
    state: 100,
    postal_code: 20,
  };
  Object.keys(textFields).forEach((col) => {
    if (col in body) add(col, cleanText(body[col], textFields[col]));
  });

  // Notification email: where intake-completion alerts are sent. Optional — a
  // blank clears it — but a non-blank value must be a valid email, so we never
  // store (and later hand SES) a login username like "BigRedd".
  if ('notification_email' in body) {
    const notify = cleanText(body.notification_email, 200);
    if (notify && !isValidEmail(notify)) {
      return json(400, { error: 'Enter a valid notification email address.' }, event);
    }
    add('notification_email', notify);
  }

  if (sets.length === 0) {
    return json(400, { error: 'No updatable fields provided.' }, event);
  }

  params.push(practiceId);
  const res = await db.query(
    `update practices set ${sets.join(', ')}
      where id = $${params.length} and is_active = true
      returning *`,
    params
  );
  if (res.rowCount === 0) return json(404, { error: 'Not found' }, event);
  await audit(event, authCtx, {
    action: 'practice.update',
    resourceType: 'practice',
    resourceId: practiceId,
    metadata: { fields_changed: sanitizeFields(before, changes) },
  });
  return json(200, { practice: shapePractice(res.rows[0]) }, event);
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
    const principal = await loadPrincipal(auth.user.sub);
    if (!principal) {
      return json(401, { error: 'Unauthorized' }, event);
    }
    const practiceId = principal.practice_id;

    if (method === 'GET') return await getPractice(practiceId, event);
    if (method === 'PUT' || method === 'PATCH') {
      const body = parseBody(event);
      const authCtx = { userId: auth.user.sub, practiceId };
      return await updatePractice(practiceId, principal.role, body, event, authCtx);
    }

    return json(405, { error: 'Method not allowed' }, event);
  } catch (err) {
    // Never log PHI-adjacent detail (tax_id) — generic only.
    console.error('practice error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
