'use strict';

// Static guard — a module-level SHARED CONSTANT in a browser view must never be
// re-declared with `var` deeper in the same file.
//
// WHY THIS TEST EXISTS. public/app/views/clients.js declared, inside
// insurancePanel():
//
//     var INSURANCE_FIELDS = { member_id: 1, subscriber_name: 1, subscriber_dob: 1 };
//
// while the top of the same file already had the form's field ARRAY under that
// exact name. `var` is function-scoped and hoists, so the inner declaration
// shadowed the outer one across the whole of insurancePanel — including
// openForm(), which does `INSURANCE_FIELDS.forEach(...)`. Every click on "Edit
// insurance" and "Add insurance" threw `INSURANCE_FIELDS.forEach is not a
// function` and opened nothing at all. Silent in the UI, obvious in the console,
// and invisible to every backend test in this suite.
//
// SCOPE. Only module-level UPPER_SNAKE_CASE names — a file's shared constant
// vocabulary. Those are never meaningfully re-declared deeper down, so a second
// `var` of that name is always the mistake above. Ordinary lower-case locals
// (`rows`, `body`, `payload`) legitimately repeat across sibling functions and
// are deliberately NOT checked; flagging them would be pure noise.
//
//   node backend/tests/frontend_constant_shadowing.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

function jsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) jsFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Every `var NAME =` in the file, with its 1-based line and its indentation.
// Module level inside the standard `(function (window, document) { ... })` IIFE
// these views use is two spaces; anything deeper is inside a function.
function varDeclarations(src) {
  const out = [];
  const re = /(^|\n)([ \t]*)var[ \t]+([A-Za-z_$][\w$]*)[ \t]*=/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({
      name: m[3],
      indent: m[2].length,
      line: src.slice(0, m.index).split('\n').length + (m[1] === '\n' ? 1 : 0),
    });
  }
  return out;
}

const MODULE_INDENT = 2;
const SHARED_CONSTANT = /^[A-Z][A-Z0-9_]*$/;

const files = jsFiles(PUBLIC_DIR);
assert.ok(files.length > 0, 'found JavaScript under public/');

const offenders = [];

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const decls = varDeclarations(src);

  const moduleConstants = new Map();   // name -> line
  for (const d of decls) {
    if (d.indent === MODULE_INDENT && SHARED_CONSTANT.test(d.name)) {
      moduleConstants.set(d.name, d.line);
    }
  }

  for (const d of decls) {
    if (d.indent <= MODULE_INDENT) continue;           // the declaration itself
    if (!moduleConstants.has(d.name)) continue;
    offenders.push(
      `${path.relative(PUBLIC_DIR, file)}: \`var ${d.name}\` at line ${d.line} ` +
      `shadows the module-level constant at line ${moduleConstants.get(d.name)}`
    );
  }
}

assert.deepStrictEqual(
  offenders,
  [],
  'A module-level shared constant is re-declared with `var` deeper in the same ' +
  'file. `var` hoists to the whole enclosing function, so every use of the outer ' +
  'constant inside that function silently reads the inner one instead. Rename ' +
  'the inner declaration.\n  ' + offenders.join('\n  ')
);

// The specific regression: clients.js must still expose INSURANCE_FIELDS as an
// ARRAY of form fields (what openForm iterates), and the discrepancy lookups
// must carry their own names.
const clientsSrc = fs.readFileSync(
  path.join(PUBLIC_DIR, 'app', 'views', 'clients.js'), 'utf8'
);
assert.match(
  clientsSrc, /\n {2}var INSURANCE_FIELDS = \[/,
  'clients.js declares INSURANCE_FIELDS as a module-level array'
);
assert.doesNotMatch(
  clientsSrc, /\n {3,}var INSURANCE_FIELDS\b/,
  'nothing re-declares INSURANCE_FIELDS inside a function'
);
assert.doesNotMatch(
  clientsSrc, /\n {3,}var CLIENT_FIELDS\b/,
  'nothing re-declares CLIENT_FIELDS inside a function'
);
assert.match(
  clientsSrc, /INSURANCE_FIELDS\.forEach\(/,
  'openForm still builds its field list from the INSURANCE_FIELDS array'
);

console.log('frontend_constant_shadowing: ok');
