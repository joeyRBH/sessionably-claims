'use strict';

// Providers resource — provider billing identity for clean 837P construction.
//
//   POST /providers/verify-npi                    → NPPES lookup (normalized)
//   GET  /providers/{userId}/billing-profile      → the provider's billing profile (masked)
//   PUT  /providers/{userId}/billing-profile      → create/update it, with the
//                                                   entity-type guardrail
//
// verify-npi is auth-only and PHI-free (public registry data). The billing
// profile is practice-scoped: a practice_admin / billing_staff can edit any
// provider in the practice; a clinician can edit only their own row.
//
// The billing TIN (EIN or SSN) is sensitive: stored as AES-256-GCM ciphertext
// (backend/lib/crypto.js) with a display-only masked last-4, never returned raw
// and never logged. The organization EIN is not stored here — it stays on
// practices.tax_id. Audit records field NAMES only (no values).

const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const { parseBody } = require('../lib/util');
const { audit, sanitizeFields } = require('../lib/audit');
const db = require('../lib/db');
const nppes = require('../lib/nppes');
const tin = require('../lib/tin');
const crypto = require('../lib/crypto');

const EDIT_ANY_ROLES = ['practice_admin', 'billing_staff'];

function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

function pathParam(event, name) {
  return event && event.pathParameters ? event.pathParameters[name] : undefined;
}

function rawPath(event) {
  if (!event) return '';
  if (event.rawPath) return event.rawPath;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.path) || event.path || '';
}

// Load the caller's practice scope + role, re-read from the DB (never trust the
// token's practice_id/role). -> { practiceId, role } or null when deactivated.
async function loadScope(userId) {
  const res = await db.query(
    'select practice_id, role from users where id = $1 and is_active = true limit 1',
    [userId]
  );
  const row = res.rows[0];
  return row ? { practiceId: row.practice_id, role: row.role } : null;
}

// -----------------------------------------------------------------------------
// POST /providers/verify-npi
// -----------------------------------------------------------------------------
async function verifyNpiRoute(event) {
  const body = parseBody(event);
  const npi = String(body.npi == null ? '' : body.npi).trim();
  if (!nppes.isValidNpiFormat(npi)) {
    return json(400, { error: 'NPI must be exactly 10 digits.' }, event);
  }

  try {
    const result = await nppes.verifyNpi(npi);
    if (!result.found) {
      return json(
        200,
        {
          found: false,
          npi,
          message: 'No NPPES record found for that NPI. Check the number, or continue with manual entry.',
        },
        event
      );
    }
    return json(
      200,
      {
        found: true,
        npi: result.npi,
        enumerationType: result.enumerationType,
        entityType: result.entityType,
        name: result.name,
        soleProprietor: result.soleProprietor,
        primaryTaxonomy: result.primaryTaxonomy,
        active: result.active,
        checksumValid: nppes.hasValidNpiChecksum(result.npi),
      },
      event
    );
  } catch (err) {
    if (err && err.name === 'NppesUnreachableError') {
      // Outage: retryable, and the client may fall back to manual entry (which
      // stores the record npi_verified=false for follow-up). Never hard-block.
      return json(
        503,
        {
          error: 'NPPES is temporarily unavailable. Try again, or continue with manual entry.',
          retryable: true,
          allow_manual: true,
        },
        event
      );
    }
    if (err && err.code === 'INVALID_NPI') {
      return json(400, { error: err.message }, event);
    }
    console.error('verify-npi error:', err && err.message);
    return json(502, { error: 'Could not verify the NPI right now.' }, event);
  }
}

