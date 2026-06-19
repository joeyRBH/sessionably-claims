/* Claimsub API client — the single entry point for all network calls.
 * Views must use window.ClaimsubAPI and never call fetch() directly.
 *
 * Auth token is stored in localStorage under "claimsub_access_token".
 * No PHI is ever placed in URLs or query strings.
 */
(function (window) {
  'use strict';

  var API_BASE = 'https://api.claimsub.com';
  var TOKEN_KEY = 'claimsub_access_token';

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

  // --- auth methods ----------------------------------------------------------

  // register(payload) -> POST /register; stores token on success.
  // payload: { mode: 'new_practice' | 'invitation', ... } per backend.
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

  // TODO(google-oauth): loginWithGoogle(idToken) -> POST /auth/google once Google
  // client credentials exist.
  // TODO(magic-link): requestMagicLink(email) / verifyMagicLink(token) once the
  // /send-email endpoint exists (client/patient portal auth).

  window.ClaimsubAPI = {
    // config
    API_BASE: API_BASE,
    // token helpers
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    isAuthenticated: isAuthenticated,
    // low-level (kept available for other ClaimsubAPI modules; views use the named methods)
    request: request,
    // auth
    register: register,
    login: login,
    logout: logout,
    me: me,
  };
})(window);
