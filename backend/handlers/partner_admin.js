'use strict';

// Operator-invoked partner-credential administration
// (claimsub-<env>-partner-admin).
//
// WHY THIS EXISTS
//
// backend/scripts/partner_credential.js is the implementation, and it reaches
// the database through lib/db — i.e. DATABASE_URL. RDS is
// publicly_accessible = false, the account has no EC2 and nothing registered
// with SSM, and there is no bastion. So an operator's laptop cannot run that
// script against production at all: it is correct code with no way to execute.
//
// This is the same gap that left migration 023 merged-but-unappliable, and it
// gets the same fix — a VPC-attached Lambda that reads DATABASE_URL from SSM at
// runtime. See infra/terraform/apply-migration.tf and backfill.tf; this is the
// third instance of that pattern and the reason it is now a pattern.
//
// This handler deliberately does NOT reimplement credential logic. It calls
// lib/partner_auth's generateCredential() and assertScopes(), so the hashing
// parameters, key format and scope allowlist have exactly one definition.
//
// ============================================================================
// READ-ONLY BY DEFAULT
// ============================================================================
//
//   {}                                    -> summary counts, no PII
//   {"resolve":{"email":"..."}}           -> ONE user's ids, for linking
//   {"list":{"practice_id":"..."}}        -> that practice's credentials
//   {"issue":{"practice_id":"...", ...}}  -> WRITES. Returns the secret ONCE.
//   {"revoke":{"key_id":"..."}}           -> WRITES. The off switch.
//
// Every write mode is named explicitly; there is no flag that turns a read into
// a write, and an unrecognised payload is a summary rather than an error, so a
// typo cannot mutate anything.
//
// ============================================================================
// THE SECRET
// ============================================================================
//
// generateCredential() returns the plaintext exactly once and only its scrypt
// digest is stored. This handler returns that plaintext in the INVOKE RESPONSE
// and never anywhere else:
//
//   * it is never written to a log line — console.log carries the key_id only;
//   * it is never returned by list/resolve/summary;
//   * it is not recoverable afterwards. A lost secret is revoked and reissued.
//
// The intended operator flow pipes the response straight into the consuming
// system's secret manager so the value never reaches a terminal or a file.
//
// ============================================================================
// PII
// ============================================================================
//
// `resolve` takes an email and returns ids for THAT ONE user. It will not list
// a practice's members, and it refuses rather than guessing when the lookup is
// not unique — a credential or a clinician link recorded against the wrong
// identity is a misattributed clinical and financial record. Summary mode
// returns counts only. No patient data is reachable from this handler at all.

const db = require('../lib/db');
const partner = require('../lib/partner_auth');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadDatabaseUrl() {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    const name = process.env.DATABASE_URL_SSM_PARAM;
    if (!name) throw new Error('DATABASE_URL_SSM_PARAM is not set');
    // Required lazily: @aws-sdk/client-ssm ships in the Node 20 Lambda runtime
    // and is deliberately not a package.json dependency.
    const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
    const ssm = new SSMClient({});
    const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    const value = out && out.Parameter && out.Parameter.Value;
    if (!value) throw new Error('DATABASE_URL SSM parameter is empty');
    return value;
}

async function summary() {
    const r = await db.query(`
        select
          (select count(*)::int from practices)                                          as practices,
          (select count(*)::int from partner_credentials where revoked_at is null)        as active_credentials,
          (select count(*)::int from partner_credentials where revoked_at is not null)    as revoked_credentials`);
    return {
        ok: true,
        mode: 'summary',
        counts: r.rows[0],
        known_scopes: partner.SCOPES,
        usage: {
            resolve: '{"resolve":{"email":"someone@example.com"}}',
            list: '{"list":{"practice_id":"<uuid>"}}',
            issue: '{"issue":{"practice_id":"<uuid>","scopes":["clients:read"],"label":"..."}}',
            revoke: '{"revoke":{"key_id":"rdbp_..."}}',
        },
    };
}

/**
 * Resolve ONE user by email. Returns ids only — never a list, never a password
 * hash, never another member's details.
 */
async function resolve(spec) {
    const email = typeof spec.email === 'string' ? spec.email.trim() : '';
    if (!email) return { ok: false, mode: 'resolve', message: 'resolve requires an email' };

    const r = await db.query(
        `select u.id as user_id, u.practice_id, u.role, u.first_name, u.last_name,
                p.name as practice_name
           from users u
           join practices p on p.id = u.practice_id
          where lower(u.email) = lower($1)`,
        [email]
    );
    if (r.rows.length === 0) {
        return { ok: false, mode: 'resolve', message: 'no user with that email' };
    }
    if (r.rows.length > 1) {
        // users.email is UNIQUE, so this is unreachable by construction. If it
        // ever fires, the uniqueness guarantee is gone and nothing downstream
        // should pick a winner.
        return { ok: false, mode: 'resolve', message: 'email is not unique — stop and investigate' };
    }
    const u = r.rows[0];
    return {
        ok: true,
        mode: 'resolve',
        user_id: u.user_id,
        practice_id: u.practice_id,
        practice_name: u.practice_name,
        role: u.role,
        display_name: `${u.first_name} ${u.last_name}`.trim(),
    };
}

