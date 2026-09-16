'use strict';

// Scheduled insurance-details reminder (reddably-<env>-insurance-reminder).
//
// WHAT IT IS FOR. Staff text a patient an intake link and we record the moment on
// clients.payment_link_sent_at. Nothing then watches whether the patient actually
// finished. A client who never fills the form just sits there, and the first
// anyone notices is a claim that will not submit ("Attach an insurance record
// before submitting") — which surfaces days later, on the biller's screen rather
// than the patient's. This closes that loop: 24 hours after the link went out, a
// patient whose insurance details are still missing gets ONE email with a fresh
// link.
//
// ONE EMAIL, THEN IT STOPS. clients.insurance_reminder_sent_at is stamped on a
// successful send and the query excludes anyone who has one. A daily job with no
// such guard would mail the same person every day for as long as the form stays
// blank, and a patient who marks that as spam damages the SES domain reputation
// every other notification in this product depends on. Staff can still send a
// link by hand at any time; this is the automatic nudge, and it fires once.
//
// DRY RUN BY DEFAULT, AND THE SCHEDULE IS OFF BY DEFAULT. This is unattended
// outbound mail to PATIENTS across every practice on the platform — the least
// reversible thing in this codebase short of moving money. A dry run resolves who
// WOULD be emailed and logs the count, mints no token, sends nothing, and writes
// nothing. Read one run's output, then set INSURANCE_REMINDER_DRY_RUN=false. The
// EventBridge rule is separately disabled (infra/terraform/insurance-reminder.tf)
// so this does not run at all until somebody turns it on.
//
// WHAT COUNTS AS "NOT DONE" is not redefined here. It is read live from the chart
// with the same rule handlers/card_setup.js applies (intakeCompleteness): a
// primary, non-hidden insurance record carrying carrier_name, member_id AND
// payer_id. A second, subtly different definition of "complete" would eventually
// disagree with the chart, and the patient would be chased for something they had
// already done.
//
// PHI: this job touches many practices' patients. It logs COUNTS and client ids,
// never names, email addresses, member ids, or the token in the link.

const db = require('../lib/db');
const paymentToken = require('../lib/payment_token');
const email = require('../lib/email');
const { audit } = require('../lib/audit');

// The patient lands on the Vercel-served card-setup page — the same origin
// payment_link.js builds, for the same reason (the page and the /api functions it
// calls must be same-origin).
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://claims.sessionably.com').replace(/\/+$/, '');

function intEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Dry run unless explicitly disabled. Only "false" — trimmed and case-folded,
// matching handlers/claim_status_poll.js so the two safety switches behave
// identically — arms it. Anything unset, misspelled or empty means DRY: the safe
// reading of an ambiguous configuration is the one that sends no mail.
function isDryRun() {
  return String(process.env.INSURANCE_REMINDER_DRY_RUN || 'true').trim().toLowerCase() !== 'false';
}

// Secrets at runtime from SSM, like handlers/claim_status_poll.js — this Lambda is
// not one of the API functions deploy.sh hydrates, so it hydrates itself. The
// JWT secret is needed to mint the card-setup token. Never logged.
async function hydrateFromSsm() {
  const wanted = [
    ['DATABASE_URL', process.env.DATABASE_URL_SSM_PARAM],
    ['JWT_SECRET', process.env.JWT_SECRET_SSM_PARAM],
  ];
  const missing = wanted.filter(([envName, paramName]) => paramName && !process.env[envName]);

  if (missing.length) {
    // @aws-sdk/client-ssm ships with the Node 20 runtime and is deliberately
    // absent from package.json, so this require must stay lazy — a top-level one
    // would make the module unloadable in its own tests.
    // eslint-disable-next-line global-require
    const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
    const ssm = new SSMClient({});
    for (const [envName, paramName] of missing) {
      try {
        const out = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
        const value = out && out.Parameter && out.Parameter.Value;
        if (value) process.env[envName] = value;
      } catch (err) {
        // Name the PARAMETER, never the value, and never the error's own text.
        console.error(`insurance reminder: could not read SSM parameter ${envName}`);
      }
    }
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('insurance reminder: DATABASE_URL is not available');
  }
}

