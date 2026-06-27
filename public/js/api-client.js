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

  function request(method, path, body) {
    var headers = { 'Content-Type': 'application/json' };
    var token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    var opts = { method: method, headers: headers };
    if (body !== undefined && body !== null) {
      opts.body = JSON.stringify(body);
    }

    return window.fetch(API_BASE + path, opts).then(function (res) {
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

  var claims = {
    // filters: { session_id, client_id, status }
    list: function (filters) { return request('GET', '/claims' + buildQuery(filters)); },
    get: function (id) { return request('GET', '/claims/' + id); },
    create: function (payload) { return request('POST', '/claims', payload); },
    update: function (id, payload) { return request('PATCH', '/claims/' + id, payload); },
    remove: function (id) { return request('DELETE', '/claims/' + id); },
    // lifecycle actions
    submit: function (id) { return request('POST', '/claims/' + id + '/submit', {}); },
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

  window.ReddablyAPI = {
    // config
    API_BASE: API_BASE,
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
  };
})(window);
