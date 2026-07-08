'use strict';

// Small shared helpers used across the auth handlers.

const crypto = require('crypto');

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

// Normalize a user-entered US phone number to E.164 (+1XXXXXXXXXX), the format
// Twilio SMS requires. Accepts any common US style — "(970) 825-2499",
// "970-825-2499", "9708252499", "+19708252499" — and returns
// { ok: true, value: '+1XXXXXXXXXX' } or { ok: false } when it cannot resolve to
// a valid 10-digit NANP number. NANP rules: the area code and the exchange code
// each start 2-9 (so "0…"/"1…" style garbage is rejected). This mirrors the
// front-end helper (public/js/phone.js) — keep the two in sync.
function normalizePhone(input) {
  if (input == null) return { ok: false };
  const raw = String(input).trim();
  if (raw === '') return { ok: false };

  const digits = raw.replace(/\D/g, '');

  let national;
  if (digits.length === 11 && digits[0] === '1') {
    national = digits.slice(1);        // 1XXXXXXXXXX → drop the country code
  } else if (digits.length === 10) {
    national = digits;
  } else {
    return { ok: false };
  }

  // NANP: area-code and exchange first digits are 2-9.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) return { ok: false };

  return { ok: true, value: `+1${national}` };
}

// Base slug derived from a practice name: lowercase, hyphenate, strip unsafe
// chars, collapse repeated hyphens, trim leading/trailing hyphens. Falls back to
// 'practice' if nothing usable remains. The caller adds a random suffix only on
// a uniqueness collision (see registerNewPractice).
function baseSlug(name) {
  return (
    String(name || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'practice'
  );
}

// 5 chars of base36 randomness, used to disambiguate colliding slugs.
function randomSlugSuffix() {
  return crypto.randomBytes(4).readUInt32BE(0).toString(36).padStart(5, '0').slice(-5);
}

// Shape a users row for the API. NEVER includes password_hash.
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    practice_id: row.practice_id,
    role: row.role,
    first_name: row.first_name,
    last_name: row.last_name,
    email: row.email,
    title: row.title,
    npi: row.npi,
    license_state: row.license_state,
    fee_payer_override: row.fee_payer_override,
    is_active: row.is_active,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
  };
}

// Parse a proxy-integration body (string or already-parsed object).
// Returns {} on empty/invalid JSON so handlers can validate fields uniformly.
function parseBody(event) {
  if (!event || event.body == null) return {};
  if (typeof event.body === 'object') return event.body;
  try {
    return JSON.parse(event.body);
  } catch (_) {
    return {};
  }
}

module.exports = { normalizeEmail, normalizePhone, baseSlug, randomSlugSuffix, publicUser, parseBody };
