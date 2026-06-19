'use strict';

// JWT signing/verification. HS256, secret from env. Claims: sub, practice_id, role.

const jwt = require('jsonwebtoken');

const ALGORITHM = 'HS256';

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set');
  }
  return secret;
}

// sign(user) -> token string. `user` is a row from the users table.
// iat/exp are added by jsonwebtoken.
function sign(user) {
  const payload = {
    sub: user.id,
    practice_id: user.practice_id,
    role: user.role,
  };
  return jwt.sign(payload, getSecret(), {
    algorithm: ALGORITHM,
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  });
}

// verify(token) -> decoded payload, or throws if missing/invalid/expired.
function verify(token) {
  return jwt.verify(token, getSecret(), { algorithms: [ALGORITHM] });
}

module.exports = { sign, verify };
