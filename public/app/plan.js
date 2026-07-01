/* =============================================================================
 * Reddably — plan state + topbar plan badge (window.ReddablyPlan)
 * =============================================================================
 * Loads AFTER api-client.js / app.js / views.js. On boot it fetches the
 * practice's subscription plan once and caches it in a module-level variable so
 * the Instant VOB gate check is instant (no per-click network call). Renders a
 * small plan badge in the topbar and toasts on return from Stripe Checkout.
 *
 * Public surface (consumed by views/clients.js):
 *   ReddablyPlan.get()      -> 'free' | 'vob' | 'founder'
 *   ReddablyPlan.isPaid()   -> boolean (vob or founder)
 *   ReddablyPlan.state      -> { plan, vob_checks_used, vob_period_start, loaded }
 *   ReddablyPlan.refresh()  -> Promise (re-fetch + re-render)
 * ========================================================================== */
(function (window, document) {
  'use strict';

  var api = window.ReddablyAPI;

  var state = {
    plan: 'free',
    vob_checks_used: 0,
    vob_period_start: null,
    loaded: false,
  };

  // Plan → { label, tone }. Founder stays subtle (neutral), VOB earns success.
  var PLAN_META = {
    free:    { label: 'Free',       tone: 'neutral' },
    vob:     { label: 'VOB Active', tone: 'success' },
    founder: { label: 'Founder',    tone: 'neutral' },
  };

  function toast(message, kind) {
    if (window.Reddably && typeof window.Reddably.toast === 'function') {
      window.Reddably.toast(message, kind);
    }
  }

  // Insert (or update) the plan badge at the front of the topbar's right cluster.
  function renderBadge() {
    var host = document.querySelector('.topbar__right');
    if (!host) return;

    var meta = PLAN_META[state.plan] || PLAN_META.free;
    var badge = document.getElementById('plan-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'plan-badge';
      badge.style.marginRight = 'var(--space-3)';
      host.insertBefore(badge, host.firstChild);
    }
    badge.className = 'badge badge--' + meta.tone;
    badge.textContent = meta.label;
    badge.setAttribute('title', 'Current plan: ' + meta.label);
  }

  function apply(data) {
    data = data || {};
    if (data.plan) state.plan = data.plan;
    if (typeof data.vob_checks_used === 'number') state.vob_checks_used = data.vob_checks_used;
    if ('vob_period_start' in data) state.vob_period_start = data.vob_period_start;
    state.loaded = true;
    renderBadge();
    return state;
  }

  function load() {
    if (!api || !api.subscription || !api.subscription.status) {
      renderBadge();
      return Promise.resolve(state);
    }
    return api.subscription.status()
      .then(apply)
      .catch(function () {
        // Leave the default (free) badge; a failed status must not block the app.
        renderBadge();
        return state;
      });
  }

  // Toast + refresh when returning from Stripe Checkout (#vob-activated / -cancelled).
  function handleReturnHash() {
    var hash = window.location.hash || '';
    if (hash.indexOf('vob-activated') !== -1) {
      toast('Instant VOB is now active.', 'success');
      // The webhook flips the plan server-side; re-fetch to update the badge/gate.
      load();
    } else if (hash.indexOf('vob-cancelled') !== -1) {
      toast('Checkout cancelled.', '');
    }
  }

  window.ReddablyPlan = {
    state: state,
    get: function () { return state.plan; },
    isPaid: function () { return state.plan === 'vob' || state.plan === 'founder'; },
    refresh: load,
  };

  function init() {
    load();
    handleReturnHash();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window, document);
