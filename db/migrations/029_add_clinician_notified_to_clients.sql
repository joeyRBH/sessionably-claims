-- 029: record when the primary clinician was told a client finished intake.
--
-- WHY
--
-- A client's primary clinician is emailed once the client has BOTH an insurance
-- record and a saved card (backend/handlers/card_setup.js,
-- notifyClinicianIfComplete). The patient can finish the two steps in either
-- order and can re-open the link and re-submit either one, so the handler needs a
-- durable "already told them" marker. It claims this column with a single
-- UPDATE ... WHERE clinician_intake_notified_at IS NULL, so concurrent requests
-- and repeat submissions cannot send a second email. A send that fails releases
-- the claim (sets it back to NULL) so a later step can retry.
--
-- WHAT IT IS NOT
--
-- Not PHI: a timestamp about our own outreach to staff. Not a completion signal:
-- whether intake is complete is read live from the chart.
--
-- DEPLOY ORDER
--
-- Purely additive: one nullable column, no default, no constraint, no backfill.
-- Apply BEFORE the handler ships (the handler's notification query names the
-- column; without it that query errors and is swallowed, so intake itself keeps
-- working but no clinician email is sent). Folded into db/schema.sql, so the
-- migrate Lambda applies it on the ordinary deploy — migrate function first, per
-- the CLAUDE.md deploy-ordering section.

begin;

alter table clients
  add column if not exists clinician_intake_notified_at timestamptz;

comment on column clients.clinician_intake_notified_at is
  'When the primary clinician was emailed that this client finished insurance + payment. NULL means not yet. Claimed atomically so it sends once. Not PHI.';

commit;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--
--   select count(*) from clients where clinician_intake_notified_at is not null;
--   ^^ MUST be 0 immediately after applying — nothing has notified anyone yet.
--
--   select count(*) from information_schema.columns
--    where table_name = 'clients' and column_name = 'clinician_intake_notified_at';
--   ^^ MUST be 1.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
--
--   alter table clients drop column if exists clinician_intake_notified_at;
--
-- Safe at any time: the handler swallows the resulting query error, so intake
-- keeps working and only the clinician email stops.
