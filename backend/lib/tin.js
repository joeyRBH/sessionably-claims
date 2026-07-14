'use strict';

// TIN (Taxpayer Identification Number) format validation + masking.
//
// FORMAT ONLY. This does NOT prove a TIN belongs to the provider or matches IRS
// records — there is no authoritative TIN-matching here, and the UI must say so.
// It only catches structurally-impossible numbers before they reach a claim.
//
//   * EIN (Employer Identification Number): 9 digits, rendered "XX-XXXXXXX".
//     All-zeros is rejected.
//   * SSN (Social Security Number): 9 digits, rendered "XXX-XX-XXXXX". Rejects
//     structurally-invalid numbers per SSA allocation rules:
//       - area  (digits 1-3): 000, 666, and 900-999 are never issued
//       - group (digits 4-5): 00 is never issued
//       - serial(digits 6-9): 0000 is never issued
//
// Values here are sensitive: never log a full TIN. Callers store only ciphertext
// (see backend/lib/crypto.js) plus a masked last-4 for display.

function digitsOnly(raw) {
  return String(raw == null ? '' : raw).replace(/\D/g, '');
}

// Validate an EIN. -> { valid, digits, formatted, type:'EIN', error }.
function validateEin(raw) {
  const digits = digitsOnly(raw);
  if (digits.length !== 9) {
    return { valid: false, type: 'EIN', error: 'EIN must be 9 digits.' };
  }
  if (digits === '000000000') {
    return { valid: false, type: 'EIN', error: 'EIN cannot be all zeros.' };
  }
  return {
    valid: true,
    type: 'EIN',
    digits,
    formatted: `${digits.slice(0, 2)}-${digits.slice(2)}`,
  };
}

// Validate an SSN. -> { valid, digits, formatted, type:'SSN', error }.
function validateSsn(raw) {
  const digits = digitsOnly(raw);
  if (digits.length !== 9) {
    return { valid: false, type: 'SSN', error: 'SSN must be 9 digits.' };
  }
  const area = digits.slice(0, 3);
  const group = digits.slice(3, 5);
  const serial = digits.slice(5);
  const areaNum = Number(area);
  if (area === '000' || area === '666' || areaNum >= 900) {
    return { valid: false, type: 'SSN', error: 'SSN has an invalid area number.' };
  }
  if (group === '00') {
    return { valid: false, type: 'SSN', error: 'SSN has an invalid group number.' };
  }
  if (serial === '0000') {
    return { valid: false, type: 'SSN', error: 'SSN has an invalid serial number.' };
  }
  return {
    valid: true,
    type: 'SSN',
    digits,
    formatted: `${area}-${group}-${serial}`,
  };
}

// validateTin(raw, type) — dispatch on 'EIN' | 'SSN'. Unknown type -> invalid.
function validateTin(raw, type) {
  const t = String(type || '').toUpperCase();
  if (t === 'EIN') return validateEin(raw);
  if (t === 'SSN') return validateSsn(raw);
  return { valid: false, type: t || null, error: "TIN type must be 'EIN' or 'SSN'." };
}

// Last 4 digits of a TIN (for display-only storage), or null.
function last4(raw) {
  const digits = digitsOnly(raw);
  return digits.length >= 4 ? digits.slice(-4) : null;
}

// A masked, display-safe rendering from a stored last-4 (never the full value).
// EIN: "XX-XXX1234"; SSN: "XXX-XX-1234"; unknown type: "•••••1234".
function maskFromLast4(l4, type) {
  if (!l4) return null;
  const t = String(type || '').toUpperCase();
  if (t === 'EIN') return `••-•••${l4}`;
  if (t === 'SSN') return `•••-••-${l4}`;
  return `•••••${l4}`;
}

module.exports = { digitsOnly, validateEin, validateSsn, validateTin, last4, maskFromLast4 };
