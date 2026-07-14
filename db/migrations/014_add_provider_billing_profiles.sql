-- =============================================================================
-- Provider billing identity: per-clinician billing profile + NPPES verification.
-- =============================================================================
-- Guarantees every clinician's 837P billing-provider loop is constructed
-- correctly. Stores, per provider, whether they bill as an INDIVIDUAL (Type-1 /
-- person) or under the practice ORGANIZATION (Type-2 / non-person entity), the
-- NPPES verification snapshot for their individual NPI, and — for the person
-- case — their billing TIN.
--
-- This adds:
--   * practices.npi_verified / npi_verified_at / npi_enumeration_type — the
--     result of verifying the practice's OWN (organizational, Type-2) NPI, so a
--     practice billing as an organization can confirm its NPI is really NPI-2.
--   * provider_billing_profiles — one row per (practice_id, provider_user_id).
--
-- Sensitivity: the individual billing TIN (EIN or SSN) is encrypted at the
-- application layer (AES-256-GCM, see backend/lib/crypto.js) and stored as
-- ciphertext; only a masked last-4 is ever returned to a client. The
-- ORGANIZATION EIN continues to live on practices.tax_id (unchanged) — it is not
-- duplicated here. TIN/EIN/SSN values must never be logged.
--
-- All of the above is already declared in db/schema.sql (the source of truth);
-- this migration guarantees it exists on a live database created before it.
-- Idempotent / re-runnable. No PHI in column names.
-- =============================================================================

-- Practice organizational-NPI (Type-2) verification result.
ALTER TABLE practices ADD COLUMN IF NOT EXISTS npi_verified         boolean not null default false;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS npi_verified_at      timestamptz;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS npi_enumeration_type text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'practices_npi_enum_type_check') THEN
    ALTER TABLE practices ADD CONSTRAINT practices_npi_enum_type_check
      CHECK (npi_enumeration_type IS NULL OR npi_enumeration_type IN ('NPI-1', 'NPI-2'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS provider_billing_profiles (
  id                          uuid primary key default gen_random_uuid(),
  practice_id                 uuid not null references practices (id) on delete restrict,
  provider_user_id            uuid not null references users (id) on delete restrict,
  billing_entity_type         text not null check (billing_entity_type in ('person', 'non_person_entity')),
  -- Individual identity (must be a Type-1 / NPI-1). For a person profile this is
  -- the billing AND rendering provider; for a non-person profile it is the
  -- rendering provider (the org itself is the billing provider — see practices).
  individual_npi              text,
  legal_first_name            text,
  legal_last_name             text,
  -- Person billing TIN (EIN or SSN). App-layer AES-256-GCM ciphertext + masked
  -- last-4 for display. NEVER store or return the raw value. The organization
  -- EIN is NOT stored here — it stays on practices.tax_id.
  billing_tin_ciphertext      text,
  billing_tin_last4           text,
  billing_tin_type            text check (billing_tin_type in ('EIN', 'SSN')),
  -- NPPES verification snapshot for individual_npi.
  npi_verified                boolean not null default false,
  npi_verified_at             timestamptz,
  npi_enumeration_type        text check (npi_enumeration_type in ('NPI-1', 'NPI-2')),
  sole_proprietor             boolean,
  primary_taxonomy_code       text,
  primary_taxonomy_desc       text,
  primary_taxonomy_license    text,
  primary_taxonomy_state      text,
  -- True when billing as an organization: the 837P must then carry a distinct
  -- rendering-provider loop (the individual above).
  rendering_provider_required boolean not null default false,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (practice_id, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_billing_profiles_practice_id ON provider_billing_profiles (practice_id);
CREATE INDEX IF NOT EXISTS idx_provider_billing_profiles_user_id ON provider_billing_profiles (provider_user_id);

DROP TRIGGER IF EXISTS trg_provider_billing_profiles_updated_at ON provider_billing_profiles;
CREATE TRIGGER trg_provider_billing_profiles_updated_at
  BEFORE UPDATE ON provider_billing_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
