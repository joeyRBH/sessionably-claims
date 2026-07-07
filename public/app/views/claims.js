/* =============================================================================
 * Reddably — Claims workspace (list + new-from-session + detail w/ lifecycle)
 * =============================================================================
 * Registers under #claims (list) and #claims/<id> (detail). Built entirely on
 * the shared kit (window.Reddably) and ReddablyAPI — no direct fetch(), no raw
 * hex, no new globals. No PHI in hashes/URLs (claim ids are UUIDs; the status
 * filter is a non-PHI enum). Loaded after clients.js.
 * ========================================================================== */
(function (window, document) {
  'use strict';

  var R = window.Reddably;
  if (!R) return;

  var h = R.h;
  var api = R.api;

  // The full claim lifecycle, in order. Drives the list filter and the
  // status -> action matrix on the detail screen.
  var CLAIM_STATUSES = [
    'draft', 'submitted', 'processing', 'info_requested',
    'denied', 'appealed', 'paid', 'void',
  ];

  // ---------------------------------------------------------------------------
  // Small shared helpers
  // ---------------------------------------------------------------------------
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

  function clientName(c) {
    return c.preferred_name || ((c.first_name || '') + ' ' + (c.last_name || '')).trim();
  }

  function claimLabel(claim) {
    return claim.claim_number || claim.control_number ||
      ('#' + String(claim.id).slice(0, 8));
  }

  function inlineEmpty(text) {
    return h('p', {
      class: 'empty-state__body',
      style: 'margin:0;padding:var(--space-3) 0',
    }, text);
  }

  // ===========================================================================
  // Screen 1 — Claims list (#claims)
  // ===========================================================================
  function renderClaimList(root) {
    // Server-side status filter: re-query on change, never filter client-side.
    function load(status) {
      R.renderLoading(root);
      var filters = status ? { status: status } : undefined;
      api.claims.list(filters).then(function (res) {
        render((res && res.claims) || [], status || '');
      }).catch(function (err) {
        R.renderError(root, err, function () { load(status); });
      });
    }

    // New claim — claims are created from a session, so chain two pickers:
    //   1) choose a client  2) choose one of that client's sessions.
    function openCreate() {
      api.clients.list().then(function (res) {
        var clients = (res && res.clients) || [];
        if (!clients.length) {
          R.toast('Add a client first', 'error');
          return;
        }
        var clientOptions = clients.map(function (c) {
          return { value: c.id, label: clientName(c) };
        });

        R.formModal({
          title: 'New claim — choose client',
          fields: [
            { name: 'client_id', label: 'Client', type: 'select',
              required: true, options: clientOptions },
          ],
          submitLabel: 'Next',
        }).then(function (step1) {
          if (!step1) return;
          chooseSession(step1.client_id);
        });
      }).catch(function (err) {
        R.toast(err.message, 'error');
      });
    }

    function chooseSession(clientId) {
      api.sessions.list({ client_id: clientId }).then(function (res) {
        var sessions = (res && res.sessions) || [];
        if (!sessions.length) {
          R.toast('That client has no sessions yet', 'error');
          return;
        }
        var sessionOptions = sessions.map(function (s) {
          return {
            value: s.id,
            label: R.fmtDate(s.session_date) + ' · ' +
              (s.cpt_code || '—') + ' · ' + R.fmtMoney(s.fee),
          };
        });

        R.formModal({
          title: 'New claim — choose session',
          fields: [
            { name: 'session_id', label: 'Session', type: 'select',
              required: true, options: sessionOptions },
            { name: 'billed_amount', label: 'Billed amount (optional)', type: 'number' },
            { name: 'claim_number', label: 'Claim # (optional)', type: 'text' },
          ],
          submitLabel: 'Create claim',
        }).then(function (values) {
          if (!values) return;
          // The claim auto-attaches the client's primary insurance server-side;
          // we send only the session + optional fields.
          api.claims.create(compact(values)).then(function (created) {
            R.toast('Claim created', 'success');
            R.navigate('claims/' + created.claim.id);
          }).catch(function (err) {
            R.toast(err.message, 'error');
          });
        });
      }).catch(function (err) {
        R.toast(err.message, 'error');
      });
    }

    function render(claims, status) {
      R.clear(root);

      // Genuinely-empty (unfiltered) state gets the full empty placeholder.
      if (!claims.length && !status) {
        R.renderEmpty(root, {
          title: 'No claims yet',
          body: 'Create a claim from a session.',
          actionLabel: 'New claim',
          onAction: openCreate,
        });
        return;
      }

      var filterSelect = h('select', {
        class: 'field__control',
        'aria-label': 'Filter by status',
        style: 'max-width:16rem',
        onChange: function (e) { load(e.target.value); },
      }, [{ value: '', label: 'All statuses' }].concat(
        CLAIM_STATUSES.map(function (s) { return { value: s, label: humanize(s) }; })
      ).map(function (o) {
        var attrs = { value: o.value };
        if (o.value === status) attrs.selected = 'selected';
        return h('option', attrs, o.label);
      }));

      var cardContent;
      if (!claims.length) {
        cardContent = inlineEmpty('No claims match this filter.');
      } else {
        // One row per claim: client · date of service · billed · status · payer.
        // The display fields (client_name, session_date, payer_*) come from the
        // list payload so there is no per-row fetch. Rows link to the detail view.
        var rows = claims.map(function (c) {
          var payer = c.payer_name || c.payer_id || '—';
          var client = c.client_name || ('#' + String(c.client_id || '').slice(0, 8));
          var row = h('tr', {
            class: 'data-table__row--clickable',
            tabindex: '0',
            role: 'link',
          }, [
            h('td', null, client),
            h('td', null, R.fmtDate(c.session_date)),
            h('td', { class: 'data-table__num' }, R.fmtMoney(c.billed_amount)),
            h('td', null, R.statusBadge(c.status)),
            h('td', null, payer),
          ]);
          function go() { R.navigate('claims/' + c.id); }
          row.addEventListener('click', go);
          row.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
          });
          return row;
        });

        cardContent = h('table', { class: 'data-table' }, [
          h('thead', null, h('tr', null, [
            h('th', null, 'Client'),
            h('th', null, 'Date of service'),
            h('th', { class: 'data-table__num' }, 'Billed'),
            h('th', null, 'Status'),
            h('th', null, 'Payer'),
          ])),
          h('tbody', null, rows),
        ]);
      }

      var view = h('div', { class: 'view stack' }, [
        h('div', { class: 'page-header' }, [
          h('h1', { class: 'page-header__title' }, 'Claims'),
          h('div', { class: 'page-header__actions' }, [
            h('button', { class: 'btn btn--primary', type: 'button', onClick: openCreate },
              'New claim'),
          ]),
        ]),
        filterSelect,
        h('div', { class: 'card' }, cardContent),
      ]);

      root.appendChild(view);
    }

    load('');
  }

  // ===========================================================================
  // Screen 2 — Claim detail (#claims/<id>)
  // ===========================================================================
  function renderClaimDetail(root, id) {
    function backLink() {
      return h('a', {
        href: '#claims',
        class: 'btn btn--ghost btn--sm',
        style: 'align-self:flex-start',
      }, '← Claims');
    }

    function load() {
      R.renderLoading(root);
      Promise.all([
        api.claims.get(id),
        api.claims.events(id),
      ]).then(function (results) {
        var claim = results[0] && results[0].claim;
        if (!claim) {
          var notFound = new Error('Claim not found.');
          notFound.status = 404;
          throw notFound;
        }
        render(claim, (results[1] && results[1].claim_events) || []);
      }).catch(function (err) {
        if (err && err.status === 404) {
          R.clear(root);
          root.appendChild(h('div', { class: 'view stack' }, [
            backLink(),
            h('div', { class: 'empty-state' }, [
              h('h1', { class: 'empty-state__title' }, 'Claim not found'),
              h('p', { class: 'empty-state__body' },
                'This claim may have been removed.'),
            ]),
          ]));
          return;
        }
        R.renderError(root, err, load);
      });
    }

    // --- Lifecycle actions (each re-renders the whole detail on success) -----
    function doSubmit() {
      R.confirmModal({
        title: 'Submit claim?',
        body: 'Sends the claim to the clearinghouse.',
        confirmLabel: 'Submit',
      }).then(function (ok) {
        if (!ok) return;
        api.claims.submit(id).then(function () {
          R.toast('Claim submitted', 'success');
          load();
        }).catch(function (err) {
          R.toast(err.message, 'error');
        });
      });
    }

    function doRefresh() {
      api.claims.refresh(id).then(function () {
        R.toast('Status refreshed', 'success');
        load();
      }).catch(function (err) {
        R.toast(err.message, 'error');
      });
    }

    function doVoid() {
      R.confirmModal({
        title: 'Void claim?',
        body: 'This voids the claim and cannot be undone.',
        confirmLabel: 'Void',
        danger: true,
      }).then(function (ok) {
        if (!ok) return;
        api.claims.void(id).then(function () {
          R.toast('Claim voided', 'success');
          load();
        }).catch(function (err) {
          R.toast(err.message, 'error');
        });
      });
    }

    function doEdit(claim) {
      R.formModal({
        title: 'Edit claim',
        fields: [
          { name: 'claim_number',  label: 'Claim #',       type: 'text' },
          { name: 'billed_amount', label: 'Billed amount',  type: 'number' },
        ],
        values: claim,
        submitLabel: 'Save changes',
      }).then(function (values) {
        if (!values) return;
        api.claims.update(id, compact(values)).then(function () {
          R.toast('Claim updated', 'success');
          load();
        }).catch(function (err) {
          R.toast(err.message, 'error');
        });
      });
    }

    // Edit the claim's UNDERLYING SESSION (date / CPT / diagnosis / rate), then
    // regenerate the claim's derived fields (billed amount) from the saved
    // session. Only offered for draft + denied claims; submitted claims stay
    // read-only. No status field here, so saving never transitions the session.
    function doEditClaim(claim) {
      api.sessions.get(claim.session_id).then(function (res) {
        var session = res && res.session;
        if (!session) {
          R.toast('Underlying session not found', 'error');
          return;
        }
        R.formModal({
          title: 'Edit claim',
          fields: [
            { name: 'session_date',   label: 'Session date',   type: 'date', required: true },
            { name: 'cpt_code',       label: 'CPT code',       type: 'text' },
            { name: 'diagnosis_codes', label: 'Diagnosis code(s)', type: 'diagnosis',
              placeholder: 'Search code or condition (e.g. F411 or anxiety)…' },
            { name: 'fee',            label: 'Rate / fee',     type: 'number' },
          ],
          values: {
            session_date: session.session_date ? String(session.session_date).slice(0, 10) : '',
            cpt_code: session.cpt_code || '',
            diagnosis_codes: Array.isArray(session.diagnosis_codes) ? session.diagnosis_codes : [],
            fee: session.fee != null ? session.fee : '',
          },
          submitLabel: 'Save & regenerate',
        }).then(function (values) {
          if (!values) return;
          var codes = String(values.diagnosis_codes || '')
            .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
          var payload = {
            session_date: values.session_date,
            cpt_code: values.cpt_code,          // null clears it
            fee: values.fee,                     // null clears it
            diagnosis_codes: codes,              // [] clears them
          };
          api.sessions.update(session.id, payload).then(function () {
            // Regenerate billed amount etc. from the updated session, server-side.
            return api.claims.regenerate(claim.id);
          }).then(function () {
            R.toast('Claim updated from session', 'success');
            load();
          }).catch(function (err) {
            R.toast(err.message, 'error');
          });
        });
      }).catch(function (err) {
        R.toast(err.message, 'error');
      });
    }

    function doDelete() {
      R.confirmModal({
        title: 'Delete claim?',
        body: 'This removes the claim record.',
        confirmLabel: 'Delete',
        danger: true,
      }).then(function (ok) {
        if (!ok) return;
        api.claims.remove(id).then(function () {
          R.toast('Claim deleted', 'success');
          R.navigate('claims');
        }).catch(function (err) {
          R.toast(err.message, 'error');
        });
      });
    }

    // Show only the buttons allowed for the current status (see matrix).
    function actionsFor(claim) {
      var s = claim.status;
      function btn(label, cls, handler) {
        return h('button', { class: 'btn ' + cls, type: 'button', onClick: handler }, label);
      }
      if (s === 'draft') {
        return [
          btn('Submit', 'btn--primary', doSubmit),
          btn('Edit claim', 'btn--ghost', function () { doEditClaim(claim); }),
          btn('Claim #', 'btn--ghost', function () { doEdit(claim); }),
          btn('Delete', 'btn--danger', doDelete),
        ];
      }
      // Denied (rejected) claims can be corrected: edit the session, regenerate,
      // then void + resubmit or appeal via the existing paths.
      if (s === 'denied') {
        return [
          btn('Refresh', 'btn--primary', doRefresh),
          btn('Edit claim', 'btn--ghost', function () { doEditClaim(claim); }),
          btn('Void', 'btn--danger', doVoid),
        ];
      }
      if (s === 'submitted' || s === 'processing' || s === 'info_requested' ||
          s === 'appealed') {
        return [
          btn('Refresh', 'btn--primary', doRefresh),
          btn('Void', 'btn--danger', doVoid),
        ];
      }
      if (s === 'paid') {
        // Terminal: voiding a paid claim would 409, so omit Void.
        return [btn('Refresh', 'btn--primary', doRefresh)];
      }
      if (s === 'void') {
        return [btn('Delete', 'btn--danger', doDelete)];
      }
      return [];
    }

    // --- Header card ---------------------------------------------------------
    function detailItem(label, value) {
      return h('div', { class: 'stat' }, [
        h('span', { class: 'stat__label' }, label),
        h('span', { style: 'font-size:var(--font-size-4);color:var(--color-text)' }, value),
      ]);
    }

    function headerCard(claim, contextEl) {
      var grid = h('div', {
        style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));' +
          'gap:var(--space-4)',
      }, [
        detailItem('Billed', R.fmtMoney(claim.billed_amount)),
        detailItem('Allowed', R.fmtMoney(claim.allowed_amount)),
        detailItem('Reimbursed', R.fmtMoney(claim.reimbursed_amount)),
        detailItem('Patient responsibility', R.fmtMoney(claim.patient_responsibility)),
        detailItem('Clearinghouse', claim.clearinghouse || '—'),
        detailItem('Control #', claim.control_number || '—'),
        detailItem('Submitted', R.fmtDate(claim.submitted_at)),
      ]);

      var denial = claim.denial_reason
        ? h('p', {
            style: 'margin:0;color:var(--color-danger);font-size:var(--font-size-3)',
          }, [h('strong', null, 'Denial reason: '), claim.denial_reason])
        : null;

      return h('div', { class: 'card' }, [
        h('div', { class: 'card__header' }, [
          h('div', { style: 'display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap' }, [
            h('h1', { class: 'page-header__title' }, claimLabel(claim)),
            R.statusBadge(claim.status),
          ]),
          h('div', { class: 'page-header__actions' }, actionsFor(claim)),
        ]),
        h('div', { style: 'display:flex;flex-direction:column;gap:var(--space-4)' }, [
          contextEl,
          grid,
          denial,
        ]),
      ]);
    }

    // Best-effort context line (client name + session date/CPT). Never blocks
    // the page — a failed lookup just leaves the line hidden.
    function enrich(claim, contextEl) {
      Promise.all([
        api.clients.get(claim.client_id).catch(function () { return null; }),
        api.sessions.get(claim.session_id).catch(function () { return null; }),
      ]).then(function (results) {
        var parts = [];
        var client = results[0] && results[0].client;
        var session = results[1] && results[1].session;
        if (client) parts.push(clientName(client));
        if (session) {
          parts.push(R.fmtDate(session.session_date) + ' · ' + (session.cpt_code || '—'));
        }
        if (parts.length) {
          contextEl.textContent = parts.join('  ·  ');
          contextEl.hidden = false;
        }
      }).catch(function () { /* best-effort — ignore */ });
    }

    // --- Events timeline -----------------------------------------------------
    function eventRow(ev) {
      var transition = (ev.status_from && ev.status_to)
        ? h('span', { style: 'color:var(--color-text-muted);font-size:var(--font-size-2)' },
            humanize(ev.status_from) + ' → ' + humanize(ev.status_to))
        : null;

      return h('div', { class: 'timeline__item' }, [
        h('div', { class: 'timeline__row' }, [
          h('div', { class: 'timeline__main' }, [
            h('span', { class: 'badge badge--neutral' }, humanize(ev.event_type)),
            transition,
          ]),
          h('span', { class: 'timeline__time' }, R.fmtDate(ev.created_at)),
        ]),
        ev.note
          ? h('p', { style: 'margin:0;font-size:var(--font-size-3);color:var(--color-text)' }, ev.note)
          : null,
      ]);
    }

    function eventsCard(events) {
      var body = events.length
        ? h('div', { class: 'timeline' }, events.map(eventRow))
        : inlineEmpty('No events yet.');

      return h('div', { class: 'card' }, [
        h('div', { class: 'card__header' }, [
          h('h2', { class: 'card__title' }, 'Events'),
        ]),
        body,
      ]);
    }

    // --- Compose the detail view --------------------------------------------
    function render(claim, events) {
      R.clear(root);

      var contextEl = h('p', {
        hidden: 'hidden',
        style: 'margin:0;color:var(--color-text-muted);font-size:var(--font-size-3)',
      });

      var view = h('div', { class: 'view stack' }, [
        backLink(),
        headerCard(claim, contextEl),
        eventsCard(events),
      ]);

      root.appendChild(view);
      enrich(claim, contextEl);
    }

    load();
  }

  // ===========================================================================
  // Route registration — params[0] is the claim id when present.
  // ===========================================================================
  R.registerView('claims', function (root, params) {
    if (params && params[0]) return renderClaimDetail(root, params[0]);
    return renderClaimList(root);
  });
})(window, document);
