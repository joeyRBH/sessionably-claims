'use strict';

// Module-scope pg Pool, reused across warm Lambda invocations.
// Never string-concatenate SQL — use parameterized queries only.

const { Pool, types } = require('pg');

// Treat PostgreSQL `date` (OID 1082) as a plain 'YYYY-MM-DD' string instead of a
// JS Date. By default node-postgres parses a date-only column into a Date at
// *local* midnight; JSON-serializing that (toISOString) then shifts it by the
// process timezone, so a date of birth entered as the 14th comes back to the
// browser as "…T00:00:00Z" and renders as the 13th in Mountain time. Date-only
// values (date_of_birth, session_date, subscriber_dob, vob_period_start) have no
// time or zone, so we keep the raw string end to end and never build a Date from
// it. `timestamptz` (OID 1184) is unaffected and still parses to a Date.
types.setTypeParser(1082, (value) => value);

// One pool per warm container. Lazily created so requiring this module never
// throws if DATABASE_URL is briefly unset (e.g. during cold-start config load).
let pool;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // RDS requires TLS. Set DB_SSL=disable only for local dev against a
      // plaintext Postgres. rejectUnauthorized:false trusts the RDS CA chain
      // without bundling it; tighten with a CA cert if your posture requires.
      ssl: process.env.DB_SSL === 'disable' ? false : { rejectUnauthorized: false },
      // Keep the pool small — Lambda concurrency multiplies connections.
      max: Number(process.env.DB_POOL_MAX || 2),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }
  return pool;
}

// Parameterized query helper. `params` are bound by the driver, never interpolated.
function query(text, params) {
  return getPool().query(text, params);
}

// Run a function inside a transaction with a dedicated client.
// Commits on success, rolls back on any throw, always releases the client.
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore rollback failure; surface the original error */
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getPool, query, withTransaction };
