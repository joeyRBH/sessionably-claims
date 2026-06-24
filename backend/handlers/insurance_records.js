'use strict';

// Insurance records resource — one Lambda for the whole resource, routed
// internally by HTTP method and the presence of an {id} path parameter:
//
//   POST   /insurance-records        → create under the caller's practice
//   GET    /insurance-records         → list the caller's practice's records
//                                       (excludes hidden); optional ?client_id filter
//   GET    /insurance-records/{id}     → one record, practice-scoped
//   PATCH  /insurance-records/{id}     → update allowed fields, practice-scoped
//   DELETE /insurance-records/{id}     → soft-delete (is_hidden = true), practice-scoped
//
// Security: practice_id is ALWAYS derived from the authenticated user (loaded
// from the users row), never taken from the request body. Every query is
// filtered by that practice_id so a user can never read or modify another
// practice's records. Out-of-network benefit data is PHI — error logs never
// include member_id, subscriber_name, subscriber_dob, or benefits_raw.

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const { parseBody } = require('../lib/util');

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

// A query-string parameter, or undefined.
function queryParam(event, name) {
  return event && event.queryStringParameters ? event.queryStringParameters[name] : undefined;
}

// --- validation helpers ------------------------------------------------------

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

// Optional money: absent/blank → null; otherwise a finite number >= 0.
// Returns { ok, value } so callers can map a failure to a 400.
function parseMoney(v) {
  if (v == null || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

// Optional percentage: absent/blank → null; otherwise a finite number 0–100.
function parseRate(v) {
  if (v == null || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false };
  return { ok: true, value: n };
}

// Optional boolean: must be a real boolean when present.
function parseBool(v) {
  if (typeof v === 'boolean') return { ok: true, value: v };
  return { ok: false };
}

// --- shaping -----------------------------------------------------------------

// Shape an insurance_records row for the API. All fields belong to the caller's
// own practice, so the full record (including PHI) is safe to return to them.
function shapeRecord(r) {
  if (!r) return null;
  return {
    id: r.id,
    practice_id: r.practice_id,
    client_id: r.client_id,
    carrier_name: r.carrier_name,
    member_id: r.member_id,
    group_number: r.group_number,
    plan_type: r.plan_type,
    subscriber_relationship: r.subscriber_relationship,
    subscriber_name: r.subscriber_name,
    subscriber_dob: r.subscriber_dob,
    oon_deductible_total: r.oon_deductible_total,
    oon_deductible_met: r.oon_deductible_met,
    oon_reimbursement_rate: r.oon_reimbursement_rate,
    benefits_checked_at: r.benefits_checked_at,
    benefits_raw: r.benefits_raw,
    is_primary: r.is_primary,
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

// True if clientId is a non-hidden client within this practice. Guards against
// attaching insurance to a client from another practice.
async function clientInPractice(practiceId, clientId) {
  const res = await db.query(
    `select 1 from clients where id = $1 and practice_id = $2 and is_hidden = false limit 1`,
    [clientId, practiceId]
  );
  return res.rowCount > 0;
}

// --- handlers ----------------------------------------------------------------

async function createRecord(practiceId, body, event) {
  const clientId = cleanText(body.client_id);
  if (!clientId) {
    return json(400, { error: 'Missing required fields: client_id' }, event);
  }
  if (!isUUID(clientId)) {
    return json(400, { error: 'Invalid client_id.' }, event);
  }
  if (!(await clientInPractice(practiceId, clientId))) {
    return json(400, { error: 'client_id is not a client in this practice.' }, event);
  }

  const dob = cleanText(body.subscriber_dob);
  if (dob && !isValidDate(dob)) {
    return json(400, { error: 'Invalid subscriber_dob. Expected YYYY-MM-DD.' }, event);
  }

  const total = parseMoney(body.oon_deductible_total);
  if (!total.ok) {
    return json(400, { error: 'Invalid oon_deductible_total. Expected a number >= 0.' }, event);
  }
  const met = parseMoney(body.oon_deductible_met);
  if (!met.ok) {
    return json(400, { error: 'Invalid oon_deductible_met. Expected a number >= 0.' }, event);
  }
  const rate = parseRate(body.oon_reimbursement_rate);
  if (!rate.ok) {
    return json(400, { error: 'Invalid oon_reimbursement_rate. Expected a number between 0 and 100.' }, event);
  }

  let isPrimary = null;
  if ('is_primary' in body) {
    const b = parseBool(body.is_primary);
    if (!b.ok) {
      return json(400, { error: 'Invalid is_primary. Expected a boolean.' }, event);
    }
    isPrimary = b.value;
  }

  // benefits_checked_at and benefits_raw are system-managed — never accepted
  // from the client, so they are left null at creation.
  const res = await db.query(
    `insert into insurance_records
       (practice_id, client_id, carrier_name, member_id, group_number, plan_type,
        subscriber_relationship, subscriber_name, subscriber_dob,
        oon_deductible_total, oon_deductible_met, oon_reimbursement_rate, is_primary)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, coalesce($13, true))
     returning *`,
    [
      practiceId,
      clientId,
      cleanText(body.carrier_name),
      cleanText(body.member_id),
      cleanText(body.group_number),
      cleanText(body.plan_type),
      cleanText(body.subscriber_relationship),
      cleanText(body.subscriber_name),
      dob,
      total.value,
      met.value,
      rate.value,
      isPrimary,
    ]
  );

  return json(201, { insurance_record: shapeRecord(res.rows[0]) }, event);
}

async function listRecords(practiceId, event) {
  const params = [practiceId];
  let where = `practice_id = $1 and is_hidden = false`;

  const clientId = queryParam(event, 'client_id');
  if (clientId != null && clientId !== '') {
    if (!isUUID(clientId)) {
      return json(400, { error: 'Invalid client_id.' }, event);
    }
    params.push(clientId);
    where += ` and client_id = $${params.length}`;
  }

  const res = await db.query(
    `select * from insurance_records
      where ${where}
      order by created_at desc`,
    params
  );
  return json(200, { insurance_records: res.rows.map(shapeRecord) }, event);
}

async function getRecord(practiceId, id, event) {
  if (!isUUID(id)) {
    return json(404, { error: 'Not found' }, event);
  }
  const res = await db.query(
    `select * from insurance_records
      where id = $1 and practice_id = $2 and is_hidden = false
      limit 1`,
    [id, practiceId]
  );
  if (res.rowCount === 0) {
    return json(404, { error: 'Not found' }, event);
  }
  return json(200, { insurance_record: shapeRecord(res.rows[0]) }, event);
}

async function updateRecord(practiceId, id, body, event) {
  if (!isUUID(id)) {
    return json(404, { error: 'Not found' }, event);
  }

  // client_id is immutable — a record stays attached to its original client.
  if ('client_id' in body) {
    return json(400, { error: 'client_id cannot be changed.' }, event);
  }

  const sets = [];
  const params = [];
  const add = (col, val) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };

  // Optional nullable text fields.
  for (const col of [
    'carrier_name',
    'member_id',
    'group_number',
    'plan_type',
    'subscriber_relationship',
    'subscriber_name',
  ]) {
    if (col in body) add(col, cleanText(body[col]));
  }

  if ('subscriber_dob' in body) {
    const dob = cleanText(body.subscriber_dob);
    if (dob && !isValidDate(dob)) {
      return json(400, { error: 'Invalid subscriber_dob. Expected YYYY-MM-DD.' }, event);
    }
    add('subscriber_dob', dob);
  }

  if ('oon_deductible_total' in body) {
    const total = parseMoney(body.oon_deductible_total);
    if (!total.ok) {
      return json(400, { error: 'Invalid oon_deductible_total. Expected a number >= 0.' }, event);
    }
    add('oon_deductible_total', total.value);
  }

  if ('oon_deductible_met' in body) {
    const met = parseMoney(body.oon_deductible_met);
    if (!met.ok) {
      return json(400, { error: 'Invalid oon_deductible_met. Expected a number >= 0.' }, event);
    }
    add('oon_deductible_met', met.value);
  }

  if ('oon_reimbursement_rate' in body) {
    const rate = parseRate(body.oon_reimbursement_rate);
    if (!rate.ok) {
      return json(400, { error: 'Invalid oon_reimbursement_rate. Expected a number between 0 and 100.' }, event);
    }
    add('oon_reimbursement_rate', rate.value);
  }

  if ('is_primary' in body) {
    const b = parseBool(body.is_primary);
    if (!b.ok) {
      return json(400, { error: 'Invalid is_primary. Expected a boolean.' }, event);
    }
    add('is_primary', b.value);
  }

  if (sets.length === 0) {
    return json(400, { error: 'No updatable fields provided.' }, event);
  }

  // Scope the UPDATE to this practice and exclude hidden (soft-deleted) rows so
  // a deleted record reads as 404. updated_at is maintained by the table trigger.
  params.push(id);
  const idParam = `$${params.length}`;
  params.push(practiceId);
  const practiceParam = `$${params.length}`;

  const res = await db.query(
    `update insurance_records set ${sets.join(', ')}
      where id = ${idParam} and practice_id = ${practiceParam} and is_hidden = false
      returning *`,
    params
  );
  if (res.rowCount === 0) {
    return json(404, { error: 'Not found' }, event);
  }
  return json(200, { insurance_record: shapeRecord(res.rows[0]) }, event);
}

async function deleteRecord(practiceId, id, event) {
  if (!isUUID(id)) {
    return json(404, { error: 'Not found' }, event);
  }
  // Soft-delete only — never hard-delete a PHI record.
  const res = await db.query(
    `update insurance_records set is_hidden = true
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

    if (method === 'POST' && !id) return await createRecord(practiceId, body, event);
    if (method === 'GET' && !id) return await listRecords(practiceId, event);
    if (method === 'GET' && id) return await getRecord(practiceId, id, event);
    if (method === 'PATCH' && id) return await updateRecord(practiceId, id, body, event);
    if (method === 'DELETE' && id) return await deleteRecord(practiceId, id, event);

    return json(405, { error: 'Method not allowed' }, event);
  } catch (err) {
    // Never log PHI (member_id, subscriber_name/dob, benefits_raw) — generic only.
    console.error('insurance_records error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
