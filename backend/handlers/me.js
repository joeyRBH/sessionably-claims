'use strict';

// GET /me — return the current user plus a small practice summary. 401 if no/bad token.

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const { publicUser } = require('../lib/util');

exports.handler = async (event) => {
  if (event && event.httpMethod === 'OPTIONS') {
    return preflight(event);
  }

  let auth;
  try {
    auth = requireAuth(event);
  } catch (err) {
    return json(err.statusCode || 401, { error: 'Unauthorized' }, event);
  }

  try {
    // Re-load from the DB so a deactivated user (or changed role) can't keep acting
    // on a still-valid token.
    const res = await db.query(
      `select u.*, p.name as practice_name
         from users u
         join practices p on p.id = u.practice_id
        where u.id = $1 and u.is_active = true
        limit 1`,
      [auth.user.sub]
    );
    const row = res.rows[0];
    if (!row) {
      return json(401, { error: 'Unauthorized' }, event);
    }

    return json(
      200,
      {
        user: publicUser(row),
        practice: {
          id: row.practice_id,
          name: row.practice_name,
          role: row.role, // the current user's role within the practice
        },
      },
      event
    );
  } catch (err) {
    console.error('me error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
