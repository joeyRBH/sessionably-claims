'use strict';

// Shared email helper — wraps AWS SES SendEmail (AWS SDK v3) so any handler can
// send a transactional notification. Kept small and dependency-injectable so it
// unit-tests without touching the network or the SDK.
//
// @aws-sdk/client-ses is provided by the Node 20 Lambda runtime, so it is NOT a
// package.json dependency (the deploy zip stays lean) — required lazily below.
//
// Sending requires the SES domain identity (reddably.com) to be verified and the
// Lambda role to hold ses:SendEmail on that identity (see infra/terraform/ses.tf
// + iam.tf). Until DNS verifies the domain, SendEmail throws — callers MUST treat
// a send failure as non-fatal (log a warning, never fail the user's request).
//
// PHI: keep message bodies minimal. Never put DOB, member IDs, or diagnoses in an
// email; a name plus an app link is the ceiling.

// FROM address for all notifications. Overridable via env for non-prod, but the
// default is baked in so a fresh deploy works without extra env hydration (the
// Lambda `environment` block is ignore_changes — see lambda.tf).
const FROM_ADDRESS = process.env.SES_FROM_ADDRESS || 'notifications@reddably.com';

// Base URL for building app deep-links (client chart, etc.). app.reddably.com is
// the app shell host.
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://app.reddably.com').replace(/\/+$/, '');

// Build the SES SendEmail input from a simple { to, subject, text, html } shape.
// Pure — no I/O — so tests can assert on Source / Destination / body directly.
function buildSendEmailInput(opts) {
  const o = opts || {};
  const to = Array.isArray(o.to) ? o.to : [o.to];
  const body = {};
  if (o.text != null) body.Text = { Data: String(o.text), Charset: 'UTF-8' };
  if (o.html != null) body.Html = { Data: String(o.html), Charset: 'UTF-8' };
  return {
    Source: o.from || FROM_ADDRESS,
    Destination: { ToAddresses: to.filter(Boolean).map(String) },
    Message: {
      Subject: { Data: String(o.subject || ''), Charset: 'UTF-8' },
      Body: body,
    },
  };
}

// Lazily construct (and cache) a real SES client. Region comes from the Lambda
// runtime (AWS_REGION); no explicit config needed.
let cachedClient = null;
function realClient() {
  if (cachedClient) return cachedClient;
  const { SESClient } = require('@aws-sdk/client-ses');
  cachedClient = new SESClient({});
  return cachedClient;
}

// Send an email via SES. `deps` allows unit tests to inject a mocked SES client
// and command class so no network/SDK is exercised:
//   deps.client           — object with async send(command); defaults to realClient()
//   deps.SendEmailCommand — command constructor; defaults to the SDK's
// Throws on failure (SES/network) — callers decide whether that is fatal.
async function sendEmail(opts, deps) {
  deps = deps || {};
  const input = buildSendEmailInput(opts);
  const client = deps.client || realClient();
  const SendEmailCommand =
    deps.SendEmailCommand || require('@aws-sdk/client-ses').SendEmailCommand;
  return client.send(new SendEmailCommand(input));
}

// Compose the "intake completed" admin notification. PHI-minimal: the client's
// name and a link to their chart only — no DOB, member ID, or diagnosis. Returns
// { subject, text, html }.
function buildIntakeCompletionEmail(opts) {
  const o = opts || {};
  const clientName = String(o.clientName || 'A client').trim() || 'A client';
  const completedAt = o.completedAt || new Date().toISOString();
  const chartUrl = o.chartUrl
    || (o.clientId ? `${APP_BASE_URL}/app/#clients/${encodeURIComponent(o.clientId)}` : APP_BASE_URL);

  const subject = `${clientName} completed intake`;
  const lines = [
    `${clientName} has finished the intake flow.`,
    '',
    'Completed: payment method saved + insurance information submitted.',
    `Time: ${completedAt}`,
    '',
    `View their chart: ${chartUrl}`,
  ];
  const text = lines.join('\n');
  const html =
    `<p><strong>${escapeHtml(clientName)}</strong> has finished the intake flow.</p>` +
    `<p>Completed: payment method saved + insurance information submitted.<br>` +
    `Time: ${escapeHtml(completedAt)}</p>` +
    `<p><a href="${escapeHtml(chartUrl)}">View their chart</a></p>`;
  return { subject, text, html };
}

// Send the intake-completion notification to the practice admin. Never throws:
// SES not being verified yet (or any transient failure) must not fail the
// patient's intake request. Returns { sent: boolean, error?: string }.
async function sendIntakeCompletionEmail(opts, deps) {
  const o = opts || {};
  if (!o.to) return { sent: false, error: 'no recipient' };
  try {
    const content = buildIntakeCompletionEmail(o);
    await sendEmail(
      { to: o.to, from: o.from, subject: content.subject, text: content.text, html: content.html },
      deps
    );
    return { sent: true };
  } catch (err) {
    // Log only the message — never the recipient/PHI.
    console.warn('email: intake-completion send failed:', err && err.message);
    return { sent: false, error: (err && err.message) || 'send failed' };
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  FROM_ADDRESS,
  APP_BASE_URL,
  buildSendEmailInput,
  sendEmail,
  buildIntakeCompletionEmail,
  sendIntakeCompletionEmail,
};
