'use strict';

// Claims resource — one Lambda for the whole resource, routed internally by HTTP
// method, the presence of an {id} path parameter, and (for actions) the trailing
// path segment read from the HTTP API v2 routeKey:
//
//   POST   /claims                 → create a draft claim from a session
//   GET    /claims                 → list the practice's claims (excludes hidden);
//                                    optional ?session_id, ?client_id, ?status
//   GET    /claims/{id}            → one claim, practice-scoped
//   PATCH  /claims/{id}            → edit a DRAFT claim's billable fields
//   DELETE /claims/{id}            → soft-delete (draft/void only)
//   POST   /claims/{id}/submit     → submit via the clearinghouse adapter
//   POST   /claims/{id}/refresh    → poll the clearinghouse for status + amounts
//   POST   /claims/{id}/void       → mark the claim void
//   GET    /claims/{id}/events     → the claim's status-history (claim_events)
//
// Security: practice_id is ALWAYS derived from the authenticated user, never from
// the body or token. Every query is filtered by practice_id; cross-practice / not
// found returns 404 (never 403). Claims and events carry PHI-adjacent billing data,
// so error logs stay generic. Soft-delete via is_hidden; never hard-delete.

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const { parseBody } = require('../lib/util');
const { getClearinghouse } = require('../lib/clearinghouse');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CLAIM_STATUSES = [
  'draft', 'submitted', 'processing', 'info_requested',
  'denied', 'appealed', 'paid', 'void',
];

// claim_events.event_type enum (distinct from claim status). Used when logging.
function eventTypeForStatus(status) {
  switch (status) {
    case 'submitted': return 'submitted';
    case 'processing': return 'processing';
    case 'info_requested': return 'info_requested';
    case 'denied': return 'denied';
    case 'appealed': return 'appealed';
    case 'paid': return 'paid';
    case 'void': return 'voided';
    default: return 'note';
  }
}

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

