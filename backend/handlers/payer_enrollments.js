'use strict';

// Payer ERA-enrollment resource — one Lambda for the whole resource, routed
// internally by HTTP method and the presence of an {id} path parameter:
//
//   GET  /payer-enrollments            → list the caller's practice's enrollments.
//                                         Non-terminal rows older than 1h are
//                                         refreshed from the clearinghouse first;
//                                         enrollments created outside the app are
//                                         imported. A clearinghouse failure never
//                                         fails the list — it returns stored rows
//                                         with sync_error: true.
//   POST /payer-enrollments            → enroll the practice with a payer for ERA
//                                         (practice_admin only). Lazily creates the
//                                         clearinghouse provider (per practice TIN).
//   POST /payer-enrollments/{id}/sync  → force a single-row status refresh.
//
// Enrollment is per-practice (TIN-level), not per-clinician. Security: practice_id
// is ALWAYS derived from the authenticated user (loaded fresh from the users row),
// never taken from the request body; every query is practice-scoped. No PHI is
// involved (practice/payer trading-partner data only), but error logs stay generic.

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const { parseBody } = require('../lib/util');
const { audit } = require('../lib/audit');
const stedi = require('../lib/clearinghouse/stedi');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSACTION_TYPE = 'claimPayment';

// Terminal enrollment states never need re-syncing (case-insensitive match).
const TERMINAL_STATUSES = new Set(['live', 'canceled', 'cancelled']);

// Refresh a non-terminal row at most this often.
const SYNC_STALE_MS = 60 * 60 * 1000; // 1 hour

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

// The action segment after the id (e.g. "sync"), from the route or the raw path.
function pathAction(event) {
  if (event && event.pathParameters && event.pathParameters.action) {
    return event.pathParameters.action;
  }
  const raw = (event && (event.rawPath || event.path)) || '';
  const m = /\/payer-enrollments\/[^/]+\/([^/?]+)/.exec(raw);
  return m ? m[1] : undefined;
}

