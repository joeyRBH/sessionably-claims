-- =============================================================================
-- Add diagnosis_codes to clients.
-- =============================================================================
-- A client's working ICD-10 diagnosis code(s) live on the client record so new
-- sessions (and the claims derived from them) can auto-populate the diagnosis
-- without re-entry. The session form still allows a per-session override; this is
-- only the default.
--
-- Codes are stored WITHOUT the decimal point (e.g. F3290, F1090) — the 837P
-- transmits ICD-10 codes dotless, and lib/clearinghouse/stedi.js sends
-- session.diagnosis_codes[0] verbatim. Only billable, highest-specificity codes
-- are offered by the picker (public/app/diagnosis-codes.js); category codes such
-- as F10.9 were rejected by Aetna (error 33 — "must be to the highest level of
-- specificity"), so the picker never lets one be chosen.
--
-- text[] mirrors sessions.diagnosis_codes. Idempotent / re-runnable. Keep in sync
-- with db/schema.sql (clients table).
-- =============================================================================

ALTER TABLE clients ADD COLUMN IF NOT EXISTS diagnosis_codes text[];
