/* =============================================================================
 * Reddably — Payer ERA Enrollments workspace
 * =============================================================================
 * Registers under #enrollments. Practice admins manage per-payer ERA (electronic
 * remittance) enrollments here instead of the clearinghouse portal: see each
 * payer's status, start a new enrollment, and read the clearinghouse's next-step
 * instructions when a payer needs manual action. Enrollment is per-practice
 * (TIN-level), not per-clinician.
 *
 * Admin-only: the nav item is revealed for practice_admin in app.js, and this view
 * guards again on mount. All network calls go through ReddablyAPI (no direct
 * fetch()). The clearinghouse vendor is never named — any clearinghouse-originated
 * text (status_reason) is passed through R.scrubVendor() before display. Built on
 * the shared kit (window.Reddably); no raw hex, no new globals. Loaded last.
 * ========================================================================== */
(function (window, document) {
  'use strict';

  var R = window.Reddably;
  if (!R) return;

  var h = R.h;
  var api = R.api;

  // Map a clearinghouse enrollment status to a display badge. The raw status
  // string is NEVER rendered (it embeds the vendor name, e.g. STEDI_ACTION_
  // REQUIRED) — only this label/tone is shown, so unknown/new statuses fall back
  // to a neutral "Processing" rather than echoing the raw value.
  function statusDisplay(status) {
    switch (String(status == null ? '' : status).trim().toUpperCase()) {
      case 'LIVE':
        return { label: 'Live', tone: 'success' };
      case 'PROVIDER_ACTION_REQUIRED':
        return { label: 'Action needed', tone: 'warning' };
      case 'REJECTED':
        return { label: 'Rejected', tone: 'warning' };
      case 'CANCELED':
      case 'CANCELLED':
        return { label: 'Canceled', tone: 'muted' };
      // STEDI_ACTION_REQUIRED, PROVISIONING, requested, and anything else →
      // "Processing" (neutral).
      default:
        return { label: 'Processing', tone: 'neutral' };
    }
  }

  function statusBadge(status) {
    var d = statusDisplay(status);
    if (d.tone === 'muted') {
      return h('span', {
        class: 'badge badge--neutral',
        style: 'opacity:0.65',
      }, d.label);
    }
    return h('span', { class: 'badge badge--' + d.tone }, d.label);
  }

  function isTerminal(status) {
    var s = String(status == null ? '' : status).trim().toUpperCase();
    return s === 'LIVE' || s === 'CANCELED' || s === 'CANCELLED';
  }

  // ---------------------------------------------------------------------------
  // View
  // ---------------------------------------------------------------------------
  function renderEnrollments(root) {
    // Resolve the caller's role once (cached from /me by app.js when available).
    function resolveRole() {
      var cached = window.Reddably && window.Reddably.currentUser;
      if (cached) {
        var u = cached.user || cached;
        return Promise.resolve((u && u.role) || (cached.practice && cached.practice.role) || null);
      }
      return api.me().then(function (res) {
        var u = (res && res.user) || res || {};
        return u.role || null;
      }).catch(function () { return null; });
    }

    function load() {
      R.renderLoading(root);
      resolveRole().then(function (role) {
        if (role !== 'practice_admin') {
          R.renderEmpty(root, {
            title: 'Admins only',
            body: 'Payer enrollments are managed by a practice admin.',
          });
          return;
        }
        api.payerEnrollments.list().then(function (res) {
          render(role, (res && res.payer_enrollments) || [], res && res.sync_error);
        }).catch(function (err) {
          R.renderError(root, err, load);
        });
      });
    }

    // Open the "Enroll with payer" flow: a payer picker (reused from the shared
    // kit) whose selection carries both payer_id and payer_name.
    function openEnroll() {
      R.formModal({
        title: 'Enroll with payer',
        submitLabel: 'Enroll',
        fields: [
          {
            name: 'payer_id',
            label: 'Payer',
            type: 'payer',
            required: true,
            payerNameField: 'payer_name',
            placeholder: 'Search payer name or enter a Payer ID…',
          },
        ],
      }).then(function (values) {
        if (!values) return; // canceled
        api.payerEnrollments.create({
          payer_id: values.payer_id,
          payer_name: values.payer_name || null,
        }).then(function () {
          R.toast('Enrollment started.', 'success');
          load();
        }).catch(function (err) {
          // Surface the 422 missing-fields message (and 409 duplicate) verbatim.
          R.toast((err && err.message) || 'Could not start the enrollment.', 'error');
        });
      });
    }

    function forceSync(id, btn) {
      if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
      api.payerEnrollments.sync(id).then(function () {
        load();
      }).catch(function (err) {
        if (btn) { btn.disabled = false; btn.textContent = 'Check status'; }
        R.toast((err && err.message) || 'Could not refresh status.', 'error');
      });
    }

    function enrollButton() {
      return h('button', { class: 'btn btn--primary', type: 'button', onClick: openEnroll },
        'Enroll with payer');
    }

    function reasonRow(reason, colspan) {
      // Clearinghouse manual-step instructions: scrub the vendor name/URLs, then
      // render as plain text preserving line breaks (never as markup).
      var clean = R.scrubVendor(reason);
      return h('tr', { class: 'enrollment-reason-row' }, [
        h('td', { colspan: String(colspan) }, [
          h('div', {
            style: 'white-space:pre-wrap;color:var(--color-text-muted);'
              + 'font-size:var(--font-size-2);padding:var(--space-1) 0 var(--space-2)',
          }, clean),
        ]),
      ]);
    }

    function table(list) {
      var head = h('thead', null, h('tr', null, [
        h('th', null, 'Payer'),
        h('th', null, 'Transaction'),
        h('th', null, 'Status'),
        h('th', null, 'Last updated'),
      ]));

      var rows = [];
      list.forEach(function (e) {
        var statusCell = h('td', null, [
          statusBadge(e.status),
          !isTerminal(e.status)
            ? h('button', {
                class: 'btn btn--ghost btn--sm',
                type: 'button',
                style: 'margin-left:var(--space-2)',
                onClick: function (ev) { forceSync(e.id, ev.currentTarget); },
              }, 'Check status')
            : null,
        ]);
        rows.push(h('tr', null, [
          h('td', null, e.payer_name
            ? h('span', null, [e.payer_name, h('span', {
                style: 'color:var(--color-text-muted);margin-left:var(--space-1)',
              }, '(' + e.payer_id + ')')])
            : e.payer_id),
          h('td', null, 'ERA'),
          statusCell,
          h('td', null, R.fmtDate(e.last_synced_at || e.updated_at)),
        ]));
        if (e.status_reason && String(e.status_reason).trim() !== '') {
          rows.push(reasonRow(e.status_reason, 4));
        }
      });

      return h('div', { style: 'overflow-x:auto' },
        h('table', { class: 'data-table' }, [head, h('tbody', null, rows)]));
    }

    function render(role, list, syncError) {
      R.clear(root);

      var header = h('div', { class: 'page-header' }, [
        h('h1', { class: 'page-header__title' }, 'Enrollments'),
        h('div', { class: 'page-header__actions' }, list.length ? enrollButton() : null),
      ]);

      var syncNote = syncError
        ? h('div', {
            class: 'card',
            style: 'border-color:var(--color-warning, currentColor);'
              + 'color:var(--color-text-muted);font-size:var(--font-size-2)',
          }, 'Live status could not be refreshed just now — showing the last known status. Try again shortly.')
        : null;

      var intro = h('p', {
        style: 'color:var(--color-text-muted);font-size:var(--font-size-2);margin:0 0 var(--space-3)',
      }, 'Enroll with each payer to receive electronic remittance (payment detail) automatically — claims and eligibility work without it.');

      var body;
      if (!list.length) {
        // Empty state: one-sentence explanation + the enroll button.
        body = h('div', { class: 'empty-state' }, [
          h('h2', { class: 'empty-state__title' }, 'No payer enrollments yet'),
          h('p', { class: 'empty-state__body' },
            'Enroll with each payer to receive electronic remittance (payment detail) automatically — claims and eligibility work without it.'),
          enrollButton(),
        ]);
      } else {
        body = h('div', { class: 'card' }, table(list));
      }

      root.appendChild(h('div', { class: 'view stack' }, [
        header,
        list.length ? intro : null,
        syncNote,
        body,
      ]));
    }

    load();
  }

  R.registerView('enrollments', function (root) {
    return renderEnrollments(root);
  });
})(window, document);
