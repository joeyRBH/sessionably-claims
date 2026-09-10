'use strict';

// INTEGRATION — the real handlers, a real PostgreSQL, real constraints.
//
// WHY THIS EXISTS, AND WHAT IT REPLACES
//
// The consuming side (Sessionably) previously verified its claim-creation path
// against a permissive local stand-in that accepted whatever payload it was
// sent. That stand-in proved nothing about THIS product: `POST /claims`
// requires `session_id`, and the payload being sent — client_id, service_date,
// cpt_code, charge_amount, diagnosis_code — is rejected outright.
//
// So this file drives the ACTUAL handlers against an ACTUAL database. What is
// stubbed is only the outside world: the clearinghouse, Stripe and Twilio.
// Nothing about the contract under test is faked.
//
//   DATABASE_URL=postgres://... node backend/tests/partner_session_to_claim.integration.test.js
//
// Skips (exit 0) when no database is configured, so `npm test` stays runnable
// without one.

const assert = require('node:assert');
const path = require('node:path');
const { Client } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!ADMIN_URL) {
    console.log('partner_session_to_claim.integration.test.js: SKIPPED (no DATABASE_URL)');
    process.exit(0);
}

const SCRATCH = `rdb_int_${Date.now()}_${process.pid}`;
const scratchUrl = (base, name) => { const u = new URL(base); u.pathname = `/${name}`; return u.toString(); };

