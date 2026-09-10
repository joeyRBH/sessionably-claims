'use strict';

// One-off, operator-invoked migration Lambda (claimsub-<env>-apply-migration).
//
// WHY THIS EXISTS
//
// db/migrations/README.md told operators to apply migrations with
// `psql -f ... ` "from a host with network access (bastion / tunnel)". There is
// no such host and there never was: RDS is publicly_accessible = false, the
// account has no EC2 instances and none registered with SSM, and
// infra/terraform/backfill.tf says so outright. The only thing that ever reached
// the database was db/schema.sql, applied by the migrate Lambda on every deploy.
//
// That gap is what let migration 023 be merged (#116) with no way to apply it.
//
// Most migrations are best folded into db/schema.sql — idempotent, applied on
// every deploy, no new moving parts. This Lambda exists for the ones that must
// NOT be: a migration carrying a data backfill, or one whose timing must be
// operator-controlled rather than a side effect of shipping code.
//
// Migration 024 is exactly that case. Its CHECK rejects the inserts that
// CURRENTLY DEPLOYED code makes (a system event with no actor_type), so it must
// land WITH the deploy that changes those writes — never ahead of it, and never
// re-run automatically on a later deploy.
//
// ============================================================================
// STATUS IS THE DEFAULT. NOTHING WRITES WITHOUT AN EXPLICIT PAYLOAD.
// ============================================================================
//
//   # STATUS — read-only. Lists bundled migrations and their ledger state.
//   aws lambda invoke --function-name claimsub-prod-apply-migration \
//     /tmp/out.json && cat /tmp/out.json
//
//   # VERIFY — read-only. Structural + aggregate evidence of what actually
//   # landed in the database. Counts and catalog only; never row-level data.
//   aws lambda invoke --function-name claimsub-prod-apply-migration \
//     --payload '{"verify":true}' --cli-binary-format raw-in-base64-out \
//     /tmp/out.json && cat /tmp/out.json
//
//   # APPLY — one named migration, in one transaction, recorded in the ledger.
//   aws lambda invoke --function-name claimsub-prod-apply-migration \
//     --payload '{"migration":"024_partner_claim_event_attribution","apply":true}' \
//     --cli-binary-format raw-in-base64-out /tmp/out.json && cat /tmp/out.json
//
// `apply` is a STRICT boolean. The string "true" does not count, so a mistyped
// payload degrades to a read-only status report rather than a write.
//
// NOT invoked by deploy.sh, and never on a deploy. Same posture as
// backfill.tf's Lambda, and deliberately different from migrate, which
// deploy.sh runs every time.
//
// ============================================================================
// SAFEGUARDS AGAINST REPEATED OR CONCURRENT EXECUTION
// ============================================================================
//
//   1. LEDGER. Every apply records name + sha256 in schema_migrations, in the
//      SAME transaction as the DDL. An already-recorded migration is refused.
//   2. CHECKSUM. A migration recorded with a DIFFERENT checksum is refused
//      ALWAYS, force or not — the file changed after it was applied, and
//      re-running an edited migration is how a schema silently diverges.
//   3. ADVISORY LOCK. A session-level pg_advisory_lock serialises invokes, so
//      two operators (or a double-click) cannot interleave.
//   4. ONE TRANSACTION. The migration's own BEGIN/COMMIT are stripped and it
//      runs inside ours, so a failure rolls back the DDL *and* the ledger row
//      together. There is no half-applied state to reason about.
//   5. NAME WHITELIST. The migration name must match the repo's own filename
//      convention; no path separators, so no traversal out of the bundle.
//
// Security: NEVER log the connection string or anything derived from it. The
// status report carries object names and counts only — no PHI, no secrets.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../lib/db');

// Copied here by `npm run bundle:schema` (db/migrations -> backend/sql/migrations).
//
// MIGRATIONS_BUNDLE_DIR overrides it for tests only. It is never set in the
// Lambda's environment (see infra/terraform/apply-migration.tf), so in
// production this is always the bundled directory.
const MIGRATIONS_DIR = process.env.MIGRATIONS_BUNDLE_DIR
    || path.join(__dirname, '..', 'sql', 'migrations');

