'use strict';

// partner-admin: the operator tool that issues partner credentials.
//
// Two layers, because the interesting properties split cleanly:
//
//   * PURE — payload routing and the read-only default. These need no database
//     and run everywhere, including CI, which has none.
//   * DB-BACKED — issue / replace / revoke and the secret-handling guarantees.
//     Skipped with a printed notice when DATABASE_URL is unset, so the suite
//     stays green in CI while still being runnable for real locally:
//
//       DATABASE_URL=postgres://... DB_SSL=disable node backend/tests/partner_admin.test.js
//
// THE PROPERTY THIS FILE EXISTS FOR: a tool that mints credentials must not be
// able to mutate anything by accident, and must never persist or log the
// plaintext it returns. Both are asserted below rather than assumed.

const assert = require('assert');

let passed = 0;
let failed = 0;
function check(name, fn) {
    try {
        const r = fn();
        if (r && typeof r.then === 'function') return r.then(
            () => { passed++; console.log(`  ok    ${name}`); },
            (e) => { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); },
        );
        passed++; console.log(`  ok    ${name}`);
    } catch (e) {
        failed++; console.log(`  FAIL  ${name}\n        ${e.message}`);
    }
    return Promise.resolve();
}

const handlerPath = '../handlers/partner_admin';
const partner = require('../lib/partner_auth');

async function pureTests() {
    const mod = require(handlerPath);
    const { UUID_RE } = mod._internals;

    await check('UUID_RE rejects a non-uuid practice id', () => {
        assert.equal(UUID_RE.test('not-a-uuid'), false);
        assert.equal(UUID_RE.test('11111111-1111-1111-1111-111111111111'), true);
    });

    await check('assertScopes rejects an unknown scope', () => {
        assert.throws(() => partner.assertScopes(['claims:destroy']), /unknown scope/);
    });

    await check('assertScopes accepts every documented scope', () => {
        assert.deepEqual(partner.assertScopes(partner.SCOPES.slice()), partner.SCOPES);
    });

    await check('generateCredential never returns the digest as the secret', () => {
        const c = partner.generateCredential();
        assert.ok(c.secret.length >= 32, 'secret too short');
        assert.ok(!c.secretHash.includes(c.secret), 'digest embeds the plaintext');
        assert.ok(c.keyId.startsWith('rdbp_'), 'key id is not namespaced');
    });

    await check('a generated secret verifies, a wrong one does not', () => {
        const c = partner.generateCredential();
        assert.equal(partner.verifySecret(c.secret, c.secretHash), true);
        assert.equal(partner.verifySecret(c.secret + 'x', c.secretHash), false);
    });
}