// -----------------------------------------------------------------------------
// Billing profile shaping (masked — never returns ciphertext or a raw TIN)
// -----------------------------------------------------------------------------
function shapeProfile(row, practice, user) {
  const p = row || {};
  const entityType = p.billing_entity_type || null;
  const shaped = {
    provider_user_id: (user && user.id) || p.provider_user_id || null,
    billing_entity_type: entityType,
    individual_npi: p.individual_npi || (user && user.npi) || null,
    legal_first_name: p.legal_first_name || (user && user.first_name) || null,
    legal_last_name: p.legal_last_name || (user && user.last_name) || null,
    npi_verified: !!p.npi_verified,
    npi_verified_at: p.npi_verified_at || null,
    npi_enumeration_type: p.npi_enumeration_type || null,
    sole_proprietor: p.sole_proprietor == null ? null : !!p.sole_proprietor,
    primary_taxonomy: p.primary_taxonomy_code
      ? {
          code: p.primary_taxonomy_code,
          desc: p.primary_taxonomy_desc || null,
          license: p.primary_taxonomy_license || null,
          state: p.primary_taxonomy_state || null,
        }
      : null,
    rendering_provider_required: !!p.rendering_provider_required,
    // Person billing TIN: masked only. Raw/ciphertext never leave the server.
    billing_tin_type: p.billing_tin_type || null,
    billing_tin_last4: p.billing_tin_last4 || null,
    billing_tin_masked: tin.maskFromLast4(p.billing_tin_last4, p.billing_tin_type),
  };
  // Organization identity for the non-person case is read from the practice
  // (single source of truth); the org EIN is returned masked, not in full.
  if (entityType === 'non_person_entity' && practice) {
    shaped.organization = {
      organization_name: practice.name || null,
      org_npi: practice.npi || null,
      org_npi_verified: !!practice.npi_verified,
      org_npi_enumeration_type: practice.npi_enumeration_type || null,
      org_ein_last4: tin.last4(practice.tax_id),
      org_ein_masked: tin.maskFromLast4(tin.last4(practice.tax_id), 'EIN'),
    };
  }
  return shaped;
}

async function loadTargetUser(userId, practiceId) {
  const res = await db.query('select * from users where id = $1 and practice_id = $2 limit 1', [userId, practiceId]);
  return res.rows[0] || null;
}

async function loadPractice(practiceId) {
  const res = await db.query('select * from practices where id = $1 limit 1', [practiceId]);
  return res.rows[0] || null;
}

async function loadProfile(practiceId, userId) {
  const res = await db.query(
    'select * from provider_billing_profiles where practice_id = $1 and provider_user_id = $2 limit 1',
    [practiceId, userId]
  );
  return res.rows[0] || null;
}

// -----------------------------------------------------------------------------
// GET /providers/{userId}/billing-profile
// -----------------------------------------------------------------------------
async function getProfileRoute(event, scope, callerId, targetUserId) {
  const canEditAny = EDIT_ANY_ROLES.includes(scope.role);
  if (!canEditAny && targetUserId !== callerId) {
    return json(403, { error: 'You can only view your own billing profile.' }, event);
  }
  const user = await loadTargetUser(targetUserId, scope.practiceId);
  if (!user) return json(404, { error: 'Provider not found.' }, event);
  const [practice, profile] = await Promise.all([loadPractice(scope.practiceId), loadProfile(scope.practiceId, targetUserId)]);
  return json(200, { billing_profile: shapeProfile(profile, practice, user) }, event);
}

// Verify an NPI and enforce the entity-type guardrail. Returns
//   { normalized }                              on success
//   { block: <message> }                        on a guardrail conflict / not found
//   { unreachable: true }                       on an NPPES outage
// so the caller can decide whether to honor a manual-entry fallback.
async function verifyForGuardrail(npi, selectedEntity) {
  let result;
  try {
    result = await nppes.verifyNpi(npi);
  } catch (err) {
    if (err && err.name === 'NppesUnreachableError') return { unreachable: true };
    throw err;
  }
  if (!result.found) {
    return { block: 'No NPPES record found for that NPI. Check the number, or continue with manual entry.', notFound: true };
  }
  const guard = nppes.checkEntityTypeGuardrail(selectedEntity, result);
  if (!guard.ok) return { block: guard.message, normalized: result };
  return { normalized: result };
}