// Repo convention: NNN_snake_case.sql. Anchored, no dots, no slashes — this is
// the path-traversal guard as much as it is a naming rule.
const NAME_RE = /^\d{3}_[a-z0-9]+(?:_[a-z0-9]+)*$/;

// One fixed key for the whole tool. Two different migrations still serialise
// against each other, which is what we want: applying two at once to the same
// database is never intentional.
const ADVISORY_LOCK_KEY = 8410240624;

async function loadDatabaseUrl() {
    // Allow a pre-set env var (local runs); otherwise fetch the SecureString from SSM.
    if (process.env.DATABASE_URL) {
        return process.env.DATABASE_URL;
    }

    const name = process.env.DATABASE_URL_SSM_PARAM;
    if (!name) {
        throw new Error('DATABASE_URL_SSM_PARAM is not set');
    }

    // Required lazily: @aws-sdk/client-ssm ships in the Node 20 Lambda runtime
    // and is deliberately not a package.json dependency, so a top-level require
    // would make this handler unloadable (and untestable) anywhere else.
    const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
    const ssm = new SSMClient({});
    const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    const value = out && out.Parameter && out.Parameter.Value;
    if (!value) {
        throw new Error('DATABASE_URL SSM parameter is empty');
    }
    return value;
}

function listBundled() {
    if (!fs.existsSync(MIGRATIONS_DIR)) return [];
    return fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .map((f) => f.replace(/\.sql$/, ''))
        .filter((n) => NAME_RE.test(n))
        .sort();
}

function readMigration(name) {
    const file = path.join(MIGRATIONS_DIR, `${name}.sql`);
    // Belt and braces: even with NAME_RE, confirm the resolved path stayed inside
    // the bundle before reading it.
    if (path.dirname(path.resolve(file)) !== path.resolve(MIGRATIONS_DIR)) {
        throw new Error('migration path escaped the bundle');
    }
    const sql = fs.readFileSync(file, 'utf8');
    const checksum = crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
    return { sql, checksum };
}

/**
 * Strip the migration's own transaction wrappers.
 *
 * Every migration in db/migrations opens with `begin;` and closes with
 * `commit;`. We run the body inside OUR transaction so the ledger row commits
 * atomically with the DDL — a nested `begin` would be a warning and the
 * `commit` would end our transaction early, releasing the advisory lock and
 * committing a migration we might still want to roll back.
 *
 * Only standalone statements are removed (a `begin` inside a `do $$ ... $$`
 * block is PL/pgSQL, not SQL, and is left alone).
 */
function stripTransactionWrappers(sql) {
    return sql
        .replace(/^[ \t]*begin[ \t]*;[ \t]*$/gim, '')
        .replace(/^[ \t]*commit[ \t]*;[ \t]*$/gim, '');
}

async function ensureLedger(client) {
    // Self-sufficient rather than depending on schema.sql having run first: this
    // tool must work on any database it can reach, including one mid-repair.
    await client.query(`
        create table if not exists schema_migrations (
            name        text primary key,
            checksum    text not null,
            applied_at  timestamptz not null default now(),
            applied_by  text
        )
    `);
}

async function ledgerState(client) {
    await ensureLedger(client);
    const r = await client.query(
        'select name, checksum, applied_at from schema_migrations order by name'
    );
    return r.rows;
}

/**
 * Read-only. Never writes anything except the ledger TABLE's existence, which is
 * `create table if not exists` and carries no data.
 */
async function status(client) {
    const bundled = listBundled();
    const applied = await ledgerState(client);
    const appliedByName = new Map(applied.map((r) => [r.name, r]));

    const migrations = bundled.map((name) => {
        const { checksum } = readMigration(name);
        const row = appliedByName.get(name);
        let state;
        if (!row) state = 'pending';
        else if (row.checksum !== checksum) state = 'checksum-mismatch';
        else state = 'applied';
        return {
            name,
            state,
            applied_at: row ? row.applied_at : null,
        };
    });

    // A ledger row whose file is not in the bundle — recorded elsewhere, or the
    // file was removed. Surfaced rather than hidden.
    const orphans = applied.filter((r) => !bundled.includes(r.name)).map((r) => r.name);

    return { ok: true, mode: 'status', migrations, orphan_ledger_rows: orphans };
}

