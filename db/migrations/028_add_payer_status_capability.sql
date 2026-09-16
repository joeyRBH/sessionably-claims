-- 028: remember which payers refuse an automated claim-status check.
--
-- WHY
--
-- The adapter can already tell the two 4xx kinds apart (lib/clearinghouse/stedi.js
-- statusErrorKind): INVALID_REQUEST_BODY is OUR bug, BAD_REQUEST is the payer
-- refusing on the merits — most commonly "payer not configured", i.e. it does not
-- support 276 status inquiries at all. The Refresh button uses that distinction
-- and answers 422 with something a biller can act on.
--
-- Nothing REMEMBERS it. Every caller rediscovers the same refusal from scratch:
--
--   * the scheduled poller (handlers/claim_status_poll.js) re-asks the same
--     hopeless payer every 6 hours, forever, burning clearinghouse calls and
--     filling its error count with permanent non-events — which would bury the
--     real errors in exactly the dry run that exists to be read;
--   * a biller keeps clicking Refresh on a claim that can never answer.
--
-- WHAT IT IS
--
-- One row per (practice, payer) recording whether that payer answered a status
-- inquiry, when we last found out, and the clearinghouse's own non-PHI error
-- code. It is a CACHE OF AN OBSERVATION, not a configuration switch: no human
-- sets it, and it is corrected by the next successful probe.
--
-- SCOPED PER PRACTICE, ON PURPOSE. Refusal can depend on the practice's own
-- trading-partner setup, so a global flag would let one practice's data problem
-- silently stop denial detection — and therefore fee refunds — for every other
-- practice on that payer. Costs some duplicate probes; worth it.
--
-- SELF-HEALING. A refusal is honoured for 30 days (lib/payer_capability.js
-- REPROBE_AFTER_DAYS), then probed once more. Clearinghouses add payers; a
-- permanent blocklist would go stale silently and nothing would ever say so.
--
-- NOT PHI. practice, payer id, a boolean, timestamps, and a vendor error code.
-- No patient, no claim, no member id. The payer id is trading-partner data,
-- already present on insurance_records.
--
-- DEPLOY ORDER
--
-- Purely additive: a new table nothing reads until the handler change ships.
-- Safe to apply before or with it. Folded into db/schema.sql, so the migrate
-- Lambda applies it on the ordinary deploy.

begin;

create table if not exists payer_status_capability (
  id                    uuid primary key default gen_random_uuid(),
  practice_id           uuid not null references practices (id) on delete restrict,
  payer_id              text not null,
  supports_claim_status boolean not null,
  last_probed_at        timestamptz not null default now(),
  last_error_code       text,
  consecutive_refusals  integer not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (practice_id, payer_id)
);

comment on table payer_status_capability is
  'Cache of an observation: whether a payer answered a 276 claim-status inquiry for this practice. Written only by a real probe result, never by a human. Refusals expire (see lib/payer_capability.js) so a clearinghouse adding a payer heals itself. No PHI.';
comment on column payer_status_capability.supports_claim_status is
  'false = the payer refused the inquiry on its merits (clearinghouse BAD_REQUEST). true = it answered. Corrected by the next probe.';
comment on column payer_status_capability.last_error_code is
  'The clearinghouse''s own error code (e.g. BAD_REQUEST). Vendor vocabulary, non-PHI; white-labeled before any display.';

-- The poller's hot path: "which payers should I skip right now". Partial, over
-- refusals only — a payer that answers is never looked up to be excluded.
create index if not exists idx_payer_status_capability_unsupported
  on payer_status_capability (practice_id, payer_id, last_probed_at)
  where supports_claim_status = false;

drop trigger if exists trg_payer_status_capability_updated_at on payer_status_capability;
create trigger trg_payer_status_capability_updated_at
  before update on payer_status_capability
  for each row execute function set_updated_at();

commit;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--
--   select count(*) from payer_status_capability;
--   ^^ MUST be 0 immediately after applying — only a real probe writes a row.
--
--   select indexname from pg_indexes
--    where tablename = 'payer_status_capability';
--   ^^ MUST list the primary key, the unique (practice_id, payer_id) constraint
--      index, and idx_payer_status_capability_unsupported.
--
-- After the poller has run once (dry is fine — it records capability):
--
--   select supports_claim_status, count(*) from payer_status_capability
--    group by 1;
--   ^^ this is the answer to "how many payers can we actually poll", which is
--      what decides whether the scheduled poll is a viable denial-detection path
--      at all.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
--
--   drop table if exists payer_status_capability;
--
-- Safe. Losing it costs only re-learning: every caller falls back to probing,
-- which is exactly today's behaviour. Revert the handler change first, or the
-- poller's skip query will error on a missing table.
