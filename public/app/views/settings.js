/* =============================================================================
 * Reddably — Practice Settings (#settings)
 * =============================================================================
 * A minimal settings page: practice identity (name, NPI, tax ID) plus the
 * billing address that Stedi requires on every claim (837P Billing.address).
 * Without a complete billing address, claim submission is blocked server-side
 * with a 422 — this page exists to unblock that.
 *
 * Built entirely on the shared kit (window.Reddably) and ReddablyAPI — no direct
 * fetch(), no raw hex/px, no new globals. tax_id is PHI-adjacent; it lives only
 * in the form value and the PUT body, never in the URL/hash.
 * ========================================================================== */
(function (window, document) {
  'use strict';

  var R = window.Reddably;
  if (!R) return;

  var h = R.h;
  var api = R.api;

  // Field specs: [name, label, {required, placeholder, autocomplete}].
  var IDENTITY_FIELDS = [
    ['name',    'Practice name', { required: true }],
    ['npi',     'NPI',           { placeholder: '10-digit National Provider Identifier' }],
    ['tax_id',  'Tax ID (EIN)',  { placeholder: 'Employer Identification Number' }],
  ];
  var ADDRESS_FIELDS = [
    ['address_line1', 'Address line 1', { required: true, autocomplete: 'address-line1' }],
    ['address_line2', 'Address line 2', { autocomplete: 'address-line2' }],
    ['city',          'City',           { required: true, autocomplete: 'address-level2' }],
    ['state',         'State',          { required: true, autocomplete: 'address-level1',
                                          placeholder: 'e.g. CO' }],
    ['postal_code',   'ZIP code',       { required: true, autocomplete: 'postal-code' }],
  ];

  // Where intake-completion alerts are sent. Standalone (own card + hint) rather
  // than a plain identity field because it needs email-format validation and an
  // empty-state hint.
  var NOTIFY_HINT = 'Add an email to receive intake notifications.';

  // Mirrors backend/lib/password.js MIN_LENGTH. The server is authoritative and
  // re-checks; this only spares the user a round trip to be told the obvious.
  var MIN_PASSWORD_LENGTH = 10;

  // Mirror backend/lib/email.js isValidEmail: one @, non-empty local part, dotted
  // domain with a 2+ char TLD. Blocks a login username (e.g. "BigRedd") from ever
  // reaching SES, which rejects it with "Missing final '@domain'".
  function isValidEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());
  }

  // Drop null / undefined / '' keys so untouched fields are omitted, not blanked.
  function compact(obj) {
    var out = {};
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (v === null || v === undefined || v === '') return;
      out[k] = v;
    });
    return out;
  }

  function renderSettings(root) {
    function load() {
      R.renderLoading(root);
      api.practice.get().then(function (res) {
        render((res && res.practice) || {});
      }).catch(function (err) {
        R.renderError(root, err, load);
      });
    }

    function render(practice) {
      R.clear(root);

      var controls = {};   // name -> input element
      var errorEls = {};   // name -> .field__error element

      function fieldNode(spec) {
        var name = spec[0], label = spec[1], opts = spec[2] || {};
        var input = h('input', {
          class: 'field__control',
          type: 'text',
          name: name,
          value: practice[name] != null ? String(practice[name]) : '',
          placeholder: opts.placeholder || '',
          autocomplete: opts.autocomplete || 'off',
        });
        controls[name] = input;
        var errorEl = h('span', { class: 'field__error', hidden: 'hidden' });
        errorEls[name] = errorEl;
        return h('label', { class: 'field' }, [
          h('span', { class: 'field__label' },
            opts.required ? [label, ' ', h('span', { 'aria-hidden': 'true' }, '*')] : label),
          input,
          errorEl,
        ]);
      }

      function setError(name, message) {
        var errEl = errorEls[name];
        if (!errEl) return;
        errEl.textContent = message || '';
        errEl.hidden = !message;
        errEl.parentNode.classList.toggle('field--invalid', !!message);
      }

      // Two-column grid on wider viewports; stacks on mobile via minmax/auto-fit.
      function grid(specs) {
        return h('div', {
          style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));' +
            'gap:var(--space-4)',
        }, specs.map(fieldNode));
      }

      var allSpecs = IDENTITY_FIELDS.concat(ADDRESS_FIELDS);

      // --- Notification email (standalone: email-format validation + hint) -----
      var notifyInput = h('input', {
        class: 'field__control',
        type: 'email',
        name: 'notification_email',
        value: practice.notification_email != null ? String(practice.notification_email) : '',
        placeholder: 'admin@yourpractice.com',
        autocomplete: 'email',
      });
      controls.notification_email = notifyInput;
      var notifyError = h('span', { class: 'field__error', hidden: 'hidden' });
      errorEls.notification_email = notifyError;
      var notifyHint = h('p', {
        class: 'field__hint',
        style: 'margin:var(--space-1) 0 0;color:var(--color-text-muted);' +
          'font-size:var(--font-size-2)',
      }, NOTIFY_HINT);
      function syncNotifyHint() {
        notifyHint.hidden = (notifyInput.value || '').trim() !== '';
      }
      notifyInput.addEventListener('input', syncNotifyHint);
      syncNotifyHint();

      function notificationCard() {
        return h('div', { class: 'card' }, [
          h('div', { class: 'card__header' }, [
            h('h2', { class: 'card__title' }, 'Notifications'),
          ]),
          h('p', {
            style: 'margin:0 0 var(--space-4);color:var(--color-text-muted);' +
              'font-size:var(--font-size-3)',
          }, 'Where we send alerts when a client finishes intake.'),
          h('label', { class: 'field' }, [
            h('span', { class: 'field__label' }, 'Notification email'),
            notifyInput,
            notifyError,
            notifyHint,
          ]),
        ]);
      }

      // --- Session defaults (practice-wide; admin-only edit) ------------------
      // The standard billing values for this practice. A NEW client is seeded from
      // them, and a blank client field falls back to them when a session is created
      // (client > practice). Its own form + own PUT, a SIBLING of the practice form:
      // saving identity must not touch these, and billing_staff may edit identity
      // but not these (the server returns 403; the card is read-only for them).
      function sessionDefaultsCard() {
        var cu = R.currentUser;
        var meUser = cu && (cu.user || cu);
        var role = meUser && meUser.role;
        // Unknown role (not loaded yet) stays editable; the server is the boundary.
        var readOnly = !!role && role !== 'practice_admin';

        var sdControls = {};
        var sdErrors = {};

        function sdField(name, label, control, hint) {
          sdControls[name] = control;
          if (readOnly) control.disabled = true;
          var errorEl = h('span', { class: 'field__error', hidden: 'hidden' });
          sdErrors[name] = errorEl;
          var children = [h('span', { class: 'field__label' }, label), control];
          if (hint) {
            children.push(h('p', {
              class: 'field__hint',
              style: 'margin:var(--space-1) 0 0;color:var(--color-text-muted);' +
                'font-size:var(--font-size-2)',
            }, hint));
          }
          children.push(errorEl);
          // margin-top:0 — `.field + .field` adds a top margin that would nudge every
          // grid cell after the first down by one step.
          return h('label', { class: 'field', style: 'margin-top:0' }, children);
        }
        function setSdError(name, message) {
          var errEl = sdErrors[name];
          if (!errEl) return;
          errEl.textContent = message || '';
          errEl.hidden = !message;
          errEl.parentNode.classList.toggle('field--invalid', !!message);
        }
        function textVal(v) { return v == null ? '' : String(v); }

        var cptInput = h('input', { class: 'field__control', type: 'text', name: 'default_cpt_code',
          value: textVal(practice.default_cpt_code), placeholder: 'e.g. 90837', autocomplete: 'off' });
        var feeInput = h('input', { class: 'field__control', type: 'number', name: 'default_session_fee',
          value: textVal(practice.default_session_fee), placeholder: 'e.g. 175', min: '0', step: '0.01' });
        var posSelect = h('select', { class: 'field__control', name: 'default_place_of_service' },
          R.clientDefaults.PLACE_OF_SERVICE_OPTIONS.map(function (o) {
            return h('option', { value: o.value }, o.label);
          }));
        posSelect.value = textVal(practice.default_place_of_service);
        var modsInput = h('input', { class: 'field__control', type: 'text',
          name: 'default_procedure_modifiers', placeholder: '95, GT', autocomplete: 'off',
          value: Array.isArray(practice.default_procedure_modifiers)
            ? practice.default_procedure_modifiers.join(', ') : '' });
        var durInput = h('input', { class: 'field__control', type: 'number',
          name: 'default_session_duration_minutes', placeholder: 'e.g. 50', min: '1', step: '1',
          value: textVal(practice.default_session_duration_minutes) });

        var sdSave = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Save session defaults');

        function onSdSubmit(e) {
          if (e) e.preventDefault();
          Object.keys(sdErrors).forEach(function (n) { setSdError(n, null); });

          var fee = (feeInput.value || '').trim();
          var dur = (durInput.value || '').trim();
          var ok = true;
          if (fee !== '' && !(Number(fee) >= 0)) {
            setSdError('default_session_fee', 'Enter a fee of 0 or more.'); ok = false;
          }
          if (dur !== '' && !(/^\d+$/.test(dur) && Number(dur) >= 1 && Number(dur) <= 600)) {
            setSdError('default_session_duration_minutes', 'Enter whole minutes, 1 to 600.'); ok = false;
          }
          var mods = (modsInput.value || '').split(',').map(function (m) {
            return m.trim().toUpperCase();
          }).filter(Boolean);
          if (mods.some(function (m) { return !/^[A-Z0-9]{2}$/.test(m); }) || mods.length > 4) {
            setSdError('default_procedure_modifiers',
              'Up to four two-character codes, comma-separated (e.g. 95, GT).'); ok = false;
          }
          if (!ok) return;

          // Every default is sent (a blank clears it), and nothing else rides along.
          var payload = {
            default_cpt_code: (cptInput.value || '').trim(),
            default_place_of_service: posSelect.value,
            default_session_fee: fee,
            default_procedure_modifiers: mods,
            default_session_duration_minutes: dur,
          };
          sdSave.disabled = true;
          api.practice.update(payload).then(function (res) {
            if (res && res.practice) practice = res.practice;
            R.toast('Session defaults saved', 'success');
          }).catch(function (err) {
            if (err && err.status === 403) {
              R.toast('Only a practice admin can edit session defaults.', 'error');
            } else {
              R.toast((err && err.message) || 'Could not save session defaults.', 'error');
            }
          }).then(function () { sdSave.disabled = false; });
        }

        var children = [
          h('div', { class: 'card__header' }, [
            h('h2', { class: 'card__title' }, 'Session defaults'),
          ]),
          h('p', {
            style: 'margin:0 0 var(--space-4);color:var(--color-text-muted);' +
              'font-size:var(--font-size-3)',
          }, 'Your practice’s standard billing values. New clients start with these, and ' +
             'they fill any blank on a client’s chart when a session is added. A client’s ' +
             'own defaults, and anything typed on a session, always win.'),
          h('div', {
            style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));' +
              'gap:var(--space-4);align-items:start',
          }, [
            sdField('default_cpt_code', 'Default CPT code', cptInput),
            sdField('default_session_fee', 'Default fee', feeInput),
            sdField('default_place_of_service', 'Default place of service', posSelect),
            sdField('default_procedure_modifiers', 'Default procedure modifiers', modsInput,
              'Optional, comma-separated. Example: 95 for synchronous telehealth.'),
            sdField('default_session_duration_minutes', 'Default duration (minutes)', durInput,
              'Used for a manual session added without a duration.'),
          ]),
        ];
        if (readOnly) {
          children.push(h('p', {
            style: 'margin:var(--space-4) 0 0;color:var(--color-text-muted);' +
              'font-size:var(--font-size-2)',
          }, 'Only a practice admin can change session defaults.'));
        } else {
          children.push(h('div', { class: 'page-header__actions', style: 'margin-top:var(--space-4)' },
            [sdSave]));
        }
        return h('form', { class: 'card', novalidate: 'novalidate', onSubmit: onSdSubmit }, children);
      }

      // --- Your account: change password -------------------------------------
      // A SIBLING of the practice form, never inside it. The page's Save button
      // PUTs practice identity + billing address; a password must not ride along
      // with it, and saving the practice must not require touching a password
      // field. Own inputs, own validation, own button, own endpoint.
      function passwordCard() {
        var pwControls = {};
        var pwErrors = {};

        function pwField(name, label, autocomplete, hint) {
          var input = h('input', {
            class: 'field__control',
            type: 'password',
            name: name,
            autocomplete: autocomplete,
          });
          pwControls[name] = input;
          var errorEl = h('span', { class: 'field__error', hidden: 'hidden' });
          pwErrors[name] = errorEl;
          var children = [
            h('span', { class: 'field__label' }, label),
            input,
          ];
          if (hint) {
            children.push(h('p', {
              class: 'field__hint',
              style: 'margin:var(--space-1) 0 0;color:var(--color-text-muted);' +
                'font-size:var(--font-size-2)',
            }, hint));
          }
          children.push(errorEl);
          return h('label', { class: 'field' }, children);
        }

        function setPwError(name, message) {
          var errEl = pwErrors[name];
          if (!errEl) return;
          errEl.textContent = message || '';
          errEl.hidden = !message;
          errEl.parentNode.classList.toggle('field--invalid', !!message);
        }

        function clearPwErrors() {
          Object.keys(pwErrors).forEach(function (n) { setPwError(n, null); });
        }

        var currentField = pwField('current_password', 'Current password', 'current-password');
        var newField = pwField('new_password', 'New password', 'new-password',
          'At least ' + MIN_PASSWORD_LENGTH + ' characters.');
        var confirmField = pwField('confirm_password', 'Confirm new password', 'new-password');

        var pwBtn = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Change password');

        function onPwSubmit(e) {
          if (e) e.preventDefault();
          clearPwErrors();

          var current = pwControls.current_password.value;
          var next = pwControls.new_password.value;
          var confirm = pwControls.confirm_password.value;
          var ok = true;

          // Passwords are NOT trimmed — a leading or trailing space is a real
          // character of the secret, and silently stripping it here would set a
          // password the user could never type again.
          if (current === '') { setPwError('current_password', 'Enter your current password.'); ok = false; }
          if (next.length < MIN_PASSWORD_LENGTH) {
            setPwError('new_password',
              'Your new password must be at least ' + MIN_PASSWORD_LENGTH + ' characters.');
            ok = false;
          } else if (next === current) {
            setPwError('new_password', 'Your new password must be different from your current one.');
            ok = false;
          }
          if (confirm !== next) { setPwError('confirm_password', 'The two passwords do not match.'); ok = false; }
          if (!ok) return;

          // Local busy handling: this card owns its one button. (A shared busy
          // primitive for the whole kit is a separate change.)
          pwBtn.disabled = true;
          pwBtn.textContent = 'Changing…';
          api.changePassword(current, next).then(function () {
            R.toast('Password changed.', 'success');
            // Clear all three so the secret does not sit in the DOM afterwards.
            Object.keys(pwControls).forEach(function (n) { pwControls[n].value = ''; });
          }).catch(function (err) {
            var msg = (err && err.message) || 'Could not change your password.';
            // The server tells us WHICH field is wrong; put the message on it
            // rather than in a toast that vanishes.
            if (/current password/i.test(msg)) setPwError('current_password', msg);
            else if (err && err.status === 400) setPwError('new_password', msg);
            else R.toast(msg, 'error');
          }).then(function () {
            pwBtn.disabled = false;
            pwBtn.textContent = 'Change password';
          });
        }

        return h('form', { class: 'card', novalidate: 'novalidate', onSubmit: onPwSubmit }, [
          h('div', { class: 'card__header' }, [
            h('h2', { class: 'card__title' }, 'Your password'),
          ]),
          h('p', {
            style: 'margin:0 0 var(--space-4);color:var(--color-text-muted);' +
              'font-size:var(--font-size-3)',
          }, 'Changes the password for your own sign-in only — not the practice, and ' +
             'not anyone else on your team. You stay signed in on this device.'),
          h('div', {
            style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));' +
              'gap:var(--space-4)',
          }, [currentField, newField, confirmField]),
          h('div', { class: 'page-header__actions', style: 'margin-top:var(--space-4)' }, [pwBtn]),
        ]);
      }

      function collect() {
        var out = {};
        var ok = true;
        allSpecs.forEach(function (spec) {
          var name = spec[0], label = spec[1], opts = spec[2] || {};
          var val = (controls[name].value || '').trim();
          if (opts.required && val === '') {
            setError(name, label + ' is required.');
            ok = false;
          } else {
            setError(name, null);
          }
          out[name] = val;
        });

        // Notification email is optional, but a non-blank value must be a valid
        // email (matches the backend guard) so a username never reaches SES.
        var notify = (controls.notification_email.value || '').trim();
        if (notify && !isValidEmail(notify)) {
          setError('notification_email', 'Enter a valid email address.');
          ok = false;
        } else {
          setError('notification_email', null);
        }
        out.notification_email = notify;

        return ok ? out : null;
      }

      var saveBtn = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Save changes');

      function onSubmit(e) {
        if (e) e.preventDefault();
        var values = collect();
        if (values === null) return;
        saveBtn.disabled = true;
        // Send every field (blank clears it) so an emptied optional field persists;
        // required fields are guaranteed non-empty by collect().
        api.practice.update(values).then(function (res) {
          R.toast('Settings saved', 'success');
          saveBtn.disabled = false;
          if (res && res.practice) {
            practice = res.practice;
            var nameEl = document.getElementById('practice-name');
            if (nameEl && practice.name) nameEl.textContent = practice.name;
          }
        }).catch(function (err) {
          saveBtn.disabled = false;
          if (err && err.status === 403) {
            R.toast('Only a practice admin can edit practice settings.', 'error');
          } else {
            R.toast(err.message || 'Could not save settings.', 'error');
          }
        });
      }

      // --- Calendar connection (inbound: Google Calendar -> Reddably) -----------
      // Connect your Google Calendar so appointments sync in on their own (the
      // Calendar screen refreshes them whenever you open it). Read-only: matching an
      // appointment to a client and confirming the session stay your decisions.
      // Per-user (your own calendar), so every role sees and manages their own.
      // Independent async load: a status failure shows inline, never blocks Settings.
      function calendarConnectionCard() {
        var body = h('div', { class: 'stack', style: 'gap:var(--space-3)' },
          h('div', { class: 'skeleton skeleton--line' }));

        function note(text) {
          return h('p', {
            style: 'margin:0;color:var(--color-text-muted);font-size:var(--font-size-3)',
          }, text);
        }

        function fmtWhen(iso) {
          if (!iso) return 'not yet';
          var d = new Date(iso);
          return isNaN(d.getTime()) ? 'not yet' : d.toLocaleString();
        }

        function paint(connections) {
          R.clear(body);
          var list = connections || [];
          var active = list.filter(function (c) { return c.status === 'active'; })[0] || null;
          var stale = !active && list.filter(function (c) { return c.status === 'needs_reauth'; })[0] || null;

          if (active) {
            var disconnectBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button',
              onClick: function () {
                R.confirmModal({
                  title: 'Disconnect Google Calendar?',
                  body: 'New appointments will stop syncing. Appointments and sessions you ' +
                    'already have stay exactly as they are, and you can reconnect any time.',
                  confirmLabel: 'Disconnect',
                  danger: true,
                }).then(function (ok) {
                  if (!ok) return;
                  disconnectBtn.disabled = true;
                  api.calendarConnections.disconnect(active.id).then(function () {
                    R.toast('Google Calendar disconnected', 'success');
                    load();
                  }).catch(function (err) {
                    disconnectBtn.disabled = false;
                    R.toast((err && err.message) || 'Could not disconnect.', 'error');
                  });
                });
              } }, 'Disconnect');
            body.appendChild(h('div', { style: 'display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap' }, [
              h('span', { class: 'badge badge--success' }, 'Connected'),
              h('span', null, active.account_email || 'Google Calendar'),
            ]));
            body.appendChild(note('Last synced: ' + fmtWhen(active.last_synced_at) +
              '. Appointments refresh whenever you open Calendar, or use Sync now there.'));
            body.appendChild(h('div', { class: 'page-header__actions' }, [
              h('a', { href: '#calendar', class: 'btn btn--secondary btn--sm' }, 'Open Calendar'),
              disconnectBtn,
            ]));
            return;
          }

          var connectBtn = h('button', { class: 'btn btn--primary', type: 'button',
            onClick: function () { R.connectGoogleCalendar(connectBtn); } },
            stale ? 'Reconnect Google Calendar' : 'Connect Google Calendar');
          body.appendChild(note(stale
            ? 'Your calendar connection needs to be re-authorized before appointments can sync.'
            : 'Connect your Google Calendar and your appointments sync in automatically. ' +
              'Reddably only reads them — you still match each one to a client and confirm ' +
              'the session yourself.'));
          body.appendChild(h('div', { class: 'page-header__actions' }, [connectBtn]));
        }

        function load() {
          Promise.resolve().then(function () {
            return api.calendarConnections.status();
          }).then(function (res) {
            paint((res && res.connections) || []);
          }).catch(function (err) {
            R.clear(body);
            body.appendChild(h('p', { class: 'inline-error', style: 'margin:0' },
              'Could not load your calendar connection. ' + ((err && err.message) || '')));
            body.appendChild(h('button', { class: 'btn btn--ghost btn--sm', type: 'button',
              onClick: load }, 'Retry'));
          });
        }
        load();

        return h('div', { class: 'card' }, [
          h('div', { class: 'card__header' }, [
            h('h2', { class: 'card__title' }, 'Calendar connection'),
          ]),
          body,
        ]);
      }

      // --- Calendar feed (export): per-user, de-identified read-only ICS feed ---
      // (Not the same thing as the Calendar connection above, which pulls YOUR
      // appointments IN from Google Calendar. This one publishes a feed OUT.)
      // Independent of the practice form (its own async load + actions). The feed
      // never contains client names or any PHI — only initials + a deep link.
      function calendarCard() {
        var urlInput = h('input', {
          class: 'field__control',
          type: 'text',
          readonly: 'readonly',
          value: 'Loading…',
          style: 'font-family:var(--font-mono, monospace);font-size:var(--font-size-2)',
          onClick: function () { urlInput.select(); },
        });

        var copyBtn = h('button', {
          class: 'btn btn--ghost btn--sm', type: 'button', disabled: 'disabled',
          onClick: function () {
            var val = urlInput.value || '';
            if (!val || val === 'Loading…') return;
            function done() { R.toast('Feed URL copied', 'success'); }
            try {
              if (window.navigator && window.navigator.clipboard) {
                window.navigator.clipboard.writeText(val).then(done, function () {
                  urlInput.select(); done();
                });
              } else {
                urlInput.select(); document.execCommand('copy'); done();
              }
            } catch (e) { urlInput.select(); }
          },
        }, 'Copy');

        var regenBtn = h('button', {
          class: 'btn btn--ghost btn--sm', type: 'button', disabled: 'disabled',
          onClick: function () {
            R.confirmModal({
              title: 'Regenerate calendar link?',
              body: 'Your current link stops working immediately. You will need to ' +
                're-add the new link in any calendar app already subscribed.',
              confirmLabel: 'Regenerate',
              danger: true,
            }).then(function (ok) {
              if (!ok) return;
              regenBtn.disabled = true;
              api.calendar.regenerate().then(function (res) {
                apply(res && res.calendar_feed);
                R.toast('Calendar link regenerated', 'success');
              }).catch(function (err) {
                regenBtn.disabled = false;
                R.toast(err.message || 'Could not regenerate link.', 'error');
              });
            });
          },
        }, 'Regenerate link');

        function apply(feed) {
          if (!feed || !feed.feed_url) return;
          urlInput.value = feed.feed_url;
          copyBtn.disabled = false;
          regenBtn.disabled = false;
        }

        // How-to one-liners.
        function howto(app, steps) {
          return h('li', { style: 'margin:0 0 var(--space-1)' }, [
            h('strong', null, app + ': '), steps,
          ]);
        }

        var card = h('div', { class: 'card' }, [
          h('div', { class: 'card__header' }, [
            h('h2', { class: 'card__title' }, 'Calendar feed (export)'),
          ]),
          h('p', {
            style: 'margin:0 0 var(--space-4);color:var(--color-text-muted);' +
              'font-size:var(--font-size-3)',
          }, 'Subscribe to a private, read-only feed of your sessions from Google, ' +
             'Apple, or Outlook. The feed is de-identified — it shows client initials ' +
             'and a link back to Reddably only, never names or any health information.'),
          h('label', { class: 'field' }, [
            h('span', { class: 'field__label' }, 'Your private feed URL'),
            h('div', { style: 'display:flex;gap:var(--space-2);align-items:center' }, [
              urlInput, copyBtn,
            ]),
          ]),
          h('p', {
            style: 'margin:var(--space-1) 0 var(--space-4);color:var(--color-text-muted);' +
              'font-size:var(--font-size-2)',
          }, 'Keep this link private — anyone with it can see your (de-identified) schedule.'),
          h('ul', {
            style: 'margin:0 0 var(--space-4);padding-left:var(--space-4);' +
              'color:var(--color-text-muted);font-size:var(--font-size-2)',
          }, [
            howto('Google Calendar', 'Other calendars → + → From URL → paste the link'),
            howto('Apple Calendar', 'File → New Calendar Subscription → paste the link'),
            howto('Outlook', 'Add calendar → Subscribe from web → paste the link'),
          ]),
          h('div', { style: 'display:flex;gap:var(--space-3);align-items:center' }, [
            regenBtn,
            h('span', {
              style: 'color:var(--color-text-muted);font-size:var(--font-size-2)',
            }, 'Regenerating immediately disables the old link.'),
          ]),
        ]);

        api.calendar.settings().then(function (res) {
          apply(res && res.calendar_feed);
          if (!res || !res.calendar_feed) urlInput.value = 'Unavailable';
        }).catch(function () {
          urlInput.value = 'Unavailable — reload to try again';
        });

        return card;
      }

      // Practice NPI verification: a practice that bills as an organization must
      // use a Type-2 (organizational) NPI. Verify against NPPES and warn on a
      // Type-1 (individual) NPI — the mismatch that gets claims rejected.
      var npiStatus = h('p', {
        style: 'margin:var(--space-1) 0 0;font-size:var(--font-size-2);min-height:1.2em;color:var(--color-text-muted)',
      }, '');
      function setNpiStatus(msg, color) { npiStatus.textContent = msg || ''; npiStatus.style.color = color; }
      var verifyNpiBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button',
        onClick: function () {
          var npi = String((controls.npi && controls.npi.value) || '').replace(/\D/g, '');
          if (npi.length !== 10) { setNpiStatus('Enter a 10-digit NPI.', 'var(--color-danger, #b00020)'); return; }
          setNpiStatus('Checking the NPPES registry…', 'var(--color-text-muted)');
          api.providers.verifyNpi(npi).then(function (r) {
            if (!r.found) { setNpiStatus('No NPPES record found for that NPI.', 'var(--color-danger, #b00020)'); return; }
            var nm = r.entityType === 'non_person_entity'
              ? (r.name.organizationName || '')
              : ((r.name.firstName || '') + ' ' + (r.name.lastName || '')).trim();
            if (r.enumerationType === 'NPI-2') {
              setNpiStatus('✓ Organization NPI (Type-2): ' + nm, 'var(--color-success, #2e7d32)');
            } else {
              setNpiStatus('This is an individual (Type-1) NPI registered to ' + nm +
                '. To bill as an organization, use the organization’s own Type-2 NPI — or set individual billing on the Clinicians page.',
                'var(--color-warning, #8a6d00)');
            }
          }).catch(function (err) {
            if (err && err.status === 503) {
              setNpiStatus('NPPES is temporarily unavailable — try again shortly.', 'var(--color-warning, #8a6d00)');
            } else {
              setNpiStatus(R.scrubVendor((err && err.message) || 'Verification failed.'), 'var(--color-danger, #b00020)');
            }
          });
        },
      }, 'Verify NPI with NPPES');

      var form = h('form', { novalidate: 'novalidate', onSubmit: onSubmit }, [
        h('div', { class: 'card' }, [
          h('div', { class: 'card__header' }, [
            h('h2', { class: 'card__title' }, 'Practice details'),
          ]),
          grid(IDENTITY_FIELDS),
          h('div', { style: 'display:flex;gap:var(--space-3);align-items:center;margin-top:var(--space-3)' }, [
            verifyNpiBtn,
          ]),
          npiStatus,
        ]),
        h('div', { class: 'card' }, [
          h('div', { class: 'card__header' }, [
            h('h2', { class: 'card__title' }, 'Billing address'),
          ]),
          h('p', {
            style: 'margin:0 0 var(--space-4);color:var(--color-text-muted);' +
              'font-size:var(--font-size-3)',
          }, 'Used on every insurance claim. Claims cannot be submitted until this ' +
             'is complete.'),
          grid(ADDRESS_FIELDS),
        ]),
        notificationCard(),
        h('div', { class: 'page-header__actions' }, [saveBtn]),
      ]);

      var view = h('div', { class: 'view stack' }, [
        h('div', { class: 'page-header' }, [
          h('h1', { class: 'page-header__title' }, 'Settings'),
        ]),
        form,
        sessionDefaultsCard(),
        passwordCard(),
        calendarConnectionCard(),
        calendarCard(),
      ]);

      root.appendChild(view);
    }

    load();
  }

  R.registerView('settings', function (root) {
    return renderSettings(root);
  });
})(window, document);
