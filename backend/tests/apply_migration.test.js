'use strict';

// Unit test — the one-off migration runner (backend/handlers/apply_migration.js).
// Mocks db via the require cache; no database, no network.
//
// What it pins, in the order the safety argument depends on it:
//
//   1. STATUS IS THE DEFAULT. A bare invoke, and any payload that is not a
//      STRICT {apply: true}, must not issue a single write. The string "true"
//      is the realistic mistake (`--payload '{"apply":"true"}'`) and it must
//      degrade to a read, never to a migration.
//   2. The ledger refuses a re-run, and a CHECKSUM MISMATCH is refused even
//      with force — re-running an edited migration is how a schema silently
//      diverges from what the ledger claims.
//   3. The name is whitelisted, so no payload can read a file outside the
//      bundle.
//   4. The migration's own BEGIN/COMMIT are stripped, so it runs inside OUR
//      transaction and the ledger row cannot commit without the DDL. A `begin`
//      inside a do $$ ... $$ block is PL/pgSQL and must survive untouched.
//
//   node backend/tests/apply_migration.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A throwaway bundle the handler reads instead of backend/sql/migrations, which
// is generated at build time and is not present in a clean checkout.
const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'migbundle-'));
process.env.MIGRATIONS_BUNDLE_DIR = bundle;
process.env.DATABASE_URL = 'postgres://unused/unused'; // never connected to; db is mocked

const SAMPLE = [
    'begin;',
    'alter table claim_events add column if not exists actor_type text not null default \'user\';',
    'do $$',
    'begin',
    '  if not exists (select 1 from pg_constraint where conname = \'x\') then',
    '    alter table claim_events add constraint x check (true);',
    '  end if;',
    'end $$;',
    'commit;',
    '',
].join('\n');

fs.writeFileSync(path.join(bundle, '024_partner_claim_event_attribution.sql'), SAMPLE);

