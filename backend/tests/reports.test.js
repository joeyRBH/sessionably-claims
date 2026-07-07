'use strict';

// Unit test — reports aggregation math (backend/handlers/reports.js).
// Exercises the pure aggregateReports() reducer on mock claim rows with a fixed
// `now`, so aging buckets are deterministic. No DB, no network.
//
//   node backend/tests/reports.test.js

const assert = require('node:assert');
const path = require('node:path');

const { aggregateReports } = require(path.join(__dirname, '..', 'handlers', 'reports.js'));

// Fixed clock: 2026-07-07T00:00:00Z.
const NOW = Date.UTC(2026, 6, 7);
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

// Mock claims covering multiple statuses, months, CPTs, clients, and ages.
const rows = [
  // paid, June, CPT 90837, client A — reimbursed
  { status: 'paid', billed_amount: '200.00', allowed_amount: '150.00', reimbursed_amount: '120.00',
    submitted_at: daysAgo(45), created_at: '2026-06-10T12:00:00Z', session_id: 's1',
    cpt_code: '90837', client_id: 'A', client_name: 'Alice' },
  // submitted, June, CPT 90834, client B — outstanding 10 days
  { status: 'submitted', billed_amount: '100.00', allowed_amount: null, reimbursed_amount: null,
    submitted_at: daysAgo(10), created_at: '2026-06-20T12:00:00Z', session_id: 's2',
    cpt_code: '90834', client_id: 'B', client_name: 'Bob' },
  // submitted, July, CPT 90837, client A — outstanding 40 days
  { status: 'submitted', billed_amount: '200.00', allowed_amount: null, reimbursed_amount: null,
    submitted_at: daysAgo(40), created_at: '2026-07-01T12:00:00Z', session_id: 's3',
    cpt_code: '90837', client_id: 'A', client_name: 'Alice' },
  // processing, July, CPT 90834, client B — outstanding 75 days
  { status: 'processing', billed_amount: '100.00', allowed_amount: null, reimbursed_amount: null,
    submitted_at: daysAgo(75), created_at: '2026-07-02T12:00:00Z', session_id: 's4',
    cpt_code: '90834', client_id: 'B', client_name: 'Bob' },
  // denied, July, CPT 90837, client A — outstanding 120 days (denied => NOT aged)
  { status: 'denied', billed_amount: '200.00', allowed_amount: '0.00', reimbursed_amount: '0.00',
    submitted_at: daysAgo(120), created_at: '2026-07-03T12:00:00Z', session_id: 's5',
    cpt_code: '90837', client_id: 'A', client_name: 'Alice' },
  // draft, July, no CPT, client C — draft => NOT aged, cpt => 'Unknown'
  { status: 'draft', billed_amount: '150.00', allowed_amount: null, reimbursed_amount: null,
    submitted_at: null, created_at: '2026-07-04T12:00:00Z', session_id: 's6',
    cpt_code: null, client_id: 'C', client_name: 'Carol' },
];

const rep = aggregateReports(rows, { now: NOW });

// --- claim count ---------------------------------------------------------------
assert.strictEqual(rep.claim_count, 6);

// --- (a) pipeline: status totals ----------------------------------------------
const pt = rep.pipeline.totals.counts;
assert.strictEqual(pt.paid, 1, 'one paid');
assert.strictEqual(pt.submitted, 2, 'two submitted');
assert.strictEqual(pt.processing, 1, 'one processing');
assert.strictEqual(pt.denied, 1, 'one denied');
assert.strictEqual(pt.draft, 1, 'one draft');
assert.strictEqual(rep.pipeline.totals.total_count, 6);
assert.strictEqual(rep.pipeline.totals.total_billed, 950, 'billed 200+100+200+100+200+150');

// months present and sorted: 2026-06 then 2026-07
const months = rep.pipeline.months.map((m) => m.month);
assert.deepStrictEqual(months, ['2026-06', '2026-07'], 'months sorted ascending');
const june = rep.pipeline.months.find((m) => m.month === '2026-06');
assert.strictEqual(june.counts.paid, 1);
assert.strictEqual(june.counts.submitted, 1);
assert.strictEqual(june.total_count, 2);
assert.strictEqual(june.total_billed, 300);

// --- (b) revenue ---------------------------------------------------------------
assert.strictEqual(rep.revenue.billed_total, 950);
assert.strictEqual(rep.revenue.allowed_total, 150, 'only paid+denied carry allowed (150+0)');
assert.strictEqual(rep.revenue.reimbursed_total, 120);
assert.strictEqual(rep.revenue.session_count, 6, 'six distinct sessions');
assert.strictEqual(rep.revenue.avg_reimbursement_per_session, 20, '120 / 6 sessions');

// --- (c) aging buckets (only submitted/processing/info_requested/appealed) -----
// Outstanding: s2 (10d -> 0-30), s3 (40d -> 31-60), s4 (75d -> 61-90).
// s5 denied and s6 draft are excluded even though "old"/unsubmitted.
const bucket = (label) => rep.aging.buckets.find((b) => b.label === label);
assert.strictEqual(bucket('0-30').count, 1, '0-30 has s2');
assert.strictEqual(bucket('0-30').billed, 100);
assert.strictEqual(bucket('31-60').count, 1, '31-60 has s3');
assert.strictEqual(bucket('31-60').billed, 200);
assert.strictEqual(bucket('61-90').count, 1, '61-90 has s4');
assert.strictEqual(bucket('61-90').billed, 100);
assert.strictEqual(bucket('90+').count, 0, 'nothing in 90+ (denied excluded)');
assert.strictEqual(rep.aging.total_count, 3, 'three outstanding claims aged');
assert.strictEqual(rep.aging.total_billed, 400);

// --- (d) by CPT ----------------------------------------------------------------
const cpt = (code) => rep.by_cpt.find((c) => c.cpt_code === code);
assert.strictEqual(cpt('90837').count, 3, '90837 on s1, s3, s5');
assert.strictEqual(cpt('90837').billed, 600);
assert.strictEqual(cpt('90837').reimbursed, 120);
assert.strictEqual(cpt('90834').count, 2, '90834 on s2, s4');
assert.strictEqual(cpt('90834').billed, 200);
assert.strictEqual(cpt('Unknown').count, 1, 'null cpt -> Unknown');
// by_cpt sorted by count desc: 90837 (3) first.
assert.strictEqual(rep.by_cpt[0].cpt_code, '90837');

// --- (d) by client -------------------------------------------------------------
const cl = (id) => rep.by_client.find((c) => c.client_id === id);
assert.strictEqual(cl('A').count, 3, 'Alice s1, s3, s5');
assert.strictEqual(cl('A').billed, 600);
assert.strictEqual(cl('A').reimbursed, 120);
assert.strictEqual(cl('B').count, 2);
assert.strictEqual(cl('C').count, 1);
assert.strictEqual(cl('A').client_name, 'Alice');
// sorted by billed desc: Alice (600) first.
assert.strictEqual(rep.by_client[0].client_id, 'A');

// --- empty input is safe -------------------------------------------------------
const empty = aggregateReports([], { now: NOW });
assert.strictEqual(empty.claim_count, 0);
assert.strictEqual(empty.revenue.avg_reimbursement_per_session, 0, 'no divide-by-zero');
assert.strictEqual(empty.aging.total_count, 0);
assert.deepStrictEqual(empty.by_cpt, []);

console.log('PASS reports.test.js');
