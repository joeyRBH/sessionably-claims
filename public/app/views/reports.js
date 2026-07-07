/* =============================================================================
 * Reddably — Reports workspace (practice analytics v1)
 * =============================================================================
 * Registers under #reports. All aggregation is server-side (GET /reports); this
 * view only renders the returned totals — no per-row math over claim lists. Built
 * on the shared kit (window.Reddably) and ReddablyAPI — no direct fetch(), no raw
 * hex, no new globals. The optional date range carries only YYYY-MM-DD bounds
 * (non-PHI). Loaded after claims.js.
 * ========================================================================== */
(function (window, document) {
  'use strict';

  var R = window.Reddably;
  if (!R) return;

  var h = R.h;
  var api = R.api;

  function humanize(s) {
    if (!s) return '—';
    return String(s).replace(/_/g, ' ').replace(/\b\w/g, function (c) {
      return c.toUpperCase();
    });
  }

  // A labeled metric card (used for the revenue summary row).
  function statCard(label, value, sub) {
    return h('div', { class: 'card', style: 'flex:1;min-width:12rem' }, [
      h('span', { class: 'stat__label', style: 'color:var(--color-text-muted);font-size:var(--font-size-2)' }, label),
      h('div', { style: 'font-size:var(--font-size-6);font-weight:var(--font-weight-medium);margin-top:var(--space-1)' }, value),
      sub ? h('div', { style: 'color:var(--color-text-muted);font-size:var(--font-size-2);margin-top:var(--space-1)' }, sub) : null,
    ]);
  }

  function card(title, bodyNode) {
    return h('div', { class: 'card' }, [
      h('div', { class: 'card__header' }, [h('h2', { class: 'card__title' }, title)]),
      bodyNode,
    ]);
  }

  // Wrap a wide table so it scrolls horizontally instead of blowing out the page.
  function scrollTable(tableNode) {
    return h('div', { style: 'overflow-x:auto' }, tableNode);
  }

  function emptyLine(text) {
    return h('p', { class: 'empty-state__body', style: 'margin:0;padding:var(--space-3) 0' }, text);
  }

  // ---------------------------------------------------------------------------
  // Section builders
  // ---------------------------------------------------------------------------
  function revenueSection(rev) {
    rev = rev || {};
    var row = h('div', { style: 'display:flex;flex-wrap:wrap;gap:var(--space-4)' }, [
      statCard('Billed', R.fmtMoney(rev.billed_total)),
      statCard('Allowed', R.fmtMoney(rev.allowed_total)),
      statCard('Reimbursed', R.fmtMoney(rev.reimbursed_total)),
      statCard('Avg reimbursement / session', R.fmtMoney(rev.avg_reimbursement_per_session),
        (rev.session_count || 0) + ' session' + (rev.session_count === 1 ? '' : 's')),
    ]);
    return row;
  }

  function pipelineSection(pipeline) {
    pipeline = pipeline || {};
    var statuses = pipeline.statuses || [];
    var months = pipeline.months || [];
    if (!months.length) return card('Claims pipeline', emptyLine('No claims in this range.'));

    var head = h('tr', null, [h('th', null, 'Month')]
      .concat(statuses.map(function (s) { return h('th', { class: 'data-table__num' }, humanize(s)); }))
      .concat([h('th', { class: 'data-table__num' }, 'Total'),
               h('th', { class: 'data-table__num' }, 'Billed')]));

    var bodyRows = months.map(function (m) {
      return h('tr', null, [h('td', null, m.month)]
        .concat(statuses.map(function (s) {
          return h('td', { class: 'data-table__num' }, String(m.counts[s] || 0));
        }))
        .concat([
          h('td', { class: 'data-table__num' }, String(m.total_count)),
          h('td', { class: 'data-table__num' }, R.fmtMoney(m.total_billed)),
        ]));
    });

    var t = pipeline.totals || { counts: {}, billed: {}, total_count: 0, total_billed: 0 };
    var totalRow = h('tr', { style: 'font-weight:var(--font-weight-medium)' },
      [h('td', null, 'Total')]
        .concat(statuses.map(function (s) {
          return h('td', { class: 'data-table__num' }, String((t.counts && t.counts[s]) || 0));
        }))
        .concat([
          h('td', { class: 'data-table__num' }, String(t.total_count || 0)),
          h('td', { class: 'data-table__num' }, R.fmtMoney(t.total_billed)),
        ]));

    var table = h('table', { class: 'data-table' }, [
      h('thead', null, head),
      h('tbody', null, bodyRows.concat([totalRow])),
    ]);
    return card('Claims pipeline (count by status, by month)', scrollTable(table));
  }

  function agingSection(aging) {
    aging = aging || {};
    var buckets = aging.buckets || [];
    if (!aging.total_count) {
      return card('Aging (outstanding claims)', emptyLine('No outstanding claims to age.'));
    }
    var cards = h('div', { style: 'display:flex;flex-wrap:wrap;gap:var(--space-4)' },
      buckets.map(function (b) {
        return statCard(b.label + ' days', String(b.count), R.fmtMoney(b.billed) + ' billed');
      }));
    return card('Aging (outstanding claims by days since submission)', cards);
  }

  function breakdownTable(title, rows, firstLabel, firstKey) {
    if (!rows || !rows.length) return card(title, emptyLine('No data in this range.'));
    var body = rows.map(function (r) {
      return h('tr', null, [
        h('td', null, r[firstKey] || '—'),
        h('td', { class: 'data-table__num' }, String(r.count)),
        h('td', { class: 'data-table__num' }, R.fmtMoney(r.billed)),
        h('td', { class: 'data-table__num' }, R.fmtMoney(r.reimbursed)),
      ]);
    });
    var table = h('table', { class: 'data-table' }, [
      h('thead', null, h('tr', null, [
        h('th', null, firstLabel),
        h('th', { class: 'data-table__num' }, 'Claims'),
        h('th', { class: 'data-table__num' }, 'Billed'),
        h('th', { class: 'data-table__num' }, 'Reimbursed'),
      ])),
      h('tbody', null, body),
    ]);
    return card(title, scrollTable(table));
  }

  // ---------------------------------------------------------------------------
  // View
  // ---------------------------------------------------------------------------
  function renderReports(root) {
    // Date-range state (both optional; blank = all-time). Kept in closure so the
    // Apply button re-queries server-side rather than filtering client-side.
    var state = { start: '', end: '' };

    function load() {
      R.renderLoading(root);
      var filters = {};
      if (state.start) filters.start = state.start;
      if (state.end) filters.end = state.end;
      api.reports.summary(filters).then(function (res) {
        render((res && res.report) || {});
      }).catch(function (err) {
        R.renderError(root, err, load);
      });
    }

    function controls() {
      var startInput = h('input', {
        class: 'field__control', type: 'date', 'aria-label': 'Start date',
        value: state.start, style: 'max-width:11rem',
      });
      var endInput = h('input', {
        class: 'field__control', type: 'date', 'aria-label': 'End date',
        value: state.end, style: 'max-width:11rem',
      });
      var apply = h('button', { class: 'btn btn--primary', type: 'button',
        onClick: function () {
          state.start = startInput.value || '';
          state.end = endInput.value || '';
          load();
        } }, 'Apply');
      var reset = h('button', { class: 'btn btn--ghost', type: 'button',
        onClick: function () {
          state.start = ''; state.end = '';
          load();
        } }, 'Reset');
      return h('div', {
        style: 'display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap',
      }, [
        h('span', { style: 'color:var(--color-text-muted);font-size:var(--font-size-2)' }, 'From'),
        startInput,
        h('span', { style: 'color:var(--color-text-muted);font-size:var(--font-size-2)' }, 'to'),
        endInput,
        apply,
        reset,
      ]);
    }

    function render(report) {
      R.clear(root);
      var view = h('div', { class: 'view stack' }, [
        h('div', { class: 'page-header' }, [
          h('h1', { class: 'page-header__title' }, 'Reports'),
          h('div', { class: 'page-header__actions' }, controls()),
        ]),
        revenueSection(report.revenue),
        pipelineSection(report.pipeline),
        agingSection(report.aging),
        breakdownTable('By client', report.by_client, 'Client', 'client_name'),
        breakdownTable('By CPT code', report.by_cpt, 'CPT', 'cpt_code'),
      ]);
      root.appendChild(view);
    }

    load();
  }

  R.registerView('reports', function (root) {
    return renderReports(root);
  });
})(window, document);
