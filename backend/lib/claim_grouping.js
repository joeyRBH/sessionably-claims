'use strict';

// Which draft claims may be folded into ONE 837P claim carrying several service
// lines — and, when they may not, exactly why.
//
// MONEY-PATH RULES. A grouped claim is a single filing with the payer covering
// several dates of service, and it draws a single platform fee (5% of the summed
// charge) instead of one per session. Getting the eligibility wrong does not
// produce a validation error, it produces a wrongly-filed claim: sessions billed
// under the wrong rendering provider, against the wrong policy, or with a
// diagnosis that does not belong to them.
//
// Pure: no DB, no HTTP, no logging. THIS MODULE IS THE SOLE AUTHORITY. The
// browser deliberately does not carry a copy — it offers the action for any
// two-or-more selection and renders whatever conflicts come back. A client-side
// copy would be a second, silently divergent definition of what may be filed
// together on one claim, and the divergence would surface as a wrongly-FILED
// claim rather than a broken button. claim_grouping.test.js asserts the rule
// vocabulary is absent from views/claims.js.
//
// PHI: `reason` strings name FIELDS and DATES OF SERVICE, never patient names,
// member ids or diagnosis values. They are shown to authenticated practice staff
// about their own claims and must remain safe to log if a caller ever does.

// CMS-1500 Box 24 holds six service lines. The 837P itself permits more, but a
// claim that cannot be rendered onto the paper form is a claim that cannot be
// worked by a payer's back office or mailed as a corrected copy, so six is the
// practical ceiling and the one we enforce.
const MAX_GROUPED_LINES = 6;

// The COMPATIBILITY CONTRACT for grouping is five things, not four:
//
//   client · rendering clinician · insurance policy · place of service
//   · normalized diagnosis SET
//
// The first four are simple equality and live in the list below. The fifth is
// enforced immediately after it in evaluateGroup(), separately ONLY because it
// compares as a normalized set rather than by equality. Reading this constant as
// "the whole must-match set" is a mistake: diagnoses are just as mandatory.
//
// CPT, fee and procedure modifiers are deliberately NOT here. Each rides its own
// 837P service line, so they may differ freely across a group.
//
// Fields that must be IDENTICAL across every claim in a group, because the 837P
// carries exactly one of each at the CLAIM level — not per service line. Putting
// two different values into one claim does not split it; it silently files both
// services under whichever value the builder emitted.
//
//   client_id            the patient the claim is about
//   clinician_id         the rendering provider (2310B / Box 24J)
//   insurance_record_id  the policy being billed (subscriber loop + payer)
//   place_of_service     claimInformation.placeOfServiceCode (Box 24B)
//
// Diagnoses are claim-level too, but compared as a SET rather than by equality —
// see sameDiagnoses.
const CLAIM_LEVEL_FIELDS = [
  { key: 'client_id', label: 'client' },
  { key: 'clinician_id', label: 'rendering clinician' },
  { key: 'insurance_record_id', label: 'insurance policy' },
  { key: 'place_of_service', label: 'place of service' },
];

function dateOf(claim) {
  const d = claim && claim.session_date;
  return d ? String(d).slice(0, 10) : 'an undated session';
}

// Normalize a diagnosis list for comparison: trimmed, uppercased, de-duplicated,
// sorted. Order on the session is meaningful for the 837P (the first code is the
// principal), but for deciding "are these the same diagnoses" it is not — two
// sessions carrying F411 and F321 in different orders describe the same claim.
function normalizedDiagnoses(codes) {
  if (!Array.isArray(codes)) return [];
  const seen = Object.create(null);
  const out = [];
  codes.forEach((c) => {
    if (typeof c !== 'string') return;
    const s = c.trim().toUpperCase();
    if (s === '' || seen[s]) return;
    seen[s] = true;
    out.push(s);
  });
  return out.sort();
}