// Trailing action segment for /claims/{id}/<action> routes, or null. Reads the v2
// routeKey template (stable, value-independent), falling back to the request path.
function subAction(event) {
  const rk = (event && event.requestContext && event.requestContext.routeKey) || '';
  let m = rk.match(/\/claims\/\{id\}\/([a-z]+)$/i);
  if (m) return m[1].toLowerCase();
  const path =
    (event && event.requestContext && event.requestContext.http && event.requestContext.http.path) ||
    (event && event.rawPath) || '';
  m = path.match(/\/claims\/[^/]+\/([a-z]+)\/?$/i);
  return m ? m[1].toLowerCase() : null;
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

// Optional money: absent/blank → null; otherwise finite number >= 0.
function parseMoney(v) {
  if (v == null || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

// --- shaping -----------------------------------------------------------------

function shapeClaim(r) {
  if (!r) return null;
  return {
    id: r.id,
    practice_id: r.practice_id,
    session_id: r.session_id,
    client_id: r.client_id,
    clinician_id: r.clinician_id,
    insurance_record_id: r.insurance_record_id,
    claim_number: r.claim_number,
    control_number: r.control_number,
    clearinghouse: r.clearinghouse,
    status: r.status,
    billed_amount: r.billed_amount,
    allowed_amount: r.allowed_amount,
    reimbursed_amount: r.reimbursed_amount,
    patient_responsibility: r.patient_responsibility,
    denial_reason: r.denial_reason,
    submitted_at: r.submitted_at,
    is_hidden: r.is_hidden,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function shapeEvent(r) {
  if (!r) return null;
  return {
    id: r.id,
    claim_id: r.claim_id,
    event_type: r.event_type,
    status_from: r.status_from,
    status_to: r.status_to,
    note: r.note,
    created_by: r.created_by,
    created_at: r.created_at,
  };
}

// --- practice scoping + lookups ---------------------------------------------

async function loadPracticeId(userId) {
  const res = await db.query(
    `select practice_id from users where id = $1 and is_active = true limit 1`,
    [userId]
  );
  return res.rows[0] ? res.rows[0].practice_id : null;
}

async function loadSession(practiceId, sessionId) {
  const res = await db.query(
    `select * from sessions where id = $1 and practice_id = $2 and is_hidden = false limit 1`,
    [sessionId, practiceId]
  );
  return res.rows[0] || null;
}

async function loadInsuranceRecord(practiceId, recordId) {
  const res = await db.query(
    `select * from insurance_records
      where id = $1 and practice_id = $2 and is_hidden = false limit 1`,
    [recordId, practiceId]
  );
  return res.rows[0] || null;
}

// The client's primary non-hidden insurance record, if any.
async function primaryInsuranceForClient(practiceId, clientId) {
  const res = await db.query(
    `select * from insurance_records
      where practice_id = $1 and client_id = $2 and is_hidden = false
      order by is_primary desc, created_at asc
      limit 1`,
    [practiceId, clientId]
  );
  return res.rows[0] || null;
}

async function loadClaim(practiceId, id) {
  const res = await db.query(
    `select * from claims where id = $1 and practice_id = $2 and is_hidden = false limit 1`,
    [id, practiceId]
  );
  return res.rows[0] || null;
}

// Insert a claim_events row. `q` is a pg client (inside a transaction) or db.
async function logEvent(q, e) {
  await q.query(
    `insert into claim_events
       (practice_id, claim_id, created_by, event_type, status_from, status_to, note, payload)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      e.practiceId,
      e.claimId,
      e.createdBy || null,
      e.eventType,
      e.statusFrom || null,
      e.statusTo || null,
      e.note || null,
      e.payload != null ? JSON.stringify(e.payload) : null,
    ]
  );
}

// Assemble the normalized context an adapter needs (no DB access in adapters).
async function buildClaimContext(practiceId, claim) {
  const [sessionRes, clientRes, clinicianRes, practiceRes] = await Promise.all([
    db.query(`select * from sessions where id = $1 and practice_id = $2 limit 1`, [claim.session_id, practiceId]),
    db.query(`select * from clients where id = $1 and practice_id = $2 limit 1`, [claim.client_id, practiceId]),
    db.query(`select * from users where id = $1 and practice_id = $2 limit 1`, [claim.clinician_id, practiceId]),
    db.query(`select * from practices where id = $1 limit 1`, [practiceId]),
  ]);
  let insurance = null;
  if (claim.insurance_record_id) {
    insurance = await loadInsuranceRecord(practiceId, claim.insurance_record_id);
  }
  return {
    claim,
    session: sessionRes.rows[0] || null,
    client: clientRes.rows[0] || null,
    clinician: clinicianRes.rows[0] || null,
    practice: practiceRes.rows[0] || null,
    insurance,
    payer_id: null, // not modeled yet; the Claim.MD adapter flags this
  };
}

// --- handlers ----------------------------------------------------------------

async function createClaim(practiceId, userId, body, event) {
  const sessionId = cleanText(body.session_id);
  if (!sessionId) {
    return json(400, { error: 'Missing required fields: session_id' }, event);
  }
  if (!isUUID(sessionId)) {
    return json(400, { error: 'Invalid session_id.' }, event);
  }
  const session = await loadSession(practiceId, sessionId);
  if (!session) {
    return json(400, { error: 'session_id is not a session in this practice.' }, event);
  }

  // Optional explicit insurance record, else auto-pick the client's primary.
  let insuranceRecordId = null;
  if ('insurance_record_id' in body && body.insurance_record_id != null && body.insurance_record_id !== '') {
    const rid = cleanText(body.insurance_record_id);
    if (!isUUID(rid)) {
      return json(400, { error: 'Invalid insurance_record_id.' }, event);
    }
    const rec = await loadInsuranceRecord(practiceId, rid);
    if (!rec || rec.client_id !== session.client_id) {
      return json(400, { error: 'insurance_record_id is not an insurance record for this client.' }, event);
    }
    insuranceRecordId = rec.id;
  } else {
    const primary = await primaryInsuranceForClient(practiceId, session.client_id);
    insuranceRecordId = primary ? primary.id : null;
  }

  const billed = parseMoney(body.billed_amount);
  if (!billed.ok) {
    return json(400, { error: 'Invalid billed_amount. Expected a number >= 0.' }, event);
  }
  const billedAmount = billed.value != null ? billed.value : session.fee;

  const result = await db.withTransaction(async (client) => {
    const ins = await client.query(
      `insert into claims
         (practice_id, session_id, client_id, clinician_id, insurance_record_id,
          claim_number, status, billed_amount)
       values ($1, $2, $3, $4, $5, $6, 'draft', $7)
       returning *`,
      [
        practiceId,
        session.id,
        session.client_id,
        session.clinician_id,
        insuranceRecordId,
        cleanText(body.claim_number),
        billedAmount,
      ]
    );
    const claim = ins.rows[0];
    await logEvent(client, {
      practiceId,
      claimId: claim.id,
      createdBy: userId,
      eventType: 'created',
      statusTo: 'draft',
      note: 'Claim created from session.',
    });
    return claim;
  });

  return json(201, { claim: shapeClaim(result) }, event);
}

async function listClaims(practiceId, event) {
  const params = [practiceId];
  let where = `practice_id = $1 and is_hidden = false`;

  const sessionId = queryParam(event, 'session_id');
  if (sessionId != null && sessionId !== '') {
    if (!isUUID(sessionId)) return json(400, { error: 'Invalid session_id.' }, event);
    params.push(sessionId);
    where += ` and session_id = $${params.length}`;
  }

  const clientId = queryParam(event, 'client_id');
  if (clientId != null && clientId !== '') {
    if (!isUUID(clientId)) return json(400, { error: 'Invalid client_id.' }, event);
    params.push(clientId);
    where += ` and client_id = $${params.length}`;
  }

  const status = queryParam(event, 'status');
  if (status != null && status !== '') {
    if (!CLAIM_STATUSES.includes(status)) {
      return json(400, { error: `Invalid status. Expected one of: ${CLAIM_STATUSES.join(', ')}.` }, event);
    }
    params.push(status);
    where += ` and status = $${params.length}`;
  }

  const res = await db.query(
    `select * from claims where ${where} order by created_at desc`,
    params
  );
  return json(200, { claims: res.rows.map(shapeClaim) }, event);
}

async function getClaim(practiceId, id, event) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);
  const claim = await loadClaim(practiceId, id);
  if (!claim) return json(404, { error: 'Not found' }, event);
  return json(200, { claim: shapeClaim(claim) }, event);
}

async function updateClaim(practiceId, id, body, event) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);
  const claim = await loadClaim(practiceId, id);
  if (!claim) return json(404, { error: 'Not found' }, event);
  if (claim.status !== 'draft') {
    return json(409, { error: 'Only draft claims can be edited.' }, event);
  }

  // Immutable links — a claim stays bound to its session/client/clinician.
  for (const k of ['session_id', 'client_id', 'clinician_id', 'status', 'control_number']) {
    if (k in body) return json(400, { error: `${k} cannot be changed.` }, event);
  }

  const sets = [];
  const params = [];
  const add = (col, val) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };

  if ('claim_number' in body) add('claim_number', cleanText(body.claim_number));

  if ('billed_amount' in body) {
    const billed = parseMoney(body.billed_amount);
    if (!billed.ok) return json(400, { error: 'Invalid billed_amount. Expected a number >= 0.' }, event);
    add('billed_amount', billed.value);
  }

  if ('insurance_record_id' in body) {
    const rid = cleanText(body.insurance_record_id);
    if (rid == null) {
      add('insurance_record_id', null);
    } else {
      if (!isUUID(rid)) return json(400, { error: 'Invalid insurance_record_id.' }, event);
      const rec = await loadInsuranceRecord(practiceId, rid);
      if (!rec || rec.client_id !== claim.client_id) {
        return json(400, { error: 'insurance_record_id is not an insurance record for this client.' }, event);
      }
      add('insurance_record_id', rec.id);
    }
  }

  if (sets.length === 0) {
    return json(400, { error: 'No updatable fields provided.' }, event);
  }

  params.push(id);
  const idParam = `$${params.length}`;
  params.push(practiceId);
  const practiceParam = `$${params.length}`;

  const res = await db.query(
    `update claims set ${sets.join(', ')}
      where id = ${idParam} and practice_id = ${practiceParam} and is_hidden = false and status = 'draft'
      returning *`,
    params
  );
  if (res.rowCount === 0) return json(404, { error: 'Not found' }, event);
  return json(200, { claim: shapeClaim(res.rows[0]) }, event);
}

async function deleteClaim(practiceId, id, event) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);
  const claim = await loadClaim(practiceId, id);
  if (!claim) return json(404, { error: 'Not found' }, event);
  if (claim.status !== 'draft' && claim.status !== 'void') {
    return json(409, { error: 'Only draft or void claims can be deleted; void the claim first.' }, event);
  }
  const res = await db.query(
    `update claims set is_hidden = true
      where id = $1 and practice_id = $2 and is_hidden = false
      returning id`,
    [id, practiceId]
  );
  if (res.rowCount === 0) return json(404, { error: 'Not found' }, event);
  return json(200, { deleted: true, id: res.rows[0].id }, event);
}

async function submitClaim(practiceId, userId, id, event) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);
  const claim = await loadClaim(practiceId, id);
  if (!claim) return json(404, { error: 'Not found' }, event);
  if (claim.status !== 'draft') {
    return json(409, { error: 'Only draft claims can be submitted.' }, event);
  }
  if (!claim.insurance_record_id) {
    return json(400, { error: 'Attach an insurance record before submitting.' }, event);
  }

  const ctx = await buildClaimContext(practiceId, claim);
  const adapter = getClearinghouse();

  let result;
  try {
    result = await adapter.submitClaim(ctx);
  } catch (err) {
    console.error('claims submit (clearinghouse) error:', err && err.message);
    return json(502, { error: 'Clearinghouse submission failed.' }, event);
  }

  const updated = await db.withTransaction(async (client) => {
    const res = await client.query(
      `update claims
          set status = 'submitted',
              submitted_at = now(),
              control_number = $1,
              claim_number = coalesce(claim_number, $2),
              clearinghouse = $3,
              clearinghouse_payload = $4
        where id = $5 and practice_id = $6 and is_hidden = false and status = 'draft'
        returning *`,
      [
        cleanText(result.control_number),
        cleanText(result.claim_number),
        adapter.name,
        result.raw != null ? JSON.stringify(result.raw) : null,
        id,
        practiceId,
      ]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    await logEvent(client, {
      practiceId,
      claimId: row.id,
      createdBy: userId,
      eventType: 'submitted',
      statusFrom: 'draft',
      statusTo: 'submitted',
      note: `Submitted via ${adapter.name}.`,
      payload: result.raw,
    });
    return row;
  });

  if (!updated) return json(409, { error: 'Claim is no longer in a submittable state.' }, event);
  return json(200, { claim: shapeClaim(updated) }, event);
}

async function refreshClaim(practiceId, userId, id, event) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);
  const claim = await loadClaim(practiceId, id);
  if (!claim) return json(404, { error: 'Not found' }, event);
  if (!claim.control_number) {
    return json(409, { error: 'Claim has not been submitted to a clearinghouse.' }, event);
  }

  const adapter = getClearinghouse();
  let status;
  try {
    status = await adapter.getStatus({ control_number: claim.control_number, claim });
  } catch (err) {
    console.error('claims refresh (clearinghouse) error:', err && err.message);
    return json(502, { error: 'Clearinghouse status check failed.' }, event);
  }

  const newStatus = status && status.status;
  if (!CLAIM_STATUSES.includes(newStatus)) {
    console.error('claims refresh: adapter returned unknown status');
    return json(502, { error: 'Clearinghouse returned an unrecognized status.' }, event);
  }

  // Coalesce optional amounts; ignore anything that isn't a valid money value.
  const amount = (v) => {
    const p = parseMoney(v);
    return p.ok ? p.value : null;
  };

  const updated = await db.withTransaction(async (client) => {
    const res = await client.query(
      `update claims
          set status = $1,
              allowed_amount = coalesce($2, allowed_amount),
              reimbursed_amount = coalesce($3, reimbursed_amount),
              patient_responsibility = coalesce($4, patient_responsibility),
              denial_reason = coalesce($5, denial_reason)
        where id = $6 and practice_id = $7 and is_hidden = false
        returning *`,
      [
        newStatus,
        amount(status.allowed_amount),
        amount(status.reimbursed_amount),
        amount(status.patient_responsibility),
        cleanText(status.denial_reason),
        id,
        practiceId,
      ]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    if (newStatus !== claim.status) {
      await logEvent(client, {
        practiceId,
        claimId: row.id,
        createdBy: userId,
        eventType: eventTypeForStatus(newStatus),
        statusFrom: claim.status,
        statusTo: newStatus,
        note: `Status updated via ${adapter.name}.`,
        payload: status.raw,
      });
    }
    return row;
  });

  if (!updated) return json(404, { error: 'Not found' }, event);
  return json(200, { claim: shapeClaim(updated) }, event);
}

async function voidClaim(practiceId, userId, id, event) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);
  const claim = await loadClaim(practiceId, id);
  if (!claim) return json(404, { error: 'Not found' }, event);
  if (claim.status === 'paid' || claim.status === 'void') {
    return json(409, { error: 'Paid or already-void claims cannot be voided.' }, event);
  }

  // Local state change only. Clearinghouse-side cancellation (Claim.MD /archive/
  // or a void claim upload) is out of scope for this increment.
  const updated = await db.withTransaction(async (client) => {
    const res = await client.query(
      `update claims set status = 'void'
        where id = $1 and practice_id = $2 and is_hidden = false
        returning *`,
      [id, practiceId]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    await logEvent(client, {
      practiceId,
      claimId: row.id,
      createdBy: userId,
      eventType: 'voided',
      statusFrom: claim.status,
      statusTo: 'void',
      note: 'Claim voided.',
    });
    return row;
  });

  if (!updated) return json(404, { error: 'Not found' }, event);
  return json(200, { claim: shapeClaim(updated) }, event);
}

async function listEvents(practiceId, id, event) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);
  const claim = await loadClaim(practiceId, id);
  if (!claim) return json(404, { error: 'Not found' }, event);
  const res = await db.query(
    `select * from claim_events
      where claim_id = $1 and practice_id = $2
      order by created_at asc`,
    [id, practiceId]
  );
  return json(200, { claim_events: res.rows.map(shapeEvent) }, event);
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
    const userId = auth.user.sub;
    const id = pathId(event);
    const action = subAction(event);
    const body = method === 'POST' || method === 'PATCH' ? parseBody(event) : null;

    // Action sub-routes (id always present) take precedence over base CRUD.
    if (action === 'submit' && method === 'POST' && id) return await submitClaim(practiceId, userId, id, event);
    if (action === 'refresh' && method === 'POST' && id) return await refreshClaim(practiceId, userId, id, event);
    if (action === 'void' && method === 'POST' && id) return await voidClaim(practiceId, userId, id, event);
    if (action === 'events' && method === 'GET' && id) return await listEvents(practiceId, id, event);

    if (method === 'POST' && !id) return await createClaim(practiceId, userId, body, event);
    if (method === 'GET' && !id) return await listClaims(practiceId, event);
    if (method === 'GET' && id) return await getClaim(practiceId, id, event);
    if (method === 'PATCH' && id) return await updateClaim(practiceId, id, body, event);
    if (method === 'DELETE' && id) return await deleteClaim(practiceId, id, event);

    return json(405, { error: 'Method not allowed' }, event);
  } catch (err) {
    console.error('claims error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
