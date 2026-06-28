'use strict';

// Clients resource — one Lambda for the whole resource, routed internally by
// HTTP method and the presence of an {id} path parameter:
//
//   POST   /clients        → create under the caller's practice
//   GET    /clients        → list the caller's practice's clients (excludes hidden)
//   GET    /clients/{id}    → one client, practice-scoped
//   PATCH  /clients/{id}    → update allowed fields, practice-scoped
//   DELETE /clients/{id}    → soft-delete (is_hidden = true), practice-scoped
//
// Security: practice_id is ALWAYS derived from the authenticated user (loaded
// from the users row), never taken from the request body. Every query is
// filtered by that practice_id so a user can never read or modify another
// practice's clients. Clients are PHI — error logs never include names, DOB,
// or contact info.

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const { normalizeEmail, parseBody } = require('../lib/util');

// Allowed client.status values — mirror the CHECK constraint in db/schema.sql.
const ALLOWED_STATUSES = ['active', 'awaiting_info', 'ready', 'inactive'];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- request helpers ---------------------------------------------------------

// HTTP method, tolerant of both API Gateway payload formats (v1 httpMethod,
// v2 requestContext.http.method).
function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

// The {id} path parameter, or undefined for collection routes.
function pathId(event) {
  return event && event.pathParameters ? event.pathParameters.id : undefined;
}

// --- validation helpers ------------------------------------------------------

// Mirror register's missing(): fields that are absent or blank after trimming.
function missing(fields, body) {
  return fields.filter((f) => !body[f] || String(body[f]).trim() === '');
}

