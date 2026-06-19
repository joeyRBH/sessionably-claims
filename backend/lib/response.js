'use strict';

// HTTP response helper with CORS for API Gateway proxy integration.

const ALLOWED_ORIGINS = ['https://app.claimsub.com', 'https://claimsub.com'];

// Echo the request Origin only if it's allowlisted; otherwise fall back to the
// app origin. Never reflect an arbitrary origin.
function resolveOrigin(event) {
  const headers = (event && event.headers) || {};
  const origin = headers.origin || headers.Origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }
  return ALLOWED_ORIGINS[0];
}

function corsHeaders(event) {
  return {
    'Access-Control-Allow-Origin': resolveOrigin(event),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

module.exports = { json, preflight, corsHeaders, ALLOWED_ORIGINS };
