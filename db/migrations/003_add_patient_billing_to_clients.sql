-- =============================================================================
-- Add patient billing (Stripe payment method) to clients + fee percent to practices.
-- =============================================================================
-- Reddably charges the patient a per-claim platform fee at claim submission. The
-- patient never logs in: staff send an SMS link that opens a card-capture page,
-- which saves a Stripe PaymentMethod against the client. These columns hold the
-- Stripe customer / payment-method handles and the displayable card summary, plus
-- the SMS link timestamp. The fee rate lives on the practice (default 5%).
--
-- All of these are PHI-adjacent billing data. Idempotent / re-runnable.
-- =============================================================================

-- clients — Stripe customer + saved payment method + SMS link bookkeeping.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone text;                 -- for the SMS payment link
ALTER TABLE clients ADD COLUMN IF NOT EXISTS payment_method_id text;     -- Stripe PaymentMethod ID
ALTER TABLE clients ADD COLUMN IF NOT EXISTS payment_method_brand text;  -- e.g. 'visa'
ALTER TABLE clients ADD COLUMN IF NOT EXISTS payment_method_last4 text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS payment_method_exp_month integer;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS payment_method_exp_year integer;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS payment_method_set_at timestamptz;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS payment_link_sent_at timestamptz;

-- practices — per-claim platform fee percentage (defaults to 5%).
ALTER TABLE practices ADD COLUMN IF NOT EXISTS platform_fee_percent numeric(5,2) NOT NULL DEFAULT 5.00;
