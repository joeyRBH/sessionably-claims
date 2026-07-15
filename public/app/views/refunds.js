/* =============================================================================
 * Reddably — Refund requests (#refunds)  [admin only]
 * =============================================================================
 * The queue for the patient-initiated fee-refund flow. A patient reports that their
 * claim was denied; an admin records the outcome here and decides. A claim that was
 * PAID or applied to the DEDUCTIBLE is a success — only a DENIED claim refunds the
 * platform fee. Approving issues the Stripe refund of the fee (via the Vercel
 * function); denying moves no money. Nothing here ever auto-approves.
 *
 * Admin-only in the UI (nav link hidden for non-admins in app.js) AND enforced
 * server-side (the endpoint 403s non-admins). Built on the shared kit (window.Reddably)
 * and ReddablyAPI — no direct fetch(), no raw hex/px. Copy never names a clearinghouse
 * and never says "your insurance didn't pay" — a claim is "denied". Ids/enums only in
 * the hash; patient names never go in the URL.
 * ========================================================================== */
(function (window, document) {
  'use strict';

  var R = window.Reddably;
  if (!R) return;

  var h = R.h;
  var api = R.api;

  // Claim statuses a refund can be requested against (mirrors the backend guard).
  var REQUESTABLE = ['submitted', 'processing', 'info_requested', 'denied', 'appealed', 'paid'];

  var OUTCOME_OPTIONS = [
    { value: 'denied', label: 'Denied — refund the fee' },
    { value: 'paid', label: 'Paid — reimbursed (no refund)' },
    { value: 'deductible', label: 'Applied to deductible (no refund)' },
  ];

  var STATUS_FILTERS = [
    { value: 'open', label: 'Open' },
    { value: 'approved', label: 'Approved' },
    { value: 'denied', label: 'Denied' },
    { value: '', label: 'All' },
  ];

  function isAdmin() {
    var cu = R.currentUser;
    return !!(cu && cu.user && cu.user.role === 'practice_admin');
  }

  // Local badge with sensible tones for our two enums (statusBadge treats unknown
  // values as neutral; we want approved→success, denied→danger, open→info).
  function badge(value, kind) {
    var tone = 'neutral';
    if (kind === 'status') {
      tone = value === 'approved' ? 'success' : value === 'denied' ? 'danger' : 'info';
    } else { // outcome_label
      tone = value === 'paid' ? 'success' : value === 'denied' ? 'danger' : 'neutral';
    }
    var label = String(value || '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    return h('span', { class: 'badge badge--' + tone }, label || '—');
  }

  function shortClaim(r) {
    if (r.claim_number) return r.claim_number;
    return r.claim_id ? String(r.claim_id).slice(0, 8) : '—';
  }

  function renderRefunds(root) {
    if (!isAdmin()) {
      R.renderEmpty(root, {
        title: 'Admins only',
        body: 'Refund requests are managed by practice admins.',
      });
      return;
    }

    var filter = 'open';
    var rows = [];

    var filterSelect = h('select', { class: 'field__control', style: 'max-width:12rem' },
      STATUS_FILTERS.map(function (o) {
        var attrs = { value: o.value };
        if (o.value === filter) attrs.selected = 'selected';
        return h('option', attrs, o.label);
      }));

    var tbody = h('tbody', null, []);
    var statusLine = h('p', {
      style: 'color:var(--color-text-muted);font-size:var(--font-size-2);margin:0 0 var(--space-3)',
    }, '');

    function actionsCell(r) {
      if (r.status !== 'open') {
        // Terminal: show who decided, when.
        var when = r.decided_at ? R.fmtDate(r.decided_at) : '';
        return h('span', { style: 'color:var(--color-text-muted);font-size:var(--font-size-2)' },
          r.status === 'approved' ? ('Refunded ' + when) : ('Denied ' + when));
      }
      var btns = [];
      // Only a denied outcome is refundable.
      if (r.outcome_label === 'denied') {
        var approveBtn = h('button', { class: 'btn btn--primary btn--sm', type: 'button' }, 'Approve refund');
        approveBtn.addEventListener('click', function () { onApprove(r); });
        btns.push(approveBtn);
      }
      var denyBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, 'Deny');
      denyBtn.addEventListener('click', function () { onDeny(r); });
      btns.push(denyBtn);
      return h('div', { style: 'display:flex;gap:var(--space-2);flex-wrap:wrap' }, btns);
    }

    function rowNode(r) {
      return h('tr', null, [
        h('td', { style: 'white-space:nowrap' }, R.fmtDate(r.created_at)),
        h('td', null, r.client_name || '—'),
        h('td', null, h('code', { style: 'font-size:var(--font-size-2)' }, shortClaim(r))),
        h('td', null, badge(r.outcome_label, 'outcome')),
        h('td', null, badge(r.status, 'status')),
        h('td', null, actionsCell(r)),
      ]);
    }

    function renderRows() {
      R.clear(tbody);
      if (rows.length === 0) {
        tbody.appendChild(h('tr', null, [
          h('td', { colspan: '6', style: 'color:var(--color-text-muted);padding:var(--space-4)' },
            'No refund requests here yet.'),
        ]));
      } else {
        rows.forEach(function (r) { tbody.appendChild(rowNode(r)); });
      }
      statusLine.textContent = rows.length + (rows.length === 1 ? ' request' : ' requests');
    }

    function load() {
      return api.refunds.list({ status: filter || undefined }).then(function (res) {
        rows = (res && res.refund_requests) || [];
        renderRows();
      }).catch(function (err) {
        if (err && err.status === 403) {
          R.toast('Only a practice admin can manage refund requests.', 'error');
        } else {
          R.toast((err && err.message) || 'Could not load refund requests.', 'error');
        }
      });
    }

    // --- decisions -----------------------------------------------------------

    function onApprove(r) {
      R.formModal({
        title: 'Approve refund',
        submitLabel: 'Approve & refund fee',
        fields: [
          { name: 'reason', label: 'Reason (recorded on the decision)', type: 'textarea', required: true,
            placeholder: 'e.g. Claim denied per EOB; refunding the submission fee.' },
        ],
      }).then(function (out) {
        if (!out) return;
        R.toast('Processing refund…', 'info');
        api.refunds.approve(r.id, out.reason).then(function (res) {
          if (res && res.refunded && res.recorded) {
            R.toast('Fee refunded.', 'success');
          } else if (res && res.refunded && !res.recorded) {
            // Stripe refunded but our record didn't confirm — flag for reconciliation.
            R.toast((res && res.error) || 'Refund issued, but not recorded. It has been logged for review.', 'error');
          } else if (res && res.ok && !res.refunded) {
            R.toast('No refund was needed (already refunded).', 'info');
          } else {
            R.toast((res && res.error) || 'The refund could not be completed.', 'error');
          }
          load();
        }).catch(function (err) {
          R.toast((err && err.message) || 'The refund could not be completed.', 'error');
          load();
        });
      });
    }

    function onDeny(r) {
      var prompt = r.outcome_label === 'denied'
        ? 'Reason for denying this refund request'
        : 'Reason (this claim was a success, so no fee is refunded)';
      R.formModal({
        title: 'Deny refund request',
        submitLabel: 'Deny request',
        fields: [
          { name: 'reason', label: prompt, type: 'textarea', required: true,
            placeholder: 'Recorded on the decision.' },
        ],
      }).then(function (out) {
        if (!out) return;
        api.refunds.deny(r.id, out.reason).then(function () {
          R.toast('Request denied.', 'success');
          load();
        }).catch(function (err) {
          R.toast((err && err.message) || 'Could not deny the request.', 'error');
        });
      });
    }

    // --- create --------------------------------------------------------------

    function onNew() {
      // Pull the practice's requestable claims so the admin picks one instead of
      // typing an id. Client names are PHI but this is an admin-only surface.
      api.claims.list().then(function (res) {
        var claims = ((res && res.claims) || []).filter(function (c) {
          return REQUESTABLE.indexOf(c.status) !== -1;
        });
        if (claims.length === 0) {
          R.toast('No submitted claims are available to request a refund on.', 'info');
          return;
        }
        var options = claims.map(function (c) {
          var label = '#' + (c.claim_number || String(c.id).slice(0, 8)) +
            ' · ' + (c.client_name || 'Client') +
            (c.session_date ? ' · ' + R.fmtDate(c.session_date) : '') +
            ' · ' + (c.status || '');
          return { value: c.id, label: label };
        });
        R.formModal({
          title: 'New refund request',
          submitLabel: 'Create request',
          fields: [
            { name: 'claim_id', label: 'Claim', type: 'select', required: true, options: options },
            { name: 'outcome_label', label: 'Outcome the patient reported', type: 'select',
              required: true, options: OUTCOME_OPTIONS },
            { name: 'patient_note', label: 'Note (optional)', type: 'textarea',
              placeholder: 'Anything to record with this request.' },
          ],
        }).then(function (out) {
          if (!out) return;
          api.refunds.create({
            claim_id: out.claim_id,
            outcome_label: out.outcome_label,
            patient_note: out.patient_note || undefined,
          }).then(function () {
            R.toast('Refund request created.', 'success');
            // Show it wherever it belongs given the current filter.
            load();
          }).catch(function (err) {
            R.toast((err && err.message) || 'Could not create the request.', 'error');
          });
        });
      }).catch(function (err) {
        R.toast((err && err.message) || 'Could not load claims.', 'error');
      });
    }

    filterSelect.addEventListener('change', function () {
      filter = filterSelect.value;
      load();
    });

    var newBtn = h('button', { class: 'btn btn--primary', type: 'button' }, 'New refund request');
    newBtn.addEventListener('click', onNew);

    var table = h('table', { class: 'data-table' }, [
      h('thead', null, h('tr', null, [
        h('th', null, 'Requested'),
        h('th', null, 'Patient'),
        h('th', null, 'Claim'),
        h('th', null, 'Outcome'),
        h('th', null, 'Status'),
        h('th', null, 'Actions'),
      ])),
      tbody,
    ]);

    var view = h('div', { class: 'view stack' }, [
      h('div', { class: 'page-header', style: 'display:flex;justify-content:space-between;align-items:center;gap:var(--space-3);flex-wrap:wrap' }, [
        h('h1', { class: 'page-header__title' }, 'Refund requests'),
        newBtn,
      ]),
      h('div', { class: 'card' }, [
        h('p', {
          style: 'margin:0 0 var(--space-4);color:var(--color-text-muted);font-size:var(--font-size-3)',
        }, 'When a patient’s claim is denied, refund the submission fee here. A paid or ' +
           'deductible claim is a success — only a denied claim refunds the fee. Approving ' +
           'issues the refund to the card on file; every decision is logged.'),
        h('label', { class: 'field', style: 'max-width:12rem' }, [
          h('span', { class: 'field__label' }, 'Show'),
          filterSelect,
        ]),
      ]),
      h('div', { class: 'card' }, [
        statusLine,
        h('div', { style: 'overflow-x:auto' }, table),
      ]),
    ]);

    R.clear(root);
    root.appendChild(view);
    load();
  }

  R.registerView('refunds', function (root) {
    return renderRefunds(root);
  });
})(window, document);
