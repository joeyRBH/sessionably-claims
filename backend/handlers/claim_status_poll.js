'use strict';

// Scheduled claim-status poller (reddably-<env>-claim-status-poll).
//
// WHAT IT IS FOR. Nothing watched Stedi. A claim's fate — including a denial the
// fee guarantee promises money back on — was only learned when a staff member
// happened to click Refresh on that particular claim. A practice that stopped
// clicking stopped finding out, and the patient never heard.
//
// DRY RUN BY DEFAULT, AND THAT IS THE POINT.
//
// This runs the denial classifier unattended across a whole practice's claims,
// and an adjudicated denial raises a refund request. The classifier itself is
// derived from Stedi's published 277 shapes, and lib/clearinghouse/stedi.js says
// in its own header that those mappings "should be confirmed against a Stedi
// test account before going live". Until somebody has held a real 277 denial
// next to denialClass() and agreed, automating it would be asserting something
// nobody has checked — about money.
//
// So dry run does the one thing that resolves that, and nothing else:
//
//   * it fetches the real status for real claims;
//   * it STORES the verbatim payload in claim_acknowledgments — which is
//     literally that table's stated purpose ("stored, never acted on... so a
//     later version can learn to recognize denials from real payloads");
//   * it writes NOTHING else. No status change, no claim_event, no refund
//     request. It reports what it WOULD have done and stops.
//
// Run it dry, read the payloads it collects, confirm the classifier, then set
// CLAIM_POLL_DRY_RUN=false. The switch is deliberate, and reversible in one step.
//
// The EventBridge schedule is separately DISABLED by default
// (infra/terraform/claim-status-poll.tf), so this does not run at all until
// somebody turns it on.
//
// PHI: this is a platform-wide job touching many practices' claims. It logs
// COUNTS and claim ids, never names, member ids, diagnoses, or payer text.

const db = require('../lib/db');
const { getClearinghouse } = require('../lib/clearinghouse');
const { buildClaimContext, eventTypeForStatus } = require('../lib/claim_context');
const { logClaimEvent, logClaimAcknowledgment } = require('../lib/claims');
const { applyStatusResult, refundOutcomeCode } = require('../lib/claim_status_apply');
const { audit } = require('../lib/audit');

// Claims still waiting on an answer. Terminal states (paid, void) and drafts are
// never polled — there is nothing left for the payer to tell us.
const OPEN_STATUSES = ['submitted', 'processing', 'info_requested'];

function intEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Dry run unless explicitly and exactly disabled. Anything unset, misspelled or
// empty means DRY — the safe reading of an ambiguous configuration is the one
// that writes nothing.
function isDryRun() {
  return String(process.env.CLAIM_POLL_DRY_RUN || 'true').trim().toLowerCase() !== 'false';
}

// Secrets at runtime from SSM, like handlers/migrate.js — this Lambda is not one
// of the API functions deploy.sh hydrates, so it hydrates itself. Never logged.
async function hydrateFromSsm() {
  const wanted = [
    ['DATABASE_URL', process.env.DATABASE_URL_SSM_PARAM],
    ['STEDI_API_KEY', process.env.STEDI_API_KEY_SSM_PARAM],
    ['CLEARINGHOUSE', process.env.CLEARINGHOUSE_SSM_PARAM],
  ];
  const missing = wanted.filter(([envName, paramName]) => paramName && !process.env[envName]);

  // Nothing to fetch — don't build an SSM client, and don't load the SDK.
  // @aws-sdk/client-ssm is provided by the Node 20 Lambda runtime and is
  // deliberately absent from package.json (see handlers/migrate.js), so a
  // require that always runs would make this module unloadable anywhere else,
  // including in its own tests.
  if (missing.length) {
    // eslint-disable-next-line global-require
    const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
    const ssm = new SSMClient({});
    for (const [envName, paramName] of missing) {
      try {
        const out = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
        const value = out && out.Parameter && out.Parameter.Value;
        if (value) process.env[envName] = value;
      } catch (err) {
        // Name the PARAMETER, never the value, and never the error's own text —
        // an SSM failure can echo the parameter's contents in some modes.
        console.error(`claim status poll: could not read SSM parameter ${envName}`);
      }
    }
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('claim status poll: DATABASE_URL is not available');
  }
}

