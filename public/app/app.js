/* Claimsub — app shell behavior.
 *
 * Responsibilities (shell only, no view logic):
 *   1. Auth guard (gated by AUTH_REQUIRED until /login.html ships).
 *   2. Ensure window.ClaimsubAPI exposes the contract the shell relies on.
 *   3. Off-canvas drawer toggle (mobile) + user menu + logout.
 *
 * All network calls go through window.ClaimsubAPI (public/js/api-client.js),
 * which already provides API_BASE, getToken/setToken/clearToken and request().
 * Views never call fetch() directly.
 */
(function (window, document) {
  'use strict';

  // TODO: flip AUTH_REQUIRED to true once /login.html ships, so an unauthenticated
  // visitor is redirected instead of seeing the shell. Kept false during dev.
  var AUTH_REQUIRED = false;
  var LOGIN_URL = '/login.html';

  // ---------------------------------------------------------------------------
  // ClaimsubAPI: reuse the canonical client; add a thin baseUrl alias + a
  // request(path, options) convenience without clobbering the existing module.
  // ---------------------------------------------------------------------------
  function ensureApi() {
    var api = window.ClaimsubAPI;
    if (!api) {
      // api-client.js failed to load — fail safe with a minimal stand-in so the
      // shell still renders and logout never throws.
      console.warn('[Claimsub] ClaimsubAPI unavailable; using shell fallback.');
      var TOKEN_KEY = 'claimsub_access_token';
      api = window.ClaimsubAPI = {
        getToken: function () { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } },
        setToken: function (t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); } catch (e) {} },
        clearToken: function () { try { localStorage.removeItem(TOKEN_KEY); } catch (e) {} },
      };
    }

    // baseUrl: alias the existing API_BASE (or default) without overwriting it.
    if (!api.baseUrl) {
      api.baseUrl = api.API_BASE || 'https://api.claimsub.com';
    }
    return api;
  }

  // ---------------------------------------------------------------------------
  // Auth guard
  // ---------------------------------------------------------------------------
  function guard(api) {
    if (!AUTH_REQUIRED) return true;
    var token = api.getToken && api.getToken();
    if (!token) {
      window.location.replace(LOGIN_URL);
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Off-canvas drawer (mobile)
  // ---------------------------------------------------------------------------
  function initDrawer() {
    var shell = document.getElementById('app-shell');
    var toggle = document.getElementById('drawer-toggle');
    var backdrop = document.getElementById('drawer-backdrop');
    var sidebar = document.getElementById('sidebar');
    if (!shell || !toggle) return;

    function isOpen() {
      return shell.classList.contains('is-drawer-open');
    }

    function setOpen(open) {
      shell.classList.toggle('is-drawer-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (backdrop) backdrop.hidden = !open;
    }

    toggle.addEventListener('click', function () {
      setOpen(!isOpen());
    });

    if (backdrop) {
      backdrop.addEventListener('click', function () { setOpen(false); });
    }

    // Tapping a nav link closes the drawer (mobile navigation).
    if (sidebar) {
      sidebar.addEventListener('click', function (e) {
        if (e.target.closest('.nav-link')) setOpen(false);
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) {
        setOpen(false);
        toggle.focus();
      }
    });

    // Returning to desktop width clears any open-drawer state.
    var mq = window.matchMedia('(min-width: 901px)');
    var onChange = function (e) { if (e.matches) setOpen(false); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  // ---------------------------------------------------------------------------
  // User menu (dropdown with Logout)
  // ---------------------------------------------------------------------------
  function initUserMenu(api) {
    var trigger = document.getElementById('user-menu-trigger');
    var dropdown = document.getElementById('user-menu-dropdown');
    var logoutBtn = document.getElementById('logout-btn');
    if (!trigger || !dropdown) return;

    function setExpanded(expanded) {
      trigger.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      dropdown.hidden = !expanded;
    }

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      setExpanded(dropdown.hidden);
    });

    // Outside click / Escape closes the menu.
    document.addEventListener('click', function (e) {
      if (!dropdown.hidden && !e.target.closest('#user-menu')) setExpanded(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !dropdown.hidden) {
        setExpanded(false);
        trigger.focus();
      }
    });

    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        if (api.clearToken) api.clearToken();
        window.location.assign(LOGIN_URL);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  function init() {
    var api = ensureApi();
    if (!guard(api)) return; // redirecting — stop here
    initDrawer();
    initUserMenu(api);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window, document);
