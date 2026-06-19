'use strict';

// Password hashing via bcryptjs (pure-JS — avoids native-binary issues in Lambda).

const bcrypt = require('bcryptjs');

const COST = 12;

function hash(plain) {
  return bcrypt.hash(plain, COST);
}

function compare(plain, passwordHash) {
  // bcrypt.compare tolerates a null/invalid hash by resolving false.
  return bcrypt.compare(plain, passwordHash || '');
}

module.exports = { hash, compare, COST };
