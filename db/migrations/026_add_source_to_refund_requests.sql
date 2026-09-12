-- 026: where a refund request came from — a person, or the clearinghouse.
--
-- WHY
--
-- refund_requests records WHO DECIDED (decided_by, decided_at) but nothing about
-- WHO ASKED. Until now that was fine, because there was only one answer: a
-- practice admin typed it in after the patient reported an outcome, and
-- outcome_label meant "what the patient told us".
--
-- Once the software creates requests itself from a clearinghouse denial, that
-- sentence stops being true, and the difference matters to the person deciding:
--
--   * a patient-reported denial is a human account of an EOB they are holding;
--   * a system-created one is an inference from a 277 claim-status response,
--     which is a different kind of evidence and can be wrong in different ways
--     (see the denial-class note in backend/lib/refund_auto.js).
--
-- An admin approving a refund is moving real money on the strength of that
-- evidence. Collapsing the two into one indistinguishable queue would hide the
-- distinction exactly where it is most consequential.
--
-- WHAT IT IS NOT
--
-- Not an authorization field. It records provenance and nothing else; it grants
-- no capability, and no code branches on it to decide what a caller may do.
-- Critically, it is NEVER read from a request body — a client that could claim
-- 'system_denial' could dress its own guess up as the clearinghouse's. Both
-- writers set it as a literal (handlers/refund_requests.js writes
-- 'patient_reported', lib/refund_auto.js writes 'system_denial').
--
-- Not PHI. It is a two-value enum about provenance, carrying no name, date or
-- clinical content.

begin;

-- NOT NULL with a default is safe here, unlike migration 024's CHECK: no
-- existing code writes this column, so every current INSERT simply takes the
-- default and satisfies the constraint. 'patient_reported' is the honest
-- backfill — every row that exists today was typed in by an admin.
alter table refund_requests
  add column if not exists source text not null default 'patient_reported';

comment on column refund_requests.source is
  'Provenance: patient_reported (an admin entered what the patient said) or system_denial (created from a clearinghouse denial). Never read from a request body.';

-- Dropped-then-added rather than guarded: this predicate may need to gain a
-- source later (an ERA/835 path is the obvious one), and re-running must
-- converge on the CURRENT definition rather than skip because some older
-- version of the constraint happens to exist.
alter table refund_requests drop constraint if exists refund_requests_source_check;
alter table refund_requests add constraint refund_requests_source_check
  check (source in ('patient_reported', 'system_denial'));

-- The queue reads "open requests for this practice" constantly and will now want
-- to show provenance alongside. Partial on open, matching how the queue is read.
create index if not exists idx_refund_requests_source
  on refund_requests (practice_id, source)
  where status = 'open';

commit;

-- ---------------------------------------------------------------------------
-- COMPATIBILITY
-- ---------------------------------------------------------------------------
--
-- Additive and inert on arrival. The currently deployed code names this column
-- nowhere, so it keeps inserting rows that take the default and pass the CHECK.
-- Safe to apply well BEFORE the handler change ships — which is the opposite of
-- migration 024, whose CHECK constrained a column the deployed writer was
-- already filling. The difference is that nothing writes this one yet.
--
-- THE ORDER IS NOT SYMMETRIC, AND THIS ONE MATTERS.
--
-- The handler change names `source` explicitly in both INSERTs, so shipping the
-- handlers BEFORE this migration breaks them: 42703, column does not exist.
--   * handlers/refund_requests.js createRequest → a practice admin filing a
--     patient-reported request gets a 500. USER-VISIBLE.
--   * lib/refund_auto.js → swallowed best-effort, so a refresh still succeeds,
--     but no request is raised for the window.
--
-- infra/terraform builds ONE zip shared by every Lambda and deploy.sh runs
-- `terraform apply` BEFORE invoking the migrate Lambda, so the default path has
-- exactly that window. Use the ordered rollout from CLAUDE.md:
--
--   ./deploy.sh -target=aws_lambda_function.migrate   # schema first
--   <confirm MIGRATION OK>
--   ./deploy.sh                                       # then the handlers
--
-- ---------------------------------------------------------------------------
-- VERIFY (expected result stated inline)
-- ---------------------------------------------------------------------------
--
--   select count(*) from refund_requests where source is null;
--   ^^ MUST be 0 — the column is NOT NULL with a default.
--
--   select source, count(*) from refund_requests group by source;
--   ^^ every pre-existing row MUST be 'patient_reported'; 'system_denial'
--      appears only after the handler change ships and a denial is seen.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
--
--   drop index if exists idx_refund_requests_source;
--   alter table refund_requests drop constraint if exists refund_requests_source_check;
--   alter table refund_requests drop column if exists source;
--
-- Safe while no code reads the column. After the handler change ships, dropping
-- it makes system-created requests indistinguishable from patient-reported ones
-- in the admin queue — the requests remain, but the reader loses the one signal
-- telling them what kind of evidence they are approving against. Revert the
-- handler first.
