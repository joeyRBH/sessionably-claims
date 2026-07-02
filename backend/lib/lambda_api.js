'use strict';

// Minimal client the /api Vercel adapters use to reach the VPC Lambda API for DB
// work they can't do directly: the RDS is VPC-private and unreachable from Vercel,
// while the Lambda API (api.claimsub.com, public behind API Gateway) owns DB access.
// Vercel has outbound HTTPS, so the adapters call in here and keep only their
// Stripe/Twilio call. Override the base with LAMBDA_API_BASE if needed.

const BASE = (process.env.LAMBDA_API_BASE || 'https://api.claimsub.com').replace(/\/+$/, '');

// callLambda(path, { method, token, body }) -> { status, ok, data }
// `token` is forwarded verbatim as the Authorization header (staff Bearer JWT);
// omit it for token-in-body (card-setup) or signature-authed routes.
async function callLambda(path, opts) {
  opts = opts || {};
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (opts.token) headers.Authorization = opts.token;

  const resp = await fetch(BASE + path, {
    method: opts.method || 'POST',
    headers,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });

  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, ok: resp.ok, data };
}

module.exports = { callLambda, BASE };
