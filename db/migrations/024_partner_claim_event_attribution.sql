-- 024: attribute a claim_event to a partner credential — CONTRACT PHASE.
--
-- ============================================================================
-- THIS MIGRATION IS THE SECOND HALF OF AN EXPAND/CONTRACT PAIR
-- ============================================================================
--
-- An earlier version of this file did everything at once: added both columns
-- WITH `not null default 'user'`, backfilled, and added both CHECK constraints.
-- That has NO safe ordering. Both failure modes were reproduced against a real
-- PostgreSQL 16 rather than argued about:
--
--   * The partner-aware writer against a schema without these columns:
--       42703  column "created_by_partner_credential_id" does not exist
--     — every claim-event insert fails.
--
--   * The previously deployed writer's SYSTEM event against the full 024:
--       23514  new row violates check constraint "claim_events_one_actor_check"
--     — an insert omitting actor_type takes the 'user' default while carrying
--       no created_by, which that CHECK forbids.
--
-- And the two DEADLOCK: the one-off runner can only apply a migration already
-- present in the deployed bundle, so 024 could not run before the deploy that
-- ships it, while the code in that deploy needed it already applied. Shrinking
-- the window does not help — deploy.sh updates every Lambda before invoking
-- migrate, so the new writer is live for minutes against the old schema.
--
-- The split removes the window instead of shrinking it:
--
--   1. EXPAND — db/schema.sql adds both columns NULLABLE with no default and no
--      constraints, plus the partial index. Purely additive; the deployed
--      writer names neither column, so it is unaffected. Ships on an ordinary
--      deploy.
--   2. The partner-aware writer ships. Both columns exist, so it succeeds. Rows
--      it writes carry a real actor_type; older rows carry NULL, which nothing
--      yet forbids.
--   3. THIS FILE — backfill the NULLs, then add the default, the NOT NULL and
--      both CHECKs, at which point every live writer already sets actor_type.
--
-- ORDER IS NOT OPTIONAL. Applying this before step 2 re-creates failure mode
-- two exactly. The guard below refuses to run if step 1 has not happened; it
-- CANNOT detect step 2, so that ordering is the operator's, and it is verified
-- with the runner's read-only `{"verify":true}` mode before this is invoked.
--
-- ============================================================================
-- EXACTLY ONE ACTOR PER EVENT
-- ============================================================================
--
-- The final CHECK refuses a row that names both a user and a partner, or one
-- that names a partner without declaring actor_type = 'partner'. Without it the
-- two columns could disagree and the event stream would be ambiguous about who
-- acted — which is the failure this migration exists to prevent, arriving by a
-- different route.

begin;

-- ---------------------------------------------------------------------------
-- 0. REFUSE TO RUN IF THE EXPAND PHASE IS ABSENT
-- ---------------------------------------------------------------------------
--
-- Without both columns this migration would add constraints to a shape that
-- cannot satisfy them. Failing loudly here is far better than a partially
-- constrained claim_events, and the whole file is one transaction so this
-- aborts cleanly.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'claim_events'
       and column_name = 'actor_type'
  ) or not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'claim_events'
       and column_name = 'created_by_partner_credential_id'
  ) then
    raise exception
      'claim_events attribution columns are missing: apply the EXPAND phase first (it is in db/schema.sql, applied by the migrate Lambda on deploy)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. REFUSE TO RUN IF ANY ROW CANNOT BE ATTRIBUTED
-- ---------------------------------------------------------------------------
--
-- A row naming BOTH a user and a partner credential cannot be repaired by the
-- backfill and would fail the CHECK below. One such row aborts the whole
-- migration anyway; this turns an opaque constraint violation into a sentence
-- that says what to fix. `{"verify":true}` surfaces the same number as
-- attribution.would_violate_one_actor, so it can be checked BEFORE invoking.

do $$
declare
  bad integer;
