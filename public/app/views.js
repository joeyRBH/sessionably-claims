/* =============================================================================
 * Reddably — hash router + shared view toolkit (window.Reddably)
 * =============================================================================
 * Loads AFTER api-client.js and app.js. Owns hash routing and the shared
 * helpers every view (clients / sessions / claims / dashboard) consumes.
 *
 * All network calls go through window.ReddablyAPI — this module never calls
 * fetch() directly. No PHI in hashes/URLs (ids and status enums only).
 *
 * Public surface (prompts 06-07 depend on these exact signatures):
 *   Reddably.api, Reddably.routes, registerView, navigate,
 *   h, clear, renderLoading, renderError, renderEmpty,
 *   toast, confirmModal, formModal,
 *   fmtMoney, fmtDate, statusBadge
 * ========================================================================== */
(function (window, document) {
  'use strict';

  var api = window.ReddablyAPI;
  var routes = {};

  // ---------------------------------------------------------------------------
  // DOM builder
  // ---------------------------------------------------------------------------
  // h(tag, attrs, children) -> Element.
  //   attrs: { class, html, onClick, onSubmit, ...any attribute/property }.
  //   children: a node, a string, or an array of either (null/undefined skipped).
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var val = attrs[key];
        if (val === null || val === undefined || val === false) return;
        if (key === 'class' || key === 'className') {
          el.className = val;
        } else if (key === 'html' || key === 'innerHTML') {
          el.innerHTML = val;
        } else if (key === 'text' || key === 'textContent') {
          el.textContent = val;
        } else if (key === 'dataset' && typeof val === 'object') {
          Object.keys(val).forEach(function (d) { el.dataset[d] = val[d]; });
        } else if (key.indexOf('on') === 0 && typeof val === 'function') {
          el.addEventListener(key.slice(2).toLowerCase(), val);
        } else {
          el.setAttribute(key, val);
        }
      });
    }
    appendChildren(el, children);
    return el;
  }

  function appendChildren(el, children) {
    if (children === null || children === undefined || children === false) return;
    if (Array.isArray(children)) {
      children.forEach(function (c) { appendChildren(el, c); });
      return;
    }
    if (children.nodeType) {
      el.appendChild(children);
    } else {
      el.appendChild(document.createTextNode(String(children)));
    }
  }

  function clear(el) {
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  // ---------------------------------------------------------------------------
  // Loading / error / empty states
  // ---------------------------------------------------------------------------
  function renderLoading(root) {
    clear(root);
    var panel = h('div', { class: 'view stack' }, [
      h('div', { class: 'skeleton skeleton--title' }),
      h('div', { class: 'card' }, [
        h('div', { class: 'skeleton skeleton--line' }),
        h('div', { class: 'skeleton skeleton--line' }),
        h('div', { class: 'skeleton skeleton--line', style: 'width:70%' }),
      ]),
    ]);
    root.appendChild(panel);
  }

  function renderError(root, err, retryFn) {
    clear(root);
    var msg = (err && err.message) || 'Something went wrong.';
    var children = [
      h('svg', {
        class: 'empty-state__icon',
        viewBox: '0 0 24 24',
        'aria-hidden': 'true',
        html: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
              '<path d="M12 7v6M12 16.5v.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
      }),
      h('h1', { class: 'empty-state__title' }, 'Could not load this view'),
      h('p', { class: 'empty-state__body' }, msg),
    ];
    if (typeof retryFn === 'function') {
      children.push(
        h('button', { class: 'btn btn--primary', onClick: retryFn }, 'Retry')
      );
    }
    root.appendChild(h('div', { class: 'empty-state' }, children));
  }

  // renderEmpty(root, { title, body, actionLabel, onAction })
  function renderEmpty(root, opts) {
    clear(root);
    opts = opts || {};
    var children = [
      h('svg', {
        class: 'empty-state__icon',
        viewBox: '0 0 24 24',
        'aria-hidden': 'true',
        html: '<rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
              '<path d="M3 9h18M8 14h8M8 17h5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
      }),
      h('h1', { class: 'empty-state__title' }, opts.title || 'Nothing here yet'),
      h('p', { class: 'empty-state__body' }, opts.body || ''),
    ];
    if (opts.actionLabel && typeof opts.onAction === 'function') {
      children.push(
        h('button', { class: 'btn btn--primary', onClick: opts.onAction }, opts.actionLabel)
      );
    }
    root.appendChild(h('div', { class: 'empty-state' }, children));
  }

  // ---------------------------------------------------------------------------
  // Toasts
  // ---------------------------------------------------------------------------
  function toastHost() {
    var host = document.getElementById('toast-host');
    if (!host) {
      host = h('div', { class: 'toast-host', id: 'toast-host' });
      document.body.appendChild(host);
    }
    return host;
  }

  function toast(message, kind) {
    var host = toastHost();
    var cls = 'toast' + (kind === 'success' ? ' toast--success' : kind === 'error' ? ' toast--error' : '');
    var el = h('div', { class: cls, role: 'status', 'aria-live': 'polite' }, message);
    host.appendChild(el);

    var removed = false;
    function remove() {
      if (removed) return;
      removed = true;
      el.classList.add('is-leaving');
      window.setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 250);
    }
    el.addEventListener('click', remove);
    window.setTimeout(remove, 4000);
  }

  // ---------------------------------------------------------------------------
  // Modal core (shared by confirmModal + formModal)
  // ---------------------------------------------------------------------------
  // openModal({ title, bodyNode, footerNodes, onClose }) -> { close }.
  function openModal(opts) {
    var previousFocus = document.activeElement;

    var panel = h('div', {
      class: 'modal__panel',
      role: 'dialog',
      'aria-modal': 'true',
    }, [
      h('div', { class: 'modal__header' }, [
        h('h2', { class: 'modal__title' }, opts.title || ''),
      ]),
      h('div', { class: 'modal__body' }, opts.bodyNode || null),
      h('div', { class: 'modal__footer' }, opts.footerNodes || null),
    ]);

    var backdrop = h('div', { class: 'modal__backdrop' }, panel);

    function close() {
      document.removeEventListener('keydown', onKeydown);
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      if (previousFocus && previousFocus.focus) {
        try { previousFocus.focus(); } catch (e) { /* ignore */ }
      }
    }

    function onKeydown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (typeof opts.onClose === 'function') opts.onClose();
      }
    }

    backdrop.addEventListener('mousedown', function (e) {
      if (e.target === backdrop && typeof opts.onClose === 'function') opts.onClose();
    });
    document.addEventListener('keydown', onKeydown);

    document.body.appendChild(backdrop);

    // Focus the first focusable control in the panel.
    var focusable = panel.querySelector(
      'input, select, textarea, button, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable && focusable.focus) {
      try { focusable.focus(); } catch (e) { /* ignore */ }
    }

    return { close: close, panel: panel };
  }

  // confirmModal({ title, body, confirmLabel, danger }) -> Promise<boolean>
  function confirmModal(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var settled = false;
      function settle(val, modal) {
        if (settled) return;
        settled = true;
        modal.close();
        resolve(val);
      }

      var cancelBtn = h('button', { class: 'btn btn--ghost', type: 'button' },
        opts.cancelLabel || 'Cancel');
      var confirmBtn = h('button', {
        class: 'btn ' + (opts.danger ? 'btn--danger' : 'btn--primary'),
        type: 'button',
      }, opts.confirmLabel || 'Confirm');

      var body = typeof opts.body === 'string'
        ? h('p', { style: 'margin:0' }, opts.body)
        : (opts.body || null);

      var modal = openModal({
        title: opts.title || 'Are you sure?',
        bodyNode: body,
        footerNodes: [cancelBtn, confirmBtn],
        onClose: function () { settle(false, modal); },
      });

      cancelBtn.addEventListener('click', function () { settle(false, modal); });
      confirmBtn.addEventListener('click', function () { settle(true, modal); });
    });
  }

  // ---------------------------------------------------------------------------
  // Payer type-ahead picker — reusable across the Verify Benefits + insurance
  // forms. A visible search box calls the payer-search API (debounced 300ms) and
  // lists "Name — PAYERID" matches beneath it; selecting one fills a hidden
  // control with the payer_id while showing the chosen name. Typing a raw payer
  // id and submitting without selecting still works — the hidden control mirrors
  // the raw text on every keystroke. Responses for a superseded query are ignored.
  //
  // Returns { node, control } where `node` is the composite element to render and
  // `control` is a hidden <input> whose .value is the payer_id to submit, so the
  // existing formModal collect()/required-validation path works unchanged.
  function createPayerPicker(opts) {
    opts = opts || {};
    var initial = opts.initial || '';

    var hidden = h('input', { type: 'hidden', name: opts.name || 'payer_id', value: initial });
    var input = h('input', {
      class: 'field__control',
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      value: initial,
      placeholder: opts.placeholder || 'Search payer name or enter a Payer ID…',
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'false',
    });
    var results = h('div', { class: 'payer-picker__results', role: 'listbox', hidden: 'hidden' });
    var node = h('div', { class: 'payer-picker' }, [input, results, hidden]);

    var seq = 0;            // id of the most recently issued request (stale-guard)
    var timer = null;
    var currentList = [];
    var activeIndex = -1;

    function openResults() {
      results.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }
    function closeResults() {
      results.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      activeIndex = -1;
    }

    function showStatus(text) {
      clear(results);
      results.appendChild(h('div', { class: 'payer-picker__status' }, text));
      openResults();
    }

    function paintActive() {
      var optionEls = results.querySelectorAll('.payer-picker__option');
      Array.prototype.forEach.call(optionEls, function (el, i) {
        el.classList.toggle('is-active', i === activeIndex);
      });
      if (activeIndex >= 0 && optionEls[activeIndex]) {
        optionEls[activeIndex].scrollIntoView({ block: 'nearest' });
      }
    }

    function choose(p) {
      if (!p) return;
      hidden.value = p.payer_id;
      input.value = p.name ? (p.name + ' (' + p.payer_id + ')') : p.payer_id;
      closeResults();
    }

    function renderResults(list) {
      currentList = list || [];
      activeIndex = -1;
      clear(results);
      if (!currentList.length) {
        results.appendChild(h('div', { class: 'payer-picker__status' }, 'No payers found'));
        openResults();
        return;
      }
      currentList.forEach(function (p, i) {
        var opt = h('div', { class: 'payer-picker__option', role: 'option' }, [
          h('span', { class: 'payer-picker__option-name' }, p.name || '(unnamed payer)'),
          h('span', { class: 'payer-picker__option-id' }, p.payer_id),
        ]);
        // mousedown (not click) so the pick runs before the input's blur fires.
        opt.addEventListener('mousedown', function (e) {
          e.preventDefault();
          choose(currentList[i]);
        });
        opt.addEventListener('mouseenter', function () { activeIndex = i; paintActive(); });
        results.appendChild(opt);
      });
      openResults();
    }

    function runSearch(q) {
      var mySeq = ++seq;
      showStatus('Searching…');
      api.payers.search(q).then(function (res) {
        if (mySeq !== seq) return;   // a newer query superseded this response
        renderResults((res && res.payers) || []);
      }).catch(function (err) {
        if (mySeq !== seq) return;   // stale error — ignore
        closeResults();
        toast((err && err.message) || 'Payer search failed', 'error');
      });
    }

    input.addEventListener('input', function () {
      var q = input.value.trim();
      hidden.value = q;              // raw passthrough: submit whatever is typed
      if (timer) { window.clearTimeout(timer); timer = null; }
      if (q.length < 2) { seq++; closeResults(); return; }  // too short: invalidate + hide
      timer = window.setTimeout(function () { runSearch(q); }, 300);
    });

    input.addEventListener('keydown', function (e) {
      if (results.hidden) return;
      var optionEls = results.querySelectorAll('.payer-picker__option');
      if (e.key === 'ArrowDown') {
        if (!optionEls.length) return;
        e.preventDefault();
        activeIndex = Math.min(optionEls.length - 1, activeIndex + 1);
        paintActive();
      } else if (e.key === 'ArrowUp') {
        if (!optionEls.length) return;
        e.preventDefault();
        activeIndex = Math.max(0, activeIndex - 1);
        paintActive();
      } else if (e.key === 'Enter') {
        // Only intercept Enter to pick a highlighted option; otherwise let the
        // form submit with whatever raw value is present.
        if (activeIndex >= 0 && activeIndex < currentList.length) {
          e.preventDefault();
          choose(currentList[activeIndex]);
        }
      } else if (e.key === 'Escape') {
        // Close the dropdown without closing the modal.
        e.stopPropagation();
        closeResults();
      }
    });

    // Hide the list when focus leaves, after a tick so an option mousedown lands.
    input.addEventListener('blur', function () {
      window.setTimeout(closeResults, 150);
    });

    return { node: node, control: hidden };
  }

  // formModal({ title, fields, values, submitLabel }) -> Promise<values|null>
  //   fields: [{ name, label, type, required, options, placeholder }]
  //   types: text | email | date | number | select | textarea | payer (default text)
  function formModal(opts) {
    opts = opts || {};
    var fields = opts.fields || [];
    var values = opts.values || {};

    return new Promise(function (resolve) {
      var settled = false;
      function settle(val, modal) {
        if (settled) return;
        settled = true;
        modal.close();
        resolve(val);
      }

      var controls = {};      // name -> control element
      var fieldEls = {};      // name -> .field wrapper (for error toggling)
      var errorEls = {};      // name -> .field__error element

      var form = h('form', { novalidate: 'novalidate' });

      fields.forEach(function (f) {
        var type = f.type || 'text';
        var initial = values[f.name];
        if (initial === null || initial === undefined) initial = '';

        var control;
        var display;   // node rendered in the field (usually the control itself)
        if (type === 'select') {
          control = h('select', { class: 'field__control', name: f.name },
            (f.options || []).map(function (opt) {
              var value = (opt && typeof opt === 'object') ? opt.value : opt;
              var label = (opt && typeof opt === 'object') ? opt.label : opt;
              var attrs = { value: value };
              if (String(value) === String(initial)) attrs.selected = 'selected';
              return h('option', attrs, label);
            })
          );
          display = control;
        } else if (type === 'textarea') {
          control = h('textarea', {
            class: 'field__control',
            name: f.name,
            placeholder: f.placeholder || '',
          }, String(initial));
          display = control;
        } else if (type === 'payer') {
          var picker = createPayerPicker({
            name: f.name,
            initial: String(initial),
            placeholder: f.placeholder,
          });
          control = picker.control;   // hidden input carrying the payer_id
          display = picker.node;      // composite search box + results list
        } else {
          control = h('input', {
            class: 'field__control',
            type: type,
            name: f.name,
            value: String(initial),
            placeholder: f.placeholder || '',
          });
          display = control;
        }

        controls[f.name] = control;

        var errorEl = h('span', { class: 'field__error', hidden: 'hidden' });
        errorEls[f.name] = errorEl;

        var labelText = f.label || f.name;
        var fieldEl = h('label', { class: 'field' }, [
          h('span', { class: 'field__label' },
            f.required ? [labelText, ' ', h('span', { 'aria-hidden': 'true' }, '*')] : labelText),
          display,
          errorEl,
        ]);
        fieldEls[f.name] = fieldEl;
        form.appendChild(fieldEl);
      });

      function setError(name, message) {
        var errEl = errorEls[name];
        var fieldEl = fieldEls[name];
        if (message) {
          errEl.textContent = message;
          errEl.hidden = false;
          fieldEl.classList.add('field--invalid');
        } else {
          errEl.textContent = '';
          errEl.hidden = true;
          fieldEl.classList.remove('field--invalid');
        }
      }

      function collect() {
        var out = {};
        var ok = true;
        fields.forEach(function (f) {
          var raw = controls[f.name].value;
          var val = typeof raw === 'string' ? raw.trim() : raw;
          if (f.required && (val === '' || val === null || val === undefined)) {
            setError(f.name, (f.label || f.name) + ' is required.');
            ok = false;
          } else {
            setError(f.name, null);
          }
          out[f.name] = val === '' ? null : val;
        });
        return ok ? out : null;
      }

      var cancelBtn = h('button', { class: 'btn btn--ghost', type: 'button' }, 'Cancel');
      var submitBtn = h('button', { class: 'btn btn--primary', type: 'submit' },
        opts.submitLabel || 'Save');

      function onSubmit(e) {
        if (e) e.preventDefault();
        var result = collect();
        if (result === null) return;       // validation failed; errors are shown
        settle(result, modal);
      }

      form.addEventListener('submit', onSubmit);

      var modal = openModal({
        title: opts.title || 'Form',
        bodyNode: form,
        footerNodes: [cancelBtn, submitBtn],
        onClose: function () { settle(null, modal); },
      });

      cancelBtn.addEventListener('click', function () { settle(null, modal); });
      submitBtn.addEventListener('click', onSubmit);
    });
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------
  function fmtMoney(n) {
    if (n === null || n === undefined || n === '') return '—';
    var num = typeof n === 'number' ? n : parseFloat(n);
    if (isNaN(num)) return '—';
    return '$' + num.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function fmtDate(s) {
    if (!s) return '—';
    var d;
    // Date-only strings ("2026-06-01") are parsed as local to avoid TZ drift.
    if (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
      var p = s.split('-');
      d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    } else {
      d = new Date(s);
    }
    if (isNaN(d.getTime())) return '—';
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  // ---------------------------------------------------------------------------
  // Status badge — tone mapping shared across sessions / claims / clients.
  // ---------------------------------------------------------------------------
  var BADGE_TONES = {
    // neutral
    draft: 'neutral', scheduled: 'neutral', void: 'neutral',
    no_claim: 'neutral', completed: 'neutral',
    // info
    submitted: 'info', processing: 'info',
    claim_submitted: 'info', claim_ready: 'info',
    // warning
    info_requested: 'warning', appealed: 'warning',
    awaiting_payment: 'warning', awaiting_info: 'warning',
    // success
    paid: 'success', active: 'success', ready: 'success',
    // danger
    denied: 'danger', inactive: 'danger',
  };

  function humanizeStatus(status) {
    if (!status) return '—';
    return String(status).replace(/_/g, ' ').replace(/\b\w/g, function (c) {
      return c.toUpperCase();
    });
  }

  function statusBadge(status) {
    var tone = BADGE_TONES[status] || 'neutral';
    return h('span', { class: 'badge badge--' + tone }, humanizeStatus(status));
  }

  // ---------------------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------------------
  function registerView(hash, mountFn) {
    routes[hash] = mountFn;
  }

  function navigate(hash) {
    if (!hash) return;
    var clean = hash.charAt(0) === '#' ? hash.slice(1) : hash;
    window.location.hash = '#' + clean;
  }

  function parseHash() {
    var raw = window.location.hash || '#dashboard';
    if (raw.charAt(0) === '#') raw = raw.slice(1);
    if (!raw) raw = 'dashboard';
    var segments = raw.split('/').filter(function (s) { return s !== ''; });
    var route = segments.shift() || 'dashboard';
    return { route: route, params: segments };
  }

  // Update sidebar active state to match the current route.
  function syncNav(route) {
    var links = document.querySelectorAll('.nav-link');
    Array.prototype.forEach.call(links, function (link) {
      var href = link.getAttribute('href') || '';
      var linkHash = href.charAt(0) === '#' ? href.slice(1) : href;
      var linkRoute = linkHash.split('/')[0];
      var isActive = linkRoute === route;
      link.classList.toggle('is-active', isActive);
      if (isActive) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  function renderRoute() {
    var viewRoot = document.getElementById('view-root');
    if (!viewRoot) return;

    var parsed = parseHash();
    syncNav(parsed.route);
    clear(viewRoot);
    viewRoot.scrollTop = 0;

    var mount = routes[parsed.route];
    if (typeof mount === 'function') {
      try {
        mount(viewRoot, parsed.params);
      } catch (e) {
        renderError(viewRoot, e);
      }
    } else {
      renderEmpty(viewRoot, {
        title: 'Section coming soon',
        body: 'This part of Reddably is not built yet. Check back shortly.',
      });
    }
  }

  function initRouter() {
    window.addEventListener('hashchange', renderRoute);
    renderRoute();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRouter);
  } else {
    initRouter();
  }

  // ---------------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------------
  window.Reddably = {
    api: api,
    routes: routes,
    registerView: registerView,
    navigate: navigate,
    // rendering helpers
    h: h,
    clear: clear,
    renderLoading: renderLoading,
    renderError: renderError,
    renderEmpty: renderEmpty,
    // overlays / feedback
    toast: toast,
    confirmModal: confirmModal,
    formModal: formModal,
    createPayerPicker: createPayerPicker,
    // formatting
    fmtMoney: fmtMoney,
    fmtDate: fmtDate,
    statusBadge: statusBadge,
  };
})(window, document);
