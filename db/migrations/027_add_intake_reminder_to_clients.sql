-- 027: record when a patient was reminded to finish their intake.
--
-- WHY
--
-- Staff text a patient an intake link and record the moment on
-- clients.payment_link_sent_at. Nothing then watches whether the patient
-- actually finished. A client who never fills the form simply sits there, and
-- the first anyone notices is a claim that will not submit ("Attach an insurance
-- record before submitting") — which surfaces on the biller's screen, days
-- later, not the patient's.
--
-- The scheduled reminder (backend/handlers/intake_reminder.js) closes that
-- gap: 24 hours after the link went out, a patient whose intake is still
-- incomplete gets ONE email with a fresh link.
--
-- ONE email. That is the entire reason this column exists. Without a record of
-- having sent, a daily job re-sends every single day to the same person for as
-- long as the form stays blank — and a patient who marks that as spam damages
-- the SES domain reputation that every other notification depends on. The job
-- reads this column as its own "already asked" guard.
--
-- WHAT IT IS NOT
--
-- Not PHI. It is a timestamp about OUR outreach, carrying no name, contact
-- detail, or clinical content.
--
-- Not a completion signal. It says we asked, never that the patient answered —
-- whether the intake is complete is read live from the chart (the same rule
-- card_setup.js's intakeCompleteness applies), so this column can never drift
-- out of agreement with what the patient actually filled in.
--
-- DEPLOY ORDER
--
-- Purely additive and inert: one nullable column, no default, no constraint, no
-- backfill. Nothing currently reads or writes it, so it is safe to apply BEFORE
-- the handler ships, and the handler is a no-op until its EventBridge schedule
-- is enabled (disabled by default — infra/terraform/intake-reminder.tf).
-- Folded into db/schema.sql, so the migrate Lambda applies it on the ordinary
-- deploy; no one-off runner needed.

begin;

alter table clients
  add column if not exists intake_reminder_sent_at timestamptz;

comment on column clients.intake_reminder_sent_at is
  'When the automatic "finish your details" email was sent to this patient. NULL means never. Set once — the scheduled reminder sends one email and stops. Not PHI: a timestamp about our own outreach.';

-- Partial, and deliberately so: the job looks for clients it has NOT yet
-- emailed, so the useful index is over the rows still awaiting one. An already
-- reminded client never appears in that query again and has no business sitting
-- in the index it probes.
create index if not exists idx_clients_awaiting_intake_reminder
  on clients (practice_id, payment_link_sent_at)
  where intake_reminder_sent_at is null
    and payment_link_sent_at is not null
    and is_hidden = false;

commit;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--
--   select count(*) from clients where intake_reminder_sent_at is not null;
--   ^^ MUST be 0 immediately after applying — nothing has sent a reminder yet.
--
--   select count(*) from information_schema.columns
--    where table_name = 'clients' and column_name = 'intake_reminder_sent_at';
--   ^^ MUST be 1.
--
--   select indexname from pg_indexes
--    where tablename = 'clients' and indexname = 'idx_clients_awaiting_intake_reminder';
--   ^^ MUST return exactly one row.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
--
--   drop index if exists idx_clients_awaiting_intake_reminder;
--   alter table clients drop column if exists intake_reminder_sent_at;
--
-- Safe ONLY while the reminder schedule is disabled. With the job live, dropping
-- this column removes the "already asked" guard, and the next run emails every
-- matching patient again — including everyone already reminded. Disable the
-- EventBridge rule first (intake_reminder_enabled = false), then drop.
