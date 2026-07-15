-- =============================================================================
-- Patient-initiated refund flow: refund_requests + verbatim claim acknowledgments.
-- =============================================================================
-- Two new tables for the v1 patient refund flow (see PR "feat/patient-refund-flow"):
--
--   claim_acknowledgments — every clearinghouse acknowledgment we receive for a
--     claim, stored VERBATIM (the 277CA submission accept/reject and any later
--     276/277 status response). Passive dataset only — stored, never acted on in
--     v1. Append-only; cascades with its claim.
--
--   refund_requests — a patient's "my claim was denied, refund my fee" request.
--     Admin-adjudicated. A PAID or DEDUCTIBLE outcome is a success (no refund);
--     only a DENIAL refunds the 5% platform fee. At most one OPEN request per claim.
--
-- Idempotent / re-runnable (create ... if not exists, guarded index). Mirrored in
-- db/schema.sql (§10a / §10b) — schema.sql is the only path to prod.

create table if not exists claim_acknowledgments (
  id             uuid primary key default gen_random_uuid(),
  practice_id    uuid not null references practices (id) on delete restrict,
  claim_id       uuid not null references claims (id) on delete cascade,
  source         text,
  kind           text not null default 'submission'
                   check (kind in ('submission', 'status')),
  control_number text,
  payload        jsonb not null,
  received_at    timestamptz not null default now(),
  created_at     timestamptz not null default now()
);
comment on table claim_acknowledgments is 'Verbatim clearinghouse acknowledgments (277CA / 276-277 status) per claim. Append-only passive dataset — stored, never acted on in v1.';

create index if not exists idx_claim_acknowledgments_practice_id on claim_acknowledgments (practice_id);
create index if not exists idx_claim_acknowledgments_claim_id on claim_acknowledgments (claim_id);
create index if not exists idx_claim_acknowledgments_kind on claim_acknowledgments (kind);

create table if not exists refund_requests (
  id               uuid primary key default gen_random_uuid(),
  practice_id      uuid not null references practices (id) on delete restrict,
  claim_id         uuid not null references claims (id) on delete restrict,
  client_id        uuid not null references clients (id) on delete restrict,
  outcome_label    text not null check (outcome_label in ('paid', 'deductible', 'denied')),
  status           text not null default 'open'
                     check (status in ('open', 'approved', 'denied')),
  patient_note     text,
  decision_reason  text,
  decided_by       uuid references users (id) on delete restrict,
  decided_at       timestamptz,
  stripe_refund_id text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table refund_requests is 'Patient-initiated refund of the 5% platform fee on a denied claim. Admin-adjudicated; only outcome_label=denied is refundable. One open request per claim.';

create index if not exists idx_refund_requests_practice_id on refund_requests (practice_id);
create index if not exists idx_refund_requests_claim_id on refund_requests (claim_id);
create index if not exists idx_refund_requests_client_id on refund_requests (client_id);
create index if not exists idx_refund_requests_status on refund_requests (status);

create unique index if not exists idx_refund_requests_one_open_per_claim
  on refund_requests (claim_id)
  where status = 'open';

drop trigger if exists trg_refund_requests_updated_at on refund_requests;
create trigger trg_refund_requests_updated_at
  before update on refund_requests
  for each row execute function set_updated_at();
