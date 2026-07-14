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

  function currentUserId() {
    var cu = R.currentUser;
    return (cu && cu.user && cu.user.id) || null;
  }

  // A clinician may edit only their OWN billing profile; admin/billing_staff any.
  function canEditBilling(user) {
    if (isAdmin()) return true;
    var cu = R.currentUser;
    var role = cu && cu.user && cu.user.role;
    if (role === 'billing_staff') return true;
    return user && user.id === currentUserId();
  }

  var STATUS_COLORS = {
    muted: 'var(--color-text-muted)',
    success: 'var(--color-success, #2e7d32)',
    warn: 'var(--color-warning, #8a6d00)',
    error: 'var(--color-danger, #b00020)',
  };

  // digits-only, mirrors the backend normalization.
  function digits(v) {
    return String(v == null ? '' : v).replace(/\D/g, '');
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
          { name: 'name', label: 'Name', type: 'text' },
          { name: 'email', label: 'Email', type: 'email', required: true },
          { name: 'role', label: 'Role', type: 'select',
            options: [
              { value: 'clinician',      label: 'Clinician' },
              { value: 'practice_admin', label: 'Practice Admin' },
              { value: 'billing_staff',  label: 'Billing Staff' },
            ] },
          { name: 'expires_in_days', label: 'Expires in (days)', type: 'number', placeholder: '7' },
        ],
        submitLabel: 'Send invite',
      }).then(function (result) {
        if (!result) return;
        api.invitations.create(compact(result)).then(function (res) {
          R.toast(res.email_sent ? 'Invitation emailed' : 'Invite created (email not sent)',
            res.email_sent ? 'success' : 'info');
          // Always surface the shareable link too, as a fallback for the admin to
          // send manually (email delivery is best-effort while SES is in sandbox).
          R.formModal({
            title: res.email_sent ? 'Invitation sent' : 'Share this invite link',
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

    // -------------------------------------------------------------------------
    // Billing profile (per-clinician 837P billing identity) with NPPES verify.
    // -------------------------------------------------------------------------
    function openBillingProfile(user) {
      Promise.all([
        api.providers.billingProfile.get(user.id).catch(function () { return {}; }),
        api.practice.get().catch(function () { return {}; }),
      ]).then(function (res) {
        renderBillingModal(user,
          (res[0] && res[0].billing_profile) || {},
          (res[1] && res[1].practice) || {});
      }).catch(function (err) {
        R.toast(R.scrubVendor(err.message || 'Could not load billing profile.'), 'error');
      });
    }

    function renderBillingModal(user, profile, practice) {
      var org = profile.organization || {};

      function input(attrs) { return h('input', Object.assign({ class: 'field__control', type: 'text' }, attrs)); }
      function field(labelText, control, hintText) {
        return h('label', { class: 'field' }, [
          h('span', { class: 'field__label' }, labelText),
          control,
          hintText ? h('p', {
            style: 'margin:var(--space-1) 0 0;color:var(--color-text-muted);font-size:var(--font-size-2)',
          }, hintText) : null,
        ]);
      }
      function statusLine() {
        return h('p', { style: 'margin:var(--space-1) 0 0;font-size:var(--font-size-2);min-height:1.2em' }, '');
      }
      function setStatus(el, msg, kind) {
        el.textContent = msg || '';
        el.style.color = STATUS_COLORS[kind] || STATUS_COLORS.muted;
      }
      function verifyBtn(onClick) {
        return h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: onClick }, 'Verify with NPPES');
      }

      // Entity type
      var entitySelect = h('select', { class: 'field__control' }, [
        h('option', { value: 'person' }, 'Individual (Type-1 / person)'),
        h('option', { value: 'non_person_entity' }, 'Organization (Type-2 / non-person entity)'),
      ]);
      entitySelect.value = profile.billing_entity_type || 'person';

      // Individual (rendering / person billing) NPI + name
      var npiInput = input({ value: profile.individual_npi || user.npi || '', placeholder: '10-digit NPI', inputmode: 'numeric' });
      var npiStatus = statusLine();
      var firstNameInput = input({ value: profile.legal_first_name || user.first_name || '' });
      var lastNameInput = input({ value: profile.legal_last_name || user.last_name || '' });

      // Person TIN
      var tinTypeSelect = h('select', { class: 'field__control' }, [
        h('option', { value: 'EIN' }, 'EIN'),
        h('option', { value: 'SSN' }, 'SSN'),
      ]);
      tinTypeSelect.value = profile.billing_tin_type || 'EIN';
      var tinPlaceholder = profile.billing_tin_masked
        ? ('On file: ' + profile.billing_tin_masked + ' — leave blank to keep')
        : 'Enter EIN or SSN (digits only)';
      var tinInput = input({ placeholder: tinPlaceholder, inputmode: 'numeric', autocomplete: 'off' });

      // Organization identity
      var orgNpiInput = input({ value: org.org_npi || practice.npi || '', placeholder: "Organization's 10-digit Type-2 NPI", inputmode: 'numeric' });
      var orgNpiStatus = statusLine();
      var orgNameInput = input({ value: org.organization_name || practice.name || '' });
      var orgEinPlaceholder = org.org_ein_masked
        ? ('On file: ' + org.org_ein_masked + ' — leave blank to keep')
        : 'Organization EIN (digits only)';
      var orgEinInput = input({ placeholder: orgEinPlaceholder, inputmode: 'numeric', autocomplete: 'off' });

      // Verify runner shared by both NPI inputs. `expected` is 'person' | 'organization'.
      function runVerify(npiEl, statusEl, expected) {
        var npi = digits(npiEl.value);
        if (npi.length !== 10) { setStatus(statusEl, 'Enter a 10-digit NPI.', 'error'); return; }
        setStatus(statusEl, 'Checking the NPPES registry…', 'muted');
        api.providers.verifyNpi(npi).then(function (r) {
          if (!r.found) { setStatus(statusEl, r.message || 'No NPPES record found.', 'error'); return; }
          var nm = r.entityType === 'non_person_entity'
            ? (r.name.organizationName || '')
            : ((r.name.firstName || '') + ' ' + (r.name.lastName || '')).trim();
          if (expected === 'person' && r.enumerationType === 'NPI-2') {
            setStatus(statusEl, 'This NPI is registered to an organization (' + nm + '). Enter the individual’s Type-1 NPI.', 'error');
            return;
          }
          if (expected === 'organization' && r.enumerationType === 'NPI-1') {
            setStatus(statusEl, 'This NPI is registered to an individual (' + nm + '). Enter the organization’s Type-2 NPI.', 'error');
            return;
          }
          var tax = r.primaryTaxonomy && r.primaryTaxonomy.desc ? ' · ' + r.primaryTaxonomy.desc : '';
          setStatus(statusEl, '✓ ' + r.enumerationType + ': ' + nm + tax + (r.active ? '' : ' (inactive)'), 'success');
          if (expected === 'person' && r.entityType === 'person') {
            if (!firstNameInput.value && r.name.firstName) firstNameInput.value = r.name.firstName;
            if (!lastNameInput.value && r.name.lastName) lastNameInput.value = r.name.lastName;
          }
        }).catch(function (err) {
          if (err && err.status === 503) {
            setStatus(statusEl, 'NPPES is temporarily unavailable — you can still save (marked unverified).', 'warn');
          } else {
            setStatus(statusEl, R.scrubVendor((err && err.message) || 'Verification failed.'), 'error');
          }
        });
      }

      // Person / organization field groups (toggled by entity type).
      var personBox = h('div', { class: 'stack' }, [
        field('Legal first name', firstNameInput),
        field('Legal last name', lastNameInput),
        field('Tax ID type', tinTypeSelect),
        field('Billing TIN', tinInput,
          'Format check only — this does not authoritatively match the TIN to the provider. Stored encrypted; shown masked.'),
      ]);
      var orgBox = h('div', { class: 'stack' }, [
        field('Organization name', orgNameInput),
        h('div', null, [
          field("Organization NPI (Type-2)", orgNpiInput),
          h('div', { style: 'display:flex;gap:var(--space-2);align-items:center;margin-top:var(--space-1)' }, [
            verifyBtn(function () { runVerify(orgNpiInput, orgNpiStatus, 'organization'); }),
          ]),
          orgNpiStatus,
        ]),
        field('Organization EIN', orgEinInput,
          'Format check only. Stored on the practice; shown masked.'),
        h('p', {
          style: 'margin:var(--space-2) 0 0;color:var(--color-text-muted);font-size:var(--font-size-2)',
        }, 'Billing as an organization: the individual above is sent as the rendering provider on every claim.'),
      ]);

      function syncEntity() {
        var org = entitySelect.value === 'non_person_entity';
        personBox.hidden = org;
        orgBox.hidden = !org;
      }
      entitySelect.addEventListener('change', syncEntity);
      syncEntity();

      var saveBtn = h('button', { class: 'btn btn--primary', type: 'button' }, 'Save billing profile');
      var cancelBtn = h('button', { class: 'btn btn--ghost', type: 'button' }, 'Cancel');

      var bodyNode = h('div', { class: 'stack' }, [
        field('Bills as', entitySelect),
        h('div', null, [
          field('Provider NPI (Type-1)', npiInput),
          h('div', { style: 'display:flex;gap:var(--space-2);align-items:center;margin-top:var(--space-1)' }, [
            verifyBtn(function () { runVerify(npiInput, npiStatus, 'person'); }),
          ]),
          npiStatus,
        ]),
        personBox,
        orgBox,
      ]);

      var modal = R.openModal({
        title: 'Billing profile — ' + userName(user),
        bodyNode: bodyNode,
        footerNodes: [cancelBtn, saveBtn],
        onClose: function () { modal.close(); },
      });

      cancelBtn.addEventListener('click', function () { modal.close(); });

      function submit(payload, allowUnverified) {
        if (allowUnverified) payload.allow_unverified = true;
        saveBtn.disabled = true;
        api.providers.billingProfile.save(user.id, payload).then(function () {
          R.toast('Billing profile saved', 'success');
          modal.close();
          load();
        }).catch(function (err) {
          saveBtn.disabled = false;
          var b = (err && err.body) || {};
          var msg = R.scrubVendor(b.error || (err && err.message) || 'Could not save billing profile.');
          if (b.allow_manual) {
            R.confirmModal({
              title: 'Save without NPPES verification?',
              body: msg + ' Save anyway and follow up later? The record will be flagged unverified.',
              confirmLabel: 'Save unverified',
            }).then(function (ok) { if (ok) submit(payload, true); });
            return;
          }
          R.toast(msg, 'error');
        });
      }

      saveBtn.addEventListener('click', function () {
        var entity = entitySelect.value;
        var payload = {
          billing_entity_type: entity,
          individual_npi: digits(npiInput.value),
          legal_first_name: (firstNameInput.value || '').trim(),
          legal_last_name: (lastNameInput.value || '').trim(),
        };
        if (entity === 'person') {
          payload.billing_tin_type = tinTypeSelect.value;
          var t = digits(tinInput.value);
          if (t) payload.billing_tin = t; // blank keeps the stored value
        } else {
          payload.org_npi = digits(orgNpiInput.value);
          if ((orgNameInput.value || '').trim()) payload.organization_name = orgNameInput.value.trim();
          var e = digits(orgEinInput.value);
          if (e) payload.org_ein = e;
        }
        submit(payload, false);
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
          h('td', null, inv.invited_name || '—'),
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
        h('th', null, 'Name'),
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
          var actions = [];
          if (canEditBilling(u)) {
            actions.push(h('button', { class: 'btn btn--ghost btn--sm', type: 'button',
              onClick: function () { openBillingProfile(u); } }, 'Billing'));
          }
          actions.push(h('button', { class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: function () { openEdit(u); } }, 'Edit'));
          return h('tr', null, [
            h('td', null, userName(u)),
            h('td', null, humanize(u.role)),
            h('td', null, titleNpi(u)),
            h('td', null, statusBadge(u)),
            h('td', { class: 'data-table__num' },
              h('div', { style: 'display:inline-flex;gap:var(--space-2)' }, actions)),
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