begin
  select count(*) into bad
    from claim_events
   where created_by is not null
     and created_by_partner_credential_id is not null;

  if bad > 0 then
    raise exception
      'claim_events has % row(s) naming both a user and a partner credential; resolve them before contracting', bad;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. BACKFILL — deterministic, and only where attribution is missing
-- ---------------------------------------------------------------------------
--
-- Rows written before the expand carry NULL. Rows written since carry a real
-- value and are LEFT ALONE — `where actor_type is null` is what makes that
-- true, and what makes re-running this a no-op.
--
-- The classification preserves the distinction the table already encodes: a row
-- with no created_by was generated by our own code (system); one with a
-- created_by was a human action. Nothing is invented.

update claim_events
   set actor_type = case
                      when created_by_partner_credential_id is not null then 'partner'
                      when created_by is not null                       then 'user'
                      else 'system'
                    end
 where actor_type is null;

-- ---------------------------------------------------------------------------
-- 3. VERIFY THE BACKFILL BEFORE CONSTRAINING
-- ---------------------------------------------------------------------------
--
-- Belt and braces inside the same transaction: if any row is still unattributed
-- or would fail the CHECK, abort before the constraint turns it into a much
-- more confusing error. Rolls back the backfill with it.

do $$
declare
  remaining integer;
  invalid   integer;
begin
  select count(*) into remaining from claim_events where actor_type is null;
  if remaining > 0 then
    raise exception 'backfill left % claim_events row(s) with a null actor_type', remaining;
  end if;

  select count(*) into invalid
    from claim_events
   where not (
     (actor_type = 'partner' and created_by_partner_credential_id is not null and created_by is null)
     or (actor_type = 'user'    and created_by is not null and created_by_partner_credential_id is null)
     or (actor_type = 'system'  and created_by is null and created_by_partner_credential_id is null)
   );
  if invalid > 0 then
    raise exception 'backfill produced % claim_events row(s) that violate the one-actor rule', invalid;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. CONTRACT — default, NOT NULL, then the two CHECKs
-- ---------------------------------------------------------------------------
--
-- The default exists for writers that omit the column. Every live writer sets
-- it explicitly by now; the default is the safety net, and 'user' is only ever
-- reachable together with a created_by, which the one-actor CHECK enforces.

alter table claim_events alter column actor_type set default 'user';
alter table claim_events alter column actor_type set not null;

alter table claim_events drop constraint if exists claim_events_actor_type_check;
alter table claim_events add constraint claim_events_actor_type_check
  check (actor_type in ('user', 'system', 'partner'));

alter table claim_events drop constraint if exists claim_events_one_actor_check;
alter table claim_events add constraint claim_events_one_actor_check
  check (
    (actor_type = 'partner'
       and created_by_partner_credential_id is not null
       and created_by is null)
    or
    (actor_type = 'user'
       and created_by is not null
       and created_by_partner_credential_id is null)
    or
    (actor_type = 'system'
       and created_by is null
       and created_by_partner_credential_id is null)
  );

commit;

-- ---------------------------------------------------------------------------
-- RE-RUNNING
-- ---------------------------------------------------------------------------
--
-- The runner records this file in schema_migrations and refuses a second apply,
-- so re-running is not the expected path. It is nonetheless safe: the guards
-- pass, the backfill matches no rows, `set default` / `set not null` are
-- idempotent, and both CHECKs are dropped-then-added rather than added blindly.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
--
--   alter table claim_events drop constraint if exists claim_events_one_actor_check;
--   alter table claim_events drop constraint if exists claim_events_actor_type_check;
--   alter table claim_events alter column actor_type drop not null;
--   alter table claim_events alter column actor_type drop default;
--
-- That returns the database to the EXPAND phase, where both the partner-aware
-- and the legacy writer work — which is the safe state to roll back into, and
-- the reason the columns themselves are NOT dropped here. Dropping them would
-- break the partner-aware writer that is by then deployed, and would discard
-- attribution already recorded for partner actions.
