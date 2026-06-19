'use strict';

// POST /login — email + password. Generic 401 on any failure (no enumeration).

const db = require('../lib/db');
const { compare } = require('../lib/password');
const { sign } = require('../lib/jwt');
const { json, preflight } = require('../lib/response');
const { normalizeEmail, publicUser, parseBody } = require('../lib/util');

const GENERIC_401 = { error: 'Invalid email or password' };

exports.handler = async (event) => {
  if (event && event.httpMethod === 'OPTIONS') {
    return preflight(event);
  }
  try {
    const body = parseBody(event);
    const email = normalizeEmail(body.email);
    const password = body.password;

    if (!email || !password) {
      return json(401, GENERIC_401, event);
    }

    const res = await db.query(
      `select * from users where email = $1 and is_active = true limit 1`,
      [email]
    );
    const user = res.rows[0];

    // Always run compare to keep timing uniform whether or not the user exists.
    const ok = await compare(password, user ? user.password_hash : null);
    if (!user || !ok) {
      return json(401, GENERIC_401, event);
    }

    // Best-effort last_login_at; don't fail the login if this update hiccups.
    try {
      await db.query(`update users set last_login_at = now() where id = $1`, [user.id]);
    } catch (e) {
      console.error('last_login_at update failed:', e && e.message);
    }

    const token = sign(user);
    return json(200, { token, user: publicUser(user) }, event);
  } catch (err) {
    console.error('login error:', err && err.message); // never log credentials
    return json(500, { error: 'Internal server error' }, event);
  }
};