// ---------------------------------------------------------------------------
// VERIFY — read-only structural and aggregate evidence
// ---------------------------------------------------------------------------
//
// RDS is private and there is no bastion, so without this there is no way to
// OBSERVE what a migration did — only to infer it from a Lambda exiting zero.
// That is not good enough for a migration carrying a data backfill.
//
// WHAT IT MAY REPORT, AND WHAT IT MAY NOT
//
// Structure (table / column / index / foreign-key / CHECK presence, and the
// CHECK's own predicate text, which is schema rather than data) and AGGREGATES
// (counts grouped by actor_type, counts of invalid attribution).
//
// It must NEVER return row-level data. No id, no name, no email, no claim, no
// connection string. Every query below is either a catalog lookup or a COUNT.
// claim_events is a PHI-adjacent audit stream; a debugging convenience that
// leaked one row of it would be a reportable disclosure, so the rule is
// absolute rather than case-by-case.
//
// Writes nothing. Not even the ledger table — verify() is called on a path that
// never invokes ensureLedger(), so it is safe against a database an operator is
// unsure about.

// What each migration is expected to have created. Keyed so the report reads as
// "023 landed" / "024 landed" rather than as a wall of object names.
const EXPECTED = {
    '023_partner_credentials': {
        tables: ['partner_credentials'],
        columns: [['partner_credentials', 'key_id'], ['partner_credentials', 'secret_hash'],
            ['partner_credentials', 'scopes'], ['partner_credentials', 'revoked_at'],
            ['audit_log', 'actor_partner_credential_id']],
        indexes: ['partner_credentials_active_key_idx', 'partner_credentials_practice_idx'],
        foreign_keys: [['partner_credentials', 'practices'], ['audit_log', 'partner_credentials']],
        checks: [['audit_log_actor_type_check', 'partner']],
    },
    // The EXPAND half, which arrives via schema.sql on an ordinary deploy.
    // Columns only — nullable, unconstrained. This is what makes the
    // partner-aware writer safe to ship.
    'expand_claim_event_attribution': {
        tables: [],
        columns: [['claim_events', 'actor_type'], ['claim_events', 'created_by_partner_credential_id']],
        indexes: ['idx_claim_events_partner_credential'],
        foreign_keys: [['claim_events', 'partner_credentials']],
        checks: [],
    },
    // The CONTRACT half, applied by the runner only after that writer is live.
    // Nothing here may appear before then: each of these is what breaks the
    // previously deployed writer.
    '024_partner_claim_event_attribution': {
        tables: [],
        columns: [],
        indexes: [],
        foreign_keys: [],
        checks: [['claim_events_actor_type_check', 'partner'], ['claim_events_one_actor_check', null]],
        not_null: [['claim_events', 'actor_type']],
    },
    '025_session_external_reference': {
        tables: [],
        columns: [['sessions', 'external_source'], ['sessions', 'external_id']],
        indexes: ['sessions_external_ref_uq', 'sessions_external_lookup_idx'],
        foreign_keys: [],
        checks: [['sessions_external_ref_check', 'sessionably']],
    },
};

