# Disaster Recovery Runbook

How Nexus is backed up, how to restore it, and the rehearsal that proves the
restore actually works. Written 2026-08-01. A backup that has never been
restored is a hope, not a plan - so the rehearsal (bottom) is the point.

## What exists to recover

| Asset | Where | Backup mechanism |
|---|---|---|
| Postgres data (dev + prod) | Supabase | Automated daily backups + Point-in-Time Recovery (PITR) on the project plan |
| Storage buckets (photos, hr-docs, e-sign PDFs, agent releases) | Supabase Storage | Covered by project backup; NOT versioned per-object |
| Schema | `backend/main.py` migration lists + `models.py` | In git - re-created by `create_all` + migrations on boot |
| Frontend | Cloudflare Pages / GitHub Pages | Rebuildable from git; every deploy is a rollback point |
| Secrets | Azure App Service config + (target) Key Vault | NOT in backups by design - see "Secrets" below |

## Recovery objectives (proposed - confirm with Neil)

- **RPO (max acceptable data loss): 24 hours** from daily backup, or near-zero
  with PITR if enabled on the plan. Decide which the business requires.
- **RTO (max acceptable downtime): 4 hours** for a full restore.

These are targets to ratify, not guarantees. Write the agreed numbers here.

## Restore procedures

### A. Accidental data loss (a few tables / rows)
1. Do NOT let more writes pile on top - if it's spreading, put the API in
   maintenance (scale the App Service to 0 or flip a maintenance flag).
2. Supabase dashboard -> Database -> Backups -> restore to a NEW project (never
   overwrite the live one blind), or use PITR to a timestamp just before the loss.
3. Export the affected tables from the restored project and re-import the rows
   into live with `execute_sql` / `\copy`. Reconcile against `audit_logs` (the
   Activity Log records who changed what and when).

### B. Full project loss (region outage / project deleted)
1. Restore the latest backup into a new Supabase project.
2. Repoint the backend: set `DATABASE_URL` (and the `supabase-*` MCP / client
   URLs + keys) in Azure App Service config to the new project.
3. Re-run `python check_schema_drift.py` against the restored DB to confirm no
   column drift before taking traffic.
4. Re-apply RLS: every table must have RLS enabled (advisors should show zero
   `rls_disabled` findings). Restored projects usually keep it, but verify.
5. Recreate storage buckets if they didn't restore (match public/private per
   RELEASE-CHECKLIST.md step 7).
6. Smoke test per RELEASE-CHECKLIST.md step 10, then take traffic.

### C. Bad deploy (app broken, data fine)
- Frontend: re-run the previous Pages deploy (assets are content-addressed).
- Backend: redeploy the previous `main` commit from GitHub Actions.
- Schema is additive-only, so old code runs against new schema - never drop
  columns, which keeps this rollback always safe.

## Secrets

Secrets are deliberately NOT in any backup. After a restore, re-provision:
`NEXUS_VAULT_KEY` (the vault is Fernet-encrypted with it - **without the SAME
key, vault rows are unrecoverable**, so this key must be escrowed separately,
e.g. in a password manager the founders control), plus the Azure/MSAL, Asana,
and Supabase credentials. Losing the vault key is the one truly unrecoverable
failure - treat it accordingly.

## Rehearsal (do this quarterly - the actual DR guarantee)

1. Restore the latest prod backup into a throwaway Supabase project.
2. Run `DATABASE_URL=<restored> python check_schema_drift.py` - expect clean.
3. Point a LOCAL backend at it and confirm login, an Item list, and an HR
   profile load.
4. Time the whole thing and record it below. If it took longer than RTO, fix
   the slow step now, not during a real outage.
5. Delete the throwaway project.

| Date rehearsed | By | Restore time | Notes |
|---|---|---|---|
| _(pending first rehearsal)_ | | | |