function sameDiagnoses(a, b) {
  const x = normalizedDiagnoses(a);
  const y = normalizedDiagnoses(b);
  if (x.length !== y.length) return false;
  return x.every((code, i) => code === y[i]);
}

// A replacement claim (CMS frequency 7) supersedes a claim the payer already
// accepted, and carries the original's claim control number. It is a filing about
// ONE prior filing; folding other services into it would tell the payer to
// replace that claim with a different, larger one.
function isReplacement(claim) {
  return !!claim && (claim.corrects_claim_id != null || claim.submission_frequency_code === '7');
}

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Evaluate a candidate group. Returns:
//   { ok: true,  conflicts: [], total, lines }
//   { ok: false, conflicts: [{ code, message }, ...] }
//
// EVERY conflict is reported, not just the first: a user who has ticked six rows
// should be told everything wrong with the selection in one pass rather than
// discovering it one refusal at a time.
function evaluateGroup(claims) {
  const rows = Array.isArray(claims) ? claims.filter(Boolean) : [];
  const conflicts = [];
  const add = (code, message) => conflicts.push({ code, message });

  if (rows.length < 2) {
    add('too_few', 'Select at least two draft claims to group.');
    return { ok: false, conflicts };
  }
  if (rows.length > MAX_GROUPED_LINES) {
    add('too_many',
      `A claim form holds ${MAX_GROUPED_LINES} service lines; you selected ${rows.length}. ` +
      'Group them in smaller batches.');
  }

  // --- per-claim eligibility -------------------------------------------------
  rows.forEach((c) => {
    if (c.status !== 'draft') {
      add('not_draft',
        `The claim for ${dateOf(c)} is ${c.status}, not a draft. Only unsubmitted draft claims can be grouped.`);
    }
    if (isReplacement(c)) {
      add('replacement',
        `The claim for ${dateOf(c)} is a replacement of an already-filed claim and cannot be grouped.`);
    }
    // A draft that carries a control number or a submitted_at was handed to the
    // clearinghouse at some point. Grouping it would fold a service the payer may
    // already hold into a NEW original filing — a duplicate.
    if (c.control_number != null || c.submitted_at != null) {
      add('previously_transmitted',
        `The claim for ${dateOf(c)} has already been sent to the clearinghouse once and cannot be grouped. ` +
        'Reconcile it first.');
    }
    const amount = money(c.billed_amount);
    if (amount == null || amount <= 0) {
      add('missing_amount',
        `The claim for ${dateOf(c)} has no billed amount. Every service line needs its own charge, ` +
        'because the payer requires the lines to add up to the claim total.');
    }
  });

  // --- must-match claim-level fields ----------------------------------------
  const first = rows[0];
  CLAIM_LEVEL_FIELDS.forEach(({ key, label }) => {
    const differs = rows.some((c) => (c[key] || null) !== (first[key] || null));
    if (differs) {
      add('mixed_' + key,
        `These claims do not share the same ${label}. One claim form carries a single ${label}, ` +
        'so they have to be filed separately.');
    }
  });

  // Diagnosis-set equality is a MUST-MATCH rule exactly like the four fields
  // above, and for the same reason — the 837P emits ONE diagnosis set at claim
  // level and every service line points into that shared list. It is checked
  // separately only because it compares as a normalized SET rather than by
  // equality (order, case and padding are not meaningful).
  //
  // The message names the offending DATES OF SERVICE, because the fix is not on
  // the claim at all: the clinician has to correct the diagnosis on those
  // sessions. Dates only — never the codes themselves, and never a patient.
  const dxMismatched = rows.filter((c) => !sameDiagnoses(c.diagnosis_codes, first.diagnosis_codes));
  if (dxMismatched.length) {
    add('mixed_diagnoses',
      'These claims do not carry the same diagnosis codes — ' +
      dxMismatched.map(dateOf).join(', ') + ' ' +
      (dxMismatched.length === 1 ? 'differs' : 'differ') + ' from ' + dateOf(first) + '. ' +
      'Diagnoses sit on the claim, not the service line, so grouping them would file every ' +
      'session under one session\'s diagnoses. Correct the diagnosis on those sessions first, ' +
      'or file these separately.');
  }

  // --- the same session must not appear twice --------------------------------
  const bySession = Object.create(null);
  rows.forEach((c) => {
    const sid = c.session_id;
    if (!sid) return;
    if (bySession[sid]) {
      add('duplicate_session',
        `Two of the selected claims bill the same session (${dateOf(c)}). ` +
        'Grouping them would bill the payer for it twice.');
    }
    bySession[sid] = true;
  });

  if (conflicts.length) return { ok: false, conflicts };

  const total = rows.reduce((sum, c) => sum + money(c.billed_amount), 0);
  return {
    ok: true,
    conflicts: [],
    // Rounded to cents: a sum of numeric(12,2) values can land on a binary
    // floating-point value like 449.99999999999994, and the claim charge must
    // equal the sum of the line charges exactly or the payer rejects the filing.
    total: Math.round(total * 100) / 100,
    lines: rows.length,
  };
}

