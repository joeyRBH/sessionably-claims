# Claimsub database

`schema.sql` is the **source of truth** for the Claimsub PostgreSQL data model. It is
applied to the RDS instance behind `api.claimsub.com` separately from the Vercel
frontend deploy.

## What's in here

- **`schema.sql`** — the full schema: 15 application tables plus an append-only
  `audit_log`, the shared `set_updated_at()` trigger function, table comments,
  foreign keys, indexes, and `CHECK` constraints.

## Conventions

- UUID primary keys via `gen_random_uuid()` (requires the `pgcrypto` extension, created
  at the top of the file).
- `timestamptz` `created_at` / `updated_at` on every table; `updated_at` is maintained by
  the shared `set_updated_at()` trigger. `audit_log` is the exception — it is append-only
  and has only `created_at`.
- `text` + `CHECK` constraints instead of native `ENUM` types (easier to evolve).
- Soft-delete over hard-delete (`is_active` / `is_hidden`).
- Foreign keys default to `ON DELETE RESTRICT` to protect financial and PHI records.
  The one deliberate exception is `claim_events.claim_id`, which `CASCADE`s because
  events have no meaning without their parent claim.
- `practice_id` is carried on every practice-scoped table for query scoping and future
  row-level security.
- Money is `numeric(12,2)`; percentages are `numeric(5,2)`.

The file is written to be **re-runnable** where practical: `create extension if not
exists`, `create table if not exists`, `create or replace function`, `create index if not
exists`, and `drop trigger if exists` before each `create trigger`. Re-running it will not
drop or recreate existing tables, so it is safe to apply on top of an existing database to
pick up new tables/indexes. It does **not** perform destructive migrations of existing
columns — alter existing tables with dedicated migration scripts.

## Applying it

> **Note:** RDS sits inside a VPC. Run these from somewhere with network access to the
> database (a bastion host, a VPC-attached environment, or an SSH tunnel). Never commit
> real credentials — use environment variables or your secrets manager.

### With `psql`

```bash
# Connection details come from your environment / secrets manager, e.g.:
export PGHOST=claimsub-prod.xxxxxx.us-east-1.rds.amazonaws.com
export PGPORT=5432
export PGDATABASE=claimsub
export PGUSER=claimsub_app
export PGPASSWORD=...        # pull from your secrets manager, don't hardcode

psql -v ON_ERROR_STOP=1 -f db/schema.sql
```

`ON_ERROR_STOP=1` makes `psql` exit non-zero on the first error, which is what you want in
CI / deploy scripts.

### Via an SSH tunnel to a bastion

```bash
ssh -N -L 5432:claimsub-prod.xxxxxx.us-east-1.rds.amazonaws.com:5432 bastion-host &
PGHOST=localhost PGPORT=5432 psql -v ON_ERROR_STOP=1 -f db/schema.sql
```

## Verifying

After applying, sanity-check what landed:

```sql
-- Tables
\dt

-- One table's columns / constraints
\d+ claims

-- Confirm the updated_at triggers are attached
select event_object_table, trigger_name
from information_schema.triggers
where trigger_name like 'trg_%_updated_at'
order by event_object_table;
```

## Table overview

| Table | Purpose |
| --- | --- |
| `subscription_plans` | Catalog of billing tiers (global). |
| `practices` | Top-level tenant — the group practice. |
| `practice_subscriptions` | A practice's current plan + Stripe subscription state. |
| `users` | Staff: practice admins, clinicians, billing staff. |
| `clients` | People receiving care (PHI-heavy). |
| `insurance_records` | OON benefit data per client (PHI). |
| `sessions` | Therapy sessions (claims attach to these). |
| `claims` | OON claim records (multiple per session allowed). |
| `claim_events` | Status-history log per claim (cascades with claim). |
| `transactions` | Platform fees, subscriptions, refunds, payouts, adjustments. |
| `documents` | Practice policy + questionnaire templates. |
| `document_signatures` | Legal e-signature records. |
| `questionnaire_responses` | Client intake responses. |
| `invitations` | Tokenized staff invites. |
| `shareable_links` | Custom public slugs per practice. |
| `audit_log` | Append-only HIPAA audit trail. |
