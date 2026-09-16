'use strict';

// POST /me/password — the signed-in user changes their OWN password.
//
//   { current_password, new_password } -> 200 { ok: true }
//
// SELF ONLY, ALWAYS. There is deliberately no {id} and no admin path: this
// endpoint can only ever rewrite the password_hash of the user the bearer token
// names. A practice admin resetting a colleague's password is a different
// feature (it needs an out-of-band delivery channel so the admin never learns the
// new secret) and is not smuggled in here.
//
// Knowing the CURRENT password is required even though the caller already holds a
// valid token. A token can be lifted from a left-open laptop; requiring the
// current password means a stolen session cannot be turned into permanent account
// takeover in one request.
//
// An OAuth-only account (password_hash null) cannot use this endpoint to MINT a
// first password — that would let anyone holding a Google-issued session add a
// second, independent credential silently. Those users are told to keep using
// Google.
//
// Never logs, echoes, or audits a password. The audit row records only that the
// change happened; there is no metadata beyond that.

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { hash, compare, validate } = require('../lib/password');
const { json, preflight } = require('../lib/response');
const { parseBody } = require('../lib/util');
const { audit } = require('../lib/audit');

function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

// Pure decision layer, exported for unit tests: given the stored user row and the
// submitted body, what should happen? Returns { ok: true } or
// { ok: false, status, error }. Does no I/O and never sees a hash comparison —
// the caller performs the bcrypt compare and passes the result in.
//
// `currentMatches` is only meaningful once the row has a password_hash; the
// caller passes null when it did not need to check.
function decide(user, body, currentMatches) {
  if (!user || user.is_active === false) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  if (!user.password_hash) {
    return {
      ok: false,
      status: 409,
      error: 'This account signs in with Google and has no password to change.',
    };
  }

  const current = body && body.current_password;
  const next = body && body.new_password;

  if (typeof current !== 'string' || current === '') {
    return { ok: false, status: 400, error: 'Your current password is required.' };
  }

  const policy = validate(next);
  if (policy) return { ok: false, status: 400, error: policy };

  if (next === current) {
    return {
      ok: false,
      status: 400,
      error: 'Your new password must be different from your current one.',
    };
  }

  // Checked LAST so an invalid new password is reported without the caller having
  // to get the current one right first — and, more importantly, so this endpoint
  // is not a password oracle that answers faster for a wrong current password
  // than for a malformed new one.
  if (currentMatches !== true) {
    return { ok: false, status: 400, error: 'Your current password is incorrect.' };
  }

  return { ok: true };
}

exports.handler = async (event) => {
  const method = httpMethod(event);
  if (method === 'OPTIONS') return preflight(event);
  if (method !== 'POST') return json(405, { error: 'Method not allowed' }, event);

  let auth;
  try {
    auth = requireAuth(event);
  } catch (err) {
    return json(err.statusCode || 401, { error: 'Unauthorized' }, event);
  }

  try {
    const res = await db.query(
      `select id, practice_id, password_hash, is_active from users where id = $1 limit 1`,
      [auth.user.sub]
    );
    const user = res.rows[0] || null;
    if (!user || user.is_active === false) {
      return json(401, { error: 'Unauthorized' }, event);
    }

    const body = parseBody(event) || {};

    // Only run bcrypt once we know a current password was actually supplied.
    let currentMatches = null;
    if (user.password_hash && typeof body.current_password === 'string' && body.current_password !== '') {
      currentMatches = await compare(body.current_password, user.password_hash);
    }

    const verdict = decide(user, body, currentMatches);
    if (!verdict.ok) return json(verdict.status, { error: verdict.error }, event);

    const newHash = await hash(body.new_password);
    await db.query(`update users set password_hash = $1 where id = $2`, [newHash, user.id]);

    // WHO/WHAT/WHEN only. No metadata at all — there is nothing about a password
    // change that belongs in a log, not even its length.
    await audit(event, { userId: user.id, practiceId: user.practice_id }, {
      action: 'auth.password_change',
      resourceType: 'auth',
      resourceId: user.id,
    });

    // No token is reissued: the existing session stays valid, so changing a
    // password does not sign the person out of the tab they are standing in.
    return json(200, { ok: true }, event);
  } catch (err) {
    // Never log the body — it carries both passwords in plaintext.
    console.error('password error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};

exports.decide = decide;
