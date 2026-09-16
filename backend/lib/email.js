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
const FROM_ADDRESS = process.env.SES_FROM_ADDRESS || 'notifications@claims.sessionably.com';

// Base URL for building app deep-links (client chart, etc.). The app shell is
// served at reddably.com/app/app.html (Vercel serves the static /public tree),
// so default to reddably.com — matching payment_link.js / invitations.js.
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://claims.sessionably.com').replace(/\/+$/, '');

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

// Compose the "patient submitted their information" admin notification. Intake no
// longer makes a client billable on its own — a clinician confirms on the chart
// ("Save as default") — so this reads as a REVIEW request, not a completion
// receipt. PHI-minimal: the client's name and a link to their chart only — no
// DOB, member ID, or diagnosis. Returns { subject, text, html }.
function buildIntakeCompletionEmail(opts) {
  const o = opts || {};
  const clientName = String(o.clientName || 'A client').trim() || 'A client';
  const completedAt = o.completedAt || new Date().toISOString();
  const chartUrl = o.chartUrl
    || (o.clientId ? `${APP_BASE_URL}/app/app.html#clients/${encodeURIComponent(o.clientId)}` : APP_BASE_URL);

  const subject = `${clientName} submitted their information`;
  const lines = [
    `${clientName} submitted their information and it's ready for your review.`,
    '',
    'Submitted: payment method saved + insurance information provided.',
    `Time: ${completedAt}`,
    '',
    'Nothing is billable yet — open their chart, check the details, and choose',
    '"Save as default" to confirm them for claims.',
    '',
    `Review their chart: ${chartUrl}`,
  ];
  const text = lines.join('\n');
  const html =
    `<p><strong>${escapeHtml(clientName)}</strong> submitted their information ` +
    `and it's ready for your review.</p>` +
    `<p>Submitted: payment method saved + insurance information provided.<br>` +
    `Time: ${escapeHtml(completedAt)}</p>` +
    `<p>Nothing is billable yet — open their chart, check the details, and choose ` +
    `<strong>Save as default</strong> to confirm them for claims.</p>` +
    `<p><a href="${escapeHtml(chartUrl)}">Review their chart</a></p>`;
  return { subject, text, html };
}

