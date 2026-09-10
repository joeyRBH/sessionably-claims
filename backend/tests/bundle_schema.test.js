'use strict';

// Unit test — the build step that assembles backend/sql/ (backend/scripts/bundle-schema.js).
//
// WHY THIS EXISTS
//
// The bundle is not just a copy: it is the set of migrations the one-off runner
// (backend/handlers/apply_migration.js) can invoke in production. A file that
// lingers there is a migration that can be APPLIED on a deploy that does not
// contain it.
//
// That happened. The first version copied into backend/sql/migrations without
// clearing it, so building PR-A on a checkout that had previously built #118
// left 024 in the bundle — a contract migration made invocable before the
// writer it depends on had shipped, which is the precise ordering failure the
// expand/contract split exists to prevent. A fresh clone hides the bug, because
// there is nothing left over to go stale; it only appears on a reused deploy
// checkout, which is exactly what a deploy machine is.
//
//   node backend/tests/bundle_schema.test.js

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const MIG_DEST = path.join(REPO, 'backend', 'sql', 'migrations');
const SCHEMA_DEST = path.join(REPO, 'backend', 'sql', 'schema.sql');
const MIG_SRC = path.join(REPO, 'db', 'migrations');

function bundle() {
    execFileSync(process.execPath, [path.join(REPO, 'backend', 'scripts', 'bundle-schema.js')], { stdio: 'pipe' });
}

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

const tracked = fs.readdirSync(MIG_SRC).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();

check('the bundle reproduces exactly the migrations in db/migrations', () => {
    bundle();
    const bundled = fs.readdirSync(MIG_DEST).filter((f) => f.endsWith('.sql')).sort();
    assert.deepEqual(bundled, tracked,
        'the bundled migration set does not match db/migrations');
});

check('schema.sql is bundled', () => {
    assert.ok(fs.existsSync(SCHEMA_DEST), 'backend/sql/schema.sql was not produced');
});

// THE REGRESSION. A stale file must not survive a rebuild.
check('a migration no longer in db/migrations is REMOVED from the bundle', () => {
    const stale = path.join(MIG_DEST, '999_stale_from_another_branch.sql');
    fs.writeFileSync(stale, '-- left over from a previous build on this checkout\n');
    assert.ok(fs.existsSync(stale), 'fixture was not created');

    bundle();

    assert.ok(!fs.existsSync(stale),
        'a migration absent from db/migrations survived the rebuild — it would ship in the deploy artifact and be invocable by the one-off runner');
});

check('the rebuild is still complete after clearing', () => {
    const bundled = fs.readdirSync(MIG_DEST).filter((f) => f.endsWith('.sql')).sort();
    assert.deepEqual(bundled, tracked, 'clearing the directory dropped real migrations');
    assert.ok(bundled.length > 0, 'the bundle is empty');
});

// Non-migration files in db/migrations (README.md) must not be shipped: the
// runner's name whitelist would reject them anyway, and a bundle that mirrors
// the directory exactly is easier to reason about than one that filters twice.
check('only NNN_*.sql is bundled, never README.md', () => {
    const bundled = fs.readdirSync(MIG_DEST);
    assert.ok(!bundled.includes('README.md'), 'README.md was copied into the bundle');
    for (const f of bundled) {
        assert.match(f, /^\d{3}_[a-z0-9_]+\.sql$/, `unexpected file in the bundle: ${f}`);
    }
});

if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log('\nall bundle checks passed');