async function objectPresence(client, spec) {
    const out = { tables: {}, columns: {}, indexes: {}, foreign_keys: {}, checks: {}, not_null: {} };

    for (const [t, c] of (spec.not_null || [])) {
        const r = await client.query(
            `select is_nullable from information_schema.columns
              where table_schema='public' and table_name=$1 and column_name=$2`, [t, c]);
        out.not_null[`${t}.${c}`] = r.rows.length > 0 && r.rows[0].is_nullable === 'NO';
    }

    for (const t of spec.tables) {
        const r = await client.query('select to_regclass($1) is not null as present', [`public.${t}`]);
        out.tables[t] = r.rows[0].present === true;
    }
    for (const [t, c] of spec.columns) {
        const r = await client.query(
            `select count(*)::int as n from information_schema.columns
              where table_schema = 'public' and table_name = $1 and column_name = $2`, [t, c]);
        out.columns[`${t}.${c}`] = r.rows[0].n > 0;
    }
    for (const i of spec.indexes) {
        const r = await client.query(
            `select count(*)::int as n from pg_indexes where schemaname='public' and indexname = $1`, [i]);
        out.indexes[i] = r.rows[0].n > 0;
    }
    for (const [t, ref] of spec.foreign_keys) {
        const r = await client.query(
            `select count(*)::int as n
               from pg_constraint c
               join pg_class src on src.oid = c.conrelid
               join pg_class tgt on tgt.oid = c.confrelid
              where c.contype = 'f' and src.relname = $1 and tgt.relname = $2`, [t, ref]);
        out.foreign_keys[`${t} -> ${ref}`] = r.rows[0].n > 0;
    }
    // The predicate TEXT is returned deliberately: "the constraint exists" is not
    // the same claim as "the constraint admits 'partner'", and the second is the
    // one that silently regresses (schema.sql re-adds this CHECK on every deploy).
    for (const [name, mustAdmit] of spec.checks) {
        const r = await client.query(
            `select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1 limit 1`, [name]);
        const def = r.rows.length ? r.rows[0].def : null;
        out.checks[name] = {
            present: def !== null,
            admits: mustAdmit === null ? null : (def !== null && def.includes(`'${mustAdmit}'`)),
        };
    }
    return out;
}

function allTrue(presence) {
    const vals = [];
    for (const group of ['tables', 'columns', 'indexes', 'foreign_keys', 'not_null']) {
        vals.push(...Object.values(presence[group] || {}));
    }
    for (const c of Object.values(presence.checks)) {
        vals.push(c.present);
        if (c.admits !== null) vals.push(c.admits);
    }
    return vals.length > 0 && vals.every((v) => v === true);
}

/**
 * Which phase of the expand/contract split the database is in, and — the part
 * that actually matters during a rollout — which WRITER SHAPES that phase can
 * accept.
 *
 * Derived from the catalog, never by attempting a write. A verification that
 * probed by inserting a row would be neither read-only nor safe to run against
 * production, and would leave fictional rows in a clinical audit stream.
 *
 *   pre-expansion  columns absent. Legacy writer only. Shipping the
 *                  partner-aware writer here breaks every claim-event insert.
 *   expanded       columns present, unconstrained. BOTH writers work. This is
 *                  the window the partner-aware deploy must land in.
 *   contracted     NOT NULL + both CHECKs. Partner-aware writer only; a legacy
 *                  SYSTEM event now fails, which is safe precisely because the
 *                  legacy writer is gone by then.
 */
function phaseOf(expandPresence, contractPresence) {
    const expanded = allTrue(expandPresence);
    const contracted = allTrue(contractPresence);
    if (!expanded) return 'pre-expansion';
    return contracted ? 'contracted' : 'expanded';
}

/**
 * Aggregate attribution health on claim_events. COUNTS ONLY.
 *
 * Works both BEFORE 024 (no actor_type column — grouped by whether created_by
 * is set, which is the distinction 024's backfill preserves) and AFTER it.
 *
 * `would_violate_one_actor` is the pre-flight that matters: it counts rows that
 * the post-backfill state would NOT satisfy. 024 adds the CHECK in the same
 * transaction as the backfill, so a single such row aborts the migration. Better
 * to know that before invoking it than from a rolled-back transaction.
 */
