/* =============================================================================
 * Reddably — shared phone-number normalizer (window.ReddablyPhone)
 * =============================================================================
 * Loaded by both the app shell (app.html) and the standalone patient card-setup
 * page (card-setup.html). Normalizes any common US phone format to E.164
 * (+1XXXXXXXXXX) — the format Twilio SMS requires — so views can validate input
 * inline and send a clean value. Mirrors the backend helper
 * (backend/lib/util.js normalizePhone); keep the two algorithms in sync.
 *
 * No framework, no build step, no globals other than window.ReddablyPhone.
 * ========================================================================== */
(function (window) {
  'use strict';

  // normalize(input) -> { ok: true, value: '+1XXXXXXXXXX' }
  //                   | { ok: false, error: '<message>' }
  // Accepts "(970) 825-2499", "970-825-2499", "9708252499", "+19708252499".
  // NANP rules: area-code and exchange first digits are 2-9.
  function normalize(input) {
    var INVALID = { ok: false, error: 'Enter a valid US phone number.' };
    if (input == null) return INVALID;
    var raw = String(input).trim();
    if (raw === '') return INVALID;

    var digits = raw.replace(/\D/g, '');

    var national;
    if (digits.length === 11 && digits.charAt(0) === '1') {
      national = digits.slice(1);
    } else if (digits.length === 10) {
      national = digits;
    } else {
      return INVALID;
    }

    if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) return INVALID;

    return { ok: true, value: '+1' + national };
  }

  window.ReddablyPhone = { normalize: normalize };
})(window);
