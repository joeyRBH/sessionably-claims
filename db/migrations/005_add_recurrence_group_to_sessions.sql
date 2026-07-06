-- =============================================================================
-- Add recurrence grouping to sessions.
-- =============================================================================
-- Recurring sessions are pre-generated (no cron): a single POST /sessions with a
-- recurrence cadence + end date creates the first session plus one 'scheduled'
-- session per interval (hard-capped at 30). All sessions produced by one request
-- share a recurrence_group_id so they can be grouped, filtered, or bulk-managed
-- later. A stand-alone (non-recurring) session leaves the column NULL.
--
-- Idempotent / re-runnable. Keep in sync with db/schema.sql (sessions table).
-- =============================================================================

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS recurrence_group_id uuid;
CREATE INDEX IF NOT EXISTS idx_sessions_recurrence_group_id
  ON sessions (recurrence_group_id);
