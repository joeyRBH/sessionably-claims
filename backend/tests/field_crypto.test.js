'use strict';

// App-layer field encryption (backend/lib/crypto.js). AES-256-GCM round-trip,
// tamper detection, and fail-closed behavior. node backend/tests/field_crypto.test.js

const assert = require('node:assert');
const path = require('node:path');
const crypto = require('node:crypto');
const fieldCrypto = require(path.join(__dirname, '..', 'lib', 'crypto.js'));

const prevKey = process.env.FIELD_ENCRYPTION_KEY;

// --- 1. Not configured → fail closed ----------------------------------------
delete process.env.FIELD_ENCRYPTION_KEY;
fieldCrypto._resetKeyCache();
assert.strictEqual(fieldCrypto.isConfigured(), false);
assert.throws(() => fieldCrypto.encrypt('123456789'), /FIELD_ENCRYPTION_KEY/, 'encrypt fails closed with no key');

// --- 2. Round-trip with a valid 32-byte key ----------------------------------
process.env.FIELD_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
fieldCrypto._resetKeyCache();
assert.strictEqual(fieldCrypto.isConfigured(), true);

const plain = '123456789';
const ct = fieldCrypto.encrypt(plain);
assert.ok(ct && ct.startsWith('v1.'), 'versioned ciphertext');
assert.ok(!ct.includes(plain), 'plaintext not present in ciphertext');
assert.strictEqual(fieldCrypto.decrypt(ct), plain, 'decrypts back to the original');

// Two encryptions of the same value differ (random IV) but both decrypt.
const ct2 = fieldCrypto.encrypt(plain);
assert.notStrictEqual(ct, ct2, 'unique IV → distinct ciphertext');
assert.strictEqual(fieldCrypto.decrypt(ct2), plain);

// --- 3. null / empty passthrough ---------------------------------------------
assert.strictEqual(fieldCrypto.encrypt(null), null);
assert.strictEqual(fieldCrypto.encrypt(''), null);
assert.strictEqual(fieldCrypto.decrypt(null), null);

// --- 4. Tamper / wrong-key detection (GCM auth) ------------------------------
const parts = ct.split('.');
const tampered = [parts[0], parts[1], parts[2], Buffer.from('deadbeef').toString('base64url')].join('.');
assert.throws(() => fieldCrypto.decrypt(tampered), 'auth tag mismatch throws, never returns garbage');
assert.throws(() => fieldCrypto.decrypt('v1.aaa.bbb'), /Unrecognized ciphertext/, 'malformed payload throws');

// A different key cannot decrypt.
process.env.FIELD_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
fieldCrypto._resetKeyCache();
assert.throws(() => fieldCrypto.decrypt(ct), 'ciphertext from another key fails auth');

// restore
if (prevKey === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
else process.env.FIELD_ENCRYPTION_KEY = prevKey;
fieldCrypto._resetKeyCache();

console.log('field_crypto.test.js: OK');
