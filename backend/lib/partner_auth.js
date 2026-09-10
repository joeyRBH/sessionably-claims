'use strict';

// Partner (machine-to-machine) authentication — see db/migrations/023.
//
// A partner credential belongs to an INTEGRATION, not to a person. It is bound
// to exactly one practice, carries only the scopes it was granted, and is
// revocable on its own.
//
// THE HEADER IS DELIBERATELY NOT `Bearer`
//
//     Authorization: Partner <key_id>.<secret>
//
// `Bearer` is the human staff JWT (backend/lib/jwt.js). Using a different
// scheme means the two credential types can never be confused in either
// direction, and that property is structural rather than a convention someone
// has to remember:
//
//   * backend/lib/auth.js's requireAuth() matches /^Bearer\s+/ and simply does
//     not see a Partner header — so a partner credential can never satisfy a
//     route that expects a signed-in human, even if that route is later given
//     to a partner by mistake;
//   * requirePartner() below matches /^Partner\s+/ — so a stolen staff JWT
//     cannot be replayed against a partner route.
//
// A single shared scheme would have made both of those a matter of parsing
// order.
//
// WHAT IS COMPARED, AND HOW
//
// The stored digest is scrypt with a per-credential random salt, encoded as
//
//     scrypt$N$r$p$<salt-b64>$<hash-b64>
//
// The parameters are read back OUT of the stored string rather than assumed, so
// a credential issued under older parameters keeps verifying after they are
// raised. Comparison is crypto.timingSafeEqual on equal-length buffers.
//
// NOTHING HERE LOGS THE SECRET. Not on success, not on failure, not in an error
// message. `key_id` is the public half and is safe to log; it is what makes a
// failed request diagnosable without the secret.

const crypto = require('node:crypto');
const db = require('./db');

// Current issuing parameters. Verification does NOT use these — it uses whatever
// is encoded in the row — so raising them here only affects newly issued
// credentials and cannot invalidate existing ones.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

// Every scope the system knows about. A scope not on this list is refused at
// issuing time, so a typo in an operator's command line becomes an error rather
// than a credential that silently grants nothing (or, worse, a scope string that
// some future check spells differently).
const SCOPES = Object.freeze([
    'clients:read',        // resolve and read the linked client (no write)
    'claims:read',         // list/get claims and their events, incl. status
    'claims:write',        // create and amend a draft claim
    'claims:submit',       // the irreversible one: send a claim to the payer
    'payment_link:send',   // send the client the card-setup link
]);

class PartnerAuthError extends Error {
    constructor(statusCode, code, message) {
        super(message || 'Unauthorized');
        this.name = 'PartnerAuthError';
        this.statusCode = statusCode;
        this.code = code;
    }
}

const unauthorized = (code) => new PartnerAuthError(401, code || 'PARTNER_UNAUTHORIZED', 'Unauthorized');
const forbidden = (code) => new PartnerAuthError(403, code || 'PARTNER_FORBIDDEN', 'Forbidden');

// --- hashing -----------------------------------------------------------------

function hashSecret(secret, params) {
    const p = params || { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: crypto.randomBytes(SALT_LEN) };
    // maxmem must be raised for N=16384,r=8: the default 32MB is not enough and
    // scrypt throws rather than silently weakening.
    const hash = crypto.scryptSync(secret, p.salt, KEY_LEN, {
        N: p.N, r: p.r, p: p.p, maxmem: 64 * 1024 * 1024,
    });
    return `scrypt$${p.N}$${p.r}$${p.p}$${p.salt.toString('base64')}$${hash.toString('base64')}`;
}

