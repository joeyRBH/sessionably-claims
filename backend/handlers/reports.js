'use strict';

// Reports resource — practice analytics v1.
//
//   GET /reports?start=YYYY-MM-DD&end=YYYY-MM-DD → aggregated practice metrics
//
// Security: practice_id is ALWAYS derived from the authenticated user (loaded
// from the users row), never from the body/token/query. Every row aggregated is
// scoped to that practice. Claims carry PHI-adjacent billing data, so error logs
// stay generic and never echo amounts, client names, or ids.
//
// All aggregation happens SERVER-SIDE: one practice-scoped SQL fetch, then a pure
// reducer (aggregateReports) so the browser never does per-row math over full
// claim lists. aggregateReports is exported for unit testing.

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Full claim lifecycle, in display order — drives the pipeline's stable columns.
const CLAIM_STATUSES = [
  'draft', 'submitted', 'processing', 'info_requested',
  'denied', 'appealed', 'paid', 'void',
];

// Statuses that represent money still in flight with the payer — the only ones
// that age. Draft (not sent), paid / denied / void (terminal) are excluded.
const OUTSTANDING_STATUSES = ['submitted', 'processing', 'info_requested', 'appealed'];

const DAY_MS = 24 * 60 * 60 * 1000;

// --- request helpers ---------------------------------------------------------

function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

function queryParam(event, name) {
  return event && event.queryStringParameters ? event.queryStringParameters[name] : undefined;
}

