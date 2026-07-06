-- =============================================================================
-- Add billing address to practices.
-- =============================================================================
-- Stedi's 837P professional-claims submission requires a complete Billing.address
-- block (address1 / city / state / postalCode). A practice with no billing address
-- makes Stedi reject the claim ("Billing.address: missing field `address1`").
--
-- These columns are already declared in the practices CREATE in db/schema.sql;
-- this migration guarantees they exist on a live database created before they
-- were added. address_line2 is optional; the other four are needed for a valid
-- claim (the claims Lambda blocks submission with a 422 when any are missing).
--
-- Idempotent / re-runnable. Keep in sync with db/schema.sql (practices table).
-- =============================================================================

ALTER TABLE practices ADD COLUMN IF NOT EXISTS address_line1 text;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS address_line2 text;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS city          text;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS state         text;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS postal_code   text;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS country       text NOT NULL DEFAULT 'US';