// Parse a stored digest back into its parameters. Returns null for anything
// malformed — which verify() treats as a failed match, never as a pass.
function parseDigest(stored) {
    if (typeof stored !== 'string') return null;
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
    const N = Number.parseInt(parts[1], 10);
    const r = Number.parseInt(parts[2], 10);
    const p = Number.parseInt(parts[3], 10);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
    // Bound the work an attacker-supplied row could ask for. These are our own
    // rows, but a digest is still parsed input.
    if (N < 1024 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return null;
    let salt; let hash;
    try {
        salt = Buffer.from(parts[4], 'base64');
        hash = Buffer.from(parts[5], 'base64');
    } catch (_) { return null; }
    if (salt.length === 0 || hash.length === 0) return null;
    return { N, r, p, salt, hash };
}

function verifySecret(secret, stored) {
    const parsed = parseDigest(stored);
    if (!parsed) return false;
    let candidate;
    try {
        candidate = crypto.scryptSync(secret, parsed.salt, parsed.hash.length, {
            N: parsed.N, r: parsed.r, p: parsed.p, maxmem: 64 * 1024 * 1024,
        });
    } catch (_) {
        return false;
    }
    if (candidate.length !== parsed.hash.length) return false;
    return crypto.timingSafeEqual(candidate, parsed.hash);
}

// --- issuing (operator script only; no HTTP path) ----------------------------

// Generate a credential pair. The secret is returned ONCE and never stored.
// key_id is prefixed so it is recognisable in a log or a config file, and so a
// leaked string can be identified as a Reddably partner key at a glance.
function generateCredential() {
    const keyId = 'rdbp_' + crypto.randomBytes(9).toString('base64url');
    const secret = crypto.randomBytes(32).toString('base64url');
    return { keyId, secret, secretHash: hashSecret(secret) };
}

function assertScopes(scopes) {
    if (!Array.isArray(scopes)) throw new Error('scopes must be an array');
    const bad = scopes.filter((s) => !SCOPES.includes(s));
    if (bad.length > 0) {
        throw new Error(`unknown scope(s): ${bad.join(', ')} — known scopes are ${SCOPES.join(', ')}`);
    }
    return scopes;
}

// --- request authentication --------------------------------------------------

function extractPartnerHeader(event) {
    const headers = (event && event.headers) || {};
    // API Gateway does not guarantee header casing.
    const raw = headers.authorization || headers.Authorization;
    if (!raw) return null;
    const m = /^Partner\s+(.+)$/i.exec(String(raw).trim());
    if (!m) return null;
    const value = m[1].trim();
    // key_id.secret — split on the FIRST dot only; the secret is base64url and
    // contains no dot, but splitting greedily would be a silent truncation bug
    // if that ever changed.
    const dot = value.indexOf('.');
    if (dot <= 0 || dot === value.length - 1) return null;
    return { keyId: value.slice(0, dot), secret: value.slice(dot + 1) };
}

// True when the request carries a Partner header at all — used by routes that
// accept EITHER a human or a partner, to pick which verifier to run.
function isPartnerRequest(event) {
    return extractPartnerHeader(event) !== null;
}

/**
 * Authenticate a partner request and return its principal.
 *
 * @param {object} event    API Gateway event
 * @param {string} [scope]  a scope from SCOPES that this operation requires
 * @returns {Promise<{actorType:'partner', credentialId:string, practiceId:string,
 *                    partner:string, keyId:string, scopes:string[]}>}
 * @throws {PartnerAuthError} 401 for missing/unknown/revoked/expired/bad-secret,
 *                            403 when authenticated but not granted `scope`.
 *
 * The practice id comes from the credential ROW. It is never read from the
 * request, so a partner cannot act for a practice it was not issued for.
 */
async function requirePartner(event, scope) {
    const presented = extractPartnerHeader(event);
    if (!presented) throw unauthorized('PARTNER_CREDENTIAL_MISSING');

    const res = await db.query(
        `select id, practice_id, partner, key_id, secret_hash, scopes, expires_at, revoked_at
           from partner_credentials
          where key_id = $1
          limit 1`,
        [presented.keyId]
    );
    const row = res.rows[0];

    // An unknown key_id and a wrong secret are the SAME answer to the caller, so
    // the endpoint is not an oracle for which keys exist. The unknown-key branch
    // still runs a hash of a dummy value so the two paths cost roughly the same
    // and a timing difference does not reintroduce the oracle.
    if (!row) {
        verifySecret(presented.secret, hashSecret('no-such-credential'));
        throw unauthorized('PARTNER_CREDENTIAL_INVALID');
    }
    if (row.revoked_at) throw unauthorized('PARTNER_CREDENTIAL_REVOKED');
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
        throw unauthorized('PARTNER_CREDENTIAL_EXPIRED');
    }
    if (!verifySecret(presented.secret, row.secret_hash)) {
        throw unauthorized('PARTNER_CREDENTIAL_INVALID');
    }

    const scopes = Array.isArray(row.scopes) ? row.scopes : [];
    if (scope && !scopes.includes(scope)) {
        // 403, not 401: the credential is good, it simply may not do this. A 401
        // would tell an integration to go and re-authenticate, which would not
        // help and would hide a real permission problem.
        throw forbidden('PARTNER_SCOPE_REQUIRED');
    }

    // Best-effort freshness marker for spotting a stale or leaked key. Never
    // allowed to fail the request it is recording — same policy as audit().
    db.query(`update partner_credentials set last_used_at = now() where id = $1`, [row.id])
        .catch(() => {});

    return {
        actorType: 'partner',
        credentialId: row.id,
        practiceId: row.practice_id,
        partner: row.partner,
        keyId: row.key_id,
        scopes,
    };
}

module.exports = {
    SCOPES,
    PartnerAuthError,
    hashSecret,
    verifySecret,
    parseDigest,
    generateCredential,
    assertScopes,
    extractPartnerHeader,
    isPartnerRequest,
    requirePartner,
};
