'use strict';

// HTTP response helper with CORS for API Gateway proxy integration.

// The live app origin comes first: it is both the common case and the fallback that
// resolveOrigin() echoes for an unrecognized Origin. The pre-rebrand hosts stay listed
// so any still-deployed client keeps working.
const ALLOWED_ORIGINS = [
  'https://claims.sessionably.com',
  'https://app.claimsub.com',
  'https://claimsub.com',
  'https://app.reddably.com',
  'https://reddably.com',
];

// What to echo when the Origin is missing or not allowlisted. Named, not an index:
// callers used to reach for ALLOWED_ORIGINS[0] here and ALLOWED_ORIGINS[length - 1]
// in the Vercel adapters, so the two fallbacks silently disagreed.
const DEFAULT_ORIGIN = 'https://claims.sessionably.com';

// Echo the request Origin only if it's allowlisted; otherwise fall back to the
// app origin. Never reflect an arbitrary origin.
function resolveOrigin(event) {
  const headers = (event && event.headers) || {};
  const origin = headers.origin || headers.Origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }
  return DEFAULT_ORIGIN;
}

function corsHeaders(event) {
  return {
    'Access-Control-Allow-Origin': resolveOrigin(event),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// json(statusCode, body, event) -> API Gateway proxy response.
function json(statusCode, body, event) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(event),
    },
    body: JSON.stringify(body === undefined ? {} : body),
  };
}

// Preflight response for OPTIONS requests.
function preflight(event) {
  return {
    statusCode: 204,
    headers: corsHeaders(event),
    body: '',
  };
}

module.exports = { json, preflight, corsHeaders, ALLOWED_ORIGINS, DEFAULT_ORIGIN };
