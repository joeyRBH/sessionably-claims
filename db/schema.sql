-- =============================================================================
-- Claimsub — PostgreSQL schema (source of truth)
-- =============================================================================
-- Out-of-network (OON) insurance billing for mental-health group practices.
--
-- Conventions (see CLAUDE.md):
--   * UUID primary keys via gen_random_uuid() (pgcrypto).
--   * timestamptz created_at / updated_at, with a shared set_updated_at() trigger.
--   * text + CHECK constraints instead of native ENUM types.
--   * Soft-delete over hard-delete (is_active / is_hidden).
--   * Foreign keys default to ON DELETE RESTRICT to protect financial / PHI records.
--   * practice_id carried on every practice-scoped table (query scoping + future RLS).
--   * Money as numeric(12,2); percentages as numeric(5,2).
--
-- This file is intended to be applied to RDS separately. It is written to be
-- re-runnable where practical (create ... if not exists, create or replace).
-- =============================================================================

create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- Shared trigger function: keep updated_at current on every UPDATE.
-- -----------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =============================================================================
-- 1. subscription_plans — catalog of billing tiers (global, not practice-scoped).
-- =============================================================================
create table if not exists subscription_plans (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  name          text not null,
  description   text,
  price_cents   integer not null default 0,
  interval      text check (interval in ('month', 'year')),
  features      jsonb not null default '{}'::jsonb,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table subscription_plans is 'Catalog of subscription billing tiers offered to practices.';

create index if not exists idx_subscription_plans_is_active on subscription_plans (is_active);

drop trigger if exists trg_subscription_plans_updated_at on subscription_plans;
create trigger trg_subscription_plans_updated_at
  before update on subscription_plans
  for each row execute function set_updated_at();

-- =============================================================================
-- 2. practices — the group organization (top-level tenant).
-- =============================================================================
create table if not exists practices (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  slug                 text not null unique,
  npi                  text,
  tax_id               text,                                  -- PHI-adjacent
  address_line1        text,
  address_line2        text,
  city                 text,
  state                text,
  postal_code          text,
  country              text not null default 'US',
  default_fee_payer    text not null default 'client' check (default_fee_payer in ('client', 'practice')),
  platform_fee_percent numeric(5,2) not null default 5.00,
  stripe_account_id    text,                                  -- Stripe Connect account
  stripe_customer_id   text,
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table practices is 'Top-level tenant: the group mental-health practice that owns users, clients, and claims.';

create index if not exists idx_practices_slug on practices (slug);
create index if not exists idx_practices_is_active on practices (is_active);

drop trigger if exists trg_practices_updated_at on practices;
create trigger trg_practices_updated_at
  before update on practices
  for each row execute function set_updated_at();

-- =============================================================================
-- 3. practice_subscriptions — a practice's current plan.
-- =============================================================================
create table if not exists practice_subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  practice_id             uuid not null references practices (id) on delete restrict,
  subscription_plan_id    uuid not null references subscription_plans (id) on delete restrict,
  stripe_subscription_id  text,
  status                  text not null check (status in ('active', 'trialing', 'past_due', 'canceled')),
  current_period_end      timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
comment on table practice_subscriptions is 'Links a practice to its current subscription plan and Stripe subscription state.';

create index if not exists idx_practice_subscriptions_practice_id on practice_subscriptions (practice_id);
create index if not exists idx_practice_subscriptions_plan_id on practice_subscriptions (subscription_plan_id);
create index if not exists idx_practice_subscriptions_status on practice_subscriptions (status);

drop trigger if exists trg_practice_subscriptions_updated_at on practice_subscriptions;
create trigger trg_practice_subscriptions_updated_at
  before update on practice_subscriptions
  for each row execute function set_updated_at();

-- =============================================================================
-- 4. users — clinicians and admins within a practice.
-- =============================================================================
create table if not exists users (
  id                 uuid primary key default gen_random_uuid(),
  practice_id        uuid not null references practices (id) on delete restrict,
  role               text not null check (role in ('practice_admin', 'clinician', 'billing_staff')),
  first_name         text not null,
  last_name          text not null,
  email              text not null unique,
  password_hash      text,                                    -- null when using OAuth only
  google_oauth_sub   text,
  title              text,
  npi                text,
  license_state      text,
  fee_payer_override text check (fee_payer_override in ('client', 'practice')),  -- null = inherit practice default
  is_active          boolean not null default true,
  last_login_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
comment on table users is 'Staff accounts (practice admins, clinicians, billing staff) belonging to a practice.';

create index if not exists idx_users_practice_id on users (practice_id);
create index if not exists idx_users_email on users (email);
create index if not exists idx_users_role on users (role);
create index if not exists idx_users_is_active on users (is_active);

drop trigger if exists trg_users_updated_at on users;
create trigger trg_users_updated_at
  before update on users
  for each row execute function set_updated_at();

-- =============================================================================
-- 5. clients — people receiving care (PHI-heavy).
-- =============================================================================
create table if not exists clients (
  id                   uuid primary key default gen_random_uuid(),
  practice_id          uuid not null references practices (id) on delete restrict,
  primary_clinician_id uuid references users (id) on delete restrict,
  first_name           text not null,
  last_name            text not null,
  preferred_name       text,
  pronouns             text,
  email                text,
  phone                text,
  date_of_birth        date,
  status               text not null default 'awaiting_info'
                         check (status in ('active', 'awaiting_info', 'ready', 'inactive')),
  is_hidden            boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table clients is 'People receiving care (PHI). Each has one primary clinician but can be reassigned.';

create index if not exists idx_clients_practice_id on clients (practice_id);
create index if not exists idx_clients_primary_clinician_id on clients (primary_clinician_id);
create index if not exists idx_clients_status on clients (status);
create index if not exists idx_clients_is_hidden on clients (is_hidden);

drop trigger if exists trg_clients_updated_at on clients;
create trigger trg_clients_updated_at
  before update on clients
  for each row execute function set_updated_at();

-- =============================================================================
-- 6. insurance_records — OON benefit data per client (PHI).
-- =============================================================================
create table if not exists insurance_records (
  id                       uuid primary key default gen_random_uuid(),
  practice_id              uuid not null references practices (id) on delete restrict,
  client_id                uuid not null references clients (id) on delete restrict,
  carrier_name             text,
  member_id                text,                              -- PHI
  group_number             text,
  plan_type                text,
  subscriber_relationship  text,
  subscriber_name          text,
  subscriber_dob           date,
  oon_deductible_total     numeric(12,2),
  oon_deductible_met       numeric(12,2),
  oon_reimbursement_rate   numeric(5,2),
  benefits_checked_at      timestamptz,
  benefits_raw             jsonb,
  is_primary               boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
comment on table insurance_records is 'Out-of-network insurance benefit data for a client (PHI).';

create index if not exists idx_insurance_records_practice_id on insurance_records (practice_id);
create index if not exists idx_insurance_records_client_id on insurance_records (client_id);
create index if not exists idx_insurance_records_is_primary on insurance_records (is_primary);

drop trigger if exists trg_insurance_records_updated_at on insurance_records;
create trigger trg_insurance_records_updated_at
  before update on insurance_records
  for each row execute function set_updated_at();

-- =============================================================================
-- 7. sessions — therapy sessions (exist only to attach claims to).
-- =============================================================================
create table if not exists sessions (
  id               uuid primary key default gen_random_uuid(),
  practice_id      uuid not null references practices (id) on delete restrict,
  client_id        uuid not null references clients (id) on delete restrict,
  clinician_id     uuid not null references users (id) on delete restrict,
  session_date     date not null,
  duration_minutes integer,
  cpt_code         text,
  diagnosis_codes  text[],                                    -- ICD-10 codes
  place_of_service text,
  fee              numeric(12,2),
  notes            text,                                      -- billing notes only — no clinical notes
  status           text not null default 'scheduled'
                     check (status in ('scheduled', 'completed', 'claim_ready',
                                       'claim_submitted', 'awaiting_payment', 'paid', 'no_claim')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table sessions is 'Therapy sessions that exist solely to attach claims to (no clinical notes).';

create index if not exists idx_sessions_practice_id on sessions (practice_id);
create index if not exists idx_sessions_client_id on sessions (client_id);
create index if not exists idx_sessions_clinician_id on sessions (clinician_id);
create index if not exists idx_sessions_status on sessions (status);
create index if not exists idx_sessions_session_date on sessions (session_date);

drop trigger if exists trg_sessions_updated_at on sessions;
create trigger trg_sessions_updated_at
  before update on sessions
  for each row execute function set_updated_at();

-- =============================================================================
-- 8. claims — OON claim records (multiple allowed per session for resubmit/appeal).
-- =============================================================================
create table if not exists claims (
  id                     uuid primary key default gen_random_uuid(),
  practice_id            uuid not null references practices (id) on delete restrict,
  session_id             uuid not null references sessions (id) on delete restrict,
  client_id              uuid not null references clients (id) on delete restrict,
  clinician_id           uuid not null references users (id) on delete restrict,
  insurance_record_id    uuid references insurance_records (id) on delete restrict,
  claim_number           text,
  control_number         text,
  clearinghouse          text,                                -- e.g. office_ally
  status                 text not null default 'draft'
                           check (status in ('draft', 'submitted', 'processing', 'info_requested',
                                             'denied', 'appealed', 'paid', 'void')),
  billed_amount          numeric(12,2),
  allowed_amount         numeric(12,2),
  reimbursed_amount      numeric(12,2),
  patient_responsibility numeric(12,2),
  denial_reason          text,
  submitted_at           timestamptz,
  clearinghouse_payload  jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
comment on table claims is 'Out-of-network claim records; multiple claims may attach to one session (resubmission / appeal).';

create index if not exists idx_claims_practice_id on claims (practice_id);
create index if not exists idx_claims_session_id on claims (session_id);
create index if not exists idx_claims_client_id on claims (client_id);
create index if not exists idx_claims_clinician_id on claims (clinician_id);
create index if not exists idx_claims_insurance_record_id on claims (insurance_record_id);
create index if not exists idx_claims_status on claims (status);
create index if not exists idx_claims_submitted_at on claims (submitted_at);

drop trigger if exists trg_claims_updated_at on claims;
create trigger trg_claims_updated_at
  before update on claims
  for each row execute function set_updated_at();

-- =============================================================================
-- 9. claim_events — status-history log per claim.
--    Events belong to the claim's lifecycle, so ON DELETE CASCADE.
-- =============================================================================
create table if not exists claim_events (
  id           uuid primary key default gen_random_uuid(),
  practice_id  uuid not null references practices (id) on delete restrict,
  claim_id     uuid not null references claims (id) on delete cascade,
  created_by   uuid references users (id) on delete restrict,
  event_type   text not null check (event_type in ('created', 'submitted', 'accepted', 'processing',
                                                    'info_requested', 'denied', 'paid', 'appealed',
                                                    'voided', 'note')),
  status_from  text,
  status_to    text,
  note         text,
  payload      jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
comment on table claim_events is 'Append-style status-history log for a claim''s lifecycle (cascades with its claim).';

create index if not exists idx_claim_events_practice_id on claim_events (practice_id);
create index if not exists idx_claim_events_claim_id on claim_events (claim_id);
create index if not exists idx_claim_events_created_by on claim_events (created_by);
create index if not exists idx_claim_events_event_type on claim_events (event_type);

drop trigger if exists trg_claim_events_updated_at on claim_events;
create trigger trg_claim_events_updated_at
  before update on claim_events
  for each row execute function set_updated_at();

-- =============================================================================
-- 10. transactions — fee / billing records (5% per-claim fee, subscriptions, refunds, payouts).
-- =============================================================================
create table if not exists transactions (
  id                        uuid primary key default gen_random_uuid(),
  practice_id               uuid not null references practices (id) on delete restrict,
  client_id                 uuid references clients (id) on delete restrict,
  claim_id                  uuid references claims (id) on delete restrict,
  type                      text not null check (type in ('platform_fee', 'subscription', 'refund', 'payout', 'adjustment')),
  description               text,
  amount                    numeric(12,2) not null,
  currency                  text not null default 'usd',
  fee_payer                 text check (fee_payer in ('client', 'practice')),
  stripe_payment_intent_id  text,
  stripe_charge_id          text,
  stripe_refund_id          text,
  status                    text not null default 'pending'
                              check (status in ('pending', 'paid', 'failed', 'refunded', 'canceled')),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
comment on table transactions is 'Money movements: platform fees, subscriptions, refunds, payouts, and adjustments.';

create index if not exists idx_transactions_practice_id on transactions (practice_id);
create index if not exists idx_transactions_client_id on transactions (client_id);
create index if not exists idx_transactions_claim_id on transactions (claim_id);
create index if not exists idx_transactions_type on transactions (type);
create index if not exists idx_transactions_status on transactions (status);

drop trigger if exists trg_transactions_updated_at on transactions;
create trigger trg_transactions_updated_at
  before update on transactions
  for each row execute function set_updated_at();

-- =============================================================================
-- 11. documents — practice policy + questionnaire templates.
-- =============================================================================
create table if not exists documents (
  id                  uuid primary key default gen_random_uuid(),
  practice_id         uuid not null references practices (id) on delete restrict,
  type                text not null check (type in ('practice_policy', 'informed_consent', 'credit_card_auth',
                                                     'intake_questionnaire', 'w9', 'custom')),
  title               text not null,
  body                text,
  file_url            text,
  requires_signature  boolean not null default false,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
comment on table documents is 'Practice-owned policy and questionnaire templates (consent forms, intake, W-9, etc.).';

create index if not exists idx_documents_practice_id on documents (practice_id);
create index if not exists idx_documents_type on documents (type);
create index if not exists idx_documents_is_active on documents (is_active);

drop trigger if exists trg_documents_updated_at on documents;
create trigger trg_documents_updated_at
  before update on documents
  for each row execute function set_updated_at();

-- =============================================================================
-- 12. document_signatures — e-signature records (legal).
-- =============================================================================
create table if not exists document_signatures (
  id            uuid primary key default gen_random_uuid(),
  practice_id   uuid not null references practices (id) on delete restrict,
  document_id   uuid not null references documents (id) on delete restrict,
  client_id     uuid not null references clients (id) on delete restrict,
  signed_at     timestamptz,
  signer_name   text,
  signature_ref text,
  ip_address    inet,
  status        text not null default 'pending'
                  check (status in ('pending', 'signed', 'declined', 'voided')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table document_signatures is 'Legal e-signature records linking a client to a signed practice document.';

create index if not exists idx_document_signatures_practice_id on document_signatures (practice_id);
create index if not exists idx_document_signatures_document_id on document_signatures (document_id);
create index if not exists idx_document_signatures_client_id on document_signatures (client_id);
create index if not exists idx_document_signatures_status on document_signatures (status);

drop trigger if exists trg_document_signatures_updated_at on document_signatures;
create trigger trg_document_signatures_updated_at
  before update on document_signatures
  for each row execute function set_updated_at();

-- =============================================================================
-- 13. questionnaire_responses — client intake responses.
-- =============================================================================
create table if not exists questionnaire_responses (
  id            uuid primary key default gen_random_uuid(),
  practice_id   uuid not null references practices (id) on delete restrict,
  document_id   uuid not null references documents (id) on delete restrict,
  client_id     uuid not null references clients (id) on delete restrict,
  responses     jsonb not null default '{}'::jsonb,
  submitted_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table questionnaire_responses is 'Client-submitted answers to a practice intake questionnaire (PHI).';

create index if not exists idx_questionnaire_responses_practice_id on questionnaire_responses (practice_id);
create index if not exists idx_questionnaire_responses_document_id on questionnaire_responses (document_id);
create index if not exists idx_questionnaire_responses_client_id on questionnaire_responses (client_id);

drop trigger if exists trg_questionnaire_responses_updated_at on questionnaire_responses;
create trigger trg_questionnaire_responses_updated_at
  before update on questionnaire_responses
  for each row execute function set_updated_at();

-- =============================================================================
-- 14. invitations — clinician invite tokens.
-- =============================================================================
create table if not exists invitations (
  id               uuid primary key default gen_random_uuid(),
  practice_id      uuid not null references practices (id) on delete restrict,
  invited_by       uuid references users (id) on delete restrict,
  email            text not null,
  role             text not null check (role in ('practice_admin', 'clinician', 'billing_staff')),
  token            text not null unique,
  status           text not null default 'pending'
                     check (status in ('pending', 'accepted', 'expired', 'revoked')),
  expires_at       timestamptz,
  accepted_at      timestamptz,
  accepted_user_id uuid references users (id) on delete restrict,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table invitations is 'Tokenized invitations for new staff to join a practice.';

create index if not exists idx_invitations_practice_id on invitations (practice_id);
create index if not exists idx_invitations_invited_by on invitations (invited_by);
create index if not exists idx_invitations_accepted_user_id on invitations (accepted_user_id);
create index if not exists idx_invitations_token on invitations (token);
create index if not exists idx_invitations_status on invitations (status);
create index if not exists idx_invitations_email on invitations (email);

drop trigger if exists trg_invitations_updated_at on invitations;
create trigger trg_invitations_updated_at
  before update on invitations
  for each row execute function set_updated_at();

-- =============================================================================
-- 15. shareable_links — custom slugs per practice.
-- =============================================================================
create table if not exists shareable_links (
  id                   uuid primary key default gen_random_uuid(),
  practice_id          uuid not null references practices (id) on delete restrict,
  target_clinician_id  uuid references users (id) on delete restrict,
  type                 text not null check (type in ('therapist_referral', 'benefits_check', 'client_invite')),
  slug                 text not null unique,
  is_active            boolean not null default true,
  click_count          integer not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table shareable_links is 'Custom public slugs per practice (referral, benefits-check, client invite links).';

create index if not exists idx_shareable_links_practice_id on shareable_links (practice_id);
create index if not exists idx_shareable_links_target_clinician_id on shareable_links (target_clinician_id);
create index if not exists idx_shareable_links_slug on shareable_links (slug);
create index if not exists idx_shareable_links_type on shareable_links (type);
create index if not exists idx_shareable_links_is_active on shareable_links (is_active);

drop trigger if exists trg_shareable_links_updated_at on shareable_links;
create trigger trg_shareable_links_updated_at
  before update on shareable_links
  for each row execute function set_updated_at();

-- =============================================================================
-- audit_log — append-only compliance trail (no updated_at, no trigger).
-- =============================================================================
create table if not exists audit_log (
  id             uuid primary key default gen_random_uuid(),
  practice_id    uuid references practices (id) on delete restrict,
  actor_user_id  uuid references users (id) on delete restrict,
  actor_type     text not null check (actor_type in ('user', 'client', 'system')),
  action         text not null,
  entity_type    text,
  entity_id      uuid,
  ip_address     inet,
  user_agent     text,
  metadata       jsonb,
  created_at     timestamptz not null default now()
);
comment on table audit_log is 'Append-only audit trail of PHI access and significant actions (HIPAA).';

create index if not exists idx_audit_log_practice_id on audit_log (practice_id);
create index if not exists idx_audit_log_actor_user_id on audit_log (actor_user_id);
create index if not exists idx_audit_log_action on audit_log (action);
create index if not exists idx_audit_log_entity on audit_log (entity_type, entity_id);
create index if not exists idx_audit_log_created_at on audit_log (created_at);

-- =============================================================================
-- End of schema.
-- =============================================================================
