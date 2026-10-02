-- 030: practice-wide session defaults.
--
-- WHY
--
-- Per-client billing defaults (migration 021) exist, but a practice that bills
-- 90837 at one rate in one place of service had nowhere to say so once. These columns
-- hold the practice's own standard values. They are NOT copied onto clients: a blank
-- client default means "inherit", resolved when a session is created
-- (backend/lib/billing_fields.js applyClientDefaults: request > client > practice),
-- so changing the practice default later reaches every client who never set their
-- own. default_session_duration_minutes is practice-level only; it is used for a
-- manual session that arrives with no duration.
--
-- WHAT IT IS NOT
--
-- Not a claim-behavior change: the fee path (5% platform fee), claim grouping and
-- claim submission read the SESSION's own columns, exactly as before. A default is
-- a starting value copied onto a new session, never a floor.
--
-- DEPLOY ORDER
--
-- Purely additive: five nullable columns, no default, no backfill. Folded into
-- db/schema.sql, so the migrate Lambda applies it on the ordinary deploy. Apply
-- the migrate function BEFORE the API handlers (CLAUDE.md deploy ordering): the
-- practice handler and the session/client create paths select these columns.

begin;

alter table practices add column if not exists default_cpt_code text;
alter table practices add column if not exists default_place_of_service text;
alter table practices add column if not exists default_session_fee numeric(12,2);
alter table practices add column if not exists default_procedure_modifiers text[];
alter table practices add column if not exists default_session_duration_minutes integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'practices_default_duration_check'
  ) then
    alter table practices add constraint practices_default_duration_check
      check (default_session_duration_minutes is null or default_session_duration_minutes > 0);
  end if;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--
--   select count(*) from information_schema.columns
--    where table_name = 'practices' and column_name in
--      ('default_cpt_code', 'default_place_of_service', 'default_session_fee',
--       'default_procedure_modifiers', 'default_session_duration_minutes');
--   ^^ MUST be 5.
--
--   select count(*) from practices where default_cpt_code is not null;
--   ^^ MUST be 0 immediately after applying — nobody has set a default yet.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
--
--   alter table practices drop constraint if exists practices_default_duration_check;
--   alter table practices drop column if exists default_cpt_code,
--     drop column if exists default_place_of_service,
--     drop column if exists default_session_fee,
--     drop column if exists default_procedure_modifiers,
--     drop column if exists default_session_duration_minutes;
--
-- Safe at any time before the handlers ship; afterwards the practice handler's
-- `select *` simply stops returning the keys and new clients start blank again.
