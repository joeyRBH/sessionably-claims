'use strict';

// Unit test — db/schema.sql carries the migrations that were folded into it.
//
// WHY THIS TEST EXISTS
//
// db/migrations/README.md has always said "keep schema.sql in sync: when you add
// a migration, also fold the change into schema.sql". Every migration through
// 022 did. Migrations 023 and 025 did not, and nothing noticed — because nothing
// checked.
//
// That is not a tidiness problem. schema.sql is the ONLY thing that reaches this
// database on a deploy (the migrate Lambda applies it; RDS is private and there
// is no bastion). A migration missing from it is a migration that never runs, so
// #116 merged code referencing a partner_credentials table that would not exist.
//
// This test makes the convention machine-checked, so the same drift cannot recur
// silently.
//
// It asserts the OBJECTS are present, not that the text matches the migration
// file byte for byte — schema.sql legitimately reformats and re-comments what it
// folds. Structural equivalence between the two paths was proven separately by
// applying each to an empty database and diffing pg_dump output.
//
//   node backend/tests/schema_folded_migrations.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const schemaPath = path.join(__dirname, '..', '..', 'db', 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');

// Comments explain intent and frequently quote the very SQL being discussed, so
// a naive grep passes against a description of a table that is never created.
// Strip line comments before asserting anything.
const sql = schema
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ok    ${name}`);
    } catch (err) {
        failures += 1;
        console.error(`  FAIL  ${name}`);
        console.error(`        ${err.message}`);
    }
}

function has(re, what) {
    assert.ok(re.test(sql), `schema.sql does not create ${what} — it would never exist in a deployed database`);
}

// The body of one CREATE TABLE, so a column assertion cannot be satisfied by an
// identical line belonging to a different table. `references practices (id) on
// delete restrict` appears on a dozen tables; without this, asserting it for
// partner_credentials passes even when that table is absent entirely.
function tableBody(name) {
    const m = sql.match(new RegExp(`create table if not exists ${name}\\s*\\(([\\s\\S]*?)\\n\\s*\\);`, 'i'));
    assert.ok(m, `schema.sql does not create the ${name} table — it would never exist in a deployed database`);
    return m[1];
}

// ---------------------------------------------------------------------------
// Migration 023 — partner credentials
// ---------------------------------------------------------------------------

check('023: partner_credentials table is created', () => {
    has(/create table if not exists partner_credentials\s*\(/i, 'the partner_credentials table');
});

check('023: partner_credentials is scoped to one practice, ON DELETE RESTRICT', () => {
    const body = tableBody('partner_credentials');
    assert.ok(
        /practice_id\s+uuid not null references practices \(id\) on delete restrict/i.test(body),
        'partner_credentials does not bind practice_id to practices with ON DELETE RESTRICT — the scope would not come from the row'
    );
});

check('023: key_id is unique (it is the lookup key)', () => {
    const body = tableBody('partner_credentials');
    assert.ok(
        /key_id\s+text not null unique/i.test(body),
        'partner_credentials.key_id is not UNIQUE — the credential lookup would not be single-valued'
    );
});

check('023: the active-key partial index excludes revoked credentials', () => {
    has(/create index if not exists partner_credentials_active_key_idx[\s\S]{0,200}?where revoked_at is null/i,
        'partner_credentials_active_key_idx as a partial index on revoked_at is null');
});

check('023: audit_log gains the partner credential column', () => {
    has(/add column if not exists actor_partner_credential_id uuid[\s\S]{0,120}?references partner_credentials \(id\)/i,
        'audit_log.actor_partner_credential_id');
});

// The one that actually bit. This CHECK is dropped and re-added by a do-block on
// EVERY deploy, so a narrower predicate does not fail to widen it — it reverts
// it, and partner audit writes start failing on a system that worked an hour ago.
check("023: EVERY audit_log actor_type CHECK admits 'partner'", () => {
    const checks = sql.match(/check \(actor_type in \([^)]*\)\)/gi) || [];
    assert.ok(checks.length > 0, 'no audit_log actor_type CHECK found at all');
    for (const c of checks) {
        assert.ok(
            /'partner'/.test(c),
            `an actor_type CHECK omits 'partner' and would revert the widened constraint on the next deploy: ${c}`
        );
    }
});

// ---------------------------------------------------------------------------
// Migration 025 — session external reference
// ---------------------------------------------------------------------------

check('025: sessions gains external_source and external_id', () => {
    has(/alter table sessions add column if not exists external_source text/i, 'sessions.external_source');
    has(/alter table sessions add column if not exists external_id\s+text/i, 'sessions.external_id');
});

check('025: the pair travels together, and only a known partner may claim one', () => {
    has(/sessions_external_ref_check[\s\S]{0,400}?external_source in \('sessionably'\)/i,
        'sessions_external_ref_check');
});

// This unique index — not application logic — is what makes partner session
// creation idempotent: a retry-after-timeout raises 23505 instead of a twin.
check('025: the idempotency index is UNIQUE and PARTIAL', () => {
    has(/create unique index if not exists sessions_external_ref_uq[\s\S]{0,200}?where external_id is not null/i,
        'sessions_external_ref_uq as a partial unique index');
});

check('025: the partner lookup index exists', () => {
    has(/create index if not exists sessions_external_lookup_idx/i, 'sessions_external_lookup_idx');
});

// ---------------------------------------------------------------------------
// The ledger the one-off runner writes to
// ---------------------------------------------------------------------------

check('schema_migrations ledger is declared', () => {
    has(/create table if not exists schema_migrations\s*\(/i, 'the schema_migrations ledger');
});

// ---------------------------------------------------------------------------
// schema.sql runs as ONE implicit transaction
// ---------------------------------------------------------------------------

check('no folded migration left a standalone begin;/commit; behind', () => {
    const stray = sql
        .split('\n')
        .map((l, i) => [i + 1, l.trim()])
        .filter(([, l]) => /^(begin|commit)\s*;$/i.test(l));
    assert.deepEqual(
        stray,
        [],
        `schema.sql is executed as a single simple-query batch in one implicit transaction; a standalone commit; would end it early. Found at line(s): ${stray.map(([n]) => n).join(', ')}`
    );
});

if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log('\nall schema fold checks passed');