// -----------------------------------------------------------------------------
// PUT /providers/{userId}/billing-profile
// -----------------------------------------------------------------------------
async function putProfileRoute(event, scope, callerId, targetUserId) {
  const canEditAny = EDIT_ANY_ROLES.includes(scope.role);
  if (!canEditAny && targetUserId !== callerId) {
    return json(403, { error: 'You can only edit your own billing profile.' }, event);
  }

  const user = await loadTargetUser(targetUserId, scope.practiceId);
  if (!user) return json(404, { error: 'Provider not found.' }, event);
  const practice = await loadPractice(scope.practiceId);
  const existing = (await loadProfile(scope.practiceId, targetUserId)) || null;

  const body = parseBody(event);
  const rawEntity = String(body.billing_entity_type || body.entity_type || '').toLowerCase();
  const entityType =
    rawEntity === 'person' || rawEntity === 'individual'
      ? 'person'
      : rawEntity === 'non_person_entity' || rawEntity === 'organization' || rawEntity === 'org'
      ? 'non_person_entity'
      : null;
  if (!entityType) {
    return json(400, { error: "billing_entity_type must be 'person' or 'non_person_entity'." }, event);
  }
  const allowUnverified = body.allow_unverified === true;

  // --- The individual (Type-1) NPI: billing+rendering (person) or rendering (org).
  const individualNpi = String(body.individual_npi == null ? '' : body.individual_npi).trim();
  if (!nppes.isValidNpiFormat(individualNpi)) {
    return json(400, { error: 'Provider NPI must be exactly 10 digits.' }, event);
  }
  const legalFirst = (body.legal_first_name != null ? String(body.legal_first_name) : user.first_name || '').trim();
  const legalLast = (body.legal_last_name != null ? String(body.legal_last_name) : user.last_name || '').trim();

  // Verify the individual NPI is a person (NPI-1). checkEntityTypeGuardrail with
  // 'person' blocks an NPI-2 here regardless of the profile's overall mode.
  const indiv = await verifyForGuardrail(individualNpi, 'person');
  if (indiv.block && !indiv.notFound) {
    return json(422, { error: indiv.block }, event);
  }
  let indivVerified = false;
  let indivNorm = indiv.normalized || null;
  if (indiv.unreachable || indiv.notFound) {
    if (!allowUnverified) {
      return json(
        503,
        {
          error: indiv.unreachable
            ? 'Could not reach NPPES to verify the provider NPI. Try again, or save with manual entry.'
            : indiv.block,
          retryable: !!indiv.unreachable,
          allow_manual: true,
          field: 'individual_npi',
        },
        event
      );
    }
  } else {
    indivVerified = true;
  }

  // --- Organization path: verify the practice org NPI is Type-2 (the guardrail
  //     that makes billing an individual NPI as an organization impossible).
  let orgWrite = null; // { npi, ein, name, enumerationType } to persist to practices
  if (entityType === 'non_person_entity') {
    const orgNpi = String(body.org_npi != null ? body.org_npi : practice && practice.npi ? practice.npi : '').trim();
    if (!nppes.isValidNpiFormat(orgNpi)) {
      return json(400, { error: "Enter the organization's 10-digit Type-2 NPI (or set it in practice settings)." }, event);
    }
    // Changing shared org identity (NPI / EIN / name) is an admin action.
    const orgEinRaw = body.org_ein != null ? String(body.org_ein).trim() : null;
    const orgName = body.organization_name != null ? String(body.organization_name).trim() : null;
    const changesOrg =
      (body.org_npi != null && orgNpi !== (practice && practice.npi)) ||
      (orgEinRaw != null && orgEinRaw !== '') ||
      (orgName != null && orgName !== '');
    if (changesOrg && !canEditAny) {
      return json(403, { error: 'Only a practice admin can set the organization billing identity.' }, event);
    }

    const org = await verifyForGuardrail(orgNpi, 'organization');
    if (org.block && !org.notFound) {
      return json(422, { error: org.block }, event); // ← test (c): NPI-1 as organization is blocked here
    }
    let orgEnum = org.normalized ? org.normalized.enumerationType : null;
    let orgVerified = !!org.normalized;
    if (org.unreachable || org.notFound) {
      if (!allowUnverified) {
        return json(
          503,
          {
            error: org.unreachable
              ? "Could not reach NPPES to verify the organization NPI. Try again, or save with manual entry."
              : org.block,
            retryable: !!org.unreachable,
            allow_manual: true,
            field: 'org_npi',
          },
          event
        );
      }
      orgVerified = false;
    }

    // Validate the org EIN format when provided (org EIN is always an EIN).
    let orgEinDigits = null;
    if (orgEinRaw) {
      const v = tin.validateEin(orgEinRaw);
      if (!v.valid) return json(422, { error: `Organization EIN: ${v.error}`, field: 'org_ein' }, event);
      orgEinDigits = v.digits;
    }
    orgWrite = { npi: orgNpi, ein: orgEinDigits, name: orgName || null, enumerationType: orgEnum, verified: orgVerified };
  }

  // --- Person path: validate + encrypt the billing TIN. A blank TIN on an edit
  //     keeps the stored one (so re-entry isn't forced every save).
  let tinCipher = null;
  let tinLast4 = null;
  let tinType = null;
  if (entityType === 'person') {
    tinType = String(body.billing_tin_type || '').toUpperCase();
    if (tinType !== 'EIN' && tinType !== 'SSN') {
      return json(400, { error: "billing_tin_type must be 'EIN' or 'SSN'." }, event);
    }
    const provided = body.billing_tin != null && String(body.billing_tin).replace(/\D/g, '') !== '';
    const canReuse = existing && existing.billing_tin_ciphertext && existing.billing_tin_type === tinType;
    if (!provided && canReuse) {
      // Keep the encrypted TIN already on file; only the type must still match.
      tinCipher = existing.billing_tin_ciphertext;
      tinLast4 = existing.billing_tin_last4;
    } else {
      const v = tin.validateTin(body.billing_tin, tinType);
      if (!v.valid) return json(422, { error: v.error, field: 'billing_tin' }, event);
      if (!crypto.isConfigured()) {
        // Fail closed: never store a TIN in the clear.
        console.error('billing-profile save blocked: FIELD_ENCRYPTION_KEY not configured');
        return json(503, { error: 'Secure storage is not configured. Contact support.' }, event);
      }
      tinCipher = crypto.encrypt(v.digits);
      tinLast4 = v.digits.slice(-4);
    }
  }

  // --- Persist (transaction: profile upsert + optional org identity write).
  const renderingRequired = entityType === 'non_person_entity';
  const nowVerified = indivVerified;
  const norm = indivNorm;
  const before = existing || {};

  const saved = await db.withTransaction(async (client) => {
    if (orgWrite) {
      // Persist org identity to the practice (single source of truth). Only
      // overwrite provided fields; always record NPI + its verification.
      await client.query(
        `update practices set
           npi = $2,
           tax_id = coalesce($3, tax_id),
           name = coalesce($4, name),
           npi_verified = $5,
           npi_verified_at = case when $5 then now() else npi_verified_at end,
           npi_enumeration_type = $6
         where id = $1`,
        [scope.practiceId, orgWrite.npi, orgWrite.ein, orgWrite.name, orgWrite.verified, orgWrite.enumerationType]
      );
    }

    const upsert = await client.query(
      `insert into provider_billing_profiles
         (practice_id, provider_user_id, billing_entity_type, individual_npi,
          legal_first_name, legal_last_name,
          billing_tin_ciphertext, billing_tin_last4, billing_tin_type,
          npi_verified, npi_verified_at, npi_enumeration_type, sole_proprietor,
          primary_taxonomy_code, primary_taxonomy_desc, primary_taxonomy_license, primary_taxonomy_state,
          rendering_provider_required)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
               case when $10 then now() else null end,
               $11,$12,$13,$14,$15,$16,$17)
       on conflict (practice_id, provider_user_id) do update set
         billing_entity_type = excluded.billing_entity_type,
         individual_npi = excluded.individual_npi,
         legal_first_name = excluded.legal_first_name,
         legal_last_name = excluded.legal_last_name,
         billing_tin_ciphertext = excluded.billing_tin_ciphertext,
         billing_tin_last4 = excluded.billing_tin_last4,
         billing_tin_type = excluded.billing_tin_type,
         npi_verified = excluded.npi_verified,
         npi_verified_at = excluded.npi_verified_at,
         npi_enumeration_type = excluded.npi_enumeration_type,
         sole_proprietor = excluded.sole_proprietor,
         primary_taxonomy_code = excluded.primary_taxonomy_code,
         primary_taxonomy_desc = excluded.primary_taxonomy_desc,
         primary_taxonomy_license = excluded.primary_taxonomy_license,
         primary_taxonomy_state = excluded.primary_taxonomy_state,
         rendering_provider_required = excluded.rendering_provider_required
       returning *`,
      [
        scope.practiceId,
        targetUserId,
        entityType,
        individualNpi,
        legalFirst || null,
        legalLast || null,
        tinCipher,
        tinLast4,
        tinType,
        nowVerified,
        norm ? norm.enumerationType : null,
        norm ? norm.soleProprietor : null,
        norm && norm.primaryTaxonomy ? norm.primaryTaxonomy.code : null,
        norm && norm.primaryTaxonomy ? norm.primaryTaxonomy.desc : null,
        norm && norm.primaryTaxonomy ? norm.primaryTaxonomy.license : null,
        norm && norm.primaryTaxonomy ? norm.primaryTaxonomy.state : null,
        renderingRequired,
      ]
    );
    return upsert.rows[0];
  });

  // Audit — field NAMES only, never TIN/NPI values.
  const after = {
    billing_entity_type: saved.billing_entity_type,
    individual_npi: saved.individual_npi,
    legal_first_name: saved.legal_first_name,
    legal_last_name: saved.legal_last_name,
    billing_tin_last4: saved.billing_tin_last4,
    billing_tin_type: saved.billing_tin_type,
    npi_verified: saved.npi_verified,
    rendering_provider_required: saved.rendering_provider_required,
  };
  await audit(event, { userId: callerId, practiceId: scope.practiceId }, {
    action: before.id ? 'provider_billing_profile.update' : 'provider_billing_profile.create',
    resourceType: 'provider_billing_profile',
    resourceId: saved.id,
    metadata: { provider_user_id: targetUserId, fields_changed: sanitizeFields(before, after) },
  });
  if (orgWrite) {
    // Compute changed field NAMES via sanitizeFields (never literals) so the
    // no-PHI audit guard stays satisfied and no value is ever recorded.
    const practiceBefore = {
      npi: practice && practice.npi,
      tax_id: practice && practice.tax_id,
      name: practice && practice.name,
      npi_verified: practice && practice.npi_verified,
      npi_enumeration_type: practice && practice.npi_enumeration_type,
    };
    const practiceAfter = {
      npi: orgWrite.npi,
      tax_id: orgWrite.ein != null ? orgWrite.ein : practiceBefore.tax_id,
      name: orgWrite.name != null ? orgWrite.name : practiceBefore.name,
      npi_verified: orgWrite.verified,
      npi_enumeration_type: orgWrite.enumerationType,
    };
    await audit(event, { userId: callerId, practiceId: scope.practiceId }, {
      action: 'practice.update',
      resourceType: 'practice',
      resourceId: scope.practiceId,
      metadata: { fields_changed: sanitizeFields(practiceBefore, practiceAfter) },
    });
  }

  const freshPractice = orgWrite ? await loadPractice(scope.practiceId) : practice;
  return json(200, { billing_profile: shapeProfile(saved, freshPractice, user) }, event);
}

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------
exports.handler = async (event) => {
  const method = httpMethod(event);
  if (method === 'OPTIONS') return preflight(event);

  let auth;
  try {
    auth = requireAuth(event);
  } catch (err) {
    return json(err.statusCode || 401, { error: 'Unauthorized' }, event);
  }
  const callerId = auth.user.sub;

  const targetUserId = pathParam(event, 'userId');
  const path = rawPath(event);

  try {
    // Billing-profile routes carry {userId}.
    if (targetUserId) {
      const scope = await loadScope(callerId);
      if (!scope) return json(401, { error: 'Unauthorized' }, event);
      if (method === 'GET') return await getProfileRoute(event, scope, callerId, targetUserId);
      if (method === 'PUT') return await putProfileRoute(event, scope, callerId, targetUserId);
      return json(405, { error: 'Method not allowed' }, event);
    }
    // verify-npi is the only non-parameterized route.
    if (method === 'POST' && /verify-npi\/?$/.test(path)) {
      return await verifyNpiRoute(event);
    }
    return json(404, { error: 'Not found' }, event);
  } catch (err) {
    // Generic error only — never echo a TIN/NPI or DB detail.
    console.error('providers error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};

// Exposed for unit testing (pure-ish; shapeProfile has no I/O).
exports.shapeProfile = shapeProfile;
