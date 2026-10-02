'use strict';

// The practice's own session defaults (practices.default_*, migration 030), loaded for
// the paths that resolve a new session's billing fields (POST /sessions and the
// calendar promote). One query text, narrowed to exactly the columns
// applyClientDefaults reads — practices carries tax_id, Stripe ids and more that these
// paths have no business pulling into memory.
//
// `run` is any (sql, params) => Promise<{rows}>: db.query, or a transaction's query.

const PRACTICE_DEFAULTS_SQL =
  `select default_cpt_code, default_place_of_service, default_session_fee,
          default_procedure_modifiers, default_session_duration_minutes
     from practices
    where id = $1
    limit 1`;

async function loadPracticeDefaults(run, practiceId) {
  const res = await run(PRACTICE_DEFAULTS_SQL, [practiceId]);
  return (res && res.rows && res.rows[0]) || null;
}

module.exports = { PRACTICE_DEFAULTS_SQL, loadPracticeDefaults };
