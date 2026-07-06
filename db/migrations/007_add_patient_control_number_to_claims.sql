-- =============================================================================
-- Add patient_control_number to claims.
-- =============================================================================
-- The 837P patient control number (CLM01) is capped at 20 characters, and Stedi
-- rejects longer values with error code 33 ("Invalid Patient Control Number ...
-- exceeds the maximum allowed length of 20 characters"). The adapter previously
-- sent the claim's 36-char UUID, so every live submission failed.
--
-- We now mint a short (<=17-char, alphanumeric) control number per claim and
-- persist it here so it is (a) stable across resubmissions and (b) matchable back
-- to the claim when the payer echoes it in 277CA acknowledgments and 835 ERAs.
-- Follows Stedi's best practices:
--   https://www.stedi.com/blog/how-to-track-claims#best-practices-for-creating-patient-control-numbers
--
-- varchar(20) enforces the payer limit at the column. A partial unique index
-- keeps two claims from ever sharing a control number (which would cross-match
-- ERAs) while still allowing many NULLs (claims not yet submitted).
--
-- Idempotent / re-runnable. Keep in sync with db/schema.sql (claims table).
-- =============================================================================

ALTER TABLE claims ADD COLUMN IF NOT EXISTS patient_control_number varchar(20);

CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_patient_control_number
  ON claims (patient_control_number)
  WHERE patient_control_number IS NOT NULL;
