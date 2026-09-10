#!/usr/bin/env node
'use strict';

// Issue, list and revoke partner credentials. OPERATOR TOOL — run by a human
// with database access, never reachable over HTTP.
//
// WHY THERE IS NO ENDPOINT FOR THIS
//
// A partner credential grants an external system access to a practice's PHI.
// Making that self-service would mean any practice admin could hand Reddably
// data to something else with a button, and the review point where a person
// decides "yes, this practice is in the pilot" would not exist. The same posture
// as Sessionably's practice_entitlements switch, and for the same reason.
//
// USAGE
//
//   node backend/scripts/partner_credential.js issue \
//        --practice <uuid> --scopes claims:read,claims:write --label 'Cedar Hollow pilot'
//
//   node backend/scripts/partner_credential.js list   [--practice <uuid>]
//   node backend/scripts/partner_credential.js revoke --key-id <rdbp_...>
//
// THE SECRET IS PRINTED ONCE
//
// `issue` prints the secret to stdout and it is never recoverable afterwards —
// only its scrypt digest is stored. If it is lost, revoke and issue again.
// Nothing here writes the secret to a file or a log.
//
// DATABASE_URL must be set, exactly as for the migrate Lambda.

const partner = require('../lib/partner_auth');
const db = require('../lib/db');

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const v = process.argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
        throw new Error(`--${name} needs a value`);
    }
    return v;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function issue() {
    const practiceId = arg('practice');
    if (!practiceId || !UUID_RE.test(practiceId)) {
        throw new Error('--practice must be a practice UUID');
    }
    const scopes = partner.assertScopes(
        String(arg('scopes', '')).split(',').map((s) => s.trim()).filter(Boolean)
    );
    const label = arg('label', null);
    const expires = arg('expires', null);   // ISO date, optional

    // The practice must exist. Issuing against a typo'd id would create a
    // credential that authenticates and then scopes every query to nothing,
    // which is a confusing way to fail.
    const p = await db.query(`select id, name from practices where id = $1 limit 1`, [practiceId]);
    if (p.rows.length === 0) throw new Error(`no practice with id ${practiceId}`);

    const c = partner.generateCredential();
    const res = await db.query(
        `insert into partner_credentials
           (practice_id, partner, key_id, secret_hash, scopes, label, expires_at)
         values ($1, 'sessionably', $2, $3, $4::text[], $5, $6)
         returning id, created_at`,
        [practiceId, c.keyId, c.secretHash, scopes, label, expires]
    );

    console.log('');
    console.log('  Partner credential issued');
    console.log('  ------------------------------------------------------------');
    console.log(`  practice     ${p.rows[0].name}  (${practiceId})`);
    console.log(`  scopes       ${scopes.length ? scopes.join(', ') : '(none — authenticates, grants nothing)'}`);
    console.log(`  key id       ${c.keyId}`);
    console.log(`  secret       ${c.secret}`);
    console.log(`  expires      ${expires || 'never'}`);
    console.log(`  row          ${res.rows[0].id}`);
    console.log('  ------------------------------------------------------------');
    console.log('  The secret is shown ONCE and is not stored. Put it straight into');
    console.log('  the consuming system\'s secret manager. If it is lost, revoke this');
    console.log('  credential and issue another.');
    console.log('');
    console.log('  Header format:');
    console.log(`      Authorization: Partner ${c.keyId}.<secret>`);
    console.log('');
}

async function list() {
    const practiceId = arg('practice', null);
    const res = await db.query(
        `select c.key_id, c.partner, c.scopes, c.label, c.created_at, c.last_used_at,
                c.expires_at, c.revoked_at, p.name as practice_name, c.practice_id
           from partner_credentials c
           join practices p on p.id = c.practice_id
          ${practiceId ? 'where c.practice_id = $1' : ''}
          order by c.created_at desc`,
        practiceId ? [practiceId] : []
    );
    if (res.rows.length === 0) {
        console.log('  (no partner credentials)');
        return;
    }
    for (const r of res.rows) {
        const state = r.revoked_at
            ? 'REVOKED'
            : (r.expires_at && new Date(r.expires_at) <= new Date() ? 'EXPIRED' : 'active');
        console.log('');
        console.log(`  ${r.key_id}   [${state}]`);
        console.log(`      practice   ${r.practice_name} (${r.practice_id})`);
        console.log(`      scopes     ${(r.scopes || []).join(', ') || '(none)'}`);
        if (r.label) console.log(`      label      ${r.label}`);
        console.log(`      created    ${r.created_at}`);
        console.log(`      last used  ${r.last_used_at || 'never'}`);
        if (r.expires_at) console.log(`      expires    ${r.expires_at}`);
        if (r.revoked_at) console.log(`      revoked    ${r.revoked_at}`);
    }
    console.log('');
}

// THE OFF SWITCH. Takes effect on the next request — requirePartner() checks
// revoked_at on every call and there is no caching.
async function revoke() {
    const keyId = arg('key-id');
    if (!keyId) throw new Error('--key-id is required');
    const res = await db.query(
        `update partner_credentials
            set revoked_at = coalesce(revoked_at, now())
          where key_id = $1
          returning key_id, revoked_at`,
        [keyId]
    );
    if (res.rows.length === 0) throw new Error(`no credential with key id ${keyId}`);
    console.log(`  revoked ${res.rows[0].key_id} at ${res.rows[0].revoked_at}`);
    console.log('  Takes effect on the next request; nothing is cached.');
}

(async () => {
    const cmd = process.argv[2];
    try {
        if (cmd === 'issue') await issue();
        else if (cmd === 'list') await list();
        else if (cmd === 'revoke') await revoke();
        else {
            console.error('usage: partner_credential.js <issue|list|revoke> [options]');
            console.error('       see the header of this file for the full form');
            process.exit(2);
        }
        process.exit(0);
    } catch (err) {
        console.error(`  error: ${err.message}`);
        process.exit(1);
    }
})();
