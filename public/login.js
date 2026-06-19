/* Claimsub — login page behavior.
 *
 * All network calls go through window.ClaimsubAPI (public/js/api-client.js);
 * this page never calls fetch() directly.
 *
 *   1. If already authenticated, redirect straight to the app.
 *   2. On submit, call ClaimsubAPI.login(); show a loading state; on success
 *      redirect to the app, on failure show ONE generic error (no field-level
 *      detail, no user-enumeration) and re-enable the form.
 */
(function (window, document) {
  'use strict';

  var APP_URL = './app/app.html';
  var GENERIC_ERROR = 'Invalid email or password';

  var api = window.ClaimsubAPI;

  // Already signed in? Skip the form.
  if (api && api.isAuthenticated && api.isAuthenticated()) {
    window.location.replace(APP_URL);
    return;
  }

  function init() {
    var form = document.getElementById('login-form');
    var emailInput = document.getElementById('email');
    var passwordInput = document.getElementById('password');
    var errorEl = document.getElementById('login-error');
    var submitBtn = document.getElementById('submit-btn');
    var btnLabel = submitBtn && submitBtn.querySelector('.btn__label');
    if (!form || !emailInput || !passwordInput || !submitBtn) return;

    var defaultLabel = btnLabel ? btnLabel.textContent : 'Sign in';

    function showError(message) {
      errorEl.textContent = message;
      errorEl.hidden = false;
    }

    function clearError() {
      errorEl.textContent = '';
      errorEl.hidden = true;
    }

    function setLoading(loading) {
      submitBtn.disabled = loading;
      if (btnLabel) btnLabel.textContent = loading ? 'Signing in…' : defaultLabel;
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      clearError();

      if (!api || typeof api.login !== 'function') {
        showError(GENERIC_ERROR);
        return;
      }

      var email = emailInput.value.trim();
      var password = passwordInput.value;

      setLoading(true);
      api.login(email, password).then(
        function () {
          // Token is stored by ClaimsubAPI.login on success.
          window.location.assign(APP_URL);
        },
        function () {
          // Any failure (bad credentials, network, etc.) → one generic message.
          setLoading(false);
          showError(GENERIC_ERROR);
        }
      );
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window, document);
