# Prod Release Checklist

The dev→main release steps that so far live in one person's head. Anyone
should be able to ship by following this top to bottom. Written 2026-08-01.

## Before the PR

1. **Announce in team chat** - someone may be mid-testing on dev; a merge
   restarts the dev API (~4 min) and repaves the frontend (~1 min).
2. **Schema parity check.** New columns must exist in BOTH migration lists in
   `backend/main.py` (SQLite AND Postgres - they are separate lists) and be
   pre-applied to the dev DB. Missing model columns break every SELECT on the
   table with a 500 (Jun 17 prod outage).
3. **Run the backend test suite**: `python -m unittest discover -p "test_*.py"`
   in `backend/` - at minimum `test_auth_access` (the authorization boundary)
   must pass. `cd frontend && npm run build` must compile clean.

## Shipping

4. **PR dev → main.** Never push main directly. Main requires one review.
5. **Pre-sync prod schema BEFORE the deploy lands**: apply the same
   `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` lines to prod Supabase (the
   backend also self-migrates on boot, but pre-applying removes the window
   where new code reads old schema).
6. **Enable RLS on every new table** on BOTH dev and prod (no policies needed -
   the backend uses the service connection; RLS-on locks out the anon key).
   House rule: `alter table <t> enable row level security;`
7. **Create any new storage buckets** on prod (match dev's public/private
   setting - photos buckets are public, `hr-docs`/`agent-releases` private).
8. **New env vars → prod Azure App Service** before or with the deploy.
   Current required set beyond DB/auth: `NEXUS_VAULT_KEY` (Fernet key - MUST
   be set before real secrets enter the vault), `NEXUS_APP_URL`
   (https://nexus.greensglobal.com - e-sign links in emails point here),
   `NEXUS_STEPUP_ENFORCE` (off until Entra auth-context is configured).

## After the deploy

9. **Run Supabase advisors** (security + performance) on prod after any DDL -
   catches missing-RLS regressions immediately. As of 2026-08-01 both dev and
   prod are clean (zero ERROR/WARN findings).
10. **Smoke test** as a normal user: login, Items, bell/realtime, Tasks,
    Time Clock punch, one e-sign open. GitHub Pages deploy occasionally flakes -
    a re-run of the workflow fixes it.
11. **Watch `/version.json`** - a tab on superseded code self-detects via the
    boot watchdog; if the new build id never appears, the deploy didn't land.

## Rollback

- Frontend: re-run the previous Pages deploy (content-addressed assets make
  this safe). Backend: redeploy the previous main commit from Actions.
  Schema is additive-only (`ADD COLUMN IF NOT EXISTS`), so old code runs fine
  against new schema - never drop columns in a release.
