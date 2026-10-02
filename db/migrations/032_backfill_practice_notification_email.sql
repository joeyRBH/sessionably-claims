-- 032: give existing practices a notification email (ONE-OFF DATA BACKFILL).
--
-- WHY
--
-- Intake-complete alerts go to practices.notification_email and to NOTHING else
-- (there is deliberately no fallback to a staff login — a login can be a plain
-- username that SES rejects). Practices created before register started
-- defaulting it have it NULL, so their alerts have been going nowhere. This sets
-- it, once, to the practice_admin's own email, where that email is a real address.
--
-- WHY THIS IS NOT FOLDED INTO schema.sql
--
-- schema.sql re-runs on EVERY deploy. A backfill there would re-fill the address of
-- a practice that deliberately cleared it in Settings (to stop the emails), on the
-- next deploy — silently undoing a choice the user made. A one-off applied by the
-- operator runs once, recorded in schema_migrations.
--
--   aws lambda invoke --function-name "$(terraform output -raw apply_migration_function_name)" \
--     --payload '{"migration":"032_backfill_practice_notification_email","apply":true}' \
--     --cli-binary-format raw-in-base64-out /tmp/out.json && cat /tmp/out.json
--
-- WHAT IT DOES
--
-- For each active practice whose notification_email is NULL or blank, take the
-- email of its EARLIEST-created active practice_admin whose email looks like an
-- address (same shape as backend/lib/email.js isValidEmail). A practice with no such
-- admin is left alone — NULL stays NULL, which is the honest state. Never overwrites
-- a value that is already set.
--
-- DEPLOY ORDER
--
-- Independent of the handlers: it only fills a column that already exists. It can
-- run any time after the deploy that carries this file (the runner reads it from the
-- deployed bundle). The first user-visible effect is the next intake-complete alert
-- reaching the admin's inbox.

begin;

update practices p
   set notification_email = (
         select btrim(u.email)
           from users u
          where u.practice_id = p.id
            and u.role = 'practice_admin'
            and u.is_active = true
            and btrim(u.email) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'
          order by u.created_at asc, u.id asc
          limit 1
       )
 where p.is_active = true
   and nullif(btrim(coalesce(p.notification_email, '')), '') is null
   and exists (
         select 1
           from users u
          where u.practice_id = p.id
            and u.role = 'practice_admin'
            and u.is_active = true
            and btrim(u.email) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'
       );

commit;

-- ---------------------------------------------------------------------------
-- VERIFY (run BEFORE and AFTER; counts only — no addresses)
-- ---------------------------------------------------------------------------
--
--   select count(*) as still_missing
--     from practices p
--    where p.is_active
--      and nullif(btrim(coalesce(p.notification_email, '')), '') is null
--      and exists (select 1 from users u
--                   where u.practice_id = p.id and u.role = 'practice_admin' and u.is_active
--                     and btrim(u.email) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$');
--   ^^ BEFORE: the number of practices this will fix. AFTER: MUST be 0.
--
--   select count(*) from practices
--    where is_active and nullif(btrim(coalesce(notification_email, '')), '') is not null
--      and notification_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$';
--   ^^ MUST be 0 — nothing non-email was written.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
--
-- There is no automatic undo: the original values were NULL, and a practice that
-- has since set its own address is indistinguishable from one this filled. To stop
-- the emails for a given practice, clear its address in Settings > Notifications.
-- A bulk undo would have to be keyed on the list captured from the BEFORE query.
