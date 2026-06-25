'use strict';

// Sessions resource — one Lambda for the whole resource, routed internally by
// HTTP method and the presence of an {id} path parameter:
//
//   POST   /sessions        → create under the caller's practice
//   GET    /sessions        → list the caller's practice's sessions (excludes
//                             hidden); optional ?client_id, ?clinician_id, ?status
//   GET    /sessions/{id}    → one session, practice-scoped
//   PATCH  /sessions/{id}    → update allowed fields, practice-scoped
//   DELETE /sessions/{id}    → soft-delete (is_hidden = true), practice-scoped
//
// Security: practice_id is ALWAYS derived from the authenticated user (loaded
// from the users row), never taken from the request body. Every query is
// filtered by that practice_id so a user can never read or modify another
// practice's sessions. client_id and clinician_id must both belong to the
// caller's practice. Sessions hold billing data only (no clinical notes); error
// logs stay generic and never include ids, diagnosis codes, or notes.

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const { parseBody } = require('../lib/util');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SESSION_STATUSES = [
  'scheduled', 'completed', 'claim_ready', 'claim_submitted',
  'awaiting_payment', 'paid', 'no_claim',
];

const MAX_DIAGNOSIS_CODES = 12; // CMS-1500 allows up to 12 ICD-10 codes.

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

