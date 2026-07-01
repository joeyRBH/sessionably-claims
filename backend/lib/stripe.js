'use strict';

// Minimal Stripe REST client over global fetch (Node 18+). We deliberately avoid
// the Stripe SDK to match the codebase convention (see lib/clearinghouse/stedi.js,
// which calls its API the same way) and to keep the Lambda bundle dependency-free.
//
// Auth: Authorization: Bearer <STRIPE_SECRET_KEY>. Bodies are form-encoded
// (application/x-www-form-urlencoded) with Stripe's bracket notation for nested
// fields (e.g. metadata[claim_id]=...).
//
// NOTE: these calls require outbound HTTPS to api.stripe.com. The auth Lambdas run
// in a VPC without NAT egress (see CLAUDE.md), so reaching Stripe needs either a
// NAT gateway / VPC endpoint or moving these to the Vercel /api functions. Flagged
// for infra follow-up; the handler logic is identical either way.

const BASE = process.env.STRIPE_BASE_URL || 'https://api.stripe.com/v1';

function secretKey() {
  const k = process.env.STRIPE_SECRET_KEY;
  if (!k) throw new Error('STRIPE_SECRET_KEY is not set');
  return k;
}

function publishableKey() {
  // Non-secret; returned to the browser. Empty string if unset (page can still load).
  return process.env.STRIPE_PUBLISHABLE_KEY || '';
}

// Encode a (possibly nested) params object into Stripe's form syntax.
function encodeForm(params, prefix, out) {
  out = out || [];
  Object.keys(params).forEach((key) => {
    const value = params[key];
    if (value === undefined || value === null) return;
    const path = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object' && !Array.isArray(value)) {
      encodeForm(value, path, out);
    } else {
      out.push(`${encodeURIComponent(path)}=${encodeURIComponent(String(value))}`);
    }
  });
  return out;
}

// Low-level request. method 'POST' sends the form body; 'GET' appends a query string.
async function stripeRequest(method, path, params) {
  const headers = {
    Authorization: `Bearer ${secretKey()}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };

  let url = `${BASE}${path}`;
  const opts = { method, headers };

  if (method === 'GET') {
    const qs = encodeForm(params || {}).join('&');
    if (qs) url += `?${qs}`;
  } else {
    opts.body = encodeForm(params || {}).join('&');
  }

  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `Stripe HTTP ${res.status}`;
    const err = new Error(msg);
    err.statusCode = res.status;
    err.stripeCode = data && data.error && data.error.code;
    throw err;
  }
  return data;
}

// --- resource helpers --------------------------------------------------------

function createCustomer({ name, email, metadata }) {
  return stripeRequest('POST', '/customers', { name, email, metadata });
}

function createSetupIntent({ customer }) {
  return stripeRequest('POST', '/setup_intents', { customer, usage: 'off_session' });
}

function attachPaymentMethod(paymentMethodId, customerId) {
  return stripeRequest('POST', `/payment_methods/${encodeURIComponent(paymentMethodId)}/attach`, {
    customer: customerId,
  });
}

function retrievePaymentMethod(paymentMethodId) {
  return stripeRequest('GET', `/payment_methods/${encodeURIComponent(paymentMethodId)}`, {});
}

function setDefaultPaymentMethod(customerId, paymentMethodId) {
  return stripeRequest('POST', `/customers/${encodeURIComponent(customerId)}`, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
}

function createPaymentIntent(params) {
  return stripeRequest('POST', '/payment_intents', params);
}

// Create a Checkout Session. `params` follows Stripe's shape; nested arrays are
// expressed as index-keyed objects (e.g. line_items: { 0: {...} }) so the shared
// encodeForm produces line_items[0][price_data][...] without needing array support.
function createCheckoutSession(params) {
  return stripeRequest('POST', '/checkout/sessions', params);
}

module.exports = {
  publishableKey,
  stripeRequest,
  createCustomer,
  createSetupIntent,
  attachPaymentMethod,
  retrievePaymentMethod,
  setDefaultPaymentMethod,
  createPaymentIntent,
  createCheckoutSession,
};
