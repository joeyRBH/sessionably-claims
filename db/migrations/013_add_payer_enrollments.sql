-- =============================================================================
-- Add per-practice ERA (electronic remittance) payer enrollments.
-- =============================================================================
-- Practice admins manage payer ERA enrollments from inside the app instead of the
-- clearinghouse portal. Enrollment is per-practice (TIN-level), not per-clinician.
--
-- This adds:
--   * practices.phone              — practice contact phone (enrollment contact).
--   * practices.stedi_provider_id  — the clearinghouse "provider" handle, minted
--                                    once per practice TIN on first enrollment.
--   * payer_enrollments            — one row per payer per transaction type.
--
-- All of the above are already declared in db/schema.sql (the source of truth);
-- this migration guarantees they exist on a live database created before them.
-- Idempotent / re-runnable. No PHI — practice/payer trading-partner data only.
-- =============================================================================

ALTER TABLE practices ADD COLUMN IF NOT EXISTS phone             text;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS stedi_provider_id text;

CREATE TABLE IF NOT EXISTS payer_enrollments (
  id                       uuid primary key default gen_random_uuid(),
  practice_id              uuid not null references practices (id) on delete restrict,
  payer_id                 text not null,
  payer_name               text,
  transaction_type         text not null default 'claimPayment',
  stedi_enrollment_id      text unique,
  status                   text not null default 'requested',
  status_reason            text,
  requested_effective_date date,
  last_synced_at           timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (practice_id, payer_id, transaction_type)
);

CREATE INDEX IF NOT EXISTS idx_payer_enrollments_practice_id ON payer_enrollments (practice_id);
CREATE INDEX IF NOT EXISTS idx_payer_enrollments_status ON payer_enrollments (status);

DROP TRIGGER IF EXISTS trg_payer_enrollments_updated_at ON payer_enrollments;
CREATE TRIGGER trg_payer_enrollments_updated_at
  BEFORE UPDATE ON payer_enrollments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