async function attribution(client, phase) {
    const total = (await client.query('select count(*)::int as n from claim_events')).rows[0].n;

    if (phase === 'pre-expansion') {
        const r = await client.query(`
            select count(*) filter (where created_by is null)::int     as would_be_system,
                   count(*) filter (where created_by is not null)::int as would_be_user
              from claim_events`);
        return {
            stage: 'pre-expansion',
            total_claim_events: total,
            projected_after_backfill: { system: r.rows[0].would_be_system, user: r.rows[0].would_be_user },
            would_violate_one_actor: total - (r.rows[0].would_be_system + r.rows[0].would_be_user),
        };
    }

    if (phase === 'expanded') {
        // The columns exist and are unconstrained. Rows written before the
        // expand carry NULL actor_type; rows written since carry a real one.
        // What 024 must backfill is exactly the NULL set, and the projection
        // below is the contract it has to satisfy.
        const r = await client.query(`
            select count(*) filter (where actor_type is null)::int as unattributed,
                   count(*) filter (where actor_type is null and created_by is null)::int     as would_be_system,
                   count(*) filter (where actor_type is null and created_by is not null)::int as would_be_user,
                   count(*) filter (where actor_type is not null)::int as already_attributed,
                   count(*) filter (where created_by is not null and created_by_partner_credential_id is not null)::int as both_actors
              from claim_events`);
        const b = r.rows[0];
        const byType = await client.query(
            'select actor_type, count(*)::int as n from claim_events group by actor_type order by actor_type nulls first');
        return {
            stage: 'expanded',
            total_claim_events: total,
            by_actor_type: Object.fromEntries(byType.rows.map((x) => [x.actor_type === null ? '(null)' : x.actor_type, x.n])),
            unattributed_rows: b.unattributed,
            projected_after_backfill: { system: b.would_be_system, user: b.would_be_user },
            already_attributed: b.already_attributed,
            // A row naming BOTH a user and a partner credential cannot be
            // repaired by a backfill and would abort 024's CHECK. Must be 0
            // before contracting.
            would_violate_one_actor: b.both_actors,
        };
    }

    const byType = await client.query(
        'select actor_type, count(*)::int as n from claim_events group by actor_type order by actor_type');
    const bad = await client.query(`
        select
          count(*) filter (where actor_type is null)::int as null_actor_type,
          count(*) filter (where actor_type = 'user'    and created_by is null)::int                        as user_without_creator,
          count(*) filter (where actor_type = 'partner' and created_by_partner_credential_id is null)::int  as partner_without_credential,
          count(*) filter (where actor_type = 'system'  and (created_by is not null or created_by_partner_credential_id is not null))::int as system_with_actor,
          count(*) filter (where created_by is not null and created_by_partner_credential_id is not null)::int as both_actors,
          count(*) filter (where actor_type not in ('user','system','partner'))::int as unknown_actor_type
          from claim_events`);
    const b = bad.rows[0];
    return {
        stage: 'contracted',
        total_claim_events: total,
        by_actor_type: Object.fromEntries(byType.rows.map((r) => [r.actor_type, r.n])),
        invalid: b,
        invalid_total: Object.values(b).reduce((a, v) => a + v, 0),
    };
}

async function verify(client) {
    const migrations = {};
    for (const [name, spec] of Object.entries(EXPECTED)) {
        const presence = await objectPresence(client, spec);
        migrations[name] = { structurally_present: allTrue(presence), objects: presence };
    }

    // Read the ledger WITHOUT creating it — verify must not write.
    let ledger = [];
    const hasLedger = await client.query("select to_regclass('public.schema_migrations') is not null as present");
    if (hasLedger.rows[0].present) {
        const r = await client.query('select name, applied_at from schema_migrations order by name');
        ledger = r.rows.map((x) => ({ name: x.name, applied_at: x.applied_at }));
    }

    const phase = phaseOf(
        migrations['expand_claim_event_attribution'].objects,
        migrations['024_partner_claim_event_attribution'].objects
    );

    return {
        ok: true,
        mode: 'verify',
        phase,
        // The rollout-safety question, stated directly rather than left for the
        // reader to infer from the object lists.
        writers: {
            // The writer deployed before #118: names neither new column.
            legacy_system_event_supported: phase !== 'contracted',
            // #118's writer: names actor_type and created_by_partner_credential_id.
            partner_aware_supported: phase !== 'pre-expansion',
        },
        migrations,
        attribution: await attribution(client, phase),
        ledger: { table_present: hasLedger.rows[0].present === true, rows: ledger },
    };
}