// Order service lines by date of service, earliest first, so the filed claim
// reads like the calendar and a resubmission emits the same order. Claims with
// no date sort last rather than being dropped.
function orderForFiling(claims) {
  return (claims || []).slice().sort((a, b) => {
    const x = (a && a.session_date) ? String(a.session_date).slice(0, 10) : '9999-12-31';
    const y = (b && b.session_date) ? String(b.session_date).slice(0, 10) : '9999-12-31';
    if (x < y) return -1;
    if (x > y) return 1;
    return 0;
  });
}

// =============================================================================
// SUGGESTION — which drafts the software should point out, unprompted.
// =============================================================================
//
// Same authority, opposite direction. evaluateGroup() answers "may THESE be
// filed together?" about a selection a human already made. suggestGroups()
// answers "which sets WOULD be groupable?" over the whole draft queue, so the
// biller is told rather than having to notice.
//
// It ADVISES AND NEVER ACTS. Nothing here groups a claim, retires a draft or
// moves money; the output is a list of claim ids the UI offers, and grouping
// still happens only when a human confirms and POSTs. That is why this function
// is allowed to be opinionated about which drafts to put in front of someone —
// being wrong costs a dismissed suggestion, not a wrongly-filed claim.
//
// Every emitted set is run back through evaluateGroup() before it is returned,
// so a suggestion can never be something the server would then refuse. The two
// cannot drift, because there is only one rulebook and the suggester is a
// caller of it rather than a copy of it.

// The compatibility key: two drafts can share a claim only if all five
// must-match values agree, so drafts that agree on all five land in one bucket.
// Built from CLAIM_LEVEL_FIELDS rather than a second hand-written list — adding
// a field to the contract must change the buckets automatically, or the
// suggester would go on offering sets the gate has started refusing.
//
// null and '' collapse to the same key component, matching how evaluateGroup
// compares them (`(c[key] || null) !== (first[key] || null)`).
function groupingKey(claim) {
  const parts = CLAIM_LEVEL_FIELDS.map(({ key }) => String(claim[key] || ''));
  // Diagnoses are claim-level too, normalized to a SET — same rule as
  // sameDiagnoses, reusing the same normalizer.
  parts.push(normalizedDiagnoses(claim.diagnosis_codes).join(','));
  // \u0000 cannot occur in a uuid, a POS code or an ICD-10 code, so no
  // combination of field values can collide into another bucket's key.
  return parts.join('\u0000');
}

// The per-claim half of evaluateGroup's eligibility, applied BEFORE bucketing so
// one ineligible draft cannot suppress a suggestion for the eligible ones around
// it. Kept deliberately in the same order as the checks in evaluateGroup.
function isGroupCandidate(claim) {
  if (!claim) return false;
  if (claim.status !== 'draft') return false;
  if (isReplacement(claim)) return false;
  if (claim.control_number != null || claim.submitted_at != null) return false;
  const amount = money(claim.billed_amount);
  return amount != null && amount > 0;
}