function isValidDate(s) {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Coerce a pg numeric (returned as a string) to a finite Number; anything
// non-numeric (null / undefined / '') becomes 0 so sums never turn into NaN.
function num(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Round to cents to avoid floating-point dust accumulating across many adds.
function money(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// --- pure aggregation (exported for unit tests) ------------------------------

// aggregateReports(rows, opts) → the full reports payload.
//   rows: [{ status, billed_amount, allowed_amount, reimbursed_amount,
//            submitted_at, created_at, session_id, session_date, cpt_code,
//            client_id, client_name }]
//   opts.now: ms timestamp used for aging (defaults to Date.now()).
// No DB access, no I/O — deterministic given (rows, now).
function aggregateReports(rows, opts) {
  const list = Array.isArray(rows) ? rows : [];
  const now = (opts && opts.now != null) ? opts.now : Date.now();

  // --- (a) Claims pipeline: count + billed by status, grouped by month --------
  const emptyCounts = () => CLAIM_STATUSES.reduce((acc, s) => { acc[s] = 0; return acc; }, {});
  const monthMap = {}; // 'YYYY-MM' -> { counts, billed }
  const totalCounts = emptyCounts();
  const totalBilled = emptyCounts();

  // --- (b) Revenue ------------------------------------------------------------
  let billedTotal = 0;
  let allowedTotal = 0;
  let reimbursedTotal = 0;
  const sessionIds = {}; // distinct session ids → per-session averages

  // --- (c) Aging (outstanding claims by days since submission) ----------------
  const agingDefs = [
    { label: '0-30', min: 0, max: 30 },
    { label: '31-60', min: 31, max: 60 },
    { label: '61-90', min: 61, max: 90 },
    { label: '90+', min: 91, max: Infinity },
  ];
  const aging = agingDefs.map((d) => ({ label: d.label, count: 0, billed: 0 }));

  // --- (d) Breakdowns ---------------------------------------------------------
  const clientMap = {}; // client_id -> { client_id, client_name, count, billed, reimbursed }
  const cptMap = {};    // cpt_code  -> { cpt_code, count, billed, reimbursed }

  list.forEach((r) => {
    const status = CLAIM_STATUSES.indexOf(r.status) !== -1 ? r.status : null;
    const billed = num(r.billed_amount);
    const allowed = num(r.allowed_amount);
    const reimbursed = num(r.reimbursed_amount);

    // (a) pipeline
    if (status) {
      const month = r.created_at ? String(r.created_at).slice(0, 7) : 'unknown';
      if (!monthMap[month]) monthMap[month] = { counts: emptyCounts(), billed: emptyCounts() };
      monthMap[month].counts[status] += 1;
      monthMap[month].billed[status] += billed;
      totalCounts[status] += 1;
      totalBilled[status] += billed;
    }

    // (b) revenue
    billedTotal += billed;
    allowedTotal += allowed;
    reimbursedTotal += reimbursed;
    if (r.session_id != null) sessionIds[r.session_id] = true;

    // (c) aging — only outstanding claims that carry a submission timestamp
    if (OUTSTANDING_STATUSES.indexOf(r.status) !== -1 && r.submitted_at) {
      const submittedMs = new Date(r.submitted_at).getTime();
      if (!Number.isNaN(submittedMs)) {
        const days = Math.floor((now - submittedMs) / DAY_MS);
        const idx = agingDefs.findIndex((d) => days >= d.min && days <= d.max);
        const bucket = aging[idx >= 0 ? idx : aging.length - 1];
        bucket.count += 1;
        bucket.billed += billed;
      }
    }

    // (d) by client
    if (r.client_id != null) {
      if (!clientMap[r.client_id]) {
        clientMap[r.client_id] = {
          client_id: r.client_id,
          client_name: r.client_name || null,
          count: 0, billed: 0, reimbursed: 0,
        };
      }
      const c = clientMap[r.client_id];
      c.count += 1;
      c.billed += billed;
      c.reimbursed += reimbursed;
    }

    // (d) by CPT
    const cpt = r.cpt_code || 'Unknown';
    if (!cptMap[cpt]) cptMap[cpt] = { cpt_code: cpt, count: 0, billed: 0, reimbursed: 0 };
    cptMap[cpt].count += 1;
    cptMap[cpt].billed += billed;
    cptMap[cpt].reimbursed += reimbursed;
  });

  const months = Object.keys(monthMap).sort().map((month) => {
    const m = monthMap[month];
    let mCount = 0;
    let mBilled = 0;
    CLAIM_STATUSES.forEach((s) => {
      m.billed[s] = money(m.billed[s]);
      mCount += m.counts[s];
      mBilled += m.billed[s];
    });
    return { month, counts: m.counts, billed: m.billed, total_count: mCount, total_billed: money(mBilled) };
  });

  const totalsBilledRounded = {};
  let grandCount = 0;
  let grandBilled = 0;
  CLAIM_STATUSES.forEach((s) => {
    totalsBilledRounded[s] = money(totalBilled[s]);
    grandCount += totalCounts[s];
    grandBilled += totalsBilledRounded[s];
  });

  const sessionCount = Object.keys(sessionIds).length;

  const byClient = Object.keys(clientMap).map((k) => {
    const c = clientMap[k];
    return { ...c, billed: money(c.billed), reimbursed: money(c.reimbursed) };
  }).sort((a, b) => b.billed - a.billed || b.count - a.count);

  const byCpt = Object.keys(cptMap).map((k) => {
    const c = cptMap[k];
    return { ...c, billed: money(c.billed), reimbursed: money(c.reimbursed) };
  }).sort((a, b) => b.count - a.count || b.billed - a.billed);

  return {
    claim_count: list.length,
    pipeline: {
      statuses: CLAIM_STATUSES.slice(),
      months,
      totals: {
        counts: totalCounts,
        billed: totalsBilledRounded,
        total_count: grandCount,
        total_billed: money(grandBilled),
      },
    },
    revenue: {
      billed_total: money(billedTotal),
      allowed_total: money(allowedTotal),
      reimbursed_total: money(reimbursedTotal),
      session_count: sessionCount,
      avg_reimbursement_per_session: sessionCount ? money(reimbursedTotal / sessionCount) : 0,
    },
    aging: {
      buckets: aging.map((b) => ({ label: b.label, count: b.count, billed: money(b.billed) })),
      total_count: aging.reduce((n, b) => n + b.count, 0),
      total_billed: money(aging.reduce((n, b) => n + b.billed, 0)),
    },
    by_client: byClient,
    by_cpt: byCpt,
  };
}

// --- practice scoping --------------------------------------------------------

async function loadPracticeId(userId) {
  const res = await db.query(
    `select practice_id from users where id = $1 and is_active = true limit 1`,
    [userId]
  );
  return res.rows[0] ? res.rows[0].practice_id : null;
}

// --- handler -----------------------------------------------------------------

async function getReports(practiceId, event) {
  const params = [practiceId];
  let where = `c.practice_id = $1 and c.is_hidden = false`;

  // Optional date range filters the claim's created_at (the pipeline's month key).
  const start = queryParam(event, 'start');
  if (start != null && start !== '') {
    if (!isValidDate(start)) return json(400, { error: 'Invalid start. Expected YYYY-MM-DD.' }, event);
    params.push(start);
    where += ` and c.created_at >= $${params.length}::date`;
  }
  const end = queryParam(event, 'end');
  if (end != null && end !== '') {
    if (!isValidDate(end)) return json(400, { error: 'Invalid end. Expected YYYY-MM-DD.' }, event);
    // Inclusive end: everything strictly before the day after `end`.
    params.push(end);
    where += ` and c.created_at < ($${params.length}::date + interval '1 day')`;
  }

  const res = await db.query(
    `select c.status,
            c.billed_amount,
            c.allowed_amount,
            c.reimbursed_amount,
            c.submitted_at,
            c.created_at,
            c.session_id,
            c.client_id,
            s.session_date    as session_date,
            s.cpt_code        as cpt_code,
            cl.first_name     as client_first_name,
            cl.last_name      as client_last_name,
            cl.preferred_name as client_preferred_name
       from claims c
       join clients cl on cl.id = c.client_id
       join sessions s on s.id = c.session_id
      where ${where}`,
    params
  );

  const rows = res.rows.map((r) => ({
    status: r.status,
    billed_amount: r.billed_amount,
    allowed_amount: r.allowed_amount,
    reimbursed_amount: r.reimbursed_amount,
    submitted_at: r.submitted_at,
    created_at: r.created_at,
    session_id: r.session_id,
    session_date: r.session_date,
    cpt_code: r.cpt_code,
    client_id: r.client_id,
    client_name:
      r.client_preferred_name ||
      [r.client_first_name, r.client_last_name].filter(Boolean).join(' ').trim() ||
      null,
  }));

  const report = aggregateReports(rows, {});
  report.range = { start: start || null, end: end || null };
  return json(200, { report }, event);
}

// --- entrypoint --------------------------------------------------------------

// Exported for unit testing the aggregation math (Lambda only calls .handler).
exports.aggregateReports = aggregateReports;

exports.handler = async (event) => {
  const method = httpMethod(event);
  if (method === 'OPTIONS') {
    return preflight(event);
  }

  let auth;
  try {
    auth = requireAuth(event);
  } catch (err) {
    return json(err.statusCode || 401, { error: 'Unauthorized' }, event);
  }

  try {
    const practiceId = await loadPracticeId(auth.user.sub);
    if (!practiceId) {
      return json(401, { error: 'Unauthorized' }, event);
    }
    if (method === 'GET') return await getReports(practiceId, event);
    return json(405, { error: 'Method not allowed' }, event);
  } catch (err) {
    console.error('reports error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