function isValidDate(s) {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Optional money: absent/blank → null; otherwise a finite number >= 0.
function parseMoney(v) {
  if (v == null || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

// Optional positive integer minutes: absent/blank → null; otherwise integer >= 1.
function parseDuration(v) {
  if (v == null || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return { ok: false };
  return { ok: true, value: n };
}

// Optional session status: absent/blank → null (caller applies default);
// otherwise must be one of the allowed enum values.
function parseStatus(v) {
  if (v == null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string' || !SESSION_STATUSES.includes(v)) return { ok: false };
  return { ok: true, value: v };
}

// Optional ICD-10 diagnosis codes: absent/null → null; otherwise must be an
// array of non-empty trimmed strings, at most MAX_DIAGNOSIS_CODES. An empty
// array clears the column (stored as null).
function parseDiagnosisCodes(v) {
  if (v == null) return { ok: true, value: null };
  if (!Array.isArray(v)) return { ok: false };
  const out = [];
  for (const item of v) {
    if (typeof item !== 'string') return { ok: false };
    const s = item.trim();
    if (s === '') return { ok: false };
    out.push(s);
  }
  if (out.length > MAX_DIAGNOSIS_CODES) return { ok: false };
  return { ok: true, value: out.length === 0 ? null : out };
}

// --- shaping -----------------------------------------------------------------

function shapeSession(r) {
  if (!r) return null;
  return {
    id: r.id,
    practice_id: r.practice_id,
    client_id: r.client_id,
    clinician_id: r.clinician_id,
    session_date: r.session_date,
    duration_minutes: r.duration_minutes,
    cpt_code: r.cpt_code,
    diagnosis_codes: r.diagnosis_codes,
    place_of_service: r.place_of_service,
    fee: r.fee,
    notes: r.notes,
    status: r.status,
    is_hidden: r.is_hidden,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// --- practice scoping --------------------------------------------------------

async function loadPracticeId(userId) {
  const res = await db.query(
    `select practice_id from users where id = $1 and is_active = true limit 1`,
    [userId]
  );
  return res.rows[0] ? res.rows[0].practice_id : null;
}

// True if clientId is a non-hidden client within this practice.
async function clientInPractice(practiceId, clientId) {
  const res = await db.query(
    `select 1 from clients where id = $1 and practice_id = $2 and is_hidden = false limit 1`,
    [clientId, practiceId]
  );
  return res.rowCount > 0;
}

// True if clinicianId is an active user within this practice.
async function clinicianInPractice(practiceId, clinicianId) {
  const res = await db.query(
    `select 1 from users where id = $1 and practice_id = $2 and is_active = true limit 1`,
    [clinicianId, practiceId]
  );
  return res.rowCount > 0;
}

// --- handlers ----------------------------------------------------------------

async function createSession(practiceId, body, event) {
  const clientId = cleanText(body.client_id);
  const clinicianId = cleanText(body.clinician_id);
  const sessionDate = cleanText(body.session_date);

  const missing = [];
  if (!clientId) missing.push('client_id');
  if (!clinicianId) missing.push('clinician_id');
  if (!sessionDate) missing.push('session_date');
  if (missing.length) {
    return json(400, { error: `Missing required fields: ${missing.join(', ')}` }, event);
  }

  if (!isUUID(clientId)) {
    return json(400, { error: 'Invalid client_id.' }, event);
  }
  if (!isUUID(clinicianId)) {
    return json(400, { error: 'Invalid clinician_id.' }, event);
  }
  if (!isValidDate(sessionDate)) {
    return json(400, { error: 'Invalid session_date. Expected YYYY-MM-DD.' }, event);
  }
  if (!(await clientInPractice(practiceId, clientId))) {
    return json(400, { error: 'client_id is not a client in this practice.' }, event);
  }
  if (!(await clinicianInPractice(practiceId, clinicianId))) {
    return json(400, { error: 'clinician_id is not a clinician in this practice.' }, event);
  }

  const duration = parseDuration(body.duration_minutes);
  if (!duration.ok) {
    return json(400, { error: 'Invalid duration_minutes. Expected an integer >= 1.' }, event);
  }
  const fee = parseMoney(body.fee);
  if (!fee.ok) {
    return json(400, { error: 'Invalid fee. Expected a number >= 0.' }, event);
  }
  const dx = parseDiagnosisCodes(body.diagnosis_codes);
  if (!dx.ok) {
    return json(400, { error: 'Invalid diagnosis_codes. Expected an array of up to 12 non-empty strings.' }, event);
  }
  const status = parseStatus(body.status);
  if (!status.ok) {
    return json(400, { error: `Invalid status. Expected one of: ${SESSION_STATUSES.join(', ')}.` }, event);
  }

  const res = await db.query(
    `insert into sessions
       (practice_id, client_id, clinician_id, session_date, duration_minutes,
        cpt_code, diagnosis_codes, place_of_service, fee, notes, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11, 'scheduled'))
     returning *`,
    [
      practiceId,
      clientId,
      clinicianId,
      sessionDate,
      duration.value,
      cleanText(body.cpt_code),
      dx.value,
      cleanText(body.place_of_service),
      fee.value,
      cleanText(body.notes),
      status.value,
    ]
  );

  return json(201, { session: shapeSession(res.rows[0]) }, event);
}

async function listSessions(practiceId, event) {
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

  const clinicianId = queryParam(event, 'clinician_id');
  if (clinicianId != null && clinicianId !== '') {
    if (!isUUID(clinicianId)) {
      return json(400, { error: 'Invalid clinician_id.' }, event);
    }
    params.push(clinicianId);
    where += ` and clinician_id = $${params.length}`;
  }

  const status = queryParam(event, 'status');
  if (status != null && status !== '') {
    if (!SESSION_STATUSES.includes(status)) {
      return json(400, { error: `Invalid status. Expected one of: ${SESSION_STATUSES.join(', ')}.` }, event);
    }
    params.push(status);
    where += ` and status = $${params.length}`;
  }

  const res = await db.query(
    `select * from sessions
      where ${where}
      order by session_date desc, created_at desc`,
    params
  );
  return json(200, { sessions: res.rows.map(shapeSession) }, event);
}

async function getSession(practiceId, id, event) {
  if (!isUUID(id)) {
    return json(404, { error: 'Not found' }, event);
  }
  const res = await db.query(
    `select * from sessions
      where id = $1 and practice_id = $2 and is_hidden = false
      limit 1`,
    [id, practiceId]
  );
  if (res.rowCount === 0) {
    return json(404, { error: 'Not found' }, event);
  }
  return json(200, { session: shapeSession(res.rows[0]) }, event);
}

async function updateSession(practiceId, id, body, event) {
  if (!isUUID(id)) {
    return json(404, { error: 'Not found' }, event);
  }

  // client_id is immutable — a session stays attached to its original client.
  if ('client_id' in body) {
    return json(400, { error: 'client_id cannot be changed.' }, event);
  }

  const sets = [];
  const params = [];
  const add = (col, val) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };

  // clinician_id may be reassigned, but only to a clinician in this practice.
  if ('clinician_id' in body) {
    const clinicianId = cleanText(body.clinician_id);
    if (!clinicianId || !isUUID(clinicianId)) {
      return json(400, { error: 'Invalid clinician_id.' }, event);
    }
    if (!(await clinicianInPractice(practiceId, clinicianId))) {
      return json(400, { error: 'clinician_id is not a clinician in this practice.' }, event);
    }
    add('clinician_id', clinicianId);
  }

  if ('session_date' in body) {
    const sessionDate = cleanText(body.session_date);
    if (!sessionDate || !isValidDate(sessionDate)) {
      return json(400, { error: 'Invalid session_date. Expected YYYY-MM-DD.' }, event);
    }
    add('session_date', sessionDate);
  }

  if ('duration_minutes' in body) {
    const duration = parseDuration(body.duration_minutes);
    if (!duration.ok) {
      return json(400, { error: 'Invalid duration_minutes. Expected an integer >= 1.' }, event);
    }
    add('duration_minutes', duration.value);
  }

  for (const col of ['cpt_code', 'place_of_service', 'notes']) {
    if (col in body) add(col, cleanText(body[col]));
  }

  if ('diagnosis_codes' in body) {
    const dx = parseDiagnosisCodes(body.diagnosis_codes);
    if (!dx.ok) {
      return json(400, { error: 'Invalid diagnosis_codes. Expected an array of up to 12 non-empty strings.' }, event);
    }
    add('diagnosis_codes', dx.value);
  }

  if ('fee' in body) {
    const fee = parseMoney(body.fee);
    if (!fee.ok) {
      return json(400, { error: 'Invalid fee. Expected a number >= 0.' }, event);
    }
    add('fee', fee.value);
  }

  if ('status' in body) {
    const status = parseStatus(body.status);
    if (!status.ok || status.value == null) {
      return json(400, { error: `Invalid status. Expected one of: ${SESSION_STATUSES.join(', ')}.` }, event);
    }
    add('status', status.value);
  }

  if (sets.length === 0) {
    return json(400, { error: 'No updatable fields provided.' }, event);
  }

  // Scope the UPDATE to this practice and exclude hidden rows so a deleted
  // session reads as 404. updated_at is maintained by the table trigger.
  params.push(id);
  const idParam = `$${params.length}`;
  params.push(practiceId);
  const practiceParam = `$${params.length}`;

  const res = await db.query(
    `update sessions set ${sets.join(', ')}
      where id = ${idParam} and practice_id = ${practiceParam} and is_hidden = false
      returning *`,
    params
  );
  if (res.rowCount === 0) {
    return json(404, { error: 'Not found' }, event);
  }
  return json(200, { session: shapeSession(res.rows[0]) }, event);
}

async function deleteSession(practiceId, id, event) {
  if (!isUUID(id)) {
    return json(404, { error: 'Not found' }, event);
  }
  // Soft-delete only — never hard-delete a billing record tied to PHI.
  const res = await db.query(
    `update sessions set is_hidden = true
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

    if (method === 'POST' && !id) return await createSession(practiceId, body, event);
    if (method === 'GET' && !id) return await listSessions(practiceId, event);
    if (method === 'GET' && id) return await getSession(practiceId, id, event);
    if (method === 'PATCH' && id) return await updateSession(practiceId, id, body, event);
    if (method === 'DELETE' && id) return await deleteSession(practiceId, id, event);

    return json(405, { error: 'Method not allowed' }, event);
  } catch (err) {
    // Never log PHI/billing detail — generic only.
    console.error('sessions error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
