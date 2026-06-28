-- =============================================================================
-- Add subscriber demographics + address to clients.
-- =============================================================================
-- Clearinghouses (Stedi) require the subscriber's gender and full address when the
-- patient is the subscriber (837P SBR-02 = 18 / self). The clients table previously
-- stored neither, so the Stedi adapter had no data to populate the required
-- subscriber demographics. This adds them (all PHI).
--
-- Idempotent / re-runnable.
-- =============================================================================

ALTER TABLE clients ADD COLUMN IF NOT EXISTS gender text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clients_gender_check'
  ) THEN
    ALTER TABLE clients ADD CONSTRAINT clients_gender_check
      CHECK (gender IN ('female', 'male', 'unknown'));
  END IF;
END $$;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS address_line1 text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS address_line2 text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS state text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS postal_code text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'US';
