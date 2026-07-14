'use strict';

// Application-layer field encryption for the most sensitive stored values —
// currently a provider's individual billing TIN (an EIN, or for a sole
// proprietor an SSN). Everything else in the schema relies on RDS at-rest
// encryption + tenant scoping (see CLAUDE.md); a raw SSN warrants a second layer
// so the plaintext is never present in a DB dump, replica, or backup.
//
// Scheme: AES-256-GCM (authenticated) with a 32-byte key supplied out-of-band
// via FIELD_ENCRYPTION_KEY (base64 or hex). The key is hydrated onto the Lambda
// environment from SSM by deploy.sh, exactly like DATABASE_URL / JWT_SECRET, and
// is NEVER committed. Ciphertext is stored as a self-describing string:
//
//   v1.<base64url(iv)>.<base64url(authTag)>.<base64url(ciphertext)>
//
// The version prefix lets us rotate keys/algorithms later without ambiguity.
//
// Fail-closed: encrypt()/decrypt() throw when no valid key is configured, so a
// missing key can never cause a sensitive value to be written or read in the
// clear. Callers that must degrade gracefully should gate on isConfigured().

const crypto = require('crypto');

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce — the standard/recommended size for GCM
const KEY_BYTES = 32; // AES-256

// Resolve and validate the key once per process. A warm Lambda reuses this.
let cachedKey; // undefined = not yet resolved; null = resolved-but-absent/invalid

function resolveKey() {
  if (cachedKey !== undefined) return cachedKey;
  const raw = process.env.FIELD_ENCRYPTION_KEY;
  if (!raw || String(raw).trim() === '') {
    cachedKey = null;
    return cachedKey;
  }
  const trimmed = String(raw).trim();
  let buf = null;
  // Accept base64 (44 chars for 32 bytes) or hex (64 chars); prefer whichever
  // decodes to exactly 32 bytes.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    buf = Buffer.from(trimmed, 'hex');
  } else {
    try {
      const b = Buffer.from(trimmed, 'base64');
      if (b.length === KEY_BYTES) buf = b;
    } catch (_) {
      buf = null;
    }
  }
  cachedKey = buf && buf.length === KEY_BYTES ? buf : null;
  return cachedKey;
}

// True when a valid 32-byte key is configured (so callers can branch before
// attempting to persist a sensitive value).
function isConfigured() {
  return resolveKey() != null;
}

function requireKey() {
  const key = resolveKey();
  if (!key) {
    // Message names the config knob but never the key material.
    throw new Error('FIELD_ENCRYPTION_KEY is not set or is not a 32-byte base64/hex value');
  }
  return key;
}

// encrypt(plaintext) -> versioned ciphertext string. Returns null for null/''
// input so callers can store "no value" without a special case.
function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const key = requireKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ct.toString('base64url'),
  ].join('.');
}

// decrypt(payload) -> plaintext string. Returns null for null/'' input.
// Throws on a malformed payload, an unknown version, or a failed auth check
// (wrong key / tampering) — GCM verifies integrity, so a bad key does not
// silently return garbage.
function decrypt(payload) {
  if (payload == null || payload === '') return null;
  const key = requireKey();
  const parts = String(payload).split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Unrecognized ciphertext format');
  }
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const ct = Buffer.from(parts[3], 'base64url');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

// Test-only: reset the memoized key so a test can flip FIELD_ENCRYPTION_KEY.
function _resetKeyCache() {
  cachedKey = undefined;
}

module.exports = { encrypt, decrypt, isConfigured, _resetKeyCache };
