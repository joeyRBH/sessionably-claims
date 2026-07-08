-- =============================================================================
-- Add notification_email to practices.
-- =============================================================================
-- Optional override recipient for admin notification emails — currently the
-- "a client completed intake" alert (card + demographics + insurance on file),
-- sent via AWS SES from backend/lib/email.js when the patient finishes the SMS
-- intake flow (backend/handlers/card_setup.js, save-insurance step).
--
-- When null, notifications fall back to the practice's first active
-- practice_admin user email, so this column is a convenience override, not a
-- hard requirement.
--
-- This column is already declared in the practices CREATE in db/schema.sql;
-- this migration guarantees it exists on a live database created before it was
-- added. Idempotent / re-runnable. Keep in sync with db/schema.sql.
-- =============================================================================

ALTER TABLE practices ADD COLUMN IF NOT EXISTS notification_email text;
