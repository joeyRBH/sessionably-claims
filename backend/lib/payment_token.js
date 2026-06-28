'use strict';

// Short-lived signed token for the PUBLIC patient card-capture flow. It carries a
// client_id and a fixed purpose, signed with the same JWT_SECRET (HS256) as the
// auth tokens but with a distinct `purpose` claim so it can never be used as a
// staff/session token (and vice versa). 24h expiry.
//
// This is intentionally separate from lib/jwt.js (which signs user-shaped session
// tokens) and lib/auth.js (the bearer middleware) — neither is modified.

const jwt = require('jsonwebtoken');

const ALGORITHM = 'HS256';
const PURPOSE = 'payment_setup';
const EXPIRES_IN = '24h';

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return secret;
}

// sign(clientId) -> token string with { client_id, purpose, iat, exp }.
function sign(clientId) {
  return jwt.sign({ client_id: clientId, purpose: PURPOSE }, getSecret(), {
    algorithm: ALGORITHM,
    expiresIn: EXPIRES_IN,
  });
}

// verify(token) -> { client_id } or throws. Rejects any token whose purpose is not
// the payment-setup purpose, so a session token can't be replayed here.
function verify(token) {
  const decoded = jwt.verify(token, getSecret(), { algorithms: [ALGORITHM] });
  if (!decoded || decoded.purpose !== PURPOSE || !decoded.client_id) {
    throw new Error('Invalid payment token');
  }
  return { client_id: decoded.client_id };
}

module.exports = { sign, verify, PURPOSE };
