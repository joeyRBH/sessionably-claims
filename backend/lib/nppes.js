'use strict';

// NPPES NPI Registry client + normalizer.
//
// NPPES is the CMS National Plan & Provider Enumeration System — the public,
// authoritative registry of NPIs. It has no browser CORS, so lookups must be
// server-side. This module owns the transport + normalization; the handler
// (backend/handlers/providers.js) owns auth, caching, and the billing-provider
// entity-type guardrail that consumes normalizeNppes()'s output.
//
// NPPES is a government registry, not our clearinghouse vendor, so its name may
// appear in user-facing copy (unlike the white-labeled clearinghouse).
//
// Runs on Node 20+ (global fetch + AbortController). No API key required.

const BASE = process.env.NPPES_BASE_URL || 'https://npiregistry.cms.hhs.gov/api/';
const VERSION = '2.1';
const TIMEOUT_MS = Number(process.env.NPPES_TIMEOUT_MS || 8000);

// Thrown when NPPES itself is unreachable/timed out (as opposed to reachable but
// returning "no match"). The handler treats this as retryable and offers the
// manual-entry fallback, rather than hard-blocking onboarding on an outage.
class NppesUnreachableError extends Error {
  constructor(message) {
    super(message || 'NPPES is unreachable');
    this.name = 'NppesUnreachableError';
    this.retryable = true;
  }
}

// NPI format gate: exactly 10 digits. NPPES is authoritative on whether the
// number actually exists, so we only reject the structurally-impossible here.
function isValidNpiFormat(npi) {
  return /^\d{10}$/.test(String(npi == null ? '' : npi).trim());
}

// Luhn checksum for an NPI (prefix "80840" per the CMS spec, then the first 9
// digits; the 10th is the check digit). Exported as a soft hint for the UI — the
// backend does NOT hard-block on it, since NPPES is the source of truth.
function hasValidNpiChecksum(npi) {
  const s = String(npi == null ? '' : npi).trim();
  if (!/^\d{10}$/.test(s)) return false;
  const base = '80840' + s.slice(0, 9);
  let sum = 0;
  let dbl = true; // rightmost digit of `base` is doubled (Luhn from the right)
  for (let i = base.length - 1; i >= 0; i--) {
    let d = base.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === (s.charCodeAt(9) - 48);
}

// Normalize a single NPPES `results[]` entry into the shape the app stores and
// the guardrail consumes. Pure — no network. Tolerant of missing sub-objects.
//
//   { enumerationType, entityType, name, soleProprietor, primaryTaxonomy, active }
function normalizeNppes(result) {
  const r = result || {};
  const basic = r.basic || {};
  const enumerationType = r.enumeration_type || null; // 'NPI-1' | 'NPI-2'
  const entityType = enumerationType === 'NPI-2' ? 'non_person_entity' : 'person';

  const taxonomies = Array.isArray(r.taxonomies) ? r.taxonomies : [];
  const primary = taxonomies.find((t) => t && t.primary === true) || null;
  const primaryTaxonomy = primary
    ? {
        code: primary.code || null,
        desc: primary.desc || null,
        license: primary.license || null,
        state: primary.state || null,
      }
    : null;

  let name;
  if (entityType === 'non_person_entity') {
    name = { organizationName: basic.organization_name || null };
  } else {
    name = {
      firstName: basic.first_name || null,
      lastName: basic.last_name || null,
      credential: basic.credential || null,
    };
  }

  return {
    enumerationType,
    entityType,
    name,
    soleProprietor: basic.sole_proprietor === 'YES',
    primaryTaxonomy,
    active: basic.status === 'A',
  };
}

// A human label for guardrail/warning messages, derived from a normalized record.
function displayName(normalized) {
  if (!normalized || !normalized.name) return 'this provider';
  if (normalized.entityType === 'non_person_entity') {
    return normalized.name.organizationName || 'this organization';
  }
  const full = [normalized.name.firstName, normalized.name.lastName].filter(Boolean).join(' ').trim();
  return full || 'this individual';
}

// Entity-type guardrail (pure). Given the entity type the user SELECTED and the
// normalized NPPES record for the NPI they entered, block a save when they
// conflict. `selected` accepts 'person'/'individual' and
// 'non_person_entity'/'organization'. -> { ok, message }.
function checkEntityTypeGuardrail(selected, normalized) {
  const sel = String(selected || '').toLowerCase();
  const wantsOrg = sel === 'non_person_entity' || sel === 'organization' || sel === 'org';
  const wantsPerson = sel === 'person' || sel === 'individual';
  if (!wantsOrg && !wantsPerson) {
    return { ok: false, message: "Select whether this provider bills as an individual or an organization." };
  }
  if (!normalized || !normalized.enumerationType) {
    return { ok: false, message: 'Verify the NPI against NPPES before saving.' };
  }
  const name = displayName(normalized);
  if (wantsOrg && normalized.enumerationType === 'NPI-1') {
    return {
      ok: false,
      message:
        `This NPI is registered to an individual (${name}). Bill as an individual provider, ` +
        `or enter the organization's own Type-2 NPI.`,
    };
  }
  if (wantsPerson && normalized.enumerationType === 'NPI-2') {
    return {
      ok: false,
      message:
        `This NPI is registered to an organization (${name}). Bill as an organization, ` +
        `or enter the individual's own Type-1 NPI.`,
    };
  }
  return { ok: true };
}

// Low-level fetch of the raw NPPES payload for an NPI. Throws
// NppesUnreachableError on a transport failure/timeout. Returns the parsed JSON
// (which may have result_count 0, or an `Errors` array).
async function fetchNpi(npi) {
  const url = `${BASE}?number=${encodeURIComponent(npi)}&version=${VERSION}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new NppesUnreachableError(`NPPES request timed out after ${TIMEOUT_MS}ms`);
    }
    throw new NppesUnreachableError('NPPES request failed');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // A 5xx from NPPES is an outage, not a "not found" — treat as retryable.
    throw new NppesUnreachableError(`NPPES returned HTTP ${res.status}`);
  }
  return res.json().catch(() => ({}));
}

// High-level verify. Validates format, fetches, and returns one of:
//   { found: true,  npi, ...normalizeNppes() }
//   { found: false, npi }                          — reachable, no such NPI
// Throws Error('Invalid NPI') for a bad format, or NppesUnreachableError on an
// outage (so the handler can offer retry + manual fallback).
async function verifyNpi(npi) {
  const trimmed = String(npi == null ? '' : npi).trim();
  if (!isValidNpiFormat(trimmed)) {
    const e = new Error('NPI must be exactly 10 digits.');
    e.code = 'INVALID_NPI';
    throw e;
  }
  const data = await fetchNpi(trimmed);
  const count = data && typeof data.result_count === 'number' ? data.result_count : 0;
  const results = Array.isArray(data && data.results) ? data.results : [];
  if (count === 0 || results.length === 0) {
    return { found: false, npi: trimmed };
  }
  return { found: true, npi: trimmed, ...normalizeNppes(results[0]) };
}

module.exports = {
  verifyNpi,
  fetchNpi,
  normalizeNppes,
  checkEntityTypeGuardrail,
  isValidNpiFormat,
  hasValidNpiChecksum,
  displayName,
  NppesUnreachableError,
  BASE,
};
