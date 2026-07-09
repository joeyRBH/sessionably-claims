'use strict';

// Guardrail: no audit() call site may pass PHI into its metadata argument.
//
//   node backend/scripts/check-audit-no-phi.js
//
// The audit log records WHO/WHAT/WHICH/WHEN by id and field NAME only. It must
// never carry patient values. This script scans every audit( call across
// backend/handlers, extracts the metadata: { ... } argument, and fails if any of
// the PHI-value identifiers below appear there as a hardcoded key/value.
//
// Note this checks the SOURCE. Changed-field NAMES like 'date_of_birth' can
// legitimately appear in metadata.fields_changed at RUNTIME (via
// sanitizeFields()), but they are field names, not values, and never appear as
// literals in the source metadata object — so a source scan is the right check.

const fs = require('fs');
const path = require('path');

const HANDLERS_DIR = path.join(__dirname, '..', 'handlers');

// Identifiers that would signal a raw PHI value being logged.
const FORBIDDEN = /\b(first_name|last_name|date_of_birth|member_id|dob|diagnosis)\b/;

// Return the substring from the open paren after `audit` to its matching close.
function extractCallArgs(src, openParenIdx) {
  let depth = 0;
  for (let i = openParenIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return src.slice(openParenIdx + 1, i);
    }
  }
  return null;
}

// Given a call's argument text, return the balanced value of its `metadata:` key
// (an object literal or a single expression), or null when there is none.
function extractMetadata(argsText) {
  const key = /metadata\s*:/g;
  const m = key.exec(argsText);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (i < argsText.length && /\s/.test(argsText[i])) i++;
  if (argsText[i] === '{') {
    let depth = 0;
    for (let j = i; j < argsText.length; j++) {
      const c = argsText[j];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return argsText.slice(i, j + 1);
      }
    }
    return argsText.slice(i); // unbalanced — check what we have
  }
  // Non-object value: read to the next top-level comma / end.
  let depth = 0;
  for (let j = i; j < argsText.length; j++) {
    const c = argsText[j];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) return argsText.slice(i, j);
  }
  return argsText.slice(i);
}

const violations = [];
let callsChecked = 0;

const files = fs.readdirSync(HANDLERS_DIR).filter((f) => f.endsWith('.js'));
for (const file of files) {
  const full = path.join(HANDLERS_DIR, file);
  const src = fs.readFileSync(full, 'utf8');
  // Match a call to audit( — with a word boundary before, so buildAuditEntry(
  // and comments-in-identifiers do not match.
  const callRe = /(^|[^A-Za-z0-9_.])audit\s*\(/g;
  let match;
  while ((match = callRe.exec(src)) !== null) {
    const openParen = src.indexOf('(', match.index + match[0].length - 1);
    const args = extractCallArgs(src, openParen);
    if (args == null) continue;
    callsChecked++;
    const metadata = extractMetadata(args);
    if (metadata && FORBIDDEN.test(metadata)) {
      const line = src.slice(0, openParen).split('\n').length;
      violations.push(`${file}:${line} — metadata contains a PHI identifier: ${metadata.trim()}`);
    }
  }
}

if (violations.length) {
  console.error('FAIL: PHI identifiers found in audit() metadata:');
  violations.forEach((v) => console.error('  ' + v));
  process.exit(1);
}

console.log(`OK: ${callsChecked} audit() call sites scanned across ${files.length} handlers; no PHI in metadata.`);
