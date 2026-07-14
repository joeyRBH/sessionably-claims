-- =============================================================================
-- Retire the unused 'ready' client status.
-- =============================================================================
-- clients.status allowed exactly: 'active' | 'awaiting_info' | 'inactive'.
--
-- 'ready' was a synonym for 'active' that nothing ever set: 'active' already means
-- "ready for claim submission". Keeping both invited a split-brain where half the
-- app treats one as billable and half the other. The patient intake flow now sets
-- the status itself (backend/handlers/card_setup.js) — a client who finishes intake
-- with the demographics + insurance a claim needs is promoted 'awaiting_info' →
-- 'active'; anyone missing something stays 'awaiting_info' so they surface on a
-- follow-up list instead of looking done.
--
-- Order matters: rows must be moved OFF 'ready' BEFORE the CHECK is recreated, or
-- the ALTER ... ADD CONSTRAINT fails validating them. They go to 'awaiting_info',
-- NOT 'active' — 'active' is what makes a client billable, and nobody should become
-- billable as a side effect of a migration. Staff can promote them from the chart.
--
-- Idempotent: safe to re-run. The drop is guarded on the constraint still admitting
-- 'ready', so a second run is a no-op.
--
-- Mirrored in db/schema.sql (§5 clients) — schema.sql is the only path to prod.

update clients set status = 'awaiting_info' where status = 'ready';

do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'clients'::regclass
       and conname = 'clients_status_check'
       and pg_get_constraintdef(oid) like '%ready%'
  ) then
    alter table clients drop constraint clients_status_check;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'clients'::regclass
       and conname = 'clients_status_check'
  ) then
    alter table clients add constraint clients_status_check
      check (status in ('active', 'awaiting_info', 'inactive'));
  end if;
end $$;
