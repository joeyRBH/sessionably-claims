'use strict';

// Subscription / billing resource — one Lambda, one route:
//
//   GET /subscription/status  → the caller's practice plan + VOB usage.
//
// This route is DB-only (no outbound calls), so it stays on the VPC Lambda API.
// The two Stripe-facing pieces live on Vercel instead, because the VPC Lambdas
// have no NAT egress to Stripe (see CLAUDE.md / lib/stripe.js):
//   * POST /subscription/vob/activate → api/vob-activate.js (Checkout Session)
//   * POST /subscription/vob/webhook  → api/vob-webhook.js  (plan flip on payment)
//
// Security: practice_id / plan come from the authenticated user's active row,
// never trusted from the request.

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');

// --- request helpers ---------------------------------------------------------

function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

// Path tail after "subscription/" so routing is payload-format agnostic (e.g.
// "status"). Tolerates a leading slash / stage prefix.
function subPath(event) {
  const raw =
    (event && event.rawPath) ||
    (event && event.requestContext && event.requestContext.http && event.requestContext.http.path) ||
    (event && event.path) ||
    '';
  const cleaned = String(raw).replace(/^\/+|\/+$/g, '');
  const idx = cleaned.indexOf('subscription/');
  return idx === -1 ? '' : cleaned.slice(idx + 'subscription/'.length);
}

// --- practice scoping --------------------------------------------------------

async function loadStatus(userId) {
  const res = await db.query(
    `select p.plan             as plan,
            p.vob_checks_used  as vob_checks_used,
            p.vob_period_start as vob_period_start
       from users u
       join practices p on p.id = u.practice_id
      where u.id = $1 and u.is_active = true
      limit 1`,
    [userId]
  );
  return res.rows[0] || null;
}

// --- entrypoint --------------------------------------------------------------

exports.handler = async (event) => {
  const method = httpMethod(event);
  if (method === 'OPTIONS') {
    return preflight(event);
  }

  let auth;
  try {
    auth = requireAuth(event);
  } catch (err) {
    return json(err.statusCode || 401, { error: 'Unauthorized' }, event);
  }

  try {
    const path = subPath(event);
    if (method === 'GET' && path === 'status') {
      const status = await loadStatus(auth.user.sub);
      if (!status) {
        return json(401, { error: 'Unauthorized' }, event);
      }
      return json(
        200,
        {
          plan: status.plan,
          vob_checks_used: status.vob_checks_used,
          vob_period_start: status.vob_period_start,
        },
        event
      );
    }

    return json(404, { error: 'Not found' }, event);
  } catch (err) {
    console.error('subscription error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