// Which claims are worth asking about.
//
// The "not asked recently" test reads claim_acknowledgments rather than a new
// last_polled_at column: every status check already writes one of those rows,
// including a dry run, so the record of "we asked" is a fact we already keep.
// One less column, and one less thing that can disagree with reality.
async function selectCandidates({ maxClaims, minAgeHours, recheckHours }) {
  const res = await db.query(
    `select c.*
       from claims c
      where c.is_hidden = false
        and c.control_number is not null
        and c.status = any($1)
        and c.submitted_at is not null
        and c.submitted_at < now() - ($2 || ' hours')::interval
        and not exists (
              select 1 from claim_acknowledgments a
               where a.claim_id = c.id
                 and a.kind = 'status'
                 and a.received_at > now() - ($3 || ' hours')::interval
            )
      order by c.submitted_at asc
      limit $4`,
    [OPEN_STATUSES, String(minAgeHours), String(recheckHours), maxClaims]
  );
  return res.rows;
}

// A dry run still records that we asked, and what came back — that payload is
// the whole reason to run dry. Nothing else is written.
async function recordDryRun(claim, statusResult, adapterName) {
  await db.withTransaction(async (client) => {
    await logClaimAcknowledgment(client, {
      practiceId: claim.practice_id,
      claimId: claim.id,
      source: adapterName,
      kind: 'status',
      controlNumber: claim.control_number,
      payload: statusResult.raw,
    });
  });
}

exports.handler = async () => {
  const dryRun = isDryRun();
  const maxClaims = intEnv('CLAIM_POLL_MAX_CLAIMS', 50);
  const minAgeHours = intEnv('CLAIM_POLL_MIN_AGE_HOURS', 24);
  const recheckHours = intEnv('CLAIM_POLL_RECHECK_HOURS', 24);

  await hydrateFromSsm();

  const adapter = getClearinghouse();
  const summary = {
    dry_run: dryRun,
    adapter: adapter.name,
    checked: 0,
    no_update: 0,
    updated: 0,
    refund_requests_created: 0,
    would_update: 0,
    would_create_refund_request: 0,
    errors: 0,
  };

  let claims;
  try {
    claims = await selectCandidates({ maxClaims, minAgeHours, recheckHours });
  } catch (err) {
    console.error('claim status poll: candidate query failed');
    return { ok: false, message: 'candidate query failed', summary };
  }
  summary.candidates = claims.length;

  for (const claim of claims) {
    summary.checked += 1;
    let status;
    try {
      const ctx = await buildClaimContext(claim.practice_id, claim);
      status = await adapter.getStatus({ control_number: claim.control_number, claim, ctx });
    } catch (err) {
      // One claim's failure must not end the run — the next claim is unrelated.
      // Generic: an adapter error can carry submitted PHI.
      summary.errors += 1;
      console.error(`claim status poll: status check failed for claim ${claim.id}`);
      continue;
    }

    if (!status || status.no_update) {
      summary.no_update += 1;
      continue;
    }

    if (dryRun) {
      // What WOULD have happened, without it happening. The refund line is the
      // one worth reading: it is the classifier's verdict on a real payload.
      const wouldDeny = status.status === 'denied';
      const adjudicated = wouldDeny && status.denial_class === 'adjudicated';
      if (status.status !== claim.status) summary.would_update += 1;
      if (adjudicated) summary.would_create_refund_request += 1;
      console.log(
        `claim status poll [DRY]: claim=${claim.id} ${claim.status} -> ${status.status}` +
        (wouldDeny ? ` denial_class=${status.denial_class || 'unknown'}` : '')
      );
      try {
        await recordDryRun(claim, status, adapter.name);
      } catch (err) {
        summary.errors += 1;
        console.error(`claim status poll: could not store acknowledgment for claim ${claim.id}`);
      }
      continue;
    }

    try {
      const applied = await applyStatusResult(db, {
        practiceId: claim.practice_id,
        claim,
        statusResult: status,
        // No user did this. audit_log and claim_events both model that.
        actor: { actorType: 'system' },
        adapterName: adapter.name,
        note: 'Status updated from payer response (scheduled check).',
        deps: { logEvent: logClaimEvent, logAck: logClaimAcknowledgment, eventTypeForStatus },
      });
      if (!applied.updated) continue;
      if (applied.changed) summary.updated += 1;
      if (applied.autoRefund && applied.autoRefund.created) summary.refund_requests_created += 1;

      await audit(null, { actorType: 'system', practiceId: claim.practice_id }, {
        action: 'claim.status_poll',
        resourceType: 'claim',
        resourceId: claim.id,
        metadata: {
          status: applied.updated.status,
          outcome: applied.changed ? 'updated' : 'no_update',
          refund_request: refundOutcomeCode(applied.autoRefund),
        },
      });
    } catch (err) {
      summary.errors += 1;
      console.error(`claim status poll: apply failed for claim ${claim.id}`);
    }
  }

  console.log('claim status poll summary: ' + JSON.stringify(summary));
  return { ok: true, summary };
};