// Who to remind.
//
// Every clause is a reason NOT to email somebody, which is the right way round
// for a job whose failure mode is mailing a patient who should not have been
// mailed:
//
//   * asked at least `minAgeHours` ago      — the 24h the reminder is named for
//   * never reminded before                 — one email, then silence
//   * has an email address                  — nothing to send to otherwise
//   * client not hidden, practice active    — a deleted client is not chased
//   * insurance still incomplete            — the live chart rule, below
//
// The insurance test mirrors card_setup.js intakeCompleteness's insurance_ok
// exactly: a PRIMARY, non-hidden record carrying carrier_name, member_id and
// payer_id. Demographics (DOB, address) are deliberately NOT part of it — this
// reminder is about insurance details, and chasing someone for a missing ZIP
// under a subject line about insurance would be the wrong message.
async function selectCandidates({ maxClients, minAgeHours }) {
  const res = await db.query(
    `select c.id,
            c.practice_id,
            c.first_name,
            c.preferred_name,
            c.email,
            p.name as practice_name
       from clients c
       join practices p on p.id = c.practice_id
      where c.is_hidden = false
        and p.is_active = true
        and c.email is not null
        and btrim(c.email) <> ''
        and c.payment_link_sent_at is not null
        and c.payment_link_sent_at < now() - ($1 || ' hours')::interval
        and c.insurance_reminder_sent_at is null
        and not exists (
              select 1
                from insurance_records i
               where i.client_id = c.id
                 and i.is_primary = true
                 and i.is_hidden = false
                 and nullif(btrim(i.carrier_name), '') is not null
                 and nullif(btrim(i.member_id), '') is not null
                 and nullif(btrim(i.payer_id), '') is not null
            )
      order by c.payment_link_sent_at asc
      limit $2`,
    [String(minAgeHours), maxClients]
  );
  return res.rows;
}

// Stamp "we asked". CONDITIONAL on the column still being null, so two overlapping
// runs cannot both send — whichever updates first wins, and the loser sees
// rowCount 0. Called only after SES has accepted the message.
async function markReminded(clientId) {
  const res = await db.query(
    `update clients
        set insurance_reminder_sent_at = now()
      where id = $1 and insurance_reminder_sent_at is null`,
    [clientId]
  );
  return res.rowCount > 0;
}

exports.handler = async () => {
  const dryRun = isDryRun();
  const maxClients = intEnv('INSURANCE_REMINDER_MAX_CLIENTS', 200);
  const minAgeHours = intEnv('INSURANCE_REMINDER_MIN_AGE_HOURS', 24);

  await hydrateFromSsm();

  const summary = {
    dry_run: dryRun,
    candidates: 0,
    sent: 0,
    would_send: 0,
    failed: 0,
    skipped_no_token: 0,
  };

  let clients;
  try {
    clients = await selectCandidates({ maxClients, minAgeHours });
  } catch (err) {
    console.error('insurance reminder: candidate query failed');
    return { ok: false, message: 'candidate query failed', summary };
  }
  summary.candidates = clients.length;

  for (const client of clients) {
    if (dryRun) {
      // The id only. A dry run exists to let somebody read WHO would be mailed
      // without mailing them — an id is enough to look one up on the chart, and
      // a name or address in a CloudWatch log is PHI in a place it must not be.
      summary.would_send += 1;
      console.log(`insurance reminder [DRY]: would email client=${client.id}`);
      continue;
    }

    // A FRESH token every time. The original link in the SMS has a 24h expiry
    // (lib/payment_token), so by the moment this job runs it has expired or is
    // about to — re-sending it would send the patient to a dead page, which is a
    // worse outcome than not reminding them at all.
    let setupUrl;
    try {
      setupUrl = `${APP_BASE_URL}/card-setup?token=${encodeURIComponent(paymentToken.sign(client.id))}`;
    } catch (err) {
      // JWT_SECRET missing — every client will fail the same way, so stop rather
      // than looping. Never log the error's text; it can echo configuration.
      summary.skipped_no_token += 1;
      console.error('insurance reminder: could not mint a card-setup token — aborting run');
      break;
    }

    const result = await email.sendInsuranceReminderEmail({
      to: client.email,
      firstName: client.preferred_name || client.first_name,
      practiceName: client.practice_name,
      setupUrl,
    });

    if (!result.sent) {
      // Deliberately NOT stamped: a reminder that never left must not burn the
      // single send this patient gets. The next run will try again.
      summary.failed += 1;
      console.warn(`insurance reminder: send failed for client=${client.id}`);
      continue;
    }

    // Stamp only AFTER SES accepted it. The other order — stamp, then send —
    // loses the reminder entirely if the send throws.
    try {
      await markReminded(client.id);
    } catch (err) {
      // Sent but not recorded. Say so loudly: the next run will see a null column
      // and email this patient a second time, which is exactly what this job
      // promises not to do.
      console.error(
        `insurance reminder: SENT but could not record for client=${client.id} — ` +
        'this patient may be emailed again on the next run'
      );
    }

    summary.sent += 1;

    // No user did this. audit_log models that as a system actor. Ids only — the
    // action name already says what kind of message it was.
    await audit(null, { actorType: 'system', practiceId: client.practice_id }, {
      action: 'client.insurance_reminder_sent',
      resourceType: 'client',
      resourceId: client.id,
    });
  }

  console.log(`insurance reminder: ${JSON.stringify(summary)}`);
  return { ok: true, summary };
};

// Exported for unit tests — the pure configuration reads, so the dry-run default
// and the env parsing can be asserted without invoking the handler.
exports.isDryRun = isDryRun;
exports.intEnv = intEnv;