// Drop every claim of any session that appears more than once in a bucket.
//
// Two drafts billing the SAME session is legal (claims are 1:many with sessions,
// for resubmission and appeal), but a suggestion containing both is one
// evaluateGroup would refuse as duplicate_session. The fix is NOT to pick one of
// the twins: which of two drafts for a session should be filed is a judgement
// about the claim, and making it silently inside a suggestion is exactly the
// kind of quiet filing decision this module exists to prevent. So the ambiguity
// is EXCLUDED rather than resolved — both twins step out, the unambiguous drafts
// around them are still suggested, and the biller resolves the pair themselves.
function withoutAmbiguousSessions(rows) {
  const seen = Object.create(null);
  rows.forEach((c) => {
    const sid = c.session_id;
    if (!sid) return;
    seen[sid] = (seen[sid] || 0) + 1;
  });
  return rows.filter((c) => !c.session_id || seen[c.session_id] === 1);
}

// Suggest groupable sets over a list of claims (typically one practice's whole
// draft queue, already scoped by the caller's role).
//
// Returns, ordered so the list is stable across reloads:
//   [{ client_id, claim_ids: [...], lines, total }, ...]
//
// PHI: ids, counts and a money total only — never a name, a member id or a
// diagnosis value. The browser already holds the claims these ids refer to and
// does its own labelling.
function suggestGroups(claims) {
  const rows = (Array.isArray(claims) ? claims : []).filter(isGroupCandidate);

  const buckets = new Map();
  rows.forEach((c) => {
    const key = groupingKey(c);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  });

  const out = [];
  buckets.forEach((bucket) => {
    const eligible = withoutAmbiguousSessions(bucket);
    if (eligible.length < 2) return;

    // Filing order first, then split into claim-sized chunks. A client with
    // eight groupable drafts cannot file one claim — a CMS-1500 holds six
    // service lines — but they CAN file two, and saying "group six of these"
    // while silently ignoring the rest would leave the remainder looking
    // ungroupable. Chunking by date keeps each suggested claim contiguous in
    // time, which is how a payer reads it; a trailing chunk of one is dropped,
    // because one claim is not a grouping.
    const ordered = orderForFiling(eligible);
    for (let i = 0; i < ordered.length; i += MAX_GROUPED_LINES) {
      const chunk = ordered.slice(i, i + MAX_GROUPED_LINES);
      if (chunk.length < 2) continue;

      // The gate has the final word on every set that leaves here.
      const verdict = evaluateGroup(chunk);
      if (!verdict.ok) continue;

      out.push({
        // chunk is in filing order, so chunk[0] carries the earliest date of
        // service. Captured here for the sort below and stripped before the
        // suggestion is returned — it is an ordering key, not part of the API.
        earliest: chunk[0].session_date ? String(chunk[0].session_date).slice(0, 10) : '9999-12-31',
        client_id: chunk[0].client_id || null,
        claim_ids: chunk.map((c) => c.id),
        lines: verdict.lines,
        total: verdict.total,
      });
    }
  });

  // Oldest work first — the draft that has been waiting longest is the one most
  // worth filing. Tie-broken on the first claim id so the order never depends on
  // Map iteration or row order.
  out.sort((a, b) => {
    if (a.earliest < b.earliest) return -1;
    if (a.earliest > b.earliest) return 1;
    return a.claim_ids[0] < b.claim_ids[0] ? -1 : 1;
  });

  return out.map(({ client_id, claim_ids, lines, total }) => ({
    client_id, claim_ids, lines, total,
  }));
}

module.exports = {
  MAX_GROUPED_LINES,
  CLAIM_LEVEL_FIELDS,
  normalizedDiagnoses,
  sameDiagnoses,
  isReplacement,
  evaluateGroup,
  orderForFiling,
  suggestGroups,
};
