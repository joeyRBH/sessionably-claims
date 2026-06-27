-- =============================================================================
-- Add payer_id to insurance_records.
-- =============================================================================
-- Clearinghouses (Stedi, Claim.MD) route a claim by the payer's trading-partner /
-- payer id. insurance_records previously had no column for it; this adds one so
-- the Stedi adapter can populate tradingPartnerServiceId on submit.
--
-- Idempotent / re-runnable.
-- =============================================================================

ALTER TABLE insurance_records ADD COLUMN IF NOT EXISTS payer_id VARCHAR(50);
