# Database migrations

`../schema.sql` is the canonical, full snapshot of the data model. This folder holds
**incremental, ordered migrations** applied on top of an existing database as the schema
evolves after the initial `schema.sql` apply.

## Convention

- One file per change, numbered and zero-padded: `001_*.sql`, `002_*.sql`, …
- Name describes the change: `003_add_claims_payer_index.sql`.
- Apply in ascending numeric order. Never renumber or edit a migration that has already
  been applied to any shared environment — add a new one instead.
- Each migration should be idempotent / re-runnable where practical
  (`add column if not exists`, `create index if not exists`, guarded `do $$ ... $$`).
- Keep `schema.sql` in sync: when you add a migration, also fold the change into
  `schema.sql` so a fresh database built from it matches a migrated one.
- Match the project conventions (UUID PKs, `timestamptz` + `set_updated_at()` trigger,
  `text` + `CHECK` over enums, `numeric(12,2)` money, `practice_id` scoping).

## Applying

```bash
# Apply a single migration (psql connection from your env / secrets manager):
psql -v ON_ERROR_STOP=1 -f db/migrations/001_example.sql

# Or all in order:
for f in db/migrations/[0-9]*.sql; do
  echo ">> $f"
  psql -v ON_ERROR_STOP=1 -f "$f" || break
done
```

> RDS sits inside a VPC — run these from a host with network access (bastion / tunnel).
> Never commit real credentials.

## Status

No migrations yet. Core authentication (register/login/me) needed **no** schema change —
the existing `users`, `practices`, and `invitations` tables already cover it. Add the
first migration here only when a real schema change is required.