// A pragmatic email-format check: one @, a non-empty local part, and a dotted
// domain with a 2+ char TLD. Enough to reject a login username like "BigRedd"
// (which SES rejects with "Missing final '@domain'") without a dependency. The
// recipient resolver and the practice-settings validator share this.
function isValidEmail(v) {
  if (typeof v !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
}

// Send the intake-completion notification to the practice's configured
// notification email. Never throws: SES not being verified yet (or any transient
// failure) must not fail the patient's intake request. Returns
// { sent: boolean, error?: string }.
//
// The recipient MUST be a real email address. A missing or malformed value (for
// example a login username like "BigRedd") is never handed to SES — we skip the
// send and log so it's diagnosable, instead of attempting a send SES rejects.
async function sendIntakeCompletionEmail(opts, deps) {
  const o = opts || {};
  if (!isValidEmail(o.to)) {
    console.warn('email: notification email not configured');
    return { sent: false, error: 'notification email not configured' };
  }
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

// Human-readable role label for the invite copy ('clinician' -> 'Clinician').
function humanizeRole(role) {
  var known = {
    practice_admin: 'Practice Admin',
    clinician: 'Clinician',
    billing_staff: 'Billing Staff',
  };
  return known[role] || '';
}

// Compose the "join a practice" invitation email. PHI-FREE by construction: the
// practice name, the invited person's role, an optional greeting name (staff, not
// a patient), and the single-use accept link — nothing else. Returns
// { subject, text, html }.
function buildInvitationEmail(opts) {
  const o = opts || {};
  // Fallback when the caller has no practice name. Deliberately generic: the
  // subject already ends "... on Reddably", so naming the product here too
  // reads as a stutter ("join a Reddably practice on Reddably").
  const practiceName = String(o.practiceName || '').trim() || 'a practice';
  const inviteUrl = String(o.inviteUrl || '').trim();
  const roleLabel = humanizeRole(o.role);
  const invitedName = o.invitedName ? String(o.invitedName).trim() : '';
  const greeting = invitedName ? `Hi ${invitedName},` : 'Hi,';
  const asRole = roleLabel ? ` as a ${roleLabel}` : '';

  const subject = `You're invited to join ${practiceName} on Reddably`;
  const lines = [
    greeting,
    '',
    `You've been invited to join ${practiceName} on Reddably${asRole}.`,
    '',
    'Accept your invitation and set a password:',
    inviteUrl,
    '',
    "This link is single-use and expires soon. If you weren't expecting this, " +
      'you can safely ignore this email.',
  ];
  const text = lines.join('\n');
  const html =
    `<p>${escapeHtml(greeting)}</p>` +
    `<p>You've been invited to join <strong>${escapeHtml(practiceName)}</strong> ` +
    `on Reddably${asRole ? ' as a ' + escapeHtml(roleLabel) : ''}.</p>` +
    `<p><a href="${escapeHtml(inviteUrl)}">Accept your invitation and set a password</a></p>` +
    `<p>This link is single-use and expires soon. If you weren't expecting this, ` +
    `you can safely ignore this email.</p>`;
  return { subject, text, html };
}

// Send the clinician invitation. Never throws: SES not being verified yet (sandbox)
// or any transient failure must NOT fail the admin's create-invite request — the
// shareable link is still returned so they can send it manually. Returns
// { sent: boolean, error?: string }. The recipient MUST be a real email address.
async function sendInvitationEmail(opts, deps) {
  const o = opts || {};
  if (!isValidEmail(o.to)) {
    console.warn('email: invitation recipient is not a valid email');
    return { sent: false, error: 'invalid recipient' };
  }
  try {
    const content = buildInvitationEmail(o);
    await sendEmail(
      { to: o.to, from: o.from, subject: content.subject, text: content.text, html: content.html },
      deps
    );
    return { sent: true };
  } catch (err) {
    // Log only the message — never the recipient or the token.
    console.warn('email: invitation send failed:', err && err.message);
    return { sent: false, error: (err && err.message) || 'send failed' };
  }
}

// Compose the "finish your details" patient reminder.
//
// THIS ONE GOES TO A PATIENT, so the PHI ceiling in this file's header is not a
// style note — it is the rule. The message carries a first name, the practice's
// name, and a link. It does NOT say why the practice is asking, name a payer or
// a plan, mention a diagnosis, a session, a claim, or an amount, and it never
// says the words "out of network" or "insurance claim" in the SUBJECT — an
// email subject line is visible on a lock screen to anyone holding the phone.
//
// `practiceName` is the practice the patient already knows they see, so naming
// it is what makes the mail recognisable rather than phishy. Returns
// { subject, text, html }.
function buildIntakeReminderEmail(opts) {
  const o = opts || {};
  const practiceName = String(o.practiceName || '').trim() || 'your provider';
  const setupUrl = String(o.setupUrl || '').trim();
  const firstName = o.firstName ? String(o.firstName).trim() : '';
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';

  const subject = `Finish your details for ${practiceName}`;
  const lines = [
    greeting,
    '',
    `${practiceName} sent you a short form to complete, and it looks like a few ` +
      'details are still missing.',
    '',
    'It takes a couple of minutes:',
    setupUrl,
    '',
    'This link expires in 24 hours. If you have already completed the form, or ' +
      "you weren't expecting this, you can ignore this message.",
    '',
    `Questions? Reply to ${practiceName} directly — this address is not monitored.`,
  ];
  const text = lines.join('\n');
  const html =
    `<p>${escapeHtml(greeting)}</p>` +
    `<p><strong>${escapeHtml(practiceName)}</strong> sent you a short form to ` +
    `complete, and it looks like a few details are still missing.</p>` +
    `<p><a href="${escapeHtml(setupUrl)}">Finish the form</a> — it takes a couple ` +
    `of minutes.</p>` +
    `<p>This link expires in 24 hours. If you have already completed the form, or ` +
    `you weren't expecting this, you can ignore this message.</p>` +
    `<p>Questions? Reply to ${escapeHtml(practiceName)} directly — this address is ` +
    `not monitored.</p>`;
  return { subject, text, html };
}

// Send the patient reminder. NEVER THROWS: one patient's bad address or a
// transient SES failure must not end a scheduled run that is working through
// many patients. Returns { sent: boolean, error?: string }.
//
// The caller records "we asked" ONLY on { sent: true } — a reminder that never
// left must not burn the single send this patient gets.
async function sendIntakeReminderEmail(opts, deps) {
  const o = opts || {};
  if (!isValidEmail(o.to)) {
    // Never log the address itself.
    console.warn('email: intake reminder recipient is not a valid email');
    return { sent: false, error: 'invalid recipient' };
  }
  try {
    const content = buildIntakeReminderEmail(o);
    await sendEmail(
      { to: o.to, from: o.from, subject: content.subject, text: content.text, html: content.html },
      deps
    );
    return { sent: true };
  } catch (err) {
    // The message only — never the recipient, the name, or the token in the URL.
    console.warn('email: intake reminder send failed:', err && err.message);
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
  isValidEmail,
  humanizeRole,
  buildSendEmailInput,
  sendEmail,
  buildIntakeCompletionEmail,
  sendIntakeCompletionEmail,
  buildInvitationEmail,
  sendInvitationEmail,
  buildIntakeReminderEmail,
  sendIntakeReminderEmail,
};
