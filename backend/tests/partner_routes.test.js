'use strict';

// Partner requests against the CLAIMS and PAYMENT-LINK routes.
//
// This is the file that matters. Migration 023 proved a credential can be
// authenticated; this proves what it may then DO, and the answer crosses
// practice and financial boundaries:
//
//   PERMISSION   per ACTION, not per route. Read cannot submit. Claims access
//                cannot text a client.
//   OWNERSHIP    the practice comes from the credential row, so a partner
//                cannot reach another practice's claim by naming its id.
//   RETRY        the existing unsafe-retry refusal still fires for a partner —
//                a resubmit after an unconfirmed attempt must not file a
//                duplicate with the payer.
//   DUPLICATES   a submitted claim cannot be submitted again.
//   ATTRIBUTION  a partner action is recorded AS the partner, never as a null
//                actor and never as a human.
//
// Mocks db and the clearinghouse via the require cache. No network, no DB.
//
//   node backend/tests/partner_routes.test.js

const assert = require('node:assert');
const path = require('node:path');

function mock(rel, exports) {
    const resolved = require.resolve(path.join(__dirname, '..', rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const PRACTICE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CLAIM = '33333333-3333-4333-8333-333333333333';
const CRED = '44444444-4444-4444-8444-444444444444';
const CLIENT = '55555555-5555-4555-8555-555555555555';

// --- db ----------------------------------------------------------------------
//
// MOCKED FIRST, DELIBERATELY. lib/partner_auth.js captures `db` at require
// time, so requiring it before this line would leave it holding the real
// module and every partner request would 401 against a database that is not
// there.
let claimRow = null;
let events = [];
let clientRow = null;
let updates = [];

mock('lib/db.js', {
    query: async (sql, params) => {
        const t = String(sql).trim();
        if (/from partner_credentials/i.test(t)) {
            return { rows: credRow ? [credRow] : [], rowCount: credRow ? 1 : 0 };
        }
        if (/^update partner_credentials/i.test(t)) return { rowCount: 1 };
        if (/from users/i.test(t)) return { rows: [{ practice_id: PRACTICE }], rowCount: 1 };
        if (/from claims/i.test(t)) {
            // HONOURS THE SQL: the practice predicate is part of the statement,
            // so the stub applies it rather than re-deciding ownership itself.
            const wantsPractice = params && params.length > 1 ? params[1] : null;
            const hit = claimRow && (!wantsPractice || claimRow.practice_id === wantsPractice);
            return { rows: hit ? [claimRow] : [], rowCount: hit ? 1 : 0 };
        }
        if (/from clients/i.test(t)) {
            const wantsPractice = params && params.length > 1 ? params[1] : null;
            const hit = clientRow && (!wantsPractice || clientRow.practice_id === wantsPractice);
            return { rows: hit ? [clientRow] : [], rowCount: hit ? 1 : 0 };
        }
        if (/from practices/i.test(t)) return { rows: [{ name: 'Test Practice' }], rowCount: 1 };
        if (/^insert into claim_events/i.test(t)) {
            events.push({
                practice_id: params[0], claim_id: params[1],
                created_by: params[2], partner_credential_id: params[3], actor_type: params[4],
                event_type: params[5],
            });
            return { rowCount: 1 };
        }
        if (/^update clients/i.test(t)) { updates.push('payment_link_sent_at'); return { rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
    },
});
// --- the credential the partner presents (requires the mocked db above) ------
const partnerAuth = require(path.join(__dirname, '..', 'lib', 'partner_auth.js'));
let issued = partnerAuth.generateCredential();
let credRow = null;

mock('lib/payment_token.js', { sign: () => 'signed-token', verify: () => ({}) });
mock('lib/audit.js', { audit: async () => {}, sanitizeFields: () => [] });

const claims = require(path.join(__dirname, '..', 'handlers', 'claims.js'));
const paymentLink = require(path.join(__dirname, '..', 'handlers', 'payment_link.js'));
const { logClaimEvent } = require(path.join(__dirname, '..', 'lib', 'claims.js'));
const db = require(path.join(__dirname, '..', 'lib', 'db.js'));

// --- harness -----------------------------------------------------------------

let passed = 0;
let failed = 0;
async function test(name, fn) {
    issued = partnerAuth.generateCredential();
    credRow = {
        id: CRED, practice_id: PRACTICE, partner: 'sessionably',
        key_id: issued.keyId, secret_hash: issued.secretHash,
        scopes: ['clients:read', 'claims:read', 'claims:write', 'claims:submit', 'payment_link:send'],
        expires_at: null, revoked_at: null,
    };
    claimRow = {
        id: CLAIM, practice_id: PRACTICE, status: 'draft',
        control_number: null, insurance_record_id: 'ins-1',
    };
    clientRow = { id: CLIENT, practice_id: PRACTICE, phone: '+19708252499', first_name: 'Jordan' };
    events = []; updates = [];
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

const partnerHeader = () => ({ Authorization: `Partner ${issued.keyId}.${issued.secret}` });

function claimEvent(method, { action, id, body, headers } = {}) {
    const seg = ['claims'];
    if (id) seg.push(id);
    if (action) seg.push(action);
    return {
        httpMethod: method,
        requestContext: { http: { method, path: '/' + seg.join('/') } },
        rawPath: '/' + seg.join('/'),
        pathParameters: id ? { id } : undefined,
        headers: headers || partnerHeader(),
        body: body ? JSON.stringify(body) : undefined,
    };
}

(async () => {
    /* ---------------------------------------------------------------- */
    console.log('\npermission is per ACTION, not per route');

    await test('a read-only credential may GET a claim', async () => {
        credRow.scopes = ['claims:read'];
        const r = await claims.handler(claimEvent('GET', { id: CLAIM }));
        assert.notStrictEqual(r.statusCode, 403, `read was refused: ${r.body}`);
    });

    await test('a read-only credential may NOT submit', async () => {
        credRow.scopes = ['claims:read'];
        const r = await claims.handler(claimEvent('POST', { id: CLAIM, action: 'submit' }));
        assert.strictEqual(r.statusCode, 403, `submit was allowed with read scope: ${r.body}`);
    });

    await test('a write credential may NOT submit — write and submit are different', async () => {
        credRow.scopes = ['claims:read', 'claims:write'];
        const r = await claims.handler(claimEvent('POST', { id: CLAIM, action: 'submit' }));
        assert.strictEqual(r.statusCode, 403, 'claims:write allowed an irreversible submission');
    });

    await test('replace requires submit scope — it files a replacement claim', async () => {
        credRow.scopes = ['claims:read', 'claims:write'];
        const r = await claims.handler(claimEvent('POST', { id: CLAIM, action: 'replace' }));
        assert.strictEqual(r.statusCode, 403, 'a replacement was filed with only write scope');
    });

    await test('a read-only credential may NOT create', async () => {
        credRow.scopes = ['claims:read'];
        const r = await claims.handler(claimEvent('POST', { body: {} }));
        assert.strictEqual(r.statusCode, 403);
    });

    await test('an unknown action is refused for a partner, not defaulted', async () => {
        credRow.scopes = ['claims:read', 'claims:write', 'claims:submit'];
        const r = await claims.handler(claimEvent('POST', { id: CLAIM, action: 'nonexistent' }));
        assert.strictEqual(r.statusCode, 403,
            'an unmapped action inherited a scope instead of being denied');
    });

    /* ---------------------------------------------------------------- */
    console.log('\nclaims access does not grant messaging');

    await test('full claims scope may NOT send a payment link', async () => {
        credRow.scopes = ['clients:read', 'claims:read', 'claims:write', 'claims:submit'];
        const r = await paymentLink.handler({
            httpMethod: 'POST', pathParameters: { id: CLIENT }, headers: partnerHeader(),
        });
        assert.strictEqual(r.statusCode, 403, 'a claims credential texted a client');
        assert.strictEqual(updates.length, 0, 'payment_link_sent_at was stamped despite the refusal');
    });

    await test('payment_link:send may send, and stamps the resend marker', async () => {
        credRow.scopes = ['payment_link:send'];
        const r = await paymentLink.handler({
            httpMethod: 'POST', pathParameters: { id: CLIENT }, headers: partnerHeader(),
        });
        assert.strictEqual(r.statusCode, 200, `send was refused: ${r.body}`);
        const out = JSON.parse(r.body);
        assert.ok(out.to && out.body, 'the recipient and message were not returned');
        assert.ok(!/\$|amount|charge/i.test(out.body), 'the message mentions money');
        assert.deepStrictEqual(updates, ['payment_link_sent_at']);
    });

    await test('a client with no phone is refused, before anything is stamped', async () => {
        credRow.scopes = ['payment_link:send'];
        clientRow.phone = '';
        const r = await paymentLink.handler({
            httpMethod: 'POST', pathParameters: { id: CLIENT }, headers: partnerHeader(),
        });
        assert.strictEqual(r.statusCode, 400);
        assert.strictEqual(updates.length, 0);
    });

    /* ---------------------------------------------------------------- */
    console.log('\nownership — the practice comes from the credential');

    await test('a partner cannot reach another practice\'s claim', async () => {
        claimRow.practice_id = OTHER;
        const r = await claims.handler(claimEvent('GET', { id: CLAIM }));
        assert.strictEqual(r.statusCode, 404, `cross-practice read returned ${r.statusCode}`);
    });

    await test('a partner cannot submit another practice\'s claim', async () => {
        claimRow.practice_id = OTHER;
        const r = await claims.handler(claimEvent('POST', { id: CLAIM, action: 'submit' }));
        assert.strictEqual(r.statusCode, 404);
    });

    await test('a partner cannot text another practice\'s client', async () => {
        credRow.scopes = ['payment_link:send'];
        clientRow.practice_id = OTHER;
        const r = await paymentLink.handler({
            httpMethod: 'POST', pathParameters: { id: CLIENT }, headers: partnerHeader(),
        });
        assert.strictEqual(r.statusCode, 404);
        assert.strictEqual(updates.length, 0);
    });

    await test('a practice named in the body does not move the scope', async () => {
        claimRow.practice_id = OTHER;
        const r = await claims.handler(claimEvent('GET', {
            id: CLAIM, body: { practice_id: OTHER },
        }));
        assert.strictEqual(r.statusCode, 404, 'the request body steered the practice scope');
    });

    /* ---------------------------------------------------------------- */
    console.log('\nretry and duplicate protection survive for a partner');

    await test('an unconfirmed prior attempt refuses a resubmit', async () => {
        // The existing unsafe-retry guard: the clearinghouse may already hold
        // this claim, so resubmitting could file a duplicate with the payer.
        // The real predicate is `status === 'submitted' && control_number == null`
        // — a claim that went out but whose acknowledgement never came back.
        claimRow.status = 'submitted';
        claimRow.control_number = null;
        const r = await claims.handler(claimEvent('POST', { id: CLAIM, action: 'submit' }));
        assert.strictEqual(r.statusCode, 409, `unsafe retry was allowed: ${r.statusCode}`);
        assert.match(JSON.parse(r.body).error, /duplicate|reconcile/i);
    });

    await test('an already-submitted claim cannot be submitted again', async () => {
        // CONFIRMED submitted: it has a control number, so the unsafe-retry
        // guard above does not fire and the draft-only rule is what refuses.
        claimRow.status = 'submitted';
        claimRow.control_number = 'CN0000000001';
        const r = await claims.handler(claimEvent('POST', { id: CLAIM, action: 'submit' }));
        assert.strictEqual(r.statusCode, 409);
        assert.match(JSON.parse(r.body).error, /draft/i);
    });

    await test('a revoked credential loses access mid-flight', async () => {
        credRow.revoked_at = new Date().toISOString();
        const r = await claims.handler(claimEvent('GET', { id: CLAIM }));
        assert.strictEqual(r.statusCode, 401);
    });

    /* ---------------------------------------------------------------- */
    console.log('\nattribution — a partner action is recorded as the partner');

    await test('a partner event names the credential, never a null actor', async () => {
        events = [];
        await logClaimEvent(db, {
            practiceId: PRACTICE, claimId: CLAIM,
            createdByPartnerCredentialId: CRED, eventType: 'note',
        });
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].actor_type, 'partner');
        assert.strictEqual(events[0].partner_credential_id, CRED);
        assert.strictEqual(events[0].created_by, null);
    });

    await test('a human event is unchanged', async () => {
        events = [];
        await logClaimEvent(db, {
            practiceId: PRACTICE, claimId: CLAIM, createdBy: 'user-1', eventType: 'note',
        });
        assert.strictEqual(events[0].actor_type, 'user');
        assert.strictEqual(events[0].created_by, 'user-1');
        assert.strictEqual(events[0].partner_credential_id, null);
    });

    await test('a generated event is system, with neither actor', async () => {
        events = [];
        await logClaimEvent(db, { practiceId: PRACTICE, claimId: CLAIM, eventType: 'note' });
        assert.strictEqual(events[0].actor_type, 'system');
        assert.strictEqual(events[0].created_by, null);
        assert.strictEqual(events[0].partner_credential_id, null);
    });

    await test('a partner id and a user id together resolve to the partner alone', async () => {
        // The CHECK constraint forbids both. The writer nulls them against each
        // other so an illegal row cannot be constructed by a careless caller.
        events = [];
        await logClaimEvent(db, {
            practiceId: PRACTICE, claimId: CLAIM,
            createdBy: 'user-1', createdByPartnerCredentialId: CRED, eventType: 'note',
        });
        assert.strictEqual(events[0].actor_type, 'partner');
        assert.strictEqual(events[0].created_by, null, 'both actors were written');
    });

    /* ---------------------------------------------------------------- */
    console.log('\nhumans are unaffected');

    await test('a staff JWT still works and is not scope-checked', async () => {
        // Scopes do not apply to a human; their authority is their role.
        const authPath = require.resolve(path.join(__dirname, '..', 'lib', 'auth.js'));
        const real = require.cache[authPath];
        require.cache[authPath] = {
            id: authPath, filename: authPath, loaded: true,
            exports: { requireAuth: () => ({ user: { sub: 'user-1', role: 'practice_admin' } }) },
        };
        // principal.js captured the real module at require time, so reload it.
        delete require.cache[require.resolve(path.join(__dirname, '..', 'lib', 'principal.js'))];
        delete require.cache[require.resolve(path.join(__dirname, '..', 'handlers', 'claims.js'))];
        const fresh = require(path.join(__dirname, '..', 'handlers', 'claims.js'));
        const r = await fresh.handler(claimEvent('POST', {
            id: CLAIM, action: 'submit', headers: { Authorization: 'Bearer staff.jwt' },
        }));
        assert.notStrictEqual(r.statusCode, 403,
            'a human was refused for lacking a scope they can never hold');
        require.cache[authPath] = real;
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    console.log('partner_routes.test.js: OK');
})();
