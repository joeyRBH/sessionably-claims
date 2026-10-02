-- 031: record when the PRACTICE was emailed that this client finished intake.
--
-- WHY
--
-- The "client submitted their information" alert to the practice's notification
-- address used to fire on every save-insurance call, so a patient who re-opened
-- the link and re-submitted (or fixed a typo) emailed the practice again each
-- time. It now sends once per client. The handler
-- (backend/handlers/card_setup.js, notifyPracticeIfComplete) claims this column
-- with a single UPDATE ... WHERE practice_intake_notified_at IS NULL, exactly like
-- clinician_intake_notified_at (migration 029), so concurrent requests and repeat
-- submissions cannot send a second email. A send that fails releases the claim.
--
-- WHAT IT IS NOT
--
-- Not PHI: a timestamp about our own outreach to staff. Not a completion signal:
-- whether intake is complete is read live from the chart. It is also set (without
-- a send) when the practice address is the same inbox the clinician already
-- received the alert at, so one person is not emailed twice.
--
-- DEPLOY ORDER
--
-- Purely additive: one nullable column, no default, no constraint, no backfill.
-- Folded into db/schema.sql, so the migrate Lambda applies it on the ordinary
-- deploy. Apply the migrate function BEFORE the API handlers (CLAUDE.md deploy
-- ordering): without the column the handler's notification query errors and is
-- swallowed, so intake keeps working but no practice email is sent.

begin;

alter table clients
  add column if not exists practice_intake_notified_at timestamptz;

comment on column clients.practice_intake_notified_at is
  'When the practice notification address was emailed that this client finished insurance + payment. NULL means not yet. Claimed atomically so it sends once. Not PHI.';

commit;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--
--   select count(*) from clients where practice_intake_notified_at is not null;
--   ^^ MUST be 0 immediately after applying — nothing has notified anyone yet.
--
--   select count(*) from information_schema.columns
--    where table_name = 'clients' and column_name = 'practice_intake_notified_at';
--   ^^ MUST be 1.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
--
--   alter table clients drop column if exists practice_intake_notified_at;
--
-- Safe at any time: the handler swallows the resulting query error, so intake
-- keeps working and only the practice email stops.
