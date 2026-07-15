/* =============================================================================
 * Reddably — Audit log (#audit)  [admin only]
 * =============================================================================
 * A read-only, filterable view over the practice's HIPAA audit trail
 * (GET /audit-log). Columns: time, actor, action, resource, IP. Newest first,
 * with "Load more" paging via the occurred_at cursor the API returns.
 *
 * Admin-only in the UI (the nav link is hidden for non-admins in app.js) AND
 * enforced server-side (the endpoint returns 403 to non-admins). Built entirely
 * on the shared kit (window.Reddably) and ReddablyAPI — no direct fetch(), no raw
 * hex/px. The audit rows carry NO PHI (ids, field names, and non-PHI metadata
 * only), so nothing here needs PHI handling; ids/enums stay out of the URL hash.
 * ========================================================================== */
(function (window, document) {
  'use strict';

  var R = window.Reddably;
  if (!R) return;

  var h = R.h;
  var api = R.api;

  var PAGE_SIZE = 50;

  // Resource types the API accepts as a filter (mirrors backend/handlers/audit.js).
  var RESOURCE_TYPES = [
    'client', 'insurance_record', 'session', 'claim', 'vob',
    'user', 'practice', 'invitation', 'auth', 'refund_request',
  ];

  function isAdmin() {
    var cu = R.currentUser;
    return !!(cu && cu.user && cu.user.role === 'practice_admin');
  }

  // occurred_at is a full timestamp — render date + time (fmtDate is date-only).
  function fmtDateTime(s) {
    if (!s) return '—';
    var d = new Date(s);
    if (isNaN(d.getTime())) return '—';
    return R.fmtDate(s) + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0');
  }

  // Human label for the actor cell: staff name/email when we have it, else the
  // actor type (patient_link / system) for non-user actors.
  function actorLabel(row) {
    if (row.actor_name) return row.actor_name;
    if (row.actor_email) return row.actor_email;
    if (row.actor_type === 'patient_link') return 'Patient link';
    if (row.actor_type === 'system') return 'System';
    return row.actor_user_id ? 'User' : '—';
  }

  // Compact resource label: type + short id (ids are not PHI). metadata.count is
  // shown for list events so a "viewed 25 clients" reads clearly.
  function resourceLabel(row) {
    var parts = [];
    if (row.resource_type) parts.push(row.resource_type);
    if (row.resource_id) parts.push(String(row.resource_id).slice(0, 8));
    else if (row.metadata && typeof row.metadata.count === 'number') parts.push('×' + row.metadata.count);
    return parts.length ? parts.join(' · ') : '—';
  }

  function renderAudit(root) {
    if (!isAdmin()) {
      R.renderEmpty(root, {
        title: 'Admins only',
        body: 'The audit log is available to practice admins.',
      });
      return;
    }

    // Filter state.
    var filters = { resource_type: '', action: '', from: '', to: '' };
    var rows = [];
    var nextBefore = null;

    var resourceSelect = h('select', { class: 'field__control' }, [
      h('option', { value: '' }, 'All resources'),
    ].concat(RESOURCE_TYPES.map(function (t) {
      return h('option', { value: t }, t);
    })));

    var actionInput = h('input', {
      class: 'field__control', type: 'text', placeholder: 'e.g. client.view',
    });
    var fromInput = h('input', { class: 'field__control', type: 'date' });
    var toInput = h('input', { class: 'field__control', type: 'date' });

    var tbody = h('tbody', null, []);
    var loadMoreBtn = h('button', { class: 'btn btn--secondary', type: 'button' }, 'Load more');
    var loadMoreWrap = h('div', {
      style: 'margin-top:var(--space-4);text-align:center', hidden: 'hidden',
    }, [loadMoreBtn]);
    var statusLine = h('p', {
      style: 'color:var(--color-text-muted);font-size:var(--font-size-2);margin:0 0 var(--space-3)',
    }, '');

    function rowNode(r) {
      return h('tr', null, [
        h('td', { style: 'white-space:nowrap' }, fmtDateTime(r.occurred_at)),
        h('td', null, actorLabel(r)),
        h('td', null, h('code', {
          style: 'font-size:var(--font-size-2)',
        }, r.action || '—')),
        h('td', null, resourceLabel(r)),
        h('td', { style: 'white-space:nowrap' }, r.ip_address || '—'),
      ]);
    }

    function renderRows() {
      R.clear(tbody);
      if (rows.length === 0) {
        tbody.appendChild(h('tr', null, [
          h('td', { colspan: '5', style: 'color:var(--color-text-muted);padding:var(--space-4)' },
            'No audit events match these filters.'),
        ]));
      } else {
        rows.forEach(function (r) { tbody.appendChild(rowNode(r)); });
      }
      statusLine.textContent = rows.length + (rows.length === 1 ? ' event' : ' events') +
        (nextBefore ? ' (more available)' : '');
      loadMoreWrap.hidden = !nextBefore;
    }

    function fetchPage(append) {
      var q = {
        limit: PAGE_SIZE,
        resource_type: filters.resource_type || undefined,
        action: filters.action || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
        before: append ? (nextBefore || undefined) : undefined,
      };
      loadMoreBtn.disabled = true;
      return api.auditLog.list(q).then(function (res) {
        var page = (res && res.audit_log) || [];
        nextBefore = (res && res.next_before) || null;
        rows = append ? rows.concat(page) : page;
        renderRows();
        loadMoreBtn.disabled = false;
      }).catch(function (err) {
        loadMoreBtn.disabled = false;
        if (err && err.status === 403) {
          R.toast('Only a practice admin can view the audit log.', 'error');
        } else {
          R.toast((err && err.message) || 'Could not load the audit log.', 'error');
        }
      });
    }

    function applyFilters(e) {
      if (e) e.preventDefault();
      filters.resource_type = resourceSelect.value;
      filters.action = (actionInput.value || '').trim();
      filters.from = fromInput.value;
      filters.to = toInput.value;
      nextBefore = null;
      fetchPage(false);
    }

    loadMoreBtn.addEventListener('click', function () { fetchPage(true); });

    function field(labelText, control) {
      return h('label', { class: 'field', style: 'flex:1;min-width:10rem' }, [
        h('span', { class: 'field__label' }, labelText),
        control,
      ]);
    }

    var filterForm = h('form', { onSubmit: applyFilters }, [
      h('div', {
        style: 'display:flex;flex-wrap:wrap;gap:var(--space-3);align-items:flex-end',
      }, [
        field('Resource', resourceSelect),
        field('Action', actionInput),
        field('From', fromInput),
        field('To', toInput),
        h('div', { style: 'display:flex;gap:var(--space-2)' }, [
          h('button', { class: 'btn btn--primary', type: 'submit' }, 'Apply'),
        ]),
      ]),
    ]);

    var table = h('table', { class: 'data-table' }, [
      h('thead', null, h('tr', null, [
        h('th', null, 'Time'),
        h('th', null, 'Actor'),
        h('th', null, 'Action'),
        h('th', null, 'Resource'),
        h('th', null, 'IP address'),
      ])),
      tbody,
    ]);

    var view = h('div', { class: 'view stack' }, [
      h('div', { class: 'page-header' }, [
        h('h1', { class: 'page-header__title' }, 'Audit log'),
      ]),
      h('div', { class: 'card' }, [
        h('p', {
          style: 'margin:0 0 var(--space-4);color:var(--color-text-muted);font-size:var(--font-size-3)',
        }, 'Every access to and change of protected data, plus sign-ins. Read-only ' +
           'and append-only — records who did what, when, never patient details.'),
        filterForm,
      ]),
      h('div', { class: 'card' }, [
        statusLine,
        h('div', { style: 'overflow-x:auto' }, table),
        loadMoreWrap,
      ]),
    ]);

    R.clear(root);
    root.appendChild(view);
    fetchPage(false);
  }

  R.registerView('audit', function (root) {
    return renderAudit(root);
  });
})(window, document);