function mock(rel, exports) {
    const resolved = require.resolve(path.join(__dirname, '..', rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Every statement the handler issues, in order, so a test can assert that a
// read-only path really was read-only.
let issued = [];
// What `select checksum, applied_at from schema_migrations where name = $1` returns.
let ledgerRow = null;

const client = {
    query: async (sql, params) => {
        issued.push(String(sql).trim());
        if (/from schema_migrations where name/i.test(sql)) {
            return { rows: ledgerRow ? [ledgerRow] : [] };
        }
        if (/select name, checksum, applied_at from schema_migrations/i.test(sql)) {
            return { rows: ledgerRow ? [ledgerRow] : [] };
        }
        if (/select name, applied_at from schema_migrations/i.test(sql)) {
            return { rows: [] };
        }
        // Catalog probes used by verify(). Answer "absent" uniformly — these
        // tests pin the SAFETY of verify (that it reads and never writes), not
        // its findings; the findings are proven against a real database.
        if (/to_regclass/i.test(sql)) return { rows: [{ present: false }] };
        if (/pg_get_constraintdef/i.test(sql)) return { rows: [] };
        if (/count\(\*\)/i.test(sql)) {
            return { rows: [{ n: 0, would_be_system: 0, would_be_user: 0 }] };
        }
        return { rows: [] };
    },
    release: () => {},
};

mock('lib/db.js', { getPool: () => ({ connect: async () => client }) });

const { handler, _internals } = require('../handlers/apply_migration');

function reset() {
    issued = [];
    ledgerRow = null;
}

// A statement that changes data or schema. `create table if not exists
// schema_migrations` is excluded deliberately: it carries no data and the
// handler documents that it ensures the ledger even on the read path.
function writes() {
    return issued.filter((s) =>
        /^(insert|update|delete|alter|drop|truncate)\b/i.test(s) ||
        (/^create\b/i.test(s) && !/create table if not exists schema_migrations/i.test(s))
    );
}

let failures = 0;
async function check(name, fn) {
    reset();
    try {
        await fn();
        console.log(`  ok    ${name}`);
    } catch (err) {
        failures += 1;
        console.error(`  FAIL  ${name}`);
        console.error(`        ${err.message}`);
    }
}

(async () => {
    // -----------------------------------------------------------------------
    // 1. Status is the default
    // -----------------------------------------------------------------------

    await check('a bare invoke returns status and writes nothing', async () => {
        const out = await handler({});
        assert.equal(out.ok, true);
        assert.equal(out.mode, 'status');
        assert.deepEqual(writes(), [], `read-only path issued writes: ${writes().join(' | ')}`);
        assert.equal(out.migrations.length, 1);
        assert.equal(out.migrations[0].state, 'pending');
    });

    await check('an undefined event returns status and writes nothing', async () => {
        const out = await handler(undefined);
        assert.equal(out.mode, 'status');
        assert.deepEqual(writes(), []);
    });

    // The realistic operator mistake. --payload '{"apply":"true"}' must read.
    await check('apply:"true" (the STRING) is not true — degrades to status', async () => {
        const out = await handler({ migration: '024_partner_claim_event_attribution', apply: 'true' });
        assert.equal(out.mode, 'status', 'a string "true" was treated as a boolean and would have written');
        assert.deepEqual(writes(), []);
    });

    await check('apply:1 is not true — degrades to status', async () => {
        const out = await handler({ migration: '024_partner_claim_event_attribution', apply: 1 });
        assert.equal(out.mode, 'status');
        assert.deepEqual(writes(), []);
    });

    await check('apply:true with no migration name is refused, and writes nothing', async () => {
        const out = await handler({ apply: true });
        assert.equal(out.ok, false);
        assert.match(out.message, /requires a "migration" name/);
        assert.deepEqual(writes(), []);
    });

    // -----------------------------------------------------------------------
    // 2. Name whitelist
    // -----------------------------------------------------------------------

    for (const bad of [
        '../../../etc/passwd',
        '024_partner_claim_event_attribution.sql',
        '024/../024',
        'DROP',
        '24_short_number',
    ]) {
        await check(`a migration name of ${JSON.stringify(bad)} is refused`, async () => {
            const out = await handler({ migration: bad, apply: true });
            assert.equal(out.ok, false);
            assert.deepEqual(writes(), [], 'a rejected name still reached a write');
        });
    }

    await check('a well-formed name that is not in the bundle is refused', async () => {
        const out = await handler({ migration: '099_not_bundled', apply: true });
        assert.equal(out.ok, false);
        assert.match(out.message, /not in the deployed bundle/);
        assert.deepEqual(writes(), []);
    });

    // -----------------------------------------------------------------------
    // 3. The ledger
    // -----------------------------------------------------------------------

    await check('applying a pending migration runs the DDL and records it, in one transaction', async () => {
        const out = await handler({ migration: '024_partner_claim_event_attribution', apply: true });
        assert.equal(out.ok, true, out.message);
        assert.equal(out.applied, '024_partner_claim_event_attribution');

        const joined = issued.join('\n');
        assert.ok(/pg_advisory_lock/.test(joined), 'no advisory lock was taken');
        assert.ok(/pg_advisory_unlock/.test(joined), 'the advisory lock was not released');
        assert.ok(issued.includes('begin'), 'the DDL did not run inside our transaction');
        assert.ok(issued.includes('commit'), 'the transaction was not committed');
        assert.ok(/insert into schema_migrations/i.test(joined), 'the apply was not recorded in the ledger');

        // The ledger insert must be INSIDE the transaction, not after it.
        const b = issued.indexOf('begin');
        const c = issued.indexOf('commit');
        const ins = issued.findIndex((s) => /insert into schema_migrations/i.test(s));
        assert.ok(b < ins && ins < c, 'the ledger row is not written inside the same transaction as the DDL');
    });

    await check('an already-applied migration with a matching checksum is skipped', async () => {
        const { checksum } = (() => {
            const crypto = require('node:crypto');
            const sql = fs.readFileSync(path.join(bundle, '024_partner_claim_event_attribution.sql'), 'utf8');
            return { checksum: crypto.createHash('sha256').update(sql, 'utf8').digest('hex') };
        })();
        ledgerRow = { checksum, applied_at: new Date('2026-09-10T00:00:00Z') };

        const out = await handler({ migration: '024_partner_claim_event_attribution', apply: true });
        assert.equal(out.ok, true);
        assert.equal(out.skipped, true);
        assert.deepEqual(writes(), [], 'a skipped migration still issued a write');
    });

    await check('a checksum mismatch is refused, and force does NOT override it', async () => {
        ledgerRow = { checksum: 'a'.repeat(64), applied_at: new Date('2026-09-10T00:00:00Z') };

        const out = await handler({ migration: '024_partner_claim_event_attribution', apply: true, force: true });
        assert.equal(out.ok, false, 'force overrode a checksum mismatch');
        assert.match(out.message, /DIFFERENT checksum/);
        assert.deepEqual(writes(), []);
    });

    // -----------------------------------------------------------------------
    // 4. Transaction-wrapper stripping
    // -----------------------------------------------------------------------

    await check('standalone begin;/commit; are stripped', () => {
        const out = _internals.stripTransactionWrappers(SAMPLE);
        const lines = out.split('\n').map((l) => l.trim());
        assert.ok(!lines.includes('begin;'), 'a standalone begin; survived');
        assert.ok(!lines.includes('commit;'), 'a standalone commit; survived — it would end our transaction early');
    });

    await check('a `begin` inside a do $$ block is PL/pgSQL and survives', () => {
        const out = _internals.stripTransactionWrappers(SAMPLE);
        assert.ok(/do \$\$\nbegin\n/.test(out), 'the PL/pgSQL block body was mangled');
        assert.ok(/end \$\$;/.test(out), 'the PL/pgSQL block terminator was lost');
    });

    // -----------------------------------------------------------------------
    // 5. Verify mode — read-only, and read-only WINS
    // -----------------------------------------------------------------------

    await check('verify:true returns a verify report and writes nothing', async () => {
        const out = await handler({ verify: true });
        assert.equal(out.ok, true);
        assert.equal(out.mode, 'verify');
        assert.deepEqual(writes(), [], `verify issued writes: ${writes().join(' | ')}`);
    });

    // The operator who asked to LOOK is not the operator who asked to CHANGE.
    // A payload carrying both must never fall through to the migration.
    await check('verify:true beats apply:true — the read-only request wins', async () => {
        const out = await handler({ verify: true, apply: true, migration: '024_partner_claim_event_attribution' });
        assert.equal(out.mode, 'verify', 'apply:true escaped past a verify request');
        assert.deepEqual(writes(), [], 'a verify+apply payload performed a write');
    });

    // verify() must not even create the ledger table — it runs against databases
    // an operator is unsure about, and "read-only" has to mean it.
    await check('verify never creates the ledger table', async () => {
        await handler({ verify: true });
        const creates = issued.filter((s) => /create table/i.test(s));
        assert.deepEqual(creates, [], `verify issued CREATE TABLE: ${creates.join(' | ')}`);
    });

    await check('verify reports absence rather than throwing on a bare database', async () => {
        const out = await handler({ verify: true });
        for (const name of Object.keys(_internals.EXPECTED)) {
            assert.equal(out.migrations[name].structurally_present, false,
                `${name} reported present against a database where every probe answered absent`);
        }
    });

    // A CHECK that EXISTS but no longer admits 'partner' is the exact silent
    // regression this mode exists to catch — schema.sql re-adds that constraint
    // on every deploy, so a narrowed predicate reverts it rather than failing.
    await check("allTrue() rejects a constraint that exists but does not admit 'partner'", () => {
        const base = { tables: { t: true }, columns: {}, indexes: {}, foreign_keys: {} };
        assert.equal(_internals.allTrue({ ...base, checks: { c: { present: true, admits: true } } }), true);
        assert.equal(_internals.allTrue({ ...base, checks: { c: { present: true, admits: false } } }), false,
            'a present-but-narrowed constraint was reported as structurally fine');
        assert.equal(_internals.allTrue({ ...base, checks: { c: { present: false, admits: false } } }), false);
    });

    // -----------------------------------------------------------------------
    // 6. Phase detection — the rollout-safety question
    // -----------------------------------------------------------------------
    //
    // The expand/contract split exists because there was NO safe ordering for
    // the original single-shot 024. Both failures were reproduced against a
    // real PostgreSQL 16:
    //
    //   partner-aware writer against pre-expansion  -> 42703 undefined_column
    //   legacy system event against contracted      -> 23514 check violation
    //
    // phaseOf() is what tells an operator which of those two they are one step
    // away from, so these assertions are the guard rail for the whole rollout.

    const EXPAND_OK = { tables: {}, columns: { a: true, b: true }, indexes: { i: true }, foreign_keys: { f: true }, checks: {}, not_null: {} };
    const EXPAND_NO = { tables: {}, columns: { a: false, b: false }, indexes: { i: false }, foreign_keys: { f: false }, checks: {}, not_null: {} };
    const CONTRACT_OK = { tables: {}, columns: {}, indexes: {}, foreign_keys: {}, checks: { c1: { present: true, admits: true }, c2: { present: true, admits: null } }, not_null: { 'claim_events.actor_type': true } };
    const CONTRACT_NO = { tables: {}, columns: {}, indexes: {}, foreign_keys: {}, checks: { c1: { present: false, admits: false }, c2: { present: false, admits: null } }, not_null: { 'claim_events.actor_type': false } };

    await check('phase: columns absent -> pre-expansion', () => {
        assert.equal(_internals.phaseOf(EXPAND_NO, CONTRACT_NO), 'pre-expansion');
    });

    await check('phase: columns present, unconstrained -> expanded (both writers work)', () => {
        assert.equal(_internals.phaseOf(EXPAND_OK, CONTRACT_NO), 'expanded');
    });

    await check('phase: NOT NULL + both CHECKs -> contracted', () => {
        assert.equal(_internals.phaseOf(EXPAND_OK, CONTRACT_OK), 'contracted');
    });

    // NOT NULL without the CHECKs, or the CHECKs without NOT NULL, is a
    // half-applied contract. It must NOT read as contracted — reporting a
    // partial state as finished is how a rollout proceeds over a broken schema.
    await check('phase: a half-applied contract does not read as contracted', () => {
        const halfA = { ...CONTRACT_OK, not_null: { 'claim_events.actor_type': false } };
        const halfB = { ...CONTRACT_OK, checks: { c1: { present: false, admits: false }, c2: { present: true, admits: null } } };
        assert.equal(_internals.phaseOf(EXPAND_OK, halfA), 'expanded');
        assert.equal(_internals.phaseOf(EXPAND_OK, halfB), 'expanded');
    });

    // The contract phase is what makes the OLD writer unsafe. An operator must
    // never contract while the legacy writer is still deployed.
    await check('writer compatibility is reported for every phase', async () => {
        const out = await handler({ verify: true });
        assert.equal(out.phase, 'pre-expansion');
        assert.equal(out.writers.partner_aware_supported, false,
            'a pre-expansion database claimed it could accept the partner-aware writer');
        assert.equal(out.writers.legacy_system_event_supported, true);
    });

    fs.rmSync(bundle, { recursive: true, force: true });

    if (failures > 0) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('\nall apply-migration checks passed');
})();
