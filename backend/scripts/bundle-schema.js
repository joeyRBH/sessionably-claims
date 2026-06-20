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
