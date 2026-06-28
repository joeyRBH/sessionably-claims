/* =============================================================================
 * Reddably — Clients workspace (list + detail with insurance & sessions)
 * =============================================================================
 * Registers under #clients (list) and #clients/<id> (detail). Built entirely on
 * the shared kit (window.Reddably) and ReddablyAPI — no direct fetch(), no raw
 * hex/px, no new globals. No PHI in hashes/URLs (client ids are UUIDs only).
 * Loaded after dashboard.js.
 * ========================================================================== */
(function (window, document) {
  'use strict';

  var R = window.Reddably;
  if (!R) return;

  var h = R.h;
  var api = R.api;

  // ---------------------------------------------------------------------------
  // Shared form field specs + value transforms
  // ---------------------------------------------------------------------------
  var CLIENT_FIELDS = [
    { name: 'first_name',     label: 'First name',     type: 'text',  required: true },
    { name: 'last_name',      label: 'Last name',      type: 'text',  required: true },
    { name: 'preferred_name', label: 'Preferred name', type: 'text' },
    { name: 'pronouns',       label: 'Pronouns',       type: 'text' },
    { name: 'email',          label: 'Email',          type: 'email' },
    { name: 'phone',          label: 'Mobile Phone',   type: 'text',
      placeholder: '+1 (303) 555-0100' },
    { name: 'date_of_birth',  label: 'Date of birth',  type: 'date' },
    { name: 'gender',         label: 'Biological Sex', type: 'select', required: true,
      options: [
        { value: 'male',    label: 'M' },
        { value: 'female',  label: 'F' },
        { value: 'unknown', label: 'U' },
      ] },
    { name: 'address_line1',  label: 'Address line 1', type: 'text', required: true },
    { name: 'address_line2',  label: 'Address line 2', type: 'text' },
    { name: 'city',           label: 'City',           type: 'text', required: true },
    { name: 'state',          label: 'State',          type: 'text', required: true },
    { name: 'postal_code',    label: 'Zip code',       type: 'text', required: true },
    { name: 'status',         label: 'Status',         type: 'select',
      options: ['awaiting_info', 'ready', 'active', 'inactive'] },
  ];

  var INSURANCE_FIELDS = [
    { name: 'carrier_name',            label: 'Carrier',                type: 'text' },
    { name: 'member_id',               label: 'Member ID',              type: 'text' },
    { name: 'group_number',            label: 'Group number',           type: 'text' },
    { name: 'plan_type',               label: 'Plan type',              type: 'text' },
    { name: 'payer_id',                label: 'Payer ID',               type: 'text',
      placeholder: 'e.g. 00431' },
    { name: 'subscriber_relationship', label: 'Subscriber relationship', type: 'select',
      options: ['self', 'spouse', 'child', 'other'] },
    { name: 'subscriber_name',         label: 'Subscriber name',        type: 'text' },
    { name: 'subscriber_dob',          label: 'Subscriber DOB',         type: 'date' },
    { name: 'oon_deductible_total',    label: 'OON deductible total',   type: 'number' },
    { name: 'oon_deductible_met',      label: 'OON deductible met',     type: 'number' },
    { name: 'oon_reimbursement_rate',  label: 'OON reimbursement rate (%)', type: 'number' },
    { name: 'is_primary',              label: 'Primary insurance',      type: 'select',
      options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] },
  ];

  var SESSION_FIELDS = [
    { name: 'session_date',     label: 'Session date',   type: 'date', required: true },
    { name: 'cpt_code',         label: 'CPT code',       type: 'text' },
    { name: 'duration_minutes', label: 'Duration (min)', type: 'number' },
    { name: 'fee',              label: 'Fee',            type: 'number' },
    { name: 'place_of_service', label: 'Place of service', type: 'text' },
    { name: 'diagnosis_codes',  label: 'Diagnosis codes (comma-separated)', type: 'text' },
    { name: 'status',           label: 'Status',         type: 'select',
      options: ['scheduled', 'completed', 'claim_ready', 'claim_submitted',
                'awaiting_payment', 'paid', 'no_claim'] },
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

  function clientName(c) {
    return c.preferred_name || ((c.first_name || '') + ' ' + (c.last_name || '')).trim();
  }

  // ---------------------------------------------------------------------------
  // Small shared building blocks
  // ---------------------------------------------------------------------------
  function inlineEmpty(text) {
    return h('p', {
      class: 'empty-state__body',
      style: 'margin:0;padding:var(--space-3) 0',
    }, text);
  }

  // A per-row action cell with Edit / Delete buttons.
  function rowActions(onEdit, onDelete) {
    return h('td', { class: 'data-table__num' }, [
      h('button', { class: 'btn btn--ghost btn--sm', type: 'button',
        onClick: function (e) { e.stopPropagation(); onEdit(); } }, 'Edit'),
      ' ',
      h('button', { class: 'btn btn--danger btn--sm', type: 'button',
        style: 'margin-left:var(--space-2)',
        onClick: function (e) { e.stopPropagation(); onDelete(); } }, 'Delete'),
    ]);
  }

  // ===========================================================================
  // Screen 1 — Client list (#clients)
  // ===========================================================================
  function renderClientList(root) {
    R.renderLoading(root);

    function load() {
      R.renderLoading(root);
      api.clients.list().then(function (res) {
        render((res && res.clients) || []);
      }).catch(function (err) {
        R.renderError(root, err, load);
      });
    }

    function openCreate() {
      R.formModal({
        title: 'New client',
        fields: CLIENT_FIELDS,
        submitLabel: 'Create client',
      }).then(function (values) {
        if (!values) return;
        api.clients.create(compact(values)).then(function () {
          R.toast('Client created', 'success');
          load();
        }).catch(function (err) {
          R.toast(err.message, 'error');
        });
      });
    }

    function render(clients) {
      R.clear(root);

      if (!clients.length) {
        R.renderEmpty(root, {
          title: 'No clients yet',
          body: 'Add your first client to start tracking insurance and sessions.',
          actionLabel: 'New client',
          onAction: openCreate,
        });
        return;
      }

      var tbody = h('tbody');

      function paint(filter) {
        R.clear(tbody);
        var needle = (filter || '').trim().toLowerCase();
        var rows = clients.filter(function (c) {
          if (!needle) return true;
          var hay = (clientName(c) + ' ' + (c.email || '')).toLowerCase();
          return hay.indexOf(needle) !== -1;
        });

        if (!rows.length) {
          tbody.appendChild(h('tr', null,
            h('td', { colspan: '3' }, inlineEmpty('No clients match your filter.'))));
          return;
        }

        rows.forEach(function (c) {
          var row = h('tr', {
            class: 'data-table__row--clickable',
            tabindex: '0',
            role: 'link',
          }, [
            h('td', null, clientName(c)),
            h('td', null, R.statusBadge(c.status)),
            h('td', null, R.fmtDate(c.created_at)),
          ]);
          function go() { R.navigate('clients/' + c.id); }
          row.addEventListener('click', go);
          row.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
          });
          tbody.appendChild(row);
        });
      }

      var filterInput = h('input', {
        class: 'field__control',
        type: 'search',
        placeholder: 'Filter by name or email…',
        'aria-label': 'Filter clients',
        style: 'max-width:22rem',
        onInput: function (e) { paint(e.target.value); },
      });

      var table = h('table', { class: 'data-table' }, [
        h('thead', null, h('tr', null, [
          h('th', null, 'Name'),
          h('th', null, 'Status'),
          h('th', null, 'Created'),
        ])),
        tbody,
      ]);

      paint('');

      var view = h('div', { class: 'view stack' }, [
        h('div', { class: 'page-header' }, [
          h('h1', { class: 'page-header__title' }, 'Clients'),
          h('div', { class: 'page-header__actions' }, [
            h('button', { class: 'btn btn--primary', type: 'button', onClick: openCreate },
              'New client'),
          ]),
        ]),
        filterInput,
        h('div', { class: 'card' }, table),
      ]);

      root.appendChild(view);
    }

    load();
  }

  // ===========================================================================
  // Screen 2 — Client detail (#clients/<id>)
  // ===========================================================================
  function renderClientDetail(root, id) {
    R.renderLoading(root);

    function backLink() {
      return h('a', {
        href: '#clients',
        class: 'btn btn--ghost btn--sm',
        style: 'align-self:flex-start',
      }, '← Clients');
    }

    function load() {
      R.renderLoading(root);
      Promise.all([
        api.clients.get(id),
        api.insuranceRecords.list({ client_id: id }),
        api.sessions.list({ client_id: id }),
      ]).then(function (results) {
        var client = results[0] && results[0].client;
        if (!client) {
          var notFound = new Error('Client not found.');
          throw notFound;
        }
        render(
          client,
          (results[1] && results[1].insurance_records) || [],
          (results[2] && results[2].sessions) || []
        );
      }).catch(function (err) {
        if (err && err.status === 404) {
          R.clear(root);
          root.appendChild(h('div', { class: 'view stack' }, [
            backLink(),
            h('div', { class: 'empty-state' }, [
              h('h1', { class: 'empty-state__title' }, 'Client not found'),
              h('p', { class: 'empty-state__body' },
                'This client may have been removed.'),
            ]),
          ]));
          return;
        }
        R.renderError(root, err, load);
      });
    }

    // --- Header card ---------------------------------------------------------
    function openEdit(client) {
      R.formModal({
        title: 'Edit client',
        fields: CLIENT_FIELDS,
        values: client,
        submitLabel: 'Save changes',
      }).then(function (values) {
        if (!values) return;
        api.clients.update(id, compact(values)).then(function () {
          R.toast('Client updated', 'success');
          load();
        }).catch(function (err) {
          R.toast(err.message, 'error');
        });
      });
    }

    function openDelete(client) {
      R.confirmModal({
        title: 'Delete client?',
        body: 'This hides the client and their records.',
        confirmLabel: 'Delete',
        danger: true,
      }).then(function (ok) {
        if (!ok) return;
        api.clients.remove(id).then(function () {
          R.toast('Client deleted', 'success');
          R.navigate('clients');
        }).catch(function (err) {
          R.toast(err.message, 'error');
        });
      });
    }

    // Send the SMS card-capture link, with a generic success/error toast.
    function sendPaymentLink(client) {
      api.clients.sendPaymentLink(client.id).then(function () {
        R.toast('Payment link sent to ' + (client.phone || 'the client'), 'success');
      }).catch(function (err) {
        R.toast(err.message || 'Could not send payment link', 'error');
      });
    }

    // Billing row: a saved-card badge (with "Send new link") or a "Send Payment Link"
    // button. Hidden entirely when there is no phone and no card on file.
    function billingRow(client) {
      var hasCard = !!client.payment_method_last4;
      var hasPhone = !!(client.phone && String(client.phone).trim());
      if (!hasCard && !hasPhone) return null;

      var children = [];

      if (hasCard) {
        var brand = client.payment_method_brand || 'card';
        var exp = (client.payment_method_exp_month && client.payment_method_exp_year)
          ? ' (exp ' + client.payment_method_exp_month + '/' + client.payment_method_exp_year + ')'
          : '';
        children.push(h('span', { class: 'badge badge--success' },
          '💳 Card on file: ' + brand + ' •••• ' + client.payment_method_last4 + exp));
        if (hasPhone) {
          children.push(h('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            style: 'margin-left:var(--space-3)',
            onClick: function () { sendPaymentLink(client); },
          }, 'Send new link'));
        }
      } else {
        children.push(h('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onClick: function () { sendPaymentLink(client); },
        }, 'Send Payment Link'));
      }

      return h('div', {
        style: 'display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;'
          + 'margin-top:var(--space-3);padding-top:var(--space-3);'
          + 'border-top:var(--border-width-1) solid var(--color-border)',
      }, children);
    }

    function headerCard(client) {
      var meta = [];
      if (client.email) meta.push(client.email);
      if (client.phone) meta.push(client.phone);
      if (client.date_of_birth) meta.push('DOB ' + R.fmtDate(client.date_of_birth));

      return h('div', { class: 'card' }, [
        h('div', { class: 'card__header' }, [
          h('div', { style: 'display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap' }, [
            h('h1', { class: 'page-header__title' }, clientName(client)),
            R.statusBadge(client.status),
          ]),
          h('div', { class: 'page-header__actions' }, [
            h('button', { class: 'btn btn--ghost', type: 'button',
              onClick: function () { openEdit(client); } }, 'Edit'),
            h('button', { class: 'btn btn--danger', type: 'button',
              onClick: function () { openDelete(client); } }, 'Delete'),
          ]),
        ]),
        meta.length
          ? h('p', { style: 'margin:0;color:var(--color-text-muted);font-size:var(--font-size-3)' },
              meta.join('  ·  '))
          : null,
        billingRow(client),
      ]);
    }

    // --- Panel A: Insurance --------------------------------------------------
    function insurancePanel(client, initialRecords) {
      var body = h('div');

      function reload() {
        api.insuranceRecords.list({ client_id: id }).then(function (res) {
          paint((res && res.insurance_records) || []);
        }).catch(function (err) {
          R.clear(body);
          body.appendChild(inlineEmpty(err.message || 'Could not load insurance.'));
        });
      }

      function openForm(record) {
        R.formModal({
          title: record ? 'Edit insurance' : 'Add insurance',
          fields: INSURANCE_FIELDS,
          values: record || { is_primary: 'true' },
          submitLabel: record ? 'Save changes' : 'Add insurance',
        }).then(function (values) {
          if (!values) return;
          var payload = compact(values);
          if (values.is_primary !== null && values.is_primary !== undefined) {
            payload.is_primary = values.is_primary === 'true';
          }
          payload.client_id = id;
          var p = record
            ? api.insuranceRecords.update(record.id, payload)
            : api.insuranceRecords.create(payload);
          p.then(function () {
            R.toast(record ? 'Insurance updated' : 'Insurance added', 'success');
            reload();
          }).catch(function (err) {
            R.toast(err.message, 'error');
          });
        });
      }

      function openDeleteRecord(record) {
        R.confirmModal({
          title: 'Delete insurance?',
          body: 'This hides the insurance record.',
          confirmLabel: 'Delete',
          danger: true,
        }).then(function (ok) {
          if (!ok) return;
          api.insuranceRecords.remove(record.id).then(function () {
            R.toast('Insurance deleted', 'success');
            reload();
          }).catch(function (err) {
            R.toast(err.message, 'error');
          });
        });
      }

      function paint(records) {
        R.clear(body);
        if (!records.length) {
          body.appendChild(inlineEmpty('No insurance on file'));
          return;
        }
        var rows = records.map(function (r) {
          return h('tr', null, [
            h('td', null, r.carrier_name || '—'),
            h('td', null, r.member_id || '—'),
            h('td', null, r.is_primary
              ? h('span', { class: 'badge badge--success' }, 'Primary')
              : '—'),
            h('td', null, r.oon_reimbursement_rate != null
              ? r.oon_reimbursement_rate + '%'
              : '—'),
            rowActions(
              function () { openForm(r); },
              function () { openDeleteRecord(r); }
            ),
          ]);
        });
        body.appendChild(h('table', { class: 'data-table' }, [
          h('thead', null, h('tr', null, [
            h('th', null, 'Carrier'),
            h('th', null, 'Member ID'),
            h('th', null, 'Primary'),
            h('th', null, 'OON rate'),
            h('th', { class: 'data-table__num' }, ''),
          ])),
          h('tbody', null, rows),
        ]));
      }

      paint(initialRecords || []);

      return h('div', { class: 'card' }, [
        h('div', { class: 'card__header' }, [
          h('h2', { class: 'card__title' }, 'Insurance'),
          h('button', { class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: function () { openForm(null); } }, 'Add insurance'),
        ]),
        body,
      ]);
    }

    // --- Panel B: Sessions ---------------------------------------------------
    function sessionsPanel(client, initialSessions) {
      var body = h('div');

      function reload() {
        api.sessions.list({ client_id: id }).then(function (res) {
          paint((res && res.sessions) || []);
        }).catch(function (err) {
          R.clear(body);
          body.appendChild(inlineEmpty(err.message || 'Could not load sessions.'));
        });
      }

      function openForm(session) {
        // Load the clinician roster first; the picker options are dynamic, so the
        // clinician_id field is built at call time rather than as a constant.
        api.users.list({ role: 'clinician' }).then(function (res) {
          var clinicians = (res && res.users) || [];
          var clinicianOptions = clinicians.map(function (u) {
            var label = ((u.first_name || '') + ' ' + (u.last_name || '')).trim()
              || u.email || ('User ' + u.id);
            return { value: u.id, label: label };
          });

          // Preselect: client's primary clinician (if in the roster), else the
          // current user, else the first option.
          var inList = function (uid) {
            return clinicianOptions.some(function (o) { return o.value === uid; });
          };
          var cu = R.currentUser;
          var currentUserId = cu && cu.user && cu.user.id;
          var defaultClinicianId =
            (client.primary_clinician_id && inList(client.primary_clinician_id)
              ? client.primary_clinician_id : null) ||
            currentUserId ||
            (clinicianOptions[0] && clinicianOptions[0].value) ||
            '';

          var sessionFields = SESSION_FIELDS.concat([
            { name: 'clinician_id', label: 'Clinician', type: 'select',
              required: true, options: clinicianOptions },
          ]);

          var values = { clinician_id: defaultClinicianId };
          if (session) {
            Object.keys(session).forEach(function (k) { values[k] = session[k]; });
            if (Array.isArray(session.diagnosis_codes)) {
              values.diagnosis_codes = session.diagnosis_codes.join(', ');
            }
          }

          R.formModal({
            title: session ? 'Edit session' : 'Add session',
            fields: sessionFields,
            values: values,
            submitLabel: session ? 'Save changes' : 'Add session',
          }).then(function (result) {
            if (!result) return;

            var codes = (result.diagnosis_codes || '')
              .split(',').map(function (s) { return s.trim(); })
              .filter(Boolean);

            var payload = compact(result);
            delete payload.diagnosis_codes;
            if (codes.length) payload.diagnosis_codes = codes;
            payload.client_id = id;
            payload.clinician_id = result.clinician_id;

            var p = session
              ? api.sessions.update(session.id, payload)
              : api.sessions.create(payload);
            p.then(function () {
              R.toast(session ? 'Session updated' : 'Session added', 'success');
              reload();
            }).catch(function (err) {
              R.toast(err.message, 'error');
            });
          });
        }).catch(function (err) {
          R.toast(err.message || 'Could not load clinicians', 'error');
        });
      }

      function openDeleteSession(session) {
        R.confirmModal({
          title: 'Delete session?',
          body: 'This hides the session record.',
          confirmLabel: 'Delete',
          danger: true,
        }).then(function (ok) {
          if (!ok) return;
          api.sessions.remove(session.id).then(function () {
            R.toast('Session deleted', 'success');
            reload();
          }).catch(function (err) {
            R.toast(err.message, 'error');
          });
        });
      }

      function paint(sessions) {
        R.clear(body);
        if (!sessions.length) {
          body.appendChild(inlineEmpty('No sessions yet'));
          return;
        }
        var rows = sessions.map(function (s) {
          return h('tr', null, [
            h('td', null, R.fmtDate(s.session_date)),
            h('td', null, s.cpt_code || '—'),
            h('td', { class: 'data-table__num' }, R.fmtMoney(s.fee)),
            h('td', null, R.statusBadge(s.status)),
            rowActions(
              function () { openForm(s); },
              function () { openDeleteSession(s); }
            ),
          ]);
        });
        body.appendChild(h('table', { class: 'data-table' }, [
          h('thead', null, h('tr', null, [
            h('th', null, 'Date'),
            h('th', null, 'CPT'),
            h('th', { class: 'data-table__num' }, 'Fee'),
            h('th', null, 'Status'),
            h('th', { class: 'data-table__num' }, ''),
          ])),
          h('tbody', null, rows),
        ]));
      }

      paint(initialSessions || []);

      return h('div', { class: 'card' }, [
        h('div', { class: 'card__header' }, [
          h('h2', { class: 'card__title' }, 'Sessions'),
          h('button', { class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: function () { openForm(null); } }, 'Add session'),
        ]),
        body,
      ]);
    }

    // --- Compose the detail view --------------------------------------------
    function render(client, insurance, sessions) {
      R.clear(root);

      var view = h('div', { class: 'view stack' }, [
        backLink(),
        headerCard(client),
        insurancePanel(client, insurance),
        sessionsPanel(client, sessions),
      ]);

      root.appendChild(view);
    }

    load();
  }

  // ===========================================================================
  // Route registration — params[0] is the client id when present.
  // ===========================================================================
  R.registerView('clients', function (root, params) {
    if (params && params[0]) return renderClientDetail(root, params[0]);
    return renderClientList(root);
  });
})(window, document);
