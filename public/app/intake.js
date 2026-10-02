/* =============================================================================
 * Reddably — Client intake state (window.Reddably.intake)
 * =============================================================================
 * ONE definition of where a client is in the patient-intake flow, shared by the
 * Clients list (the Intake column) and the Dashboard ("New intakes to review"), so
 * the two can never disagree about who is waiting.
 *
 * Derived entirely from fields the clients LIST already returns — no extra request:
 *
 *   payment_link_sent_at   staff texted the payment link
 *   payment_method_last4   a card is on file (the patient saved one)
 *   has_insurance          a usable primary insurance record is on file
 *   status                 awaiting_info until a clinician confirms on the chart
 *
 *   state          meaning
 *   -------------  -----------------------------------------------------------
 *   link_sent      link sent, the patient has not finished card + insurance yet
 *   needs_review   card AND insurance are on file, a clinician has not confirmed
 *   completed      card AND insurance are on file and the clinician confirmed
 *   null           nothing to show (no link sent, or an inactive client)
 *
 * Tones follow the design system: waiting is neutral/stone, "needs review" uses the
 * (deliberately stone) warning badge, and sage is earned only by `completed`.
 * ========================================================================== */
(function (window) {
  'use strict';

  var R = window.Reddably;
  if (!R) return;

  var LABELS = {
    link_sent: 'Link sent',
    needs_review: 'Needs review',
    completed: 'Completed',
  };
  var TONES = {
    link_sent: 'neutral',
    needs_review: 'warning',
    completed: 'success',
  };

  function state(client) {
    if (!client || client.status === 'inactive') return null;
    var hasCard = !!(client.payment_method_last4 && String(client.payment_method_last4).trim());
    var hasInsurance = client.has_insurance === true;
    if (hasCard && hasInsurance) {
      return client.status === 'active' ? 'completed' : 'needs_review';
    }
    if (client.payment_link_sent_at) return 'link_sent';
    return null;
  }

  function isNeedsReview(client) {
    return state(client) === 'needs_review';
  }

  R.intake = {
    LABELS: LABELS,
    TONES: TONES,
    state: state,
    label: function (client) { var s = state(client); return s ? LABELS[s] : ''; },
    isNeedsReview: isNeedsReview,
  };
})(window);