function isUUID(v) {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

function cleanText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function isTerminal(status) {
  return TERMINAL_STATUSES.has(String(status == null ? '' : status).trim().toLowerCase());
}

// --- caller / practice context ----------------------------------------------

// The caller's own users row, loaded fresh so a deactivated user (or a role
// change) can't act on a stale token. Carries the contact fields the enrollment
// provider/primary contact needs (name + email).
async function loadCaller(userId) {
  const res = await db.query(
    `select id, practice_id, role, first_name, last_name, email, is_active
       from users where id = $1 limit 1`,
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

// --- shaping -----------------------------------------------------------------

// Shape a payer_enrollments row for the API. The clearinghouse's internal
// enrollment id is intentionally omitted — it carries no user value and keeps the
// vendor invisible. `status` is a lifecycle enum the frontend maps to a badge (it
// never renders the raw value); `status_reason` is passed through scrubVendor()
// client-side before display.
function shapeEnrollment(r) {
  if (!r) return null;
  return {
    id: r.id,
    practice_id: r.practice_id,
    payer_id: r.payer_id,
    payer_name: r.payer_name,
    transaction_type: r.transaction_type,
    status: r.status,
    status_reason: r.status_reason,
    requested_effective_date: r.requested_effective_date,
    last_synced_at: r.last_synced_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// The normalized enrollment contact (business contact, no PHI): the acting admin's
// name + email and the practice's phone + billing address.
function buildContact(caller, practice) {
  return {
    firstName: caller.first_name,
    lastName: caller.last_name,
    email: caller.email,
    phone: practice.phone,
    streetAddress1: practice.address_line1,
    city: practice.city,
    state: practice.state,
    zipCode: practice.postal_code,
  };
}

// Practice-profile fields required before an enrollment can be created. Returns
// the human-readable labels that are missing (empty array = ready).
function missingEnrollmentFields(caller, practice) {
  const missing = [];
  const need = (val, label) => {
    if (val == null || String(val).trim() === '') missing.push(label);
  };
  need(practice.npi, 'NPI');
  need(practice.tax_id, 'Tax ID (EIN)');
  need(practice.address_line1, 'Practice address');
  need(practice.city, 'City');
  need(practice.state, 'State');
  need(practice.postal_code, 'ZIP code');
  need(caller.email, 'Admin email');
  return missing;
}

// --- import (enrollments created outside the app) ----------------------------

// Pull the payer id, status, reason, and enrollment id out of a raw clearinghouse
// enrollment object, tolerating a few field shapes. Returns null when there is no
// usable enrollment id (nothing to key an idempotent import on).
function extractRemoteEnrollment(item) {
  if (!item || typeof item !== 'object') return null;
  const stediId = item.id || item.enrollmentId || null;
  if (!stediId) return null;
  const payer = item.payer || {};
  const payerId = payer.idOrAlias || payer.primaryPayerId || payer.payerId || payer.id || null;
  const payerName = payer.displayName || payer.name || null;
  return {
    stediId: String(stediId),
    payerId: payerId != null ? String(payerId) : null,
    payerName: payerName != null ? String(payerName) : null,
    status: item.status || 'requested',
    reason: item.reason || null,
  };
}

// Import any clearinghouse enrollments not already stored locally. Idempotent on
// stedi_enrollment_id (ON CONFLICT DO NOTHING). Best-effort: the caller wraps this
// so a failure surfaces as sync_error rather than failing the list.
async function importRemoteEnrollments(practiceId, practice) {
  const remote = await stedi.listEnrollments({ npi: practice.npi, taxId: practice.tax_id });
  for (const raw of remote) {
    const e = extractRemoteEnrollment(raw);
    if (!e || !e.payerId) continue;
    // Only import ERA (claimPayment) enrollments — the only type the app manages.
    // When the type is unknown on the remote object, default to claimPayment.
    await db.query(
      `insert into payer_enrollments
         (practice_id, payer_id, payer_name, transaction_type,
          stedi_enrollment_id, status, status_reason, last_synced_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (stedi_enrollment_id) do nothing`,
      [practiceId, e.payerId, e.payerName, TRANSACTION_TYPE, e.stediId, e.status, e.reason]
    );
  }
}

// Refresh one non-terminal row from the clearinghouse. Returns true on success.
async function syncRow(practiceId, row) {
  if (!row.stedi_enrollment_id) return true; // nothing to poll
  const { status, reason } = await stedi.getEnrollmentStatus(row.stedi_enrollment_id);
  await db.query(
    `update payer_enrollments
        set status = coalesce($1, status),
            status_reason = $2,
            last_synced_at = now()
      where id = $3 and practice_id = $4`,
    [status, reason, row.id, practiceId]
  );
  return true;
}

// --- handlers ----------------------------------------------------------------

async function listEnrollments(practiceId, event, authCtx) {
  const practice = await loadPractice(practiceId);
  let syncError = false;

  // Import enrollments created outside the app (idempotent). Only attempt it when
  // the practice can be matched on the clearinghouse side (provider handle, or an
  // NPI + tax id to filter by). Never let a failure fail the list.
  if (practice && (practice.stedi_provider_id || (practice.npi && practice.tax_id))) {
    try {
      await importRemoteEnrollments(practiceId, practice);
    } catch (err) {
      console.error('payer_enrollments import error:', err && err.message);
      syncError = true;
    }
  }

  let res = await db.query(
    `select * from payer_enrollments where practice_id = $1 order by created_at desc`,
    [practiceId]
  );

  // Refresh non-terminal rows whose status is stale (>1h) or never synced.
  const now = Date.now();
  const stale = res.rows.filter((r) => {
    if (isTerminal(r.status)) return false;
    if (!r.last_synced_at) return true;
    return now - new Date(r.last_synced_at).getTime() > SYNC_STALE_MS;
  });
  if (stale.length) {
    for (const row of stale) {
      try {
        await syncRow(practiceId, row);
      } catch (err) {
        console.error('payer_enrollments sync error:', err && err.message);
        syncError = true;
      }
    }
    // Re-read so the response reflects the refreshed statuses.
    res = await db.query(
      `select * from payer_enrollments where practice_id = $1 order by created_at desc`,
      [practiceId]
    );
  }

  await audit(event, authCtx, {
    action: 'payer_enrollment.list',
    resourceType: 'payer_enrollment',
    metadata: { count: res.rowCount },
  });
  return json(200, {
    payer_enrollments: res.rows.map(shapeEnrollment),
    sync_error: syncError,
  }, event);
}

async function createEnrollment(caller, practiceId, body, event, authCtx) {
  if (caller.role !== 'practice_admin') {
    return json(403, { error: 'Only a practice admin can enroll with a payer.' }, event);
  }

  const payerId = cleanText(body.payer_id);
  if (!payerId) {
    return json(400, { error: 'Missing required field: payer_id.' }, event);
  }
  if (payerId.length > 50) {
    return json(400, { error: 'Invalid payer_id.' }, event);
  }
  const payerName = cleanText(body.payer_name);

  // Reject a duplicate up front (also protected by the unique constraint).
  const existing = await db.query(
    `select 1 from payer_enrollments
      where practice_id = $1 and payer_id = $2 and transaction_type = $3
      limit 1`,
    [practiceId, payerId, TRANSACTION_TYPE]
  );
  if (existing.rowCount > 0) {
    return json(409, { error: 'This practice is already enrolled with this payer for ERA.' }, event);
  }

  const practice = await loadPractice(practiceId);
  if (!practice) {
    return json(404, { error: 'Not found' }, event);
  }

  // A complete practice profile is required before the clearinghouse will accept a
  // provider/enrollment — catch it here as a clean 422 listing exactly what to fix.
  const missing = missingEnrollmentFields(caller, practice);
  if (missing.length) {
    return json(422, {
      error: `Your practice profile is missing required information before you can enroll: ${missing.join(', ')}. Add it in Practice Settings, then try again.`,
      missing_fields: missing,
    }, event);
  }

  const contact = buildContact(caller, practice);

  // Lazily create the clearinghouse provider (one per practice TIN) and persist
  // its id on the practice so later enrollments reuse it.
  let providerId;
  try {
    providerId = await stedi.ensureEnrollmentProvider(practice, contact);
  } catch (err) {
    console.error('payer_enrollments provider error:', err && err.message);
    return json(502, { error: 'Could not set up the practice for enrollment. Please try again shortly.' }, event);
  }
  if (providerId && providerId !== practice.stedi_provider_id) {
    await db.query(
      `update practices set stedi_provider_id = $1 where id = $2 and stedi_provider_id is null`,
      [providerId, practiceId]
    );
  }

  let enrollment;
  try {
    enrollment = await stedi.createPayerEnrollment({
      providerId,
      payerIdOrAlias: payerId,
      contact,
      userEmail: caller.email,
    });
  } catch (err) {
    console.error('payer_enrollments create error:', err && err.message);
    return json(502, { error: 'Could not start the enrollment. Please try again shortly.' }, event);
  }

  let inserted;
  try {
    const res = await db.query(
      `insert into payer_enrollments
         (practice_id, payer_id, payer_name, transaction_type,
          stedi_enrollment_id, status, last_synced_at)
       values ($1, $2, $3, $4, $5, $6, now())
       returning *`,
      [practiceId, payerId, payerName, TRANSACTION_TYPE, enrollment.id, enrollment.status || 'requested']
    );
    inserted = res.rows[0];
  } catch (err) {
    // A concurrent request may have inserted the same (practice, payer) or the
    // same enrollment id — treat the unique-violation as an idempotent 409.
    if (err && err.code === '23505') {
      return json(409, { error: 'This practice is already enrolled with this payer for ERA.' }, event);
    }
    throw err;
  }

  await audit(event, authCtx, {
    action: 'payer_enrollment.create',
    resourceType: 'payer_enrollment',
    resourceId: inserted.id,
    metadata: { payer_id: payerId },
  });
  return json(201, { payer_enrollment: shapeEnrollment(inserted) }, event);
}

async function syncEnrollment(practiceId, id, event, authCtx) {
  if (!isUUID(id)) {
    return json(404, { error: 'Not found' }, event);
  }
  const res = await db.query(
    `select * from payer_enrollments where id = $1 and practice_id = $2 limit 1`,
    [id, practiceId]
  );
  if (res.rowCount === 0) {
    return json(404, { error: 'Not found' }, event);
  }

  let syncError = false;
  try {
    await syncRow(practiceId, res.rows[0]);
  } catch (err) {
    console.error('payer_enrollments sync error:', err && err.message);
    syncError = true;
  }

  const after = await db.query(
    `select * from payer_enrollments where id = $1 and practice_id = $2 limit 1`,
    [id, practiceId]
  );
  await audit(event, authCtx, {
    action: 'payer_enrollment.sync',
    resourceType: 'payer_enrollment',
    resourceId: id,
  });
  return json(200, {
    payer_enrollment: shapeEnrollment(after.rows[0]),
    sync_error: syncError,
  }, event);
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
    const practiceId = caller.practice_id;
    const authCtx = { userId: caller.id, practiceId };

    const id = pathId(event);
    const action = pathAction(event);

    if (method === 'GET' && !id) return await listEnrollments(practiceId, event, authCtx);
    if (method === 'POST' && !id) {
      const body = parseBody(event);
      return await createEnrollment(caller, practiceId, body, event, authCtx);
    }
    if (method === 'POST' && id && action === 'sync') {
      return await syncEnrollment(practiceId, id, event, authCtx);
    }

    return json(405, { error: 'Method not allowed' }, event);
  } catch (err) {
    // No PHI here, but keep logs terse and never echo clearinghouse payloads.
    console.error('payer_enrollments error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