async function dbTests() {
    const db = require('../lib/db');
    const { handler } = require(handlerPath);
    const PRACTICE = '11111111-1111-1111-1111-111111111111';

    await db.query('delete from partner_credentials where practice_id = $1', [PRACTICE]).catch(() => {});

    await check('a bare payload is a read-only summary, not a write', async () => {
        const before = await db.query('select count(*)::int as n from partner_credentials');
        const r = await handler({});
        assert.equal(r.mode, 'summary');
        const after = await db.query('select count(*)::int as n from partner_credentials');
        assert.equal(after.rows[0].n, before.rows[0].n, 'summary mutated the table');
    });

    await check('an unrecognised payload is a summary, never a write', async () => {
        const r = await handler({ nonsense: true, apply: true });
        assert.equal(r.mode, 'summary');
    });

    await check('issue refuses an unknown scope', async () => {
        const r = await handler({ issue: { practice_id: PRACTICE, scopes: ['claims:destroy'] } });
        assert.equal(r.ok, false);
        assert.match(r.message, /unknown scope/);
    });

    await check('issue refuses a practice that does not exist', async () => {
        const r = await handler({ issue: { practice_id: '99999999-9999-9999-9999-999999999999', scopes: [] } });
        assert.equal(r.ok, false);
        assert.match(r.message, /no practice/);
    });

    let firstKey;
    await check('issue mints a credential and stores only its digest', async () => {
        const r = await handler({ issue: { practice_id: PRACTICE, scopes: ['claims:read'], label: 'test' } });
        assert.equal(r.ok, true);
        assert.ok(r.credential && r.credential.includes('.'), 'no credential returned');
        firstKey = r.key_id;
        const secret = r.credential.split('.').slice(1).join('.');
        const row = await db.query('select secret_hash from partner_credentials where key_id = $1', [r.key_id]);
        assert.equal(row.rows.length, 1);
        assert.ok(!row.rows[0].secret_hash.includes(secret), 'plaintext secret was stored');
        assert.equal(partner.verifySecret(secret, row.rows[0].secret_hash), true, 'stored digest does not verify');
    });

    await check('a second issue is refused while one is active', async () => {
        const r = await handler({ issue: { practice_id: PRACTICE, scopes: ['claims:read'] } });
        assert.equal(r.ok, false);
        assert.deepEqual(r.active_key_ids, [firstKey]);
    });

    await check('replace revokes the old one, leaving exactly one active', async () => {
        const r = await handler({ issue: { practice_id: PRACTICE, scopes: ['claims:read'], replace: true } });
        assert.equal(r.ok, true);
        assert.equal(r.replaced, 1);
        const active = await db.query(
            'select count(*)::int as n from partner_credentials where practice_id = $1 and revoked_at is null',
            [PRACTICE]
        );
        assert.equal(active.rows[0].n, 1, 'replace left more than one active credential');
    });

    await check('list returns key ids and never a secret', async () => {
        const r = await handler({ list: { practice_id: PRACTICE } });
        assert.equal(r.ok, true);
        assert.ok(r.credentials.length >= 2);
        for (const c of r.credentials) {
            assert.ok(c.key_id, 'missing key_id');
            assert.ok(!('secret' in c) && !('secret_hash' in c), 'list leaked secret material');
        }
    });

    await check('revoke is idempotent', async () => {
        const active = await db.query(
            'select key_id from partner_credentials where practice_id = $1 and revoked_at is null limit 1',
            [PRACTICE]
        );
        const key = active.rows[0].key_id;
        const first = await handler({ revoke: { key_id: key } });
        assert.equal(first.changed, true);
        const second = await handler({ revoke: { key_id: key } });
        assert.equal(second.ok, true);
        assert.equal(second.changed, false, 'second revoke reported a change');
    });

    await check('practices lists counts only — no member details in the bare listing', async () => {
        const r = await handler({ practices: {} });
        assert.equal(r.ok, true);
        assert.ok(Array.isArray(r.practices) && r.practices.length >= 1);
        for (const p of r.practices) {
            assert.ok(p.id && typeof p.name === 'string', 'missing id/name');
            for (const k of ['clients', 'sessions', 'claims', 'members']) {
                assert.equal(typeof p[k], 'number', `count ${k} missing`);
            }
            assert.ok(!('email' in p) && !('members_list' in p), 'bare listing leaked member detail');
        }
    });

    await check('practices refuses an unknown name and says what exists', async () => {
        const r = await handler({ practices: { name: 'No Such Practice Anywhere' } });
        assert.equal(r.ok, false);
        assert.ok(Array.isArray(r.available_names));
    });

    await check('practices returns members only for an exactly-named practice', async () => {
        const all = await handler({ practices: {} });
        const target = all.practices[0].name;
        const r = await handler({ practices: { name: target } });
        if (r.ok) {
            assert.ok(Array.isArray(r.members), 'no members returned for an exact name');
            for (const m of r.members) assert.ok(m.user_id && m.role, 'member missing ids');
        } else {
            // Duplicate names are a legitimate refusal, and the point of the mode.
            assert.match(r.message, /share that name/);
        }
    });

    await check('resolve refuses an unknown email rather than guessing', async () => {
        const r = await handler({ resolve: { email: 'nobody@example.invalid' } });
        assert.equal(r.ok, false);
    });

    await db.query('delete from partner_credentials where practice_id = $1', [PRACTICE]).catch(() => {});
    // getPool().end() — lib/db exports no end(); calling db.end() here would
    // throw in teardown and leave the pool open (see the sibling integration
    // test, which did exactly that).
    await db.getPool().end().catch(() => {});
}

(async () => {
    console.log('partner_admin.test.js');
    await pureTests();

    if (!process.env.DATABASE_URL) {
        console.log('  ....  DB-backed checks SKIPPED (no DATABASE_URL)');
    } else {
        await dbTests();
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
