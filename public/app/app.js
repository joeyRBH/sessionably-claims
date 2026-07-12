/* Reddably — app shell behavior.
 *
 * Responsibilities (shell only, no view logic):
 *   1. Auth guard (gated by AUTH_REQUIRED until /login.html ships).
 *   2. Ensure window.ReddablyAPI exposes the contract the shell relies on.
 *   3. Off-canvas drawer toggle (mobile) + user menu + logout.
 *
 * All network calls go through window.ReddablyAPI (public/js/api-client.js),
 * which already provides API_BASE, getToken/setToken/clearToken and request().
 * Views never call fetch() directly.
 */
(function (window, document) {
  'use strict';

  // Auth guard: an unauthenticated visitor is redirected to /login.html.
  var AUTH_REQUIRED = true;
  var LOGIN_URL = '/login.html';

  // ---------------------------------------------------------------------------
  // ReddablyAPI: reuse the canonical client; add a thin baseUrl alias + a
  // request(path, options) convenience without clobbering the existing module.
  // ---------------------------------------------------------------------------
  function ensureApi() {
    var api = window.ReddablyAPI;
    if (!api) {
      // api-client.js failed to load — fail safe with a minimal stand-in so the
      // shell still renders and logout never throws.
      console.warn('[Reddably] ReddablyAPI unavailable; using shell fallback.');
      var TOKEN_KEY = 'reddably_access_token';
      api = window.ReddablyAPI = {
        getToken: function () { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } },
        setToken: function (t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); } catch (e) {} },
        clearToken: function () { try { localStorage.removeItem(TOKEN_KEY); } catch (e) {} },
      };
    }

    // baseUrl: alias the existing API_BASE (or default) without overwriting it.
    // The default is configurable so the domain can be flipped with zero code edits:
    // set window.REDDABLY_API_BASE or a <meta name="reddably-api-base"> tag (see
    // api-client.js); falls back to the current live hostname.
    if (!api.baseUrl) {
      var metaBase = null;
      try {
        var meta = document.querySelector('meta[name="reddably-api-base"]');
        metaBase = meta && meta.content;
      } catch (e) { /* ignore */ }
      api.baseUrl = api.API_BASE || window.REDDABLY_API_BASE || metaBase || 'https://api.claims.sessionably.com';
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
      // Move focus into the drawer on open so keyboard/SR users land on the nav.
      if (open && sidebar) {
        var firstLink = sidebar.querySelector('.nav-link');
        if (firstLink) firstLink.focus();
      }
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
  // Topbar identity — populate the user + practice from /me (non-blocking).
  // ---------------------------------------------------------------------------
  function initials(first, last) {
    var a = (first || '').trim().charAt(0);
    var b = (last || '').trim().charAt(0);
    return (a + b).toUpperCase();
  }

  function populateTopbar(api) {
    if (!api.me) return;
    api.me().then(function (res) {
      var user = (res && res.user) || res || {};
      var practice = (res && res.practice) || (user && user.practice) || {};

      // Cache for views (e.g. the dashboard greeting) — no extra /me round-trip.
      if (window.Reddably) window.Reddably.currentUser = res;

      var first = user.first_name || '';
      var last = user.last_name || '';
      var fullName = (first + ' ' + last).trim();

      var nameEl = document.getElementById('user-name');
      var initialsEl = document.getElementById('user-initials');
      var practiceEl = document.getElementById('practice-name');

      if (nameEl && fullName) nameEl.textContent = fullName;
      if (initialsEl && (first || last)) initialsEl.textContent = initials(first, last);
      if (practiceEl && practice && practice.name) practiceEl.textContent = practice.name;

      // Reveal the admin-only Audit log nav item for practice admins. The server
      // also enforces this (GET /audit-log returns 403 to non-admins), so hiding
      // it here is UX, not the security boundary.
      var role = (user && user.role) || (practice && practice.role);
      var auditNav = document.getElementById('nav-audit-item');
      if (auditNav && role === 'practice_admin') auditNav.hidden = false;
      // Payer ERA enrollments are practice_admin-only too (the view guards again,
      // and the mutation endpoint 403s non-admins — this is UX, not the boundary).
      var enrollNav = document.getElementById('nav-enrollments-item');
      if (enrollNav && role === 'practice_admin') enrollNav.hidden = false;
    }).catch(function () {
      /* leave the existing placeholders in place on failure */
    });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  function init() {
    var api = ensureApi();
    if (!guard(api)) return; // redirecting — stop here
    initDrawer();
    initUserMenu(api);
    populateTopbar(api);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window, document);
