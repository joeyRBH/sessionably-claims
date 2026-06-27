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
      options: [
        { value: 'clinician',      label: 'Clinician' },
        { value: 'practice_admin', label: 'Practice Admin' },
        { value: 'billing_staff',  label: 'Billing Staff' },
      ] },
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

  function isAdmin() {
    var cu = R.currentUser;
    return !!(cu && cu.user && cu.user.role === 'practice_admin');
  }

  // ===========================================================================
  // Clinicians directory (#clinicians)
  // ===========================================================================
  function mountClinicians(root) {
    function load() {
      R.renderLoading(root);
      Promise.all([api.users.list(), api.invitations.list()]).then(function (res) {
        render((res[0] && res[0].users) || [], (res[1] && res[1].invitations) || []);
      }).catch(function (err) {
        R.renderError(root, err, load);
      });
    }

    // Reload only the invitations panel (after create / revoke) without a full
    // re-fetch of the clinicians table.
    function reloadInvitations() {
      api.invitations.list().then(function (res) {
        renderInvitations((res && res.invitations) || []);
      }).catch(function (err) {
        R.toast(err.message, 'error');
      });
    }

    function openInvite() {
      R.formModal({
        title: 'Invite a clinician',
        fields: [
          { name: 'email', label: 'Email', type: 'email', required: true },
          { name: 'role', label: 'Role', type: 'select',
            options: [
              { value: 'clinician',      label: 'Clinician' },
              { value: 'practice_admin', label: 'Practice Admin' },
              { value: 'billing_staff',  label: 'Billing Staff' },
            ] },
          { name: 'expires_in_days', label: 'Expires in (days)', type: 'number', placeholder: '7' },
        ],
        submitLabel: 'Create invite link',
      }).then(function (result) {
        if (!result) return;
        api.invitations.create(compact(result)).then(function (res) {
          // Surface the shareable link for the admin to copy and send manually.
          R.formModal({
            title: 'Share this invite link',
            fields: [
              { name: 'link', label: 'Invite link (copy and share)', type: 'textarea' },
            ],
            values: { link: res.link },
            submitLabel: 'Done',
          }).then(function () {
            reloadInvitations();
          });
        }).catch(function (err) {
          R.toast(err.message, 'error');
        });
      });
    }

    function revokeInvite(inv) {
      R.confirmModal({
        title: 'Revoke invitation?',
        body: 'The invite link will stop working.',
        confirmLabel: 'Revoke',
        danger: true,
      }).then(function (ok) {
        if (!ok) return;
        api.invitations.revoke(inv.id).then(function () {
          R.toast('Invitation revoked', 'success');
          reloadInvitations();
        }).catch(function (err) {
          R.toast(err.message, 'error');
        });
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

    // Stable container for the invitations panel, so reloadInvitations() can
    // repaint just this section after a create / revoke.
    var invitationsBody = null;

    // Repaint the pending-invitations table into invitationsBody. Filters to
    // pending rows only; shows an inline note when there are none.
    function renderInvitations(invitations) {
      if (!invitationsBody) return;
      R.clear(invitationsBody);

      var pending = (invitations || []).filter(function (inv) {
        return inv.status === 'pending';
      });

      if (!pending.length) {
        invitationsBody.appendChild(
          h('p', { class: 'empty-state__body', style: 'margin:0;padding:var(--space-3) 0' },
            'No pending invitations.')
        );
        return;
      }

      var admin = isAdmin();

      var rows = pending.map(function (inv) {
        var cells = [
          h('td', null, inv.email),
          h('td', null, humanize(inv.role)),
          h('td', null, R.fmtDate(inv.expires_at)),
        ];
        if (admin) {
          cells.push(
            h('td', { class: 'data-table__num' },
              h('button', { class: 'btn btn--ghost btn--sm', type: 'button',
                onClick: function () { revokeInvite(inv); } }, 'Revoke'))
          );
        }
        return h('tr', null, cells);
      });

      var head = [
        h('th', null, 'Email'),
        h('th', null, 'Role'),
        h('th', null, 'Expires'),
      ];
      if (admin) head.push(h('th', { class: 'data-table__num' }, ''));

      invitationsBody.appendChild(
        h('table', { class: 'data-table' }, [
          h('thead', null, h('tr', null, head)),
          h('tbody', null, rows),
        ])
      );
    }

    function render(users, invitations) {
      R.clear(root);

      var admin = isAdmin();

      var headerChildren = [h('h1', { class: 'page-header__title' }, 'Clinicians')];
      if (admin) {
        headerChildren.push(
          h('button', { class: 'btn btn--primary', type: 'button',
            onClick: openInvite }, 'Invite clinician')
        );
      }

      var cliniciansCard;
      if (!users.length) {
        cliniciansCard = h('div', { class: 'card' },
          h('p', { class: 'empty-state__body', style: 'margin:0' },
            'No clinicians yet. Users are added during account setup or via invitation.'));
      } else {
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

        cliniciansCard = h('div', { class: 'card' }, h('table', { class: 'data-table' }, [
          h('thead', null, h('tr', null, [
            h('th', null, 'Name'),
            h('th', null, 'Role'),
            h('th', null, 'Title / NPI'),
            h('th', null, 'Status'),
            h('th', { class: 'data-table__num' }, ''),
          ])),
          h('tbody', null, rows),
        ]));
      }

      invitationsBody = h('div');

      var view = h('div', { class: 'view stack' }, [
        h('div', { class: 'page-header' }, headerChildren),
        cliniciansCard,
        h('div', { class: 'page-header' }, [
          h('h2', { class: 'page-header__title' }, 'Pending invitations'),
        ]),
        h('div', { class: 'card' }, invitationsBody),
      ]);

      root.appendChild(view);
      renderInvitations(invitations);
    }

    load();
  }

  // ===========================================================================
  // Route registration
  // ===========================================================================
  R.registerView('clinicians', function (root) { mountClinicians(root); });
})(window, document);
