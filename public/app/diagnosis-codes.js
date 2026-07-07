/* =============================================================================
 * Reddably — curated billable ICD-10 diagnosis codes (window.ReddablyDiagnoses)
 * =============================================================================
 * A deliberately CURATED, behavioral-health subset of ICD-10-CM — NOT a full
 * import. Every entry is a billable, highest-specificity leaf code. Category /
 * header codes (e.g. F10.9, F43.2) are intentionally absent: Aetna rejected a
 * category code with error 33 ("Diagnosis code must be valid and to the highest
 * level of specificity"), so the picker must never let one be selected.
 *
 * Codes are stored DOTLESS (F1090, F17200) because the 837P transmits ICD-10
 * without the decimal and lib/clearinghouse/stedi.js sends the value verbatim.
 * display() re-inserts the dot for humans (F1090 -> F10.90).
 *
 * Expanding later: add rows to CODES. Keep them billable-specificity only. The
 * structure (dotless `code` + human `label`) is stable, so a future bulk import
 * can append without touching consumers.
 *
 * UMD shim: usable as a browser global (window.ReddablyDiagnoses) AND as a Node
 * module (module.exports) so the same list backs the picker and the unit tests.
 * No build step, no dependencies.
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.ReddablyDiagnoses = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Curated billable behavioral-health codes. `code` is dotless (as transmitted).
  var CODES = [
    // --- Substance use, F10–F19 (full specificity, uncomplicated) --------------
    { code: 'F1010',  label: 'Alcohol abuse, uncomplicated' },
    { code: 'F1020',  label: 'Alcohol dependence, uncomplicated' },
    { code: 'F1090',  label: 'Alcohol use, unspecified, uncomplicated' },
    { code: 'F1110',  label: 'Opioid abuse, uncomplicated' },
    { code: 'F1120',  label: 'Opioid dependence, uncomplicated' },
    { code: 'F1190',  label: 'Opioid use, unspecified, uncomplicated' },
    { code: 'F1210',  label: 'Cannabis abuse, uncomplicated' },
    { code: 'F1220',  label: 'Cannabis dependence, uncomplicated' },
    { code: 'F1290',  label: 'Cannabis use, unspecified, uncomplicated' },
    { code: 'F1310',  label: 'Sedative/hypnotic/anxiolytic abuse, uncomplicated' },
    { code: 'F1320',  label: 'Sedative/hypnotic/anxiolytic dependence, uncomplicated' },
    { code: 'F1410',  label: 'Cocaine abuse, uncomplicated' },
    { code: 'F1420',  label: 'Cocaine dependence, uncomplicated' },
    { code: 'F1510',  label: 'Other stimulant abuse, uncomplicated' },
    { code: 'F1520',  label: 'Other stimulant dependence, uncomplicated' },
    { code: 'F1610',  label: 'Hallucinogen abuse, uncomplicated' },
    { code: 'F1620',  label: 'Hallucinogen dependence, uncomplicated' },
    { code: 'F17200', label: 'Nicotine dependence, unspecified, uncomplicated' },
    { code: 'F17210', label: 'Nicotine dependence, cigarettes, uncomplicated' },
    { code: 'F1810',  label: 'Inhalant abuse, uncomplicated' },
    { code: 'F1820',  label: 'Inhalant dependence, uncomplicated' },
    { code: 'F1910',  label: 'Other psychoactive substance abuse, uncomplicated' },
    { code: 'F1920',  label: 'Other psychoactive substance dependence, uncomplicated' },

    // --- Depressive disorders, F32 / F33 ---------------------------------------
    { code: 'F320',  label: 'Major depressive disorder, single episode, mild' },
    { code: 'F321',  label: 'Major depressive disorder, single episode, moderate' },
    { code: 'F322',  label: 'Major depressive disorder, single episode, severe without psychotic features' },
    { code: 'F324',  label: 'Major depressive disorder, single episode, in partial remission' },
    { code: 'F325',  label: 'Major depressive disorder, single episode, in full remission' },
    { code: 'F329',  label: 'Major depressive disorder, single episode, unspecified' },
    { code: 'F330',  label: 'Major depressive disorder, recurrent, mild' },
    { code: 'F331',  label: 'Major depressive disorder, recurrent, moderate' },
    { code: 'F332',  label: 'Major depressive disorder, recurrent, severe without psychotic features' },
    { code: 'F3341', label: 'Major depressive disorder, recurrent, in partial remission' },
    { code: 'F3342', label: 'Major depressive disorder, recurrent, in full remission' },
    { code: 'F339',  label: 'Major depressive disorder, recurrent, unspecified' },
    { code: 'F340',  label: 'Cyclothymic disorder' },
    { code: 'F341',  label: 'Dysthymic disorder (persistent depressive disorder)' },

    // --- Bipolar, F31 ----------------------------------------------------------
    { code: 'F3181', label: 'Bipolar II disorder' },
    { code: 'F319',  label: 'Bipolar disorder, unspecified' },

    // --- Anxiety & phobias, F40 / F41 ------------------------------------------
    { code: 'F410',  label: 'Panic disorder (without agoraphobia)' },
    { code: 'F411',  label: 'Generalized anxiety disorder' },
    { code: 'F413',  label: 'Other mixed anxiety disorders' },
    { code: 'F418',  label: 'Other specified anxiety disorders' },
    { code: 'F419',  label: 'Anxiety disorder, unspecified' },
    { code: 'F4000', label: 'Agoraphobia, unspecified' },
    { code: 'F4010', label: 'Social phobia, unspecified' },

    // --- Obsessive-compulsive, F42 ---------------------------------------------
    { code: 'F422',  label: 'Mixed obsessional thoughts and acts' },
    { code: 'F423',  label: 'Hoarding disorder' },
    { code: 'F424',  label: 'Excoriation (skin-picking) disorder' },
    { code: 'F428',  label: 'Other obsessive-compulsive disorder' },
    { code: 'F429',  label: 'Obsessive-compulsive disorder, unspecified' },

    // --- Trauma & stressor-related, F43 ----------------------------------------
    { code: 'F430',  label: 'Acute stress reaction' },
    { code: 'F4310', label: 'Post-traumatic stress disorder, unspecified' },
    { code: 'F4311', label: 'Post-traumatic stress disorder, acute' },
    { code: 'F4312', label: 'Post-traumatic stress disorder, chronic' },
    { code: 'F4320', label: 'Adjustment disorder, unspecified' },
    { code: 'F4321', label: 'Adjustment disorder with depressed mood' },
    { code: 'F4322', label: 'Adjustment disorder with anxiety' },
    { code: 'F4323', label: 'Adjustment disorder with mixed anxiety and depressed mood' },
    { code: 'F4324', label: 'Adjustment disorder with disturbance of conduct' },
    { code: 'F4325', label: 'Adjustment disorder with mixed disturbance of emotions and conduct' },

    // --- Eating disorders, F50 -------------------------------------------------
    { code: 'F5000', label: 'Anorexia nervosa, unspecified' },
    { code: 'F502',  label: 'Bulimia nervosa' },
    { code: 'F5081', label: 'Binge eating disorder' },
    { code: 'F509',  label: 'Eating disorder, unspecified' },

    // --- Attention-deficit / hyperactivity, F90 --------------------------------
    { code: 'F900',  label: 'ADHD, predominantly inattentive type' },
    { code: 'F901',  label: 'ADHD, predominantly hyperactive type' },
    { code: 'F902',  label: 'ADHD, combined type' },
    { code: 'F908',  label: 'ADHD, other type' },
    { code: 'F909',  label: 'ADHD, unspecified type' },
  ];

  // Uppercase + strip everything but A–Z / 0–9, so 'f10.90', 'F10 90', 'F1090'
  // all normalize to the stored dotless key.
  function normalize(input) {
    if (input == null) return '';
    return String(input).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  var BY_CODE = {};
  CODES.forEach(function (entry) { BY_CODE[entry.code] = entry; });

  // Dotless -> dotted for display: insert '.' after the 3-char category (F1090 ->
  // F10.90). ICD-10 categories are always 3 chars (letter + 2 digits).
  function display(code) {
    var c = normalize(code);
    if (c.length <= 3) return c;
    return c.slice(0, 3) + '.' + c.slice(3);
  }

  // A code is billable IFF it is in the curated set. This is the guardrail that
  // keeps category codes (F10.9) out while allowing their specific children
  // (F10.90). Accepts dotted or dotless input.
  function isBillableCode(input) {
    return Object.prototype.hasOwnProperty.call(BY_CODE, normalize(input));
  }

  function find(input) {
    return BY_CODE[normalize(input)] || null;
  }

  // Human label for a code: "F10.90 — Alcohol dependence…". Unknown codes (e.g. a
  // legacy value stored before the picker existed) still render, dotted, so the
  // UI never drops data — they simply carry no description.
  function label(input) {
    var entry = find(input);
    var shown = display(input);
    return entry ? shown + ' — ' + entry.label : shown;
  }

  // Type-ahead search over code + dotted display + label. Ranked: code/display
  // prefix matches first, then substring matches on the label. `limit` caps the
  // result count (default 8).
  function search(query, limit) {
    var max = limit || 8;
    var q = String(query || '').trim().toLowerCase();
    var qCode = normalize(query);
    if (!q) return CODES.slice(0, max);

    var starts = [];
    var contains = [];
    CODES.forEach(function (entry) {
      var codeHay = entry.code.toLowerCase();
      var displayHay = display(entry.code).toLowerCase();
      var labelHay = entry.label.toLowerCase();
      if ((qCode && entry.code.indexOf(qCode) === 0) || displayHay.indexOf(q) === 0) {
        starts.push(entry);
      } else if (
        (qCode && entry.code.indexOf(qCode) !== -1) ||
        displayHay.indexOf(q) !== -1 ||
        labelHay.indexOf(q) !== -1
      ) {
        contains.push(entry);
      }
    });
    return starts.concat(contains).slice(0, max);
  }

  return {
    CODES: CODES,
    normalize: normalize,
    display: display,
    isBillableCode: isBillableCode,
    find: find,
    label: label,
    search: search,
  };
});
