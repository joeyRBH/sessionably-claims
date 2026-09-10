'use strict';

// ONE resolver for "who is asking, and what may they do".
//
// A route that accepts both a signed-in human and a partner integration must
// not decide that twice. This module is the single place the two are turned
// into the same shape, so every downstream check — practice scoping, ownership,
// audit attribution — reads one set of fields and cannot behave differently
// depending on which credential arrived.
//
// ============================================================================
// THE SHAPE
// ============================================================================
//
//   {
//     actorType:    'user' | 'partner',
//     practiceId:   uuid,           // ALWAYS server-derived, never from the request
//     userId:       uuid | null,    // the human, when there is one
//     credentialId: uuid | null,    // the partner credential, when there is one
//     role:         string | null,  // human role; null for a partner
//     scopes:       string[],       // partner scopes; [] for a human
//   }
//
// `practiceId` is the load-bearing field. For a human it comes from
// users.practice_id; for a partner it comes from the credential row. In neither
// case does the request get a say, which is what makes every existing
// practice-scoped query in the handlers correct for partners unchanged.
//
// ============================================================================
// WHY A HUMAN HAS NO SCOPES, AND WHAT THAT MEANS
// ============================================================================
//
// `scopes: []` for a human is not "no permissions" — it is "scopes do not apply
// to this actor". requireScope() below therefore SKIPS the check for a human
// and applies it for a partner. A human's authority is their role, checked the
// way it always has been; a partner has no role and its authority is exactly
// its scope list.
//
// Conflating the two would break in both directions: a human would be refused
// for lacking a scope they can never hold, or a partner would inherit a role's
// authority it was never granted.
//
// ============================================================================
// FAIL CLOSED
// ============================================================================
//
// No credential, an unknown one, a revoked one, a human with no practice — all
// 401. A recognised partner without the scope an action needs is 403, because
// re-authenticating would not help.

const { requireAuth } = require('./auth');
const partnerAuth = require('./partner_auth');
const db = require('./db');

class PrincipalError extends Error {
    constructor(statusCode, code, message) {
        super(message || 'Unauthorized');
        this.name = 'PrincipalError';
        this.statusCode = statusCode;
        this.code = code;
    }
}

async function loadUserPracticeId(userId) {
    const r = await db.query(
        `select practice_id from users where id = $1 and is_active = true limit 1`,
        [userId]
    );
    return r.rows[0] ? r.rows[0].practice_id : null;
}

/**
 * Resolve the caller. Accepts a staff Bearer JWT or a Partner credential.
 *
 * The two schemes are distinguished by the Authorization scheme itself
 * (see backend/lib/partner_auth.js) — they cannot be confused, and this
 * function does not guess.
 */
async function resolvePrincipal(event) {
    if (partnerAuth.isPartnerRequest(event)) {
        let p;
        try {
            p = await partnerAuth.requirePartner(event);   // no scope yet — see requireScope
        } catch (err) {
            throw new PrincipalError(err.statusCode || 401, err.code || 'UNAUTHORIZED');
        }
        return {
            actorType: 'partner',
            practiceId: p.practiceId,
            userId: null,
            credentialId: p.credentialId,
            keyId: p.keyId,
            role: null,
            scopes: p.scopes,
        };
    }

    let auth;
    try {
        auth = requireAuth(event);
    } catch (err) {
        throw new PrincipalError(401, 'UNAUTHORIZED');
    }
    const practiceId = await loadUserPracticeId(auth.user.sub);
    if (!practiceId) throw new PrincipalError(401, 'UNAUTHORIZED');

    return {
        actorType: 'user',
        practiceId,
        userId: auth.user.sub,
        credentialId: null,
        keyId: null,
        role: auth.user.role || null,
        scopes: [],
    };
}

/**
 * Require a scope for THIS action.
 *
 * A human is unaffected — their authority is their role, and scopes are not
 * part of that model. A partner must hold the named scope.
 *
 * Call this per ACTION, not once per route. `POST /claims/{id}/submit` and
 * `GET /claims/{id}` arrive at the same handler and are emphatically not the
 * same permission: one reads, the other files an irreversible claim.
 */
function requireScope(principal, scope) {
    if (!principal) throw new PrincipalError(401, 'UNAUTHORIZED');
    if (principal.actorType !== 'partner') return;
    if (!scope) throw new PrincipalError(403, 'PARTNER_SCOPE_REQUIRED');
    if (!principal.scopes.includes(scope)) {
        throw new PrincipalError(403, 'PARTNER_SCOPE_REQUIRED');
    }
}

/**
 * The authCtx the handlers and audit() already consume, plus partner
 * attribution. Existing named fields keep their meaning, so nothing downstream
 * needs to know a partner exists.
 */
function authContext(principal) {
    return {
        userId: principal.userId,
        practiceId: principal.practiceId,
        role: principal.role,
        actorType: principal.actorType,
        partnerCredentialId: principal.credentialId,
    };
}

/**
 * The three columns a claim_events insert needs (migration 024), derived from
 * the principal so a caller cannot get the combination wrong. The CHECK
 * constraint refuses a row naming both actors or neither; this is the only
 * place that decision is made.
 */
function eventActor(principal) {
    if (!principal || principal.actorType === 'system') {
        return { actorType: 'system', createdBy: null, createdByPartnerCredentialId: null };
    }
    if (principal.actorType === 'partner') {
        return {
            actorType: 'partner',
            createdBy: null,
            createdByPartnerCredentialId: principal.credentialId,
        };
    }
    return {
        actorType: 'user',
        createdBy: principal.userId,
        createdByPartnerCredentialId: null,
    };
}

module.exports = {
    PrincipalError,
    resolvePrincipal,
    requireScope,
    authContext,
    eventActor,
};
