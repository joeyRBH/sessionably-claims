-- =============================================================================
-- Add subscription plan + Instant VOB usage tracking to practices.
-- =============================================================================
-- Introduces the per-practice `plan` flag that gates the Instant VOB add-on:
--   * 'free'    — no VOB access (default). "Verify Benefits" prompts an upgrade.
--   * 'vob'     — $25/month Instant VOB add-on active (Stripe subscription).
--   * 'founder' — permanent, free, full access for internally-designated accounts
--                 (e.g. BigRedd). Never billed; the billing webhook never touches it.
--
-- Also adds VOB usage counters (analytics) and the Stripe subscription handle the
-- billing webhook uses to flip a practice between 'vob' and 'free'. `practices`
-- already carries stripe_customer_id / stripe_account_id, so only the subscription
-- id is new here.
--
-- Idempotent / re-runnable. Keep in sync with db/schema.sql (practices table).
-- =============================================================================

-- Plan flag. varchar(20) as specced; a named CHECK constrains it to the known set
-- (matching the project's "varchar/text + CHECK over native ENUM" convention).
ALTER TABLE practices ADD COLUMN IF NOT EXISTS plan varchar(20) NOT NULL DEFAULT 'free';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'practices_plan_check') THEN
    ALTER TABLE practices ADD CONSTRAINT practices_plan_check
      CHECK (plan IN ('free', 'vob', 'founder'));
  END IF;
END $$;

-- VOB usage tracking. vob_checks_used is incremented on every successful check;
-- vob_period_start marks when the current add-on billing period began.
ALTER TABLE practices ADD COLUMN IF NOT EXISTS vob_checks_used integer NOT NULL DEFAULT 0;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS vob_period_start date;

-- Stripe subscription handle for the VOB add-on. Set by the billing webhook on
-- checkout.session.completed; used to downgrade to 'free' on subscription deletion.
ALTER TABLE practices ADD COLUMN IF NOT EXISTS stripe_subscription_id text;

-- Designate the founder account (BigRedd) as permanently free with full access.
-- The users table has no username column, so we key on the login email. The
-- subquery yields NULL when the account is absent (e.g. a fresh database), so
-- `id = NULL` matches nothing — a safe no-op. The plan <> 'founder' guard avoids
-- a needless write on re-run.
UPDATE practices SET plan = 'founder'
 WHERE id = (
   SELECT practice_id FROM users
    WHERE lower(email) = lower('joseph@riverstonebehavioral.com')
    LIMIT 1
 )
   AND plan <> 'founder';
