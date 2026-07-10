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

      // --- Calendar sync (per-user, de-identified read-only ICS feed) ----------
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
            h('h2', { class: 'card__title' }, 'Calendar sync'),
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

      var form = h('form', { novalidate: 'novalidate', onSubmit: onSubmit }, [
        h('div', { class: 'card' }, [
          h('div', { class: 'card__header' }, [
            h('h2', { class: 'card__title' }, 'Practice details'),
          ]),
          grid(IDENTITY_FIELDS),
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
