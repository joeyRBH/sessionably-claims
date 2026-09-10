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
exports._internals = { NAME_RE, stripTransactionWrappers, listBundled, MIGRATIONS_DIR };
