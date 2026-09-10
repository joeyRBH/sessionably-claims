-- 023: partner_credentials — machine-to-machine access, scoped to ONE practice.
--
-- WHY THIS EXISTS
--
-- Sessionably (the sibling EHR) needs to create, submit and track claims, and to
-- send a client the card-setup link, on behalf of a practice that uses both
-- products. Before this migration there was no way to do that: the only
-- authentication Reddably had was `backend/lib/jwt.js`, a 12-hour HS256 token
-- minted for a HUMAN at sign-in, carrying { sub, practice_id, role }.
--
-- Reaching for that token from another system would have meant one of:
--
--   * storing a clinician's Reddably PASSWORD and signing in as them — the
--     integration would hold a human credential, act with that human's full
--     role, and be invisible in the audit log as anything other than that
--     person;
--   * shipping the signing secret to Sessionably so it could mint its own user
--     tokens — strictly worse, that is every practice at once;
--   * lifting a browser session token — expires in 12 hours, is not revocable
--     independently, and is the same full-role credential.
--
-- All three were rejected. This table is the alternative: a credential that
-- belongs to the INTEGRATION rather than to a person, is bound to exactly one
-- practice, carries only the scopes it was granted, and can be revoked on its
-- own without touching anybody's ability to sign in.
--
-- WHAT IS STORED, AND WHAT IS NOT
--
-- The secret is never stored. `secret_hash` holds a scrypt digest with a
-- per-credential random salt (see backend/lib/partner_auth.js). The plaintext
-- secret exists exactly once, in the output of the issuing script, and is not
-- recoverable afterwards — a lost secret is rotated, not looked up.
--
-- `key_id` is the public half and IS stored in the clear: it is the lookup key,
-- it is safe in a log line, and having it separate is what lets a request be
-- attributed and rate-limited before any hashing work is done.
--
-- NO SELF-SERVICE ISSUANCE
--
-- There is deliberately no HTTP endpoint that mints one of these. Rows are
-- created by an operator running backend/scripts/issue_partner_credential.js,
-- the same posture as Sessionably's practice_entitlements switch. An ordinary
-- authenticated user — including a practice admin — cannot grant an external
-- system access to their practice's PHI.
--
-- REVOCATION IS THE OFF SWITCH
--
-- `revoked_at` is checked on every request. Setting it stops the integration
-- immediately and permanently for that credential; it is never cleared (rotate
-- by issuing a new row). `expires_at` is an optional second bound.

begin;

create table if not exists partner_credentials (
  id            uuid primary key default gen_random_uuid(),

  -- The single practice this credential may ever act for. Every request
  -- authenticated by it is scoped to this id, and the id comes from HERE — never
  -- from the request — which is what stops a caller naming someone else's
  -- practice. ON DELETE RESTRICT matches the rest of the financial/PHI schema.
  practice_id   uuid not null references practices (id) on delete restrict,

  -- Which integration this is. A CHECK rather than free text so an unknown
  -- partner cannot be introduced by an INSERT typo; adding one is a migration,
  -- which is the review point we want.
  partner       text not null check (partner in ('sessionably')),

  -- Public half. Unique because it is the lookup key.
  key_id        text not null unique,

  -- scrypt(secret, salt) — see backend/lib/partner_auth.js for the exact
  -- parameters and the encoded form. Never the secret itself.
  secret_hash   text not null,

  -- Least privilege, enforced per request. A credential issued for claim
  -- preparation cannot submit, and one issued for submission cannot send a
  -- client a text. Empty is legal and means "authenticate but do nothing",
  -- which is a useful state for testing a link without granting anything.
  scopes        text[] not null default '{}',

  created_at    timestamptz not null default now(),
  created_by    uuid references users (id) on delete restrict,   -- the operator, when known
  last_used_at  timestamptz,                                     -- best-effort, for spotting a stale or leaked key
  expires_at    timestamptz,                                     -- optional hard bound
  revoked_at    timestamptz,                                     -- the off switch; never cleared
  label         text                                             -- operator note, e.g. 'Cedar Hollow pilot'

);

comment on table partner_credentials is
  'Machine-to-machine credentials for a sibling product, scoped to one practice and one scope set. Secret is scrypt-hashed and never recoverable. Issued only by an operator script; revoked_at is the immediate off switch.';

-- The hot path: look a credential up by its public half. Partial index — a
-- revoked credential is never a candidate, so it does not sit in the index that
-- every request probes.
create index if not exists partner_credentials_active_key_idx
  on partner_credentials (key_id)
  where revoked_at is null;

-- Operator view: what does this practice currently have outstanding.
create index if not exists partner_credentials_practice_idx
  on partner_credentials (practice_id);

-- ---------------------------------------------------------------------------
-- audit_log must be able to name a partner as the actor
-- ---------------------------------------------------------------------------
--
-- audit_log.actor_type is CHECK-constrained to ('user','patient_link','system').
-- A partner request is none of those: attributing it to 'system' would hide
-- which integration acted, and it has no actor_user_id to attribute it to. So
-- the constraint gains a fourth value.
--
-- Dropping and re-adding is the only way to widen a CHECK in PostgreSQL. It is
-- safe here: the new predicate is a strict superset of the old one, so no
-- existing row can fail it, and the table is append-only.
alter table audit_log drop constraint if exists audit_log_actor_type_check;
alter table audit_log add constraint audit_log_actor_type_check
  check (actor_type in ('user', 'patient_link', 'system', 'partner'));

-- Which credential acted. Nullable: every pre-existing row, and every human
-- request, has none.
alter table audit_log
  add column if not exists actor_partner_credential_id uuid
    references partner_credentials (id) on delete restrict;

comment on column audit_log.actor_partner_credential_id is
  'Set when actor_type = ''partner''. Names the credential, never the secret.';

commit;

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
--
-- Reversible, with one ordering caveat: audit_log rows may reference
-- partner_credentials, and the FK is ON DELETE RESTRICT, so the table cannot be
-- dropped while any partner-attributed audit row survives. Retention is 6 years
-- and audit_log is append-only, so in practice the rollback is:
--
--   1. revoke every credential   update partner_credentials set revoked_at = now();
--
-- which stops all partner access immediately and is sufficient on its own.
-- Dropping the table is NOT recommended: it would require deleting audit rows,
-- and destroying an audit trail to undo a schema change is the wrong trade.
--
-- If a full structural rollback is genuinely required and no partner request was
-- ever audited:
--
--   alter table audit_log drop column if exists actor_partner_credential_id;
--   alter table audit_log drop constraint if exists audit_log_actor_type_check;
--   alter table audit_log add constraint audit_log_actor_type_check
--     check (actor_type in ('user', 'patient_link', 'system'));
--   drop table if exists partner_credentials;
--
-- Re-adding the narrower CHECK fails if any 'partner' row exists, which is the
-- correct outcome: it says the audit trail is in use and the rollback is unsafe.
