/* Reddably API client — the single entry point for all network calls.
 * Views must use window.ReddablyAPI and never call fetch() directly.
 *
 * Auth token is stored in localStorage under "reddably_access_token".
 * No PHI is ever placed in URLs or query strings (ids/status enums only).
 */
(function (window) {
  'use strict';

  // API base URL — configurable so the domain can be flipped with zero code edits.
  // Resolution order (first match wins):
  //   1. window.REDDABLY_API_BASE  — global set by an inline/injected bootstrap snippet
  //   2. <meta name="reddably-api-base" content="https://api.claimsub.com">
  //   3. default below (the current live, canonical hostname)
  function resolveApiBase() {
    if (window.REDDABLY_API_BASE) return window.REDDABLY_API_BASE;
    try {
      var meta = window.document.querySelector('meta[name="reddably-api-base"]');
      if (meta && meta.content) return meta.content;
    } catch (e) {
      /* document unavailable — fall through to default */
    }
    return 'https://api.claimsub.com';
  }

  var API_BASE = resolveApiBase();

  // Base URL for the patient-billing endpoints, which run as Vercel functions
  // (Stripe/Twilio need outbound internet the VPC Lambda API lacks), NOT on the
  // Lambda API at API_BASE. Overridable via window.REDDABLY_VERCEL_BASE / a
  // <meta name="reddably-vercel-base"> tag; defaults to the canonical app domain.
  function resolveVercelBase() {
    if (window.REDDABLY_VERCEL_BASE) return window.REDDABLY_VERCEL_BASE;
    try {
      var meta = window.document.querySelector('meta[name="reddably-vercel-base"]');
      if (meta && meta.content) return meta.content;
    } catch (e) {
      /* document unavailable — fall through to default */
    }
    return 'https://reddably.com';
  }

  var VERCEL_BASE = resolveVercelBase();
  var TOKEN_KEY = 'reddably_access_token';

  // --- token storage ---------------------------------------------------------

  function getToken() {
    try {
      return window.localStorage.getItem(TOKEN_KEY);
    } catch (e) {
      return null;
    }
  }

  function setToken(token) {
    try {
      if (token) window.localStorage.setItem(TOKEN_KEY, token);
    } catch (e) {
      /* storage unavailable (private mode) — ignore */
    }
  }

  function clearToken() {
    try {
      window.localStorage.removeItem(TOKEN_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  // Decode a JWT payload without verifying the signature (client-side hint only).
  function decodeJwt(token) {
    if (!token) return null;
    var parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
      var base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      var padded = base64 + '==='.slice((base64.length + 3) % 4);
      return JSON.parse(window.atob(padded));
    } catch (e) {
      return null;
    }
  }

  // True only if a token is present and its exp is in the future.
  function isAuthenticated() {
    var payload = decodeJwt(getToken());
    if (!payload || !payload.exp) return false;
    return payload.exp * 1000 > Date.now();
  }

  // --- core request helper ---------------------------------------------------

  // `base` defaults to the Lambda API (API_BASE); pass VERCEL_BASE for the
  // patient-billing endpoints that run as Vercel functions.
  function request(method, path, body, base) {
    var headers = { 'Content-Type': 'application/json' };
    var token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    var opts = { method: method, headers: headers };
    if (body !== undefined && body !== null) {
      opts.body = JSON.stringify(body);
    }

    return window.fetch((base || API_BASE) + path, opts).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (!res.ok) {
            var err = new Error((data && data.error) || 'Request failed');
            err.status = res.status;
            err.body = data;
            throw err;
          }
          return data;
        });
    });
  }

  // Build a "?a=1&b=2" string from a params object, skipping null/undefined/''.
  // Values are encoded; only non-PHI identifiers/enums are ever passed here.
  function buildQuery(params) {
    if (!params) return '';
    var parts = [];
    Object.keys(params).forEach(function (key) {
      var v = params[key];
      if (v === null || v === undefined || v === '') return;
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(v));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  // --- auth methods ----------------------------------------------------------

  // register(payload) -> POST /register; stores token on success.
  function register(payload) {
    return request('POST', '/register', payload).then(function (res) {
      if (res && res.token) setToken(res.token);
      return res;
    });
  }

  function login(email, password) {
    return request('POST', '/login', { email: email, password: password }).then(function (res) {
      if (res && res.token) setToken(res.token);
      return res;
    });
  }

  function logout() {
    clearToken();
  }

  function me() {
    return request('GET', '/me');
  }

  // --- resource methods ------------------------------------------------------
  // Each method resolves to the backend's response object as-is, e.g.
  //   clients.list()        -> { clients: [...] }
  //   clients.get(id)       -> { client: {...} }
  //   claims.events(id)     -> { claim_events: [...] }
  // Views read the named field off the result. Errors reject with an Error whose
  // .status and .body carry the HTTP status and parsed error payload.

  var clients = {
    list: function () { return request('GET', '/clients'); },
    get: function (id) { return request('GET', '/clients/' + id); },
    create: function (payload) { return request('POST', '/clients', payload); },
    update: function (id, payload) { return request('PATCH', '/clients/' + id, payload); },
    remove: function (id) { return request('DELETE', '/clients/' + id); },
    // Text the client an SMS link to securely save a payment method (staff action).
    // Runs as a Vercel function (Twilio egress) → target VERCEL_BASE.
    sendPaymentLink: function (id) {
      return request('POST', '/clients/' + id + '/send-payment-link', {}, VERCEL_BASE);
    },
  };

  // Patient billing (PUBLIC endpoints — used by the standalone card-capture page).
  // These take a short-lived signed token in the body, not the staff bearer token,
  // and run as Vercel functions (Stripe egress) → target VERCEL_BASE.
  var billing = {
    setupIntent: function (token) {
      return request('POST', '/setup-intent', { token: token }, VERCEL_BASE);
    },
    savePaymentMethod: function (token, paymentMethodId) {
      return request('POST', '/save-payment-method', { token: token, paymentMethodId: paymentMethodId }, VERCEL_BASE);
    },
  };

  var insuranceRecords = {
    // filters: { client_id }
    list: function (filters) { return request('GET', '/insurance-records' + buildQuery(filters)); },
    get: function (id) { return request('GET', '/insurance-records/' + id); },
    create: function (payload) { return request('POST', '/insurance-records', payload); },
    update: function (id, payload) { return request('PATCH', '/insurance-records/' + id, payload); },
    remove: function (id) { return request('DELETE', '/insurance-records/' + id); },
  };

  var sessions = {
    // filters: { client_id, clinician_id, status }
    list: function (filters) { return request('GET', '/sessions' + buildQuery(filters)); },
    get: function (id) { return request('GET', '/sessions/' + id); },
    create: function (payload) { return request('POST', '/sessions', payload); },
    update: function (id, payload) { return request('PATCH', '/sessions/' + id, payload); },
    remove: function (id) { return request('DELETE', '/sessions/' + id); },
  };

  // Best-effort: after a claim is submitted, trigger the platform-fee charge on the
  // Vercel function (which has the Stripe egress the Lambda lacks). Fire-and-forget —
  // the claim is already submitted, so any failure is logged to the console and never
  // surfaced to the user. Forwards the staff session JWT so the function can verify it.
  function chargeClaimFee(id) {
    try {
      var token = getToken();
      if (!token) return;
      window.fetch(VERCEL_BASE + '/api/claims/' + id + '/charge-fee', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: '{}',
      }).then(function (res) {
        if (!res || !res.ok) {
          console.warn('Platform fee charge did not complete (status ' + (res && res.status) + ').');
        }
      }).catch(function (e) {
        console.warn('Platform fee charge request failed:', e && e.message);
      });
    } catch (e) {
      /* never throw from a best-effort fee charge */
    }
  }

  var claims = {
    // filters: { session_id, client_id, status }
    list: function (filters) { return request('GET', '/claims' + buildQuery(filters)); },
    get: function (id) { return request('GET', '/claims/' + id); },
    create: function (payload) { return request('POST', '/claims', payload); },
    update: function (id, payload) { return request('PATCH', '/claims/' + id, payload); },
    remove: function (id) { return request('DELETE', '/claims/' + id); },
    // lifecycle actions
    submit: function (id) {
      return request('POST', '/claims/' + id + '/submit', {}).then(function (res) {
        // Best-effort platform-fee charge via Vercel; never blocks or fails the submit.
        chargeClaimFee(id);
        return res;
      });
    },
    refresh: function (id) { return request('POST', '/claims/' + id + '/refresh', {}); },
    void: function (id) { return request('POST', '/claims/' + id + '/void', {}); },
    events: function (id) { return request('GET', '/claims/' + id + '/events'); },
  };

  var users = {
    // filters: { role, is_active }
    list: function (filters) { return request('GET', '/users' + buildQuery(filters)); },
    get: function (id) { return request('GET', '/users/' + id); },
    update: function (id, payload) { return request('PATCH', '/users/' + id, payload); },
  };

  var invitations = {
    list: function () { return request('GET', '/invitations'); },
    create: function (payload) { return request('POST', '/invitations', payload); },
    revoke: function (id) { return request('DELETE', '/invitations/' + id); },
  };

  // Subscription / plan (Instant VOB add-on).
  //   status()      -> { plan, vob_checks_used, vob_period_start }  (Lambda API; DB-only)
  //   activateVob() -> { checkoutUrl }  (Vercel function; Stripe egress) — redirect there
  var subscription = {
    status: function () { return request('GET', '/subscription/status'); },
    activateVob: function () {
      return request('POST', '/subscription/vob/activate', {}, VERCEL_BASE);
    },
  };

  // Instant VOB benefit check (gated by plan; see subscription). Runs on the
  // Lambda API. payload: { memberId, payerId, firstName, lastName, dateOfBirth,
  // insurance_record_id? } -> normalized benefits summary.
  var vob = {
    check: function (payload) { return request('POST', '/vob/check', payload); },
  };

  window.ReddablyAPI = {
    // config
    API_BASE: API_BASE,
    VERCEL_BASE: VERCEL_BASE,
    // token helpers
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    isAuthenticated: isAuthenticated,
    // low-level (other modules may use; views use the named resource methods)
    request: request,
    buildQuery: buildQuery,
    // auth
    register: register,
    login: login,
    logout: logout,
    me: me,
    // resources
    clients: clients,
    insuranceRecords: insuranceRecords,
    sessions: sessions,
    claims: claims,
    users: users,
    invitations: invitations,
    billing: billing,
    subscription: subscription,
    vob: vob,
  };
})(window);
