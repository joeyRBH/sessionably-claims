/* =============================================================================
 * Reddably — Clinicians directory (list + edit)
 * =============================================================================
 * Registers under #clinicians. Built entirely on the shared kit (window.Reddably)
 * and ReddablyAPI — no direct fetch(), no raw hex/px, no new globals. The backend
 * enforces all role-gating and self-lockout rules; we surface its errors verbatim.
 * Loaded after claims.js.
 * ========================================================================== */
(function (window, document) {
  'use strict';

  var R = window.Reddably;
  if (!R) return;

  var h = R.h;
  var api = R.api;

  // Edit-form field specs. role / is_active are constrained selects; is_active is
  // boolean in the DB, so it is coerced to/from strings around formModal.
  var USER_FIELDS = [
    { name: 'first_name', label: 'First name', type: 'text' },
    { name: 'last_name',  label: 'Last name',  type: 'text' },
    { name: 'title',      label: 'Title',      type: 'text' },
    { name: 'npi',        label: 'NPI',        type: 'text' },
    { name: 'role',       label: 'Role',       type: 'select',
      options: ['clinician', 'admin', 'biller'] },
    { name: 'is_active',  label: 'Active',     type: 'select',
      options: [
        { value: 'true',  label: 'Active' },
        { value: 'false', label: 'Inactive' },
      ] },
  ];

  // Drop null / undefined / '' keys so optional fields are omitted, not blanked.
  function compact(obj) {
    var out = {};
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (v === null || v === undefined || v === '') return;
      out[k] = v;
    });
    return out;
  }

  function humanize(s) {
    if (!s) return '—';
    return String(s).replace(/_/g, ' ').replace(/\b\w/g, function (c) {
      return c.toUpperCase();
    });
  }

  function userName(u) {
    var name = ((u.first_name || '') + ' ' + (u.last_name || '')).trim();
    return name || u.email || ('User ' + u.id);
  }

  // "LCSW · NPI 1234567890" — whichever of title / NPI is present.
  function titleNpi(u) {
    var parts = [];
    if (u.title) parts.push(u.title);
    if (u.npi) parts.push('NPI ' + u.npi);
    return parts.length ? parts.join('  ·  ') : '—';
  }

  function statusBadge(u) {
    return u.is_active
      ? h('span', { class: 'badge badge--success' }, 'Active')
      : h('span', { class: 'badge badge--neutral' }, 'Inactive');
  }

  // ===========================================================================
  // Clinicians directory (#clinicians)
  // ===========================================================================
  function mountClinicians(root) {
    function load() {
      R.renderLoading(root);
      api.users.list().then(function (res) {
        render((res && res.users) || []);
      }).catch(function (err) {
        R.renderError(root, err, load);
      });
    }

    function openEdit(user) {
      var values = {};
      Object.keys(user).forEach(function (k) { values[k] = user[k]; });
      values.is_active = String(user.is_active);

      R.formModal({
        title: 'Edit clinician',
        fields: USER_FIELDS,
        values: values,
        submitLabel: 'Save changes',
      }).then(function (result) {
        if (!result) return;
        var payload = compact(result);
        payload.is_active = result.is_active === 'true';
        api.users.update(user.id, payload).then(function () {
          R.toast('Clinician updated', 'success');
          load();
        }).catch(function (err) {
          R.toast(err.message, 'error');
        });
      });
    }

    function render(users) {
      R.clear(root);

      if (!users.length) {
        R.renderEmpty(root, {
          title: 'No clinicians yet',
          body: 'Users are added during account setup or via invitation.',
        });
        return;
      }

      var rows = users.map(function (u) {
        return h('tr', null, [
          h('td', null, userName(u)),
          h('td', null, humanize(u.role)),
          h('td', null, titleNpi(u)),
          h('td', null, statusBadge(u)),
          h('td', { class: 'data-table__num' },
            h('button', { class: 'btn btn--ghost btn--sm', type: 'button',
              onClick: function () { openEdit(u); } }, 'Edit')),
        ]);
      });

      var table = h('table', { class: 'data-table' }, [
        h('thead', null, h('tr', null, [
          h('th', null, 'Name'),
          h('th', null, 'Role'),
          h('th', null, 'Title / NPI'),
          h('th', null, 'Status'),
          h('th', { class: 'data-table__num' }, ''),
        ])),
        h('tbody', null, rows),
      ]);

      var view = h('div', { class: 'view stack' }, [
        h('div', { class: 'page-header' }, [
          h('h1', { class: 'page-header__title' }, 'Clinicians'),
        ]),
        h('div', { class: 'card' }, table),
      ]);

      root.appendChild(view);
    }

    load();
  }

  // ===========================================================================
  // Route registration
  // ===========================================================================
  R.registerView('clinicians', function (root) { mountClinicians(root); });
})(window, document);
