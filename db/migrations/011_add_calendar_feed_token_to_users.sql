-- =============================================================================
-- 011: per-clinician calendar feed token (de-identified ICS feed capability).
-- =============================================================================
-- Backs the read-only calendar feed at GET /calendar/{feed_token}.ics. The token
-- is an opaque, high-entropy capability: 32 bytes (64 hex chars) from pgcrypto's
-- gen_random_bytes, unique per user. The feed endpoint authenticates by token
-- alone (calendar apps cannot send a JWT); "Regenerate link" rotates the token and
-- instantly revokes the old feed. The token is NOT PHI, but it grants read access
-- to a clinician's de-identified schedule, so treat it as a secret.
--
-- Idempotent / re-runnable: add-if-not-exists, backfill only NULLs, guarded index.
-- pgcrypto is already enabled by db/schema.sql (gen_random_uuid lives there too).

alter table users add column if not exists calendar_feed_token text;

-- Backfill any existing rows with a fresh 32-byte token.
update users
   set calendar_feed_token = encode(gen_random_bytes(32), 'hex')
 where calendar_feed_token is null;

-- New rows get a token automatically (evaluated per-insert, so each is distinct).
alter table users
  alter column calendar_feed_token set default encode(gen_random_bytes(32), 'hex');

-- One token -> one user; also makes the feed lookup an indexed unique probe.
create unique index if not exists idx_users_calendar_feed_token
  on users (calendar_feed_token);