// --- stub ONLY the outside world --------------------------------------------
function stub(rel, exports) {
    const resolved = require.resolve(path.join(__dirname, '..', rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
// The clearinghouse: submitting must not reach Stedi.
try { stub('lib/clearinghouse/stedi.js', {
    submitClaim: async () => ({ ok: true, control_number: 'TEST-CTRL-1', acknowledgment: null }),
}); } catch (_) { /* path differs; submission is not exercised here */ }
// Email/SMS must not leave the machine.
try { stub('lib/email.js', { sendEmail: async () => ({ ok: true }) }); } catch (_) {}

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log(`  ok   ${name}`); }
    catch (err) { failed++; console.log(`  FAIL ${name}`); console.log(`       ${err && err.message}`); }
}

(async () => {
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
    await admin.query(`CREATE DATABASE ${SCRATCH}`);
    await admin.end();

    const url = scratchUrl(ADMIN_URL, SCRATCH);
    process.env.DATABASE_URL = url;
    process.env.PGSSLMODE = 'disable';
    process.env.JWT_SECRET = 'integration-test-not-production';

    const db = require(path.join(__dirname, '..', 'lib', 'db.js'));
    const partnerAuth = require(path.join(__dirname, '..', 'lib', 'partner_auth.js'));
    const sessions = require(path.join(__dirname, '..', 'handlers', 'sessions.js'));
    const claims = require(path.join(__dirname, '..', 'handlers', 'claims.js'));

    let exitCode = 0;
    const raw = new Client({ connectionString: url });
    await raw.connect();

    try {
        // The real schema, then the real migrations this work adds.
        const fs = require('node:fs');
        const schemaPath = path.join(__dirname, '..', '..', 'db', 'schema.sql');
        await raw.query(fs.readFileSync(schemaPath, 'utf8'));
        for (const m of ['023_partner_credentials.sql', '024_partner_claim_event_attribution.sql',
                         '025_session_external_reference.sql']) {
            const p = path.join(__dirname, '..', '..', 'db', 'migrations', m);
            if (fs.existsSync(p)) await raw.query(fs.readFileSync(p, 'utf8'));
        }

        // --- fictional fixtures ---
        const practice = (await raw.query(
            `insert into practices (name, slug) values ('Cedar Hollow Counseling','cedar-hollow') returning id`
        )).rows[0].id;
        const clinician = (await raw.query(
            `insert into users (practice_id, email, first_name, last_name, role, is_active)
             values ($1,'joe@example.test','Joe','Nolan','clinician',true) returning id`, [practice])).rows[0].id;
        const client = (await raw.query(
            `insert into clients (practice_id, first_name, last_name)
             values ($1,'Jordan','Ellis') returning id`, [practice])).rows[0].id;

        const cred = partnerAuth.generateCredential();
        await raw.query(
            `insert into partner_credentials (practice_id, partner, key_id, secret_hash, scopes)
             values ($1,'sessionably',$2,$3,$4::text[])`,
            [practice, cred.keyId, cred.secretHash,
             ['clients:read', 'sessions:read', 'sessions:write', 'claims:read', 'claims:write', 'claims:submit']]);

        const H = () => ({ Authorization: `Partner ${cred.keyId}.${cred.secret}` });
        const ev = (method, p, body, qs) => ({
            httpMethod: method,
            requestContext: { http: { method, path: p } },
            rawPath: p,
            pathParameters: /\/[0-9a-f-]{36}$/.test(p) ? { id: p.split('/').pop() } : undefined,
            queryStringParameters: qs,
            headers: H(),
            body: body ? JSON.stringify(body) : undefined,
        });
        const parse = (r) => ({ code: r.statusCode, body: JSON.parse(r.body || '{}') });

        /* ---------------------------------------------------------------- */
        console.log('\nthe OLD payload is rejected by the real handler');

        await test('POST /claims with the previous payload -> 400, session_id required', async () => {
            const r = parse(await claims.handler(ev('POST', '/claims', {
                client_id: client, service_date: '2026-09-06',
                cpt_code: '90834', charge_amount: 150, diagnosis_code: 'F41.1',
            })));
            assert.strictEqual(r.code, 400, `expected 400, got ${r.code}: ${JSON.stringify(r.body)}`);
            assert.match(r.body.error, /session_id/i);
        });

        /* ---------------------------------------------------------------- */
        console.log('\nthe CORRECTED path: create a session, complete it, get a draft');

        let sessionId;
        await test('POST /sessions with an external reference creates one', async () => {
            const r = parse(await sessions.handler(ev('POST', '/sessions', {
                client_id: client, clinician_id: clinician, session_date: '2026-09-06',
                cpt_code: '90834', fee: 150, external_source: 'sessionably', external_id: 'appt-4172',
            })));
            assert.strictEqual(r.code, 201, `expected 201, got ${r.code}: ${JSON.stringify(r.body)}`);
            assert.strictEqual(r.body.created, true);
            assert.strictEqual(r.body.session.external_id, 'appt-4172');
            sessionId = r.body.session.id;
        });

        await test('completing the session auto-creates its draft claim', async () => {
            const r = parse(await sessions.handler(ev('PATCH', `/sessions/${sessionId}`, { status: 'completed' })));
            assert.strictEqual(r.code, 200, `got ${r.code}: ${JSON.stringify(r.body)}`);
            const c = await raw.query(`select id, status from claims where session_id = $1`, [sessionId]);
            assert.strictEqual(c.rowCount, 1, `expected exactly 1 claim, found ${c.rowCount}`);
            assert.strictEqual(c.rows[0].status, 'draft');
        });

        await test('the session advanced to claim_ready', async () => {
            const r = await raw.query(`select status from sessions where id = $1`, [sessionId]);
            assert.strictEqual(r.rows[0].status, 'claim_ready');
        });

        /* ---------------------------------------------------------------- */
        console.log('\nidempotency, against the real UNIQUE index');

        await test('re-POSTing the same external id returns the SAME session, creating nothing', async () => {
            const before = await raw.query(`select count(*)::int n from sessions where practice_id = $1`, [practice]);
            const r = parse(await sessions.handler(ev('POST', '/sessions', {
                client_id: client, clinician_id: clinician, session_date: '2026-09-06',
                external_source: 'sessionably', external_id: 'appt-4172',
            })));
            assert.strictEqual(r.code, 200, 'a retry created a new session instead of returning the existing one');
            assert.strictEqual(r.body.created, false);
            assert.strictEqual(r.body.session.id, sessionId);
            const after = await raw.query(`select count(*)::int n from sessions where practice_id = $1`, [practice]);
            assert.strictEqual(after.rows[0].n, before.rows[0].n, 'a duplicate session was created');
        });

        await test('completing TWICE does not produce a second claim', async () => {
            await sessions.handler(ev('PATCH', `/sessions/${sessionId}`, { status: 'completed' }));
            const c = await raw.query(`select count(*)::int n from claims where session_id = $1`, [sessionId]);
            assert.strictEqual(c.rows[0].n, 1, 'a repeated completion doubled the claim');
        });

        await test('the database refuses a duplicate external reference outright', async () => {
            await assert.rejects(
                raw.query(
                    `insert into sessions (practice_id, client_id, clinician_id, session_date, external_source, external_id)
                     values ($1,$2,$3,'2026-09-06','sessionably','appt-4172')`, [practice, client, clinician]),
                /duplicate key|unique/i,
                'the unique index did not hold'
            );
        });

        await test('a DIFFERENT appointment on the same date is a different session', async () => {
            // The case the old date heuristic could never distinguish.
            const r = parse(await sessions.handler(ev('POST', '/sessions', {
                client_id: client, clinician_id: clinician, session_date: '2026-09-06',
                cpt_code: '90834', fee: 150, external_source: 'sessionably', external_id: 'appt-4173',
            })));
            assert.strictEqual(r.code, 201);
            assert.notStrictEqual(r.body.session.id, sessionId);
        });

        /* ---------------------------------------------------------------- */
        console.log('\nrecovery is a deterministic lookup, not a guess');

        await test('GET /sessions?external_id resolves exactly one session', async () => {
            const r = parse(await sessions.handler(ev('GET', '/sessions', null,
                { external_id: 'appt-4172', external_source: 'sessionably' })));
            assert.strictEqual(r.code, 200);
            const rows = r.body.sessions || r.body;
            assert.strictEqual(rows.length, 1, `expected 1, got ${rows.length}`);
            assert.strictEqual(rows[0].id, sessionId);
        });

        await test('an unknown external id resolves to nothing, unambiguously', async () => {
            const r = parse(await sessions.handler(ev('GET', '/sessions', null,
                { external_id: 'appt-does-not-exist' })));
            const rows = r.body.sessions || r.body;
            assert.strictEqual(rows.length, 0);
        });

        /* ---------------------------------------------------------------- */
        console.log('\nscopes are enforced on the real routes');

        await test('sessions:write is required to create a session', async () => {
            await raw.query(`update partner_credentials set scopes = $1::text[] where key_id = $2`,
                [['sessions:read', 'claims:read'], cred.keyId]);
            const r = parse(await sessions.handler(ev('POST', '/sessions', {
                client_id: client, clinician_id: clinician, session_date: '2026-09-07',
                external_source: 'sessionably', external_id: 'appt-9999',
            })));
            assert.strictEqual(r.code, 403, `a read-only credential created a session (${r.code})`);
        });

        await test('sessions:write does NOT confer claims:submit', async () => {
            await raw.query(`update partner_credentials set scopes = $1::text[] where key_id = $2`,
                [['sessions:read', 'sessions:write', 'claims:read'], cred.keyId]);
            const claim = await raw.query(`select id from claims where session_id = $1`, [sessionId]);
            const r = parse(await claims.handler(ev('POST', `/claims/${claim.rows[0].id}/submit`, {})));
            assert.strictEqual(r.code, 403, 'a session-writing credential submitted a claim');
        });

        console.log(`\n${passed} passed, ${failed} failed`);
        if (failed > 0) exitCode = 1;
        else console.log('partner_session_to_claim.integration.test.js: OK');
    } catch (err) {
        console.error('  harness error:', err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : err);
        exitCode = 1;
    } finally {
        await raw.end().catch(() => {});

        // CLOSE THE HANDLER'S OWN POOL, not a method it does not have.
        //
        // This used to read `if (db && typeof db.end === 'function') await db.end()`.
        // backend/lib/db.js exports { getPool, query, withTransaction } and has no
        // `end`, so that branch never ran and the module-scope Pool stayed open.
        // pg_terminate_backend below then killed its backend, the orphaned pool
        // emitted an unhandled 'error' ("terminating connection due to
        // administrator command"), and node died before `process.exit(exitCode)`.
        //
        // The visible effect was a test that printed "12 passed, 0 failed" and
        // then exited 1 — so the whole suite went red for anyone with a
        // DATABASE_URL set, while staying green in CI where this file skips.
        try {
            if (db && typeof db.getPool === 'function') {
                const pool = db.getPool();
                // A pool whose backend is terminated mid-teardown emits 'error'.
                // Nothing is left to report by then, so absorb it rather than
                // letting it become an unhandled event.
                pool.on('error', () => {});
                await pool.end();
            }
        } catch (_) { /* the pool may never have been created */ }

        const cleanup = new Client({ connectionString: ADMIN_URL });
        await cleanup.connect();
        await cleanup.query(
            `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
            [SCRATCH]);
        await cleanup.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
        await cleanup.end();
    }
    process.exit(exitCode);
})();
