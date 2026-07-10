-- =============================================================================
-- 012: optional display name on invitations.
-- =============================================================================
-- Captured when a practice admin creates an invite (the "name" field in the
-- Invite-clinician form). Used only to personalize the invitation email greeting
-- and the pending-invitations list. It is a staff member's name — NOT PHI — but,
-- like the rest of the invite, is kept out of URLs and audit metadata.
--
-- Idempotent / re-runnable.

alter table invitations add column if not exists invited_name text;