async function apply(client, name, force) {
    if (!NAME_RE.test(name)) {
        return { ok: false, mode: 'apply', message: 'migration name is not a valid migration filename' };
    }
    if (!listBundled().includes(name)) {
        return { ok: false, mode: 'apply', message: `migration ${name} is not in the deployed bundle` };
    }

    const { sql, checksum } = readMigration(name);

    // Serialise invokes for the whole tool. Session-level, released explicitly in
    // the finally below and by the connection ending regardless.
    await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);

    try {
        await ensureLedger(client);

        const prior = await client.query('select checksum, applied_at from schema_migrations where name = $1', [name]);
        if (prior.rows.length > 0) {
            const row = prior.rows[0];
            if (row.checksum !== checksum) {
                // Never forceable. The recorded run and the file on disk are
                // different SQL; re-running cannot converge them and would leave
                // the ledger describing something that never happened.
                return {
                    ok: false,
                    mode: 'apply',
                    message: `${name} was already applied with a DIFFERENT checksum — the file changed after it was applied. Resolve by hand; force will not override this.`,
                    applied_at: row.applied_at,
                };
            }
            if (!force) {
                return {
                    ok: true,
                    mode: 'apply',
                    skipped: true,
                    message: `${name} is already applied (checksum matches). Nothing to do.`,
                    applied_at: row.applied_at,
                };
            }
        }

        await client.query('begin');
        try {
            await client.query(stripTransactionWrappers(sql));
            await client.query(
                `insert into schema_migrations (name, checksum, applied_by)
                 values ($1, $2, $3)
                 on conflict (name) do update
                    set checksum = excluded.checksum, applied_at = now(), applied_by = excluded.applied_by`,
                [name, checksum, 'apply-migration-lambda']
            );
            await client.query('commit');
        } catch (err) {
            await client.query('rollback');
            throw err;
        }

        return { ok: true, mode: 'apply', applied: name, message: `${name} applied and recorded.` };
    } finally {
        await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    }
}

exports.handler = async (event) => {
    let client;
    try {
        // lib/db reads process.env.DATABASE_URL lazily on first query, so set it first.
        process.env.DATABASE_URL = await loadDatabaseUrl();

        const payload = (event && typeof event === 'object') ? event : {};
        // STRICT boolean. "true" (the string) is not true — a mistyped payload
        // must read as a status request, never as a write.
        const wantsApply = payload.apply === true;
        const force = payload.force === true;
        const name = typeof payload.migration === 'string' ? payload.migration.trim() : '';

        client = await db.getPool().connect();

        // VERIFY IS CHECKED FIRST, and returns unconditionally. A payload that
        // asks to verify can never fall through to a write, even if it also
        // carries apply:true — the read-only request wins, because the operator
        // who asked to look is not the operator who asked to change.
        if (payload.verify === true) {
            const out = await verify(client);
            console.log(`apply-migration: verify, phase=${out.phase} legacy_ok=${out.writers.legacy_system_event_supported} partner_ok=${out.writers.partner_aware_supported}`);
            return out;
        }

        if (!wantsApply) {
            const out = await status(client);
            console.log(`apply-migration: status, ${out.migrations.length} bundled`);
            return out;
        }

        if (!name) {
            return {
                ok: false,
                mode: 'apply',
                message: 'apply:true requires a "migration" name. Invoke with no payload for a status report.',
            };
        }

        const out = await apply(client, name, force);
        console.log(`apply-migration: ${out.ok ? 'ok' : 'refused'} ${name}`);
        return out;
    } catch (err) {
        // Log only the message — never the connection string or the environment.
        const message = (err && err.message) || 'apply-migration failed.';
        console.error('apply-migration error:', message);
        return { ok: false, message };
    } finally {
        if (client && typeof client.release === 'function') client.release();
    }
};

// Exported for tests. Not part of the Lambda contract.
exports._internals = { NAME_RE, stripTransactionWrappers, listBundled, MIGRATIONS_DIR, EXPECTED, verify, allTrue, phaseOf };
