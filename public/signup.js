/* Reddably — signup page behavior.
 *
 * All network calls go through window.ReddablyAPI (public/js/api-client.js);
 * this page never calls fetch() directly.
 *
 *   1. If already authenticated, redirect straight to the app.
 *   2. On submit, call ReddablyAPI.register() in new_practice mode; show a
 *      loading state; on success the token is stored by the API client and we
 *      redirect to the app; on failure show the API's error message inline and
 *      re-enable the form.
 */
(function (window, document) {
  'use strict';

  var APP_URL = './app/app.html';
  var GENERIC_ERROR = 'Could not create your account. Please try again.';

  var api = window.ReddablyAPI;

  // Already signed in? Skip the form.
  if (api && api.isAuthenticated && api.isAuthenticated()) {
    window.location.replace(APP_URL);
    return;
  }

  function init() {
    var form = document.getElementById('signup-form');
    var errorEl = document.getElementById('signup-error');
    var submitBtn = document.getElementById('submit-btn');
    var btnLabel = submitBtn && submitBtn.querySelector('.btn__label');
    if (!form || !submitBtn) return;

    var fields = {
      first_name: document.getElementById('first_name'),
      last_name: document.getElementById('last_name'),
      email: document.getElementById('email'),
      password: document.getElementById('password'),
      practice_name: document.getElementById('practice_name'),
    };

    var defaultLabel = btnLabel ? btnLabel.textContent : 'Create practice';

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
      if (btnLabel) btnLabel.textContent = loading ? 'Creating practice…' : defaultLabel;
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      clearError();

      if (!api || typeof api.register !== 'function') {
        showError(GENERIC_ERROR);
        return;
      }

      var payload = {
        mode: 'new_practice',
        first_name: fields.first_name.value.trim(),
        last_name: fields.last_name.value.trim(),
        email: fields.email.value.trim(),
        password: fields.password.value,
        practice_name: fields.practice_name.value.trim(),
      };

      setLoading(true);
      api.register(payload).then(
        function () {
          // Token is stored by ReddablyAPI.register on success.
          window.location.assign(APP_URL);
        },
        function (err) {
          // Surface the API's error message inline; fall back to a generic one.
          setLoading(false);
          showError((err && err.message) || GENERIC_ERROR);
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
