'use strict';

// Unit test — partner (machine-to-machine) authentication
// (backend/lib/partner_auth.js). Mocks db via the require cache; no database,
// no network, no JWT.
//
// What it pins, in the order the security argument depends on it:
//
//   1. The two credential schemes cannot cross. A Partner header must not
//      satisfy the human Bearer path, and a Bearer header must not satisfy the
//      partner path. This is the property the whole design rests on.
//   2. The practice id comes from the ROW, never from the request.
//   3. Revocation is immediate, expiry is honoured, a wrong secret fails, and an
//      unknown key and a wrong secret are indistinguishable to the caller.
//   4. Scopes are enforced per operation, and a credential with a scope may not
//      use a different one.
//   5. The secret never appears in an error.
//
// NOTE ON LITERALS: every credential-shaped string here is GENERATED at run
// time, never written into the file. A literal that looks like a key trips
// secret scanning and fails the PR.
//
//   node backend/tests/partner_auth.test.js

const assert = require('node:assert');
const path = require('node:path');

function mock(rel, exports) {
    const resolved = require.resolve(path.join(__dirname, '..', rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// One row, swapped per case. `updates` records the best-effort last_used_at
// write so the test can assert it happens without it being load-bearing.
let row = null;
const updates = [];
mock('lib/db.js', {
    query: async (sql, params) => {
        if (/from partner_credentials/i.test(sql)) {
            const hit = row && row.key_id === params[0] ? [row] : [];
            return { rows: hit, rowCount: hit.length };
        }
        if (/^update\s+partner_credentials/i.test(sql.trim())) {
            updates.push(params[0]);
            return { rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    },
});

const partner = require(path.join(__dirname, '..', 'lib', 'partner_auth.js'));
const auth = require(path.join(__dirname, '..', 'lib', 'auth.js'));

const PRACTICE = '22222222-2222-4222-8222-222222222222';
const OTHER_PRACTICE = '33333333-3333-4333-8333-333333333333';

// Build a real credential the same way the issuing script does.
function issue(scopes, overrides) {
    const c = partner.generateCredential();
    row = Object.assign({
        id: '44444444-4444-4444-8444-444444444444',
        practice_id: PRACTICE,
        partner: 'sessionably',
        key_id: c.keyId,
        secret_hash: c.secretHash,
        scopes: scopes || [],
        expires_at: null,
        revoked_at: null,
    }, overrides || {});
    return c;
}

const partnerEvent = (c, secret) => ({
    httpMethod: 'POST',
    headers: { Authorization: `Partner ${c.keyId}.${secret === undefined ? c.secret : secret}` },
});

let passed = 0;
let failed = 0;
async function test(name, fn) {
    updates.length = 0;
    try {
        await fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (err) {
        failed++;
        console.log(`  FAIL ${name}`);
        console.log(`       ${err && err.message}`);
    }
}
async function rejects(fn, code) {
    let threw = null;
    try { await fn(); } catch (e) { threw = e; }
    assert.ok(threw, 'expected a rejection, got none');
    if (code) assert.strictEqual(threw.code, code, `expected code ${code}, got ${threw.code}`);
    return threw;
}

(async () => {
    /* ---------------------------------------------------------------- */
    console.log('\nthe two credential schemes cannot cross');

    await test('a Partner header does NOT satisfy the human Bearer path', async () => {
        const c = issue(['claims:read']);
        // requireAuth is synchronous and throws AuthError for a non-Bearer header.
        assert.throws(() => auth.requireAuth(partnerEvent(c)),
            /Unauthorized|Missing bearer token/i,
            'a partner credential was accepted as a signed-in human');
    });

    await test('a Bearer header does NOT satisfy the partner path', async () => {
        issue(['claims:read']);
        await rejects(
            () => partner.requirePartner({ headers: { Authorization: 'Bearer some.staff.jwt' } }, 'claims:read'),
            'PARTNER_CREDENTIAL_MISSING'
        );
    });

    await test('no Authorization header at all is refused', async () => {
        issue(['claims:read']);
        await rejects(() => partner.requirePartner({ headers: {} }, 'claims:read'),
            'PARTNER_CREDENTIAL_MISSING');
    });

    /* ---------------------------------------------------------------- */
    console.log('\nthe practice comes from the credential, never the request');

    await test('a valid credential resolves to ITS practice', async () => {
        const c = issue(['claims:read']);
        const p = await partner.requirePartner(partnerEvent(c), 'claims:read');
        assert.strictEqual(p.practiceId, PRACTICE);
        assert.strictEqual(p.actorType, 'partner');
        assert.strictEqual(p.partner, 'sessionably');
    });

    await test('a practice named in the request body is ignored', async () => {
        const c = issue(['claims:read']);
        const ev = partnerEvent(c);
        ev.body = JSON.stringify({ practice_id: OTHER_PRACTICE });
        ev.queryStringParameters = { practice_id: OTHER_PRACTICE };
        const p = await partner.requirePartner(ev, 'claims:read');
        assert.strictEqual(p.practiceId, PRACTICE, 'the request steered the practice scope');
    });

    /* ---------------------------------------------------------------- */
    console.log('\nrevocation, expiry and a wrong secret');

    await test('revoked is refused immediately', async () => {
        const c = issue(['claims:read'], { revoked_at: new Date().toISOString() });
        await rejects(() => partner.requirePartner(partnerEvent(c), 'claims:read'),
            'PARTNER_CREDENTIAL_REVOKED');
    });

    await test('expired is refused', async () => {
        const c = issue(['claims:read'], { expires_at: new Date(Date.now() - 1000).toISOString() });
        await rejects(() => partner.requirePartner(partnerEvent(c), 'claims:read'),
            'PARTNER_CREDENTIAL_EXPIRED');
    });

    await test('an unexpired expires_at still works', async () => {
        const c = issue(['claims:read'], { expires_at: new Date(Date.now() + 60000).toISOString() });
        const p = await partner.requirePartner(partnerEvent(c), 'claims:read');
        assert.strictEqual(p.practiceId, PRACTICE);
    });

    await test('a wrong secret is refused', async () => {
        const c = issue(['claims:read']);
        const wrong = partner.generateCredential().secret;
        await rejects(() => partner.requirePartner(partnerEvent(c, wrong), 'claims:read'),
            'PARTNER_CREDENTIAL_INVALID');
    });

    await test('an unknown key and a wrong secret give the SAME code', async () => {
        const real = issue(['claims:read']);
        const wrongSecret = await rejects(
            () => partner.requirePartner(partnerEvent(real, partner.generateCredential().secret), 'claims:read'));
        const unknownKey = partner.generateCredential();
        row = null; // nothing in the table
        const noSuchKey = await rejects(() => partner.requirePartner(partnerEvent(unknownKey), 'claims:read'));
        assert.strictEqual(noSuchKey.code, wrongSecret.code,
            'the endpoint distinguishes an unknown key from a wrong secret — that is an existence oracle');
        assert.strictEqual(noSuchKey.statusCode, wrongSecret.statusCode);
    });

    await test('a malformed header (no dot) is refused, not split wrongly', async () => {
        const c = issue(['claims:read']);
        await rejects(
            () => partner.requirePartner({ headers: { Authorization: `Partner ${c.keyId}` } }, 'claims:read'),
            'PARTNER_CREDENTIAL_MISSING'
        );
    });

    /* ---------------------------------------------------------------- */
    console.log('\nscopes are least privilege, per operation');

    await test('a granted scope is allowed', async () => {
        const c = issue(['claims:read', 'claims:write']);
        const p = await partner.requirePartner(partnerEvent(c), 'claims:write');
        assert.deepStrictEqual(p.scopes, ['claims:read', 'claims:write']);
    });

    await test('an ungranted scope is 403, not 401', async () => {
        const c = issue(['claims:read']);
        const err = await rejects(() => partner.requirePartner(partnerEvent(c), 'claims:submit'),
            'PARTNER_SCOPE_REQUIRED');
        assert.strictEqual(err.statusCode, 403,
            'an authenticated-but-unauthorized partner must not be told to re-authenticate');
    });

    await test('read does not imply write, and write does not imply submit', async () => {
        const c = issue(['claims:read']);
        await rejects(() => partner.requirePartner(partnerEvent(c), 'claims:write'), 'PARTNER_SCOPE_REQUIRED');
        const w = issue(['claims:write']);
        await rejects(() => partner.requirePartner(partnerEvent(w), 'claims:submit'), 'PARTNER_SCOPE_REQUIRED');
    });

    await test('an empty scope set authenticates but grants nothing', async () => {
        const c = issue([]);
        const p = await partner.requirePartner(partnerEvent(c));   // no scope required
        assert.strictEqual(p.practiceId, PRACTICE);
        for (const s of partner.SCOPES) {
            await rejects(() => partner.requirePartner(partnerEvent(c), s), 'PARTNER_SCOPE_REQUIRED');
        }
    });

    await test('sending a text is its own scope, separate from claims', async () => {
        const c = issue(['claims:read', 'claims:write', 'claims:submit']);
        await rejects(() => partner.requirePartner(partnerEvent(c), 'payment_link:send'),
            'PARTNER_SCOPE_REQUIRED');
    });

    /* ---------------------------------------------------------------- */
    console.log('\nthe secret is never exposed');

    await test('no error message or property carries the secret', async () => {
        const c = issue(['claims:read']);
        const err = await rejects(() => partner.requirePartner(partnerEvent(c), 'claims:submit'));
        const blob = JSON.stringify({ m: err.message, c: err.code, s: err.stack || '' });
        assert.ok(!blob.includes(c.secret), 'the secret leaked into the error');
    });

    await test('the resolved principal carries the key id but not the secret', async () => {
        const c = issue(['claims:read']);
        const p = await partner.requirePartner(partnerEvent(c), 'claims:read');
        const blob = JSON.stringify(p);
        assert.ok(blob.includes(c.keyId), 'the key id should be available for logging/attribution');
        assert.ok(!blob.includes(c.secret), 'the secret is in the principal');
        assert.ok(!blob.includes(row.secret_hash), 'the stored digest is in the principal');
    });

    /* ---------------------------------------------------------------- */
    console.log('\nhashing');

    await test('the same secret verifies, a different one does not', async () => {
        const c = partner.generateCredential();
        assert.ok(partner.verifySecret(c.secret, c.secretHash));
        assert.ok(!partner.verifySecret(partner.generateCredential().secret, c.secretHash));
    });

    await test('two credentials for the same secret hash differently (per-credential salt)', async () => {
        const secret = partner.generateCredential().secret;
        assert.notStrictEqual(partner.hashSecret(secret), partner.hashSecret(secret));
        // ...and both still verify.
        assert.ok(partner.verifySecret(secret, partner.hashSecret(secret)));
    });

    await test('a malformed stored digest fails closed', async () => {
        const secret = partner.generateCredential().secret;
        for (const bad of ['', 'not-a-digest', 'scrypt$1$1$1$$', 'scrypt$abc$8$1$AAAA$AAAA', null, undefined]) {
            assert.ok(!partner.verifySecret(secret, bad), `accepted a malformed digest: ${String(bad)}`);
        }
    });

    await test('verification reads parameters from the row, not the current constants', async () => {
        // A credential issued under weaker parameters must keep verifying, or
        // raising the constants would lock every existing integration out.
        const secret = partner.generateCredential().secret;
        const old = partner.hashSecret(secret, {
            N: 1024, r: 8, p: 1, salt: require('node:crypto').randomBytes(16),
        });
        assert.ok(old.startsWith('scrypt$1024$'));
        assert.ok(partner.verifySecret(secret, old));
    });

    /* ---------------------------------------------------------------- */
    console.log('\nissuing');

    await test('unknown scopes are refused at issuing time', () => {
        assert.throws(() => partner.assertScopes(['claims:read', 'claims:delete']), /unknown scope/i);
        assert.deepStrictEqual(partner.assertScopes(['claims:read']), ['claims:read']);
    });

    await test('generated key ids are prefixed and unique', () => {
        const a = partner.generateCredential();
        const b = partner.generateCredential();
        assert.ok(a.keyId.startsWith('rdbp_'));
        assert.notStrictEqual(a.keyId, b.keyId);
        assert.notStrictEqual(a.secret, b.secret);
    });

    await test('last_used_at is recorded, best-effort', async () => {
        const c = issue(['claims:read']);
        await partner.requirePartner(partnerEvent(c), 'claims:read');
        // The update is fire-and-forget; give the microtask a turn.
        await new Promise((r) => setImmediate(r));
        assert.deepStrictEqual(updates, [row.id]);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    console.log('partner_auth.test.js: OK');
})();