async function list(spec) {
    const practiceId = typeof spec.practice_id === 'string' ? spec.practice_id.trim() : '';
    if (!UUID_RE.test(practiceId)) {
        return { ok: false, mode: 'list', message: 'list requires a practice_id uuid' };
    }
    const r = await db.query(
        `select key_id, scopes, label, created_at, last_used_at, expires_at, revoked_at
           from partner_credentials
          where practice_id = $1
          order by created_at desc`,
        [practiceId]
    );
    // key_id is the PUBLIC half and is safe here; secret_hash is never selected.
    return { ok: true, mode: 'list', practice_id: practiceId, credentials: r.rows };
}

async function issue(spec) {
    const practiceId = typeof spec.practice_id === 'string' ? spec.practice_id.trim() : '';
    if (!UUID_RE.test(practiceId)) {
        return { ok: false, mode: 'issue', message: 'issue requires a practice_id uuid' };
    }

    let scopes;
    try {
        scopes = partner.assertScopes(Array.isArray(spec.scopes) ? spec.scopes : []);
    } catch (err) {
        return { ok: false, mode: 'issue', message: err.message };
    }

    const label = typeof spec.label === 'string' && spec.label.trim() ? spec.label.trim() : null;
    const expires = typeof spec.expires_at === 'string' && spec.expires_at.trim() ? spec.expires_at.trim() : null;

    // Issuing against a typo'd id would mint a credential that authenticates and
    // then scopes every query to a practice that does not exist — a confusing
    // way to fail, and one that leaves a live credential behind.
    const p = await db.query('select id, name from practices where id = $1 limit 1', [practiceId]);
    if (p.rows.length === 0) {
        return { ok: false, mode: 'issue', message: `no practice with id ${practiceId}` };
    }

    // Two live credentials for one practice is almost always a forgotten first
    // one rather than an intent. Refuse by default; `replace: true` revokes the
    // existing ones in the same transaction so there is never a window with two.
    const active = await db.query(
        'select key_id from partner_credentials where practice_id = $1 and revoked_at is null',
        [practiceId]
    );
    if (active.rows.length > 0 && spec.replace !== true) {
        return {
            ok: false,
            mode: 'issue',
            message: `${active.rows.length} active credential(s) already exist for this practice. `
                + 'Re-invoke with "replace": true to revoke them and issue a new one, or revoke explicitly.',
            active_key_ids: active.rows.map((x) => x.key_id),
        };
    }

    const c = partner.generateCredential();

    const client = await db.getPool().connect();
    let row;
    try {
        await client.query('begin');
        if (active.rows.length > 0) {
            await client.query(
                'update partner_credentials set revoked_at = now() where practice_id = $1 and revoked_at is null',
                [practiceId]
            );
        }
        const res = await client.query(
            `insert into partner_credentials
               (practice_id, partner, key_id, secret_hash, scopes, label, expires_at)
             values ($1, 'sessionably', $2, $3, $4::text[], $5, $6)
             returning id, created_at`,
            [practiceId, c.keyId, c.secretHash, scopes, label, expires]
        );
        row = res.rows[0];
        await client.query('commit');
    } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
    } finally {
        client.release();
    }

    // key_id only. The secret never reaches CloudWatch.
    console.log(`partner-admin: issued ${c.keyId} for practice ${practiceId} scopes=[${scopes.join(',')}]`);

    return {
        ok: true,
        mode: 'issue',
        practice_id: practiceId,
        practice_name: p.rows[0].name,
        key_id: c.keyId,
        scopes,
        label,
        expires_at: expires,
        credential_row_id: row.id,
        replaced: active.rows.length,
        // The ONE time this value exists outside the caller's own memory.
        credential: `${c.keyId}.${c.secret}`,
        note: 'The credential is shown once and is not stored. Put it straight into '
            + "the consuming system's secret manager. If lost, revoke and reissue.",
    };
}

async function revoke(spec) {
    const keyId = typeof spec.key_id === 'string' ? spec.key_id.trim() : '';
    if (!keyId) return { ok: false, mode: 'revoke', message: 'revoke requires a key_id' };
    const r = await db.query(
        `update partner_credentials set revoked_at = now()
          where key_id = $1 and revoked_at is null
          returning key_id, practice_id, revoked_at`,
        [keyId]
    );
    if (r.rows.length === 0) {
        return { ok: true, mode: 'revoke', changed: false, message: 'no active credential with that key_id (already revoked, or unknown)' };
    }
    console.log(`partner-admin: revoked ${keyId}`);
    return { ok: true, mode: 'revoke', changed: true, ...r.rows[0] };
}

exports.handler = async (event) => {
    try {
        process.env.DATABASE_URL = await loadDatabaseUrl();
        const payload = (event && typeof event === 'object') ? event : {};

        // Each mode is opted into by name. An unknown or empty payload is a
        // read-only summary, never a write.
        if (payload.resolve && typeof payload.resolve === 'object') return await resolve(payload.resolve);
        if (payload.list && typeof payload.list === 'object') return await list(payload.list);
        if (payload.revoke && typeof payload.revoke === 'object') return await revoke(payload.revoke);
        if (payload.issue && typeof payload.issue === 'object') return await issue(payload.issue);
        return await summary();
    } catch (err) {
        const message = (err && err.message) || 'partner-admin failed.';
        console.error('partner-admin error:', message);
        return { ok: false, message };
    }
};

exports._internals = { UUID_RE, summary, resolve, list, issue, revoke };
