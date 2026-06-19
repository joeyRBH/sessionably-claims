'use strict';

// Auth middleware: turn a Bearer token into the authenticated principal, or 401.

const { verify } = require('./jwt');

// Thrown when authentication fails. Handlers catch this and return 401.
class AuthError extends Error {
  constructor(message) {
    super(message || 'Unauthorized');
    this.name = 'AuthError';
    this.statusCode = 401;
  }
}

function extractBearer(event) {
  const headers = (event && event.headers) || {};
  // API Gateway header casing is not guaranteed.
  const raw = headers.authorization || headers.Authorization;
  if (!raw) return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1].trim() : null;
}

// requireAuth(event) -> { user } where user is the decoded token payload
// ({ sub, practice_id, role, iat, exp }). Throws AuthError (statusCode 401) on
// a missing/invalid/expired token. Never logs the token.
function requireAuth(event) {
  const token = extractBearer(event);
  if (!token) {
    throw new AuthError('Missing bearer token');
  }
  try {
    const decoded = verify(token);
    return { user: decoded };
  } catch (_) {
    // Swallow the underlying jwt error detail — don't leak it to the client/logs.
    throw new AuthError('Invalid or expired token');
  }
}

module.exports = { requireAuth, AuthError };