// Trim a value to a non-empty string, or null. Used for optional text columns
// so a blank string clears the column rather than storing ''.
function cleanText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function isUUID(v) {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

// Calendar-valid YYYY-MM-DD (rejects e.g. 2020-13-40 before it reaches Postgres).
function isValidDate(s) {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// --- shaping -----------------------------------------------------------------

// Shape a clients row for the API. All fields belong to the caller's own
// practice, so the full record is safe to return.
function shapeClient(r) {
  if (!r) return null;
  return {
    id: r.id,
    practice_id: r.practice_id,
    primary_clinician_id: r.primary_clinician_id,
    first_name: r.first_name,
    last_name: r.last_name,
    preferred_name: r.preferred_name,
    pronouns: r.pronouns,
    email: r.email,
    phone: r.phone,
    date_of_birth: r.date_of_birth,
    status: r.status,
    // Display-only payment-method summary (never the Stripe customer / PM ids).
    payment_method_brand: r.payment_method_brand,
    payment_method_last4: r.payment_method_last4,
    payment_method_exp_month: r.payment_method_exp_month,
    payment_method_exp_year: r.payment_method_exp_year,
    payment_method_set_at: r.payment_method_set_at,
    payment_link_sent_at: r.payment_link_sent_at,
    is_hidden: r.is_hidden,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// --- practice scoping --------------------------------------------------------

// Derive the caller's practice_id from their (active) users row. Re-loading
// from the DB means a deactivated user can't keep acting on a still-valid token,
// and the practice_id is never trusted from the request.
async function loadPracticeId(userId) {
  const res = await db.query(
    `select practice_id from users where id = $1 and is_active = true limit 1`,
    [userId]
  );
  return res.rows[0] ? res.rows[0].practice_id : null;
}

// True if clinicianId is an active user within this practice. Guards against
// pointing a client at a clinician from another practice.
async function clinicianInPractice(practiceId, clinicianId) {
  const res = await db.query(
    `select 1 from users where id = $1 and practice_id = $2 and is_active = true limit 1`,
    [clinicianId, practiceId]
  );
  return res.rowCount > 0;
}

// --- handlers ----------------------------------------------------------------

async function createClient(practiceId, body, event) {
  const absent = missing(['first_name', 'last_name'], body);
  if (absent.length) {
    return json(400, { error: `Missing required fields: ${absent.join(', ')}` }, event);
  }

  const status = cleanText(body.status);
  if (status && !ALLOWED_STATUSES.includes(status)) {
    return json(400, { error: `Invalid status. Expected one of: ${ALLOWED_STATUSES.join(', ')}` }, event);
  }

  const dob = cleanText(body.date_of_birth);
  if (dob && !isValidDate(dob)) {
    return json(400, { error: 'Invalid date_of_birth. Expected YYYY-MM-DD.' }, event);
  }

  const primaryClinicianId = cleanText(body.primary_clinician_id);
  if (primaryClinicianId) {
    if (!isUUID(primaryClinicianId)) {
      return json(400, { error: 'Invalid primary_clinician_id.' }, event);
    }
    if (!(await clinicianInPractice(practiceId, primaryClinicianId))) {
      return json(400, { error: 'primary_clinician_id is not a clinician in this practice.' }, event);
    }
  }

  const email = body.email ? normalizeEmail(body.email) : null;

  const res = await db.query(
    `insert into clients
       (practice_id, first_name, last_name, preferred_name, pronouns, email, phone,
        date_of_birth, primary_clinician_id, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10, 'awaiting_info'))
     returning *`,
    [
      practiceId,
      String(body.first_name).trim(),
      String(body.last_name).trim(),
      cleanText(body.preferred_name),
      cleanText(body.pronouns),
      email,
      cleanText(body.phone),
      dob,
      primaryClinicianId,
      status,
    ]
  );

  return json(201, { client: shapeClient(res.rows[0]) }, event);
}

async function listClients(practiceId, event) {
  const res = await db.query(
    `select * from clients
      where practice_id = $1 and is_hidden = false
      order by created_at desc`,
    [practiceId]
  );
  return json(200, { clients: res.rows.map(shapeClient) }, event);
}

async function getClient(practiceId, id, event) {
  if (!isUUID(id)) {
    return json(404, { error: 'Not found' }, event);
  }
  const res = await db.query(
    `select * from clients
      where id = $1 and practice_id = $2 and is_hidden = false
      limit 1`,
    [id, practiceId]
  );
  if (res.rowCount === 0) {
    return json(404, { error: 'Not found' }, event);
  }
  return json(200, { client: shapeClient(res.rows[0]) }, event);
}

async function updateClient(practiceId, id, body, event) {
  if (!isUUID(id)) {
    return json(404, { error: 'Not found' }, event);
  }

  const sets = [];
  const params = [];
  const add = (col, val) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };

  // Required-ish text fields: if present they must be non-empty.
  for (const col of ['first_name', 'last_name']) {
    if (col in body) {
      const v = cleanText(body[col]);
      if (v == null) {
        return json(400, { error: `${col} cannot be empty.` }, event);
      }
      add(col, v);
    }
  }

  // Optional nullable text fields.
  for (const col of ['preferred_name', 'pronouns', 'phone']) {
    if (col in body) add(col, cleanText(body[col]));
  }

  if ('email' in body) {
    add('email', body.email ? normalizeEmail(body.email) : null);
  }

  if ('date_of_birth' in body) {
    const dob = cleanText(body.date_of_birth);
    if (dob && !isValidDate(dob)) {
      return json(400, { error: 'Invalid date_of_birth. Expected YYYY-MM-DD.' }, event);
    }
    add('date_of_birth', dob);
  }

  if ('status' in body) {
    const status = cleanText(body.status);
    if (!status || !ALLOWED_STATUSES.includes(status)) {
      return json(400, { error: `Invalid status. Expected one of: ${ALLOWED_STATUSES.join(', ')}` }, event);
    }
    add('status', status);
  }

  if ('primary_clinician_id' in body) {
    const primaryClinicianId = cleanText(body.primary_clinician_id);
    if (primaryClinicianId) {
      if (!isUUID(primaryClinicianId)) {
        return json(400, { error: 'Invalid primary_clinician_id.' }, event);
      }
      if (!(await clinicianInPractice(practiceId, primaryClinicianId))) {
        return json(400, { error: 'primary_clinician_id is not a clinician in this practice.' }, event);
      }
    }
    add('primary_clinician_id', primaryClinicianId);
  }

  if (sets.length === 0) {
    return json(400, { error: 'No updatable fields provided.' }, event);
  }

  // Scope the UPDATE to this practice and exclude hidden (soft-deleted) rows so
  // a deleted client reads as 404. updated_at is maintained by the table trigger.
  params.push(id);
  const idParam = `$${params.length}`;
  params.push(practiceId);
  const practiceParam = `$${params.length}`;

  const res = await db.query(
    `update clients set ${sets.join(', ')}
      where id = ${idParam} and practice_id = ${practiceParam} and is_hidden = false
      returning *`,
    params
  );
  if (res.rowCount === 0) {
    return json(404, { error: 'Not found' }, event);
  }
  return json(200, { client: shapeClient(res.rows[0]) }, event);
}

async function deleteClient(practiceId, id, event) {
  if (!isUUID(id)) {
    return json(404, { error: 'Not found' }, event);
  }
  // Soft-delete only — never hard-delete a PHI record.
  const res = await db.query(
    `update clients set is_hidden = true
      where id = $1 and practice_id = $2 and is_hidden = false
      returning id`,
    [id, practiceId]
  );
  if (res.rowCount === 0) {
    return json(404, { error: 'Not found' }, event);
  }
  return json(200, { deleted: true, id: res.rows[0].id }, event);
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
    const practiceId = await loadPracticeId(auth.user.sub);
    if (!practiceId) {
      return json(401, { error: 'Unauthorized' }, event);
    }

    const id = pathId(event);
    const body = method === 'POST' || method === 'PATCH' ? parseBody(event) : null;

    if (method === 'POST' && !id) return await createClient(practiceId, body, event);
    if (method === 'GET' && !id) return await listClients(practiceId, event);
    if (method === 'GET' && id) return await getClient(practiceId, id, event);
    if (method === 'PATCH' && id) return await updateClient(practiceId, id, body, event);
    if (method === 'DELETE' && id) return await deleteClient(practiceId, id, event);

    return json(405, { error: 'Method not allowed' }, event);
  } catch (err) {
    // Never log PHI (names, DOB, contact info) — only a generic message.
    console.error('clients error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
