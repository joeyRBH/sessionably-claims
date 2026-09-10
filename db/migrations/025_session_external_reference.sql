-- 025: an external reference on sessions — the durable identity anchor.
--
-- WHY
--
-- A partner system (Sessionably) creates a session here for each of its own
-- completed appointments. Without a reference of its own it cannot answer the
-- one question everything else depends on:
--
--     "Does a session already exist for MY appointment 4172?"
--
-- Before this migration the only way to guess was to list a client's sessions
-- and match on date — which cannot distinguish two sessions on the same day,
-- cannot see soft-deleted rows (`is_hidden`), and cannot observe a create that
-- was still in flight. Every one of those produced a duplicate or an
-- unresolvable state on the partner's side.
--
-- This makes the question answerable by the DATABASE rather than by a
-- heuristic, and makes session creation idempotent as a consequence.
--
-- WHAT IT IS NOT
--
-- Not an authorization boundary — `practice_id` remains the tenant column and
-- every query stays scoped by it. This is an identity anchor, nothing more.
--
-- Not PHI. `external_id` is the partner's opaque row identifier; it carries no
-- name, date of birth or clinical content.

begin;

alter table sessions
  add column if not exists external_source text,
  add column if not exists external_id     text;

comment on column sessions.external_source is
  'Which partner system owns external_id (currently only ''sessionably''). NULL for sessions created here.';
comment on column sessions.external_id is
  'That system''s own identifier for the appointment this session represents. Opaque; never PHI.';

-- Only a known partner may claim an external identity, and the pair travels
-- together — one without the other is a half-recorded reference that no lookup
-- could use.
alter table sessions drop constraint if exists sessions_external_ref_check;
alter table sessions add constraint sessions_external_ref_check
  check (
    (external_source is null and external_id is null)
    or (external_source in ('sessionably') and external_id is not null)
  );

-- ---------------------------------------------------------------------------
-- THE CONSTRAINT THAT MAKES CREATION IDEMPOTENT
-- ---------------------------------------------------------------------------
--
-- One session per (practice, partner, partner row). PARTIAL, so the ordinary
-- sessions created in this product — which have no external reference — are
-- entirely unaffected and can exist in any number.
--
-- This is what a partner's retry-after-timeout collides with: a second POST for
-- the same appointment raises 23505 rather than creating a twin, and the
-- handler turns that into "here is the one that already exists". The guarantee
-- is PostgreSQL's, not the application's, so two concurrent requests cannot
-- both win.
create unique index if not exists sessions_external_ref_uq
  on sessions (practice_id, external_source, external_id)
  where external_id is not null;

-- The lookup path: "find the session for this partner row".
create index if not exists sessions_external_lookup_idx
  on sessions (external_source, external_id)
  where external_id is not null;

commit;

-- ---------------------------------------------------------------------------
-- COMPATIBILITY
-- ---------------------------------------------------------------------------
--
-- Purely additive and inert on arrival. Both columns are nullable with no
-- default, the CHECK admits the all-NULL case every existing row is in, and the
-- unique index is partial on `external_id is not null` — so it indexes nothing
-- until a partner writes one.
--
-- Existing code neither reads nor writes these columns, so this is safe to
-- apply well before the handler change ships. That is the OPPOSITE of migration
-- 024, whose CHECK required the handler change to land with it; the difference
-- is that 024 constrained a column existing code already wrote, and this one
-- adds columns nothing writes yet.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
--
--   drop index if exists sessions_external_lookup_idx;
--   drop index if exists sessions_external_ref_uq;
--   alter table sessions drop constraint if exists sessions_external_ref_check;
--   alter table sessions drop column if exists external_id;
--   alter table sessions drop column if exists external_source;
--
-- Safe at any time for this product's own data. It does, however, destroy the
-- link a partner integration depends on: after dropping these, that partner can
-- no longer tell which session belongs to which of its appointments, and its
-- recovery path degrades to the guessing this migration exists to replace.
-- Disable the partner credential first (023), then drop.
