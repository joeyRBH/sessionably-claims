'use strict';

// One-off schema-migration Lambda (claimsub-<env>-migrate).
//
// Applies db/schema.sql to the database from inside the VPC, so no bastion or
// public DB access is needed. Unlike the auth handlers, this one reads the
// connection string from SSM at RUNTIME (the parameter named by
// DATABASE_URL_SSM_PARAM), reached via the SSM interface endpoint — so there is
// no separate out-of-band env-hydration step.
//
// schema.sql is bundled next to this handler at build time (see
// scripts/bundle-schema.js); db/schema.sql stays the single source of truth.
// It uses "create ... if not exists" / "create or replace", so applying it is
// idempotent and this Lambda is safe to invoke repeatedly.
//
// Security: NEVER log the connection string (or anything derived from it).

const fs = require('fs');
const path = require('path');
// @aws-sdk/client-ssm is provided by the Node 20 Lambda runtime — not bundled
// in package.json, so the auth zip is unaffected.
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const db = require('../lib/db');

// Copied here by `npm run bundle:schema` (db/schema.sql -> backend/sql/schema.sql).
const SCHEMA_PATH = path.join(__dirname, '..', 'sql', 'schema.sql');

async function loadDatabaseUrl() {
  // Allow a pre-set env var (local runs); otherwise fetch the SecureString from SSM.
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const name = process.env.DATABASE_URL_SSM_PARAM;
  if (!name) {
    throw new Error('DATABASE_URL_SSM_PARAM is not set');
  }

  const ssm = new SSMClient({}); // region comes from the Lambda runtime (AWS_REGION).
  const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = out && out.Parameter && out.Parameter.Value;
  if (!value) {
    throw new Error('DATABASE_URL SSM parameter is empty');
  }
  return value;
}

exports.handler = async () => {
  try {
    // lib/db reads process.env.DATABASE_URL lazily on first query, so set it first.
    process.env.DATABASE_URL = await loadDatabaseUrl();

    const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');

    // node-postgres runs a multi-statement string as one simple-query batch in a
    // single implicit transaction. No parameters → no interpolation risk.
    await db.query(sql);

    console.log('migrate: schema applied');
    return { ok: true, message: 'Schema applied successfully.' };
  } catch (err) {
    // Log only the message — never the connection string or full environment.
    const message = (err && err.message) || 'Migration failed.';
    console.error('migrate error:', message);
    return { ok: false, message };
  }
};
