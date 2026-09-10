'use strict';

// Build step: copy db/schema.sql into the Lambda package so handlers/migrate.js
// can read it at runtime. db/schema.sql stays the SINGLE source of truth; the
// copy (backend/sql/schema.sql) is gitignored and regenerated, never edited.
//
// Run before `terraform apply` (which zips /backend):  npm run bundle:schema

const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', '..', 'db', 'schema.sql');
const destDir = path.join(__dirname, '..', 'sql');
const dest = path.join(destDir, 'schema.sql');

if (!fs.existsSync(src)) {
  console.error(`bundle:schema: source not found: ${src}`);
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);

console.log(`bundle:schema: copied ${path.relative(process.cwd(), src)} -> ${path.relative(process.cwd(), dest)}`);

// Also ship db/migrations/ so the one-off apply-migration Lambda
// (backend/handlers/apply_migration.js) can read a named migration at runtime.
// RDS is private and there is no bastion, so a migration that must NOT be folded
// into schema.sql — one carrying a data backfill, or one whose timing must be
// operator-controlled — has no other way to reach the database.
//
// Only NNN_*.sql is copied: README.md and anything else in that directory is not
// a migration and the Lambda's name whitelist would reject it anyway.
const migSrcDir = path.join(__dirname, '..', '..', 'db', 'migrations');
const migDestDir = path.join(destDir, 'migrations');

if (fs.existsSync(migSrcDir)) {
  // CLEAR FIRST. This directory is a build artifact, and copying into it without
  // clearing only ever ACCUMULATES: a migration deleted, renamed, or simply not
  // present on the branch being built lingers from whatever was built here last.
  //
  // That is not cosmetic. The bundle is what the one-off runner can invoke, so a
  // stale file makes a migration invocable on a deploy that does not contain it
  // — which for the expand/contract pair means 024 could be applied before the
  // writer it depends on has shipped, the exact ordering failure the split
  // exists to prevent. Caught on a reused deploy checkout; a fresh clone hides
  // it, because there is nothing left over to go stale.
  fs.rmSync(migDestDir, { recursive: true, force: true });
  fs.mkdirSync(migDestDir, { recursive: true });
  const files = fs.readdirSync(migSrcDir).filter((f) => /^\d{3}_.*\.sql$/.test(f));
  for (const f of files) {
    fs.copyFileSync(path.join(migSrcDir, f), path.join(migDestDir, f));
  }
  console.log(`bundle:schema: copied ${files.length} migration file(s) -> ${path.relative(process.cwd(), migDestDir)}`);
} else {
  console.log('bundle:schema: no db/migrations directory; skipping migration bundle');
}
