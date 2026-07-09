-- =============================================================================
-- HIPAA application-level audit log (45 CFR 164.312(b)).
-- =============================================================================
-- Records WHO did WHAT to WHICH resource WHEN, using ids and field NAMES only.
-- The table MUST NOT contain PHI — never a patient name, DOB, member id, or
-- diagnosis code in any column or in metadata. Append-only by convention: the
-- application has no UPDATE/DELETE path, and the read endpoint
-- (backend/handlers/audit.js) is GET-only. Retain rows for at least 6 years.
--
-- A prior schema (db/schema.sql) shipped an older audit_log shape
-- (entity_type/entity_id/created_at, ip_address inet, actor_type allowing
-- 'client'). This migration both creates the table on a fresh database and
-- reconciles a pre-existing one to the HIPAA design. Idempotent / re-runnable.
-- Keep in sync with db/schema.sql.
-- =============================================================================

create table if not exists audit_log (
  id             uuid primary key default gen_random_uuid(),
  occurred_at    timestamptz not null default now(),
  practice_id    uuid references practices (id) on delete restrict,
  actor_user_id  uuid references users (id) on delete restrict,
  actor_type     text not null check (actor_type in ('user', 'patient_link', 'system')),
  action         text not null,
  resource_type  text,
  resource_id    uuid,
  ip_address     text,
  user_agent     text,
  request_id     text,
  metadata       jsonb
);
comment on table audit_log is 'Append-only HIPAA audit trail (45 CFR 164.312(b)). WHO/WHAT/WHICH/WHEN by id and field name only — NEVER PHI values. No app UPDATE/DELETE path; 6-year retention.';

-- Reconcile a pre-existing (older-shape) audit_log with the design above.
alter table audit_log add column if not exists occurred_at   timestamptz not null default now();
alter table audit_log add column if not exists resource_type text;
alter table audit_log add column if not exists resource_id   uuid;
alter table audit_log add column if not exists request_id    text;

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_name = 'audit_log' and column_name = 'ip_address' and data_type <> 'text'
  ) then
    alter table audit_log alter column ip_address type text using ip_address::text;
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'audit_log_actor_type_check') then
    alter table audit_log drop constraint audit_log_actor_type_check;
  end if;
  alter table audit_log add constraint audit_log_actor_type_check
    check (actor_type in ('user', 'patient_link', 'system'));
end $$;

create index if not exists idx_audit_log_practice_occurred on audit_log (practice_id, occurred_at desc);
create index if not exists idx_audit_log_resource on audit_log (resource_type, resource_id);
create index if not exists idx_audit_log_actor_occurred on audit_log (actor_user_id, occurred_at desc);
create index if not exists idx_audit_log_action on audit_log (action);
