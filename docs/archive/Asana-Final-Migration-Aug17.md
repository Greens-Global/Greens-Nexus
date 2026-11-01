# Asana Final Migration Audit - 08/17/2026

Asana subscription ends **08/19/2026**. This is the complete read-only audit of
what is still in Asana, what is in Nexus prod, the diff between them, and the
prepared (NOT executed) artifacts for the migration. Nothing was written to any
database or to Asana during this audit - every query was a SELECT, every Asana
call a GET.

Raw inventories, diff CSVs, and the scripts that produced them are in the
session scratchpad:
`C:\Users\Vlow\AppData\Local\Temp\claude\C--Users-Vlow-Desktop-Greens-Nexus---First-Build\ff45eefe-7b3b-41b8-816f-d20e501a0c63\scratchpad\asana-audit\`
(`asana/` = per-project JSONL inventory, `nexus/` = prod table exports,
`out/` = diff results, `PROGRESS.md` = timeline). Reviewer copies of the three
key tables are in docs: `Asana-Audit-Aug17-assignee-diff.csv`,
`Asana-Audit-Aug17-missing.csv`, `Asana-Audit-Aug17-identity-map.csv`.

---

## 1. Verdict on Neil's "120+ tasks the site managers can't see"

**The hypothesis is confirmed in kind, but the misassignment accounts for only
~44 tasks. The rest of what the managers "can't see" is a Nexus visibility
problem, not missing or misassigned data.**

What actually happened, with evidence:

1. The two-way sync stopped applying inbound changes on **08/04/2026**
   (`asana_sync_config.enabled = false`; every gm-task link's `last_synced_at`
   is frozen at 08/04). 
2. On **08/14/2026** Neil reassigned batches of Asana tasks from the shared
   gm accounts to the real site managers. The Asana story stream on the
   spot-checked tasks literally reads "Neil Kadakia assigned to Valinda
   Cranfill", dated 08/14 (section 8).
3. Nexus never received those changes. Result today:
   - **40 open tasks** still carry a gm address in Nexus while Asana assigns
     them to a real manager: **Amy 21, Valinda 13, Miranda 6, Ashley 0**.
   - **4 open tasks** are unassigned in Nexus while Asana assigns them to
     Miranda (3) or Valinda (1).
   - The other ~690 reassignments had already synced **before** 08/04 and are
     correct in Nexus (Valinda 329, Miranda 194, Amy 151, Ashley 19 linked
     tasks agree on both sides).
   - **701 gm-assigned Nexus tasks are completed on both sides** and are now
     *unassigned* in Asana (the gm accounts were deprovisioned from the
     workspace, which stripped their assignments). Historical records only -
     no manager needs to see them, recommend leaving them as-is.

**Why managers still "can't see" hundreds of correctly assigned tasks:** every
GS project in Nexus is `access_level = "restricted"`, and the membership lists
have gaps - most glaring: **Amy Bolanos is not a member of GSE Operations**,
her own 550-task site project (the member list still contains
`gm04@greensstorage.com` instead), and **Miranda is not a member of GSM IT**.
Unless a restricted project's tasks are visible to their assignee regardless of
membership, Amy sees nothing of GSE Operations. Fixing membership/access is an
app-side action for the execution session (add the four managers to their
site projects, remove the dead gm entries), separate from the SQL pass.

Asana-side open-task load per manager today: Valinda 123, Miranda 95, Amy 62,
Ashley 9. If Neil's "120+" was a single-manager count, it matches Valinda's
open list; if it was the batch he reassigned on 08/14, most of it was already
in Nexus correctly and hidden by the access gaps above.

## 2. Inventory summary

| | Count |
|---|---|
| Asana projects (union of both tokens, incl. 6 archived) | **125** |
| Asana tasks + subtasks (deduped by gid) | **6,635** |
| Asana workspace users | 51 |
| Nexus prod tasks | **6,373** |
| Nexus-Asana link rows (`asana_task_links`) | 6,326 |
| Links resolving to a live Asana task | 6,326 (100%) |
| Nexus tasks with no Asana link (Nexus-native) | 47 |

Method notes:
- Token: the service PAT stored in `asana_sync_config.token` (owner: Sai
  Malladi). It turned out to be blind to 4 projects (**GSF Operations, GS
  Fairfield**, Asana Tasks Status, Satish Mandale's previously assigned tasks);
  those were inventoried with the setup PAT (`setup_token`, owner: Visesh
  Lodha). Neither .env holds these tokens - they live only in that DB row.
- 113 link rows initially looked orphaned; all 113 resolved fine under the
  setup token (108 in GSF Operations / GS Fairfield, 5 project-less). **Zero
  links are actually dead - nothing was deleted in Asana that Nexus still holds.**
- Residual blind spot: a project private to some *third* member (e.g. a
  Neil-only private project) is invisible to both PATs and absent from this
  inventory. The connected per-user Asana OAuth accounts are Visesh, Aarav,
  Pranshu (no Neil). Before cancellation, have Neil eyeball the project list in
  Asana's admin console against `scratchpad\asana-audit\asana\projects.json`
  (125 names).

## 3. Diff A - Asana tasks with no Nexus counterpart: 309 (252 truly missing)

309 Asana tasks have no link row. 57 of them match an existing Nexus task
title exactly (normalized); most of those are same-title duplicates that exist
in Asana itself (e.g. five distinct "GSVC Sell Rate Adjustment" tasks) or
pre-link imports the engine will adopt. **252 are truly missing; 207 of the
309 are open.**

**Root cause - this is why the Aug 15 "Pull new only" found only 3-4 tasks:
293 of the 309 live in 22 Asana projects that were never added to
`asana_project_map`. The additive pull only walks mapped projects.**

Missing by project (project / missing tasks / mapped? / archived?):

| Project | Missing | In map? | Archived? |
|---|---|---|---|
| GST Construction | 133 | NO | no |
| Offboarding [Blue Elliott] | 24 | NO | YES |
| GSM: Annual Maintenance | 18 | NO | YES |
| GSVC: Annual Maintenance | 17 | NO | YES |
| GST: Annual Maintenance | 16 | NO | YES |
| Duplicate of Test Project by Sagar | 15 | NO | no (test project) |
| Ankush Test Project-Software implementation | 14 | NO | no (test project) |
| GSF Maintenance | 14 | NO | no |
| Test Project by Sagar - August | 11 | NO | no (test project) |
| GSM Storage Shed | 10 | NO | YES |
| GS Murietta | 8 | NO | no |
| Nexus | 8 | yes | no |
| Automatic Task Assigning | 7 | NO | no |
| NEXUS - FEEDBACK & BUGS | 5 | yes | no |
| Construction GSVC House 29277 Valley Center Road | 4 | NO | no |
| Corporate Training, LMS & KB | 2 | yes | no |
| Construction - Brown Trailer - VC | 1 | NO | no |
| GS Fairfield | 1 | yes | no |
| Maintenance 47385 Rainbow Canyon Road | 1 | NO | no |

Missing-task assignees: 164 unassigned, sam@greensglobal.com 63 (GST
Construction), then small counts (Sagar 13, Malay 11, Sai 11, Roger 6, Visesh
6, Jackson 6, Neil 5, Valinda 5, Miranda 1, ...). The three test projects (40
tasks) are a human call - probably skip them.

What dies with these tasks if not migrated: **133 attachments (227 MB) and 244
comments** live on the missing tasks Asana-side (detail per task in
`out/missing_detail.json`).

## 4. Diff B - assignee mismatches on linked tasks: 962

| Category | Count | Action |
|---|---|---|
| gm-to-unassigned (Nexus gm0X, Asana now unassigned; 700/701 completed both sides - gm deprovisioning artifact) | 701 | none (historical) |
| asana-blank-nexus-person (Nexus has a person, Asana blank - Nexus is richer) | 137 | none |
| alias-only (same person, Asana shows @greensg.onmicrosoft.com guest relay) | 72 | none |
| **gm-to-person (Nexus gm0X, Asana a real site manager - Neil's bucket)** | **40** | **Fix SQL section 1** |
| person-to-person-CONFLICT (both real people, different) | 8 | human call (below) |
| nexus-blank-asana-person (Nexus blank, Asana a manager) | 4 | Fix SQL section 3 (optional) |

The 40 gm-to-person tasks (all open; full rows in
`Asana-Audit-Aug17-assignee-diff.csv`): gm04 -> Amy Bolanos x21 (GSE
Operations / GSE Maintenance / GS Area Manager), gm02 -> Valinda Cranfill x13
(GSVC Operations / GS Area Manager), gm03 -> Miranda Negrete x6 (GSM IT / GS
Area Manager).

The 8 conflicts needing a human call (Nexus person vs Asana person):

| Task | Nexus assignee | Asana assignee |
|---|---|---|
| Task from Asana | Arnav Kapoor | Sagar Kumar Shoundik |
| Accounting - Verify Export into Intacct | Charmi Desai | Neil Kadakia |
| Greens Storage Murrieta Storage Containers | craig@builtbycmi.com | Sahil Desai (sam@) |
| Set up protection plans | Miranda Negrete | Neil Kadakia |
| LinkedIn for Greens Global | Pranshu Pandey | Visesh Lodha |
| Switch to PTI Cloud | Sai Malladi | Neil Kadakia |
| Integrate Nexus with Cubby tasks | Visesh Lodha | Neil Kadakia |
| Power BI - cancel and recreate metrics | Visesh Lodha | Neil Kadakia |

Separate Nexus-side finding (not an Asana diff): **56 Nexus tasks are assigned
to `vinod@greensg.onmicrosoft.com`**, the M365 guest relay of Vinod Bhole's
Asana account. His Nexus login is vinod.bhole@greensglobal.com, so these are
invisible to him. Fix SQL section 2 (optional) consolidates them.

## 5. Diff C - staleness (Asana newer than the last sync): 549 tasks

549 linked tasks changed in Asana after their `last_synced_at` in a way Nexus
does not reflect. Change kinds: **assignee 545** (includes the 40+4 above and
488 "-> unassigned" from the gm deprovisioning), **completed 4** (including
"Check Monthly Scheduled Rent Increases" reopened in Asana while Nexus has it
completed), **due date 2**. Full list: `out/diff_stale.csv` /
`Asana-Audit-Aug17-assignee-diff.csv` companion `diff_stale.csv` in scratchpad.
Report-only; the assignee portion is covered by the fix SQL, and the 6
completed/due rows are listed for manual review.

## 6. Identity mapping

Site managers (all present and active in `nexus_employees`):

| Person | Nexus email | Title | Shared account replaced |
|---|---|---|---|
| Ashley Vizcarra | ashley.vizcarra@greensstorage.com | Site Manager I | gm01@greensstorage.com (GST) |
| Valinda Cranfill | valinda.cranfill@greensstorage.com | Area Manager III | gm02@greensstorage.com (GSVC) |
| Miranda Negrete | miranda.negrete@greensstorage.com | Technical Manager | gm03@greensstorage.com (GSM) |
| Amy Bolanos | amy.bolanos@greensstorage.com | Area Manager I | gm04@greensstorage.com (GSE) |

(gm-to-site attribution from Nexus project residency of the gm-assigned tasks:
gm01 59/64 in GST Operations, gm02 110/116 in GSVC Operations, gm04 548/555 in
GSE Operations; gm03 has only 6 tasks, mostly GS Area Manager/GSM IT.)

Every other Asana assignee seen maps by exact email, by name, or by unique
local part (the `@greensg.onmicrosoft.com` guest relays: priyanka.sahu,
urmi.gor, sagar.shoundik, arnav.kapoor, pranshu.pandey, aarav.mehta, vinod ->
their @greensglobal.com identities). Full 55-row table:
`docs/Asana-Audit-Aug17-identity-map.csv`.

**Asana identities with NO Nexus match (do not invent emails):**

| Asana identity | Tasks assigned in Asana |
|---|---|
| info@craftywebbies.com | 11 |
| sgilbertmd@gmail.com | 2 |
| ryan@westglare.com | 1 |
| aarnav@greensglobal.com | 0 |
| arnav@greensglobal.com | 0 |
| archana@kadakia.com | 0 |
| shivaniray@gmail.com | 0 |
| skipsmanagementllc@gmail.com | 0 |
| umesh.deshpande@greensg.onmicrosoft.com | 0 |

(craig@builtbycmi.com and skipsmanagementllc@gmail.com also appear as Nexus
assignees on 120 / 2 tasks - external collaborators, left as-is.)

## 7. Attachment risk

How inbound Asana attachments are stored (`asana_sync._pull_attachments`):
Asana-hosted files up to 5 MB are downloaded and re-uploaded to Supabase
storage (safe). Files **over 5 MB** keep their Asana URL. Externally hosted
attachments (Google Drive etc.) keep an `app.asana.com` permanent/view URL.

Prod `task_attachments` URL audit (3,555 rows):

| Host | Rows | Distinct tasks | Risk |
|---|---|---|---|
| occnthvvymisyijxebal.supabase.co | 3,088 | - | safe |
| **asanausercontent.com** | **447** | **217** | **DIES at cancellation** (signed S3 URLs; most are already expired signatures) |
| **app.asana.com** | **19** | **12** | **DIES at cancellation** (view/permanent URLs behind Asana login) |
| data: URLs | 0 | - | n/a |

The 447 asanausercontent rows carry stated sizes summing to **~3.9 GB**
(consistent with the >5 MB skip threshold). Rescue = re-fetch each linked
attachment's fresh `download_url` via `GET /attachments/{gid}` (the gid is in
`asana_attachment_links`, 3,546 rows) and store via the existing
`task_files.store_bytes` path, before 08/19. The 19 app.asana.com rows are
external-host pointers; resolve each via `GET /attachments/{gid}` and store
the underlying external URL instead.

Plus the missing tasks' Asana-side files (section 3): 133 files, ~227 MB -
these are rescued automatically by the import/pull-new pass (files <= 5 MB) or
by the same >5 MB rescue script.

**Total download estimate if full rescue is needed: ~4.2 GB** (3.9 GB over-cap
rows + 227 MB on missing tasks). Watch Supabase egress/storage budget - this
roughly triples current storage use in one pass.

## 8. Spot-check evidence (5 gm tasks end to end)

All five: Nexus `assignee_email = gm02@greensstorage.com`, status not_started,
link `last_synced_at` 08/04/2026; Asana current assignee Valinda Cranfill with
an assignment story by Neil Kadakia on **08/14/2026** (after the last sync):

| Asana gid | Task | Nexus assignee | Asana assignee | Asana story |
|---|---|---|---|---|
| 1216431203081641 | EOM Update | gm02@ | valinda.cranfill@ | 08/14 "Neil Kadakia assigned to Valinda Cranfill" |
| 1203632553374975 | Bulbs and Ballast | gm02@ | valinda.cranfill@ | 12/31/2022 assigned to "Greens Storage Valley Center" (the gm02 shared account), then 08/14/2026 Neil -> Valinda |
| 1210633579286511 | Verify all Delinquent/Auction Status - On Track for Auction | gm02@ | valinda.cranfill@ | 08/14 Neil -> Valinda |
| 1213250037579899 | Submit List of Inactive Units | gm02@ | valinda.cranfill@ | 08/14 Neil -> Valinda |
| 1212270853729104 | Make sure all cash was deposited in the bank | gm02@ | valinda.cranfill@ | 08/14 Neil -> Valinda |

Raw payloads: `out/spotcheck.json`.

## 9. Execution runbook (for the write session, after human review)

Order matters. Do not deploy anything while a pull is running (advisory-lock
convoy - Aug 15 lesson). All steps below except 9.5/9.6 are app/API actions,
not raw SQL.

**9.0 Preconditions**
- Confirm `NEXUS_ASANA_PUSH_DISABLED=true` on the prod Azure app (kill switch;
  keeps every step below pull-only). Verify, do not assume.
- Keep `asana_sync_config.enabled = false` and `manual_sync_enabled = false`.
  The additive pull-new works with sync off by design.
- Do NOT enable `delete_sync` + full Pull at any point after 08/19: with the
  workspace gone or emptied a reaping pull would delete Nexus tasks. (Today
  zero links are orphaned, so there is nothing a reap would legitimately do.)

**9.1 Map the 19 never-mapped projects that have tasks** (section 3 table;
skip the 3 test projects if Neil agrees)
- Simplest for the non-archived ones: run **Manage -> Two-way Sync ->
  Import all** (`POST /task-config/asana-sync/import-all`). It walks every
  non-archived project the token can see, creates/adopts Nexus projects,
  writes the map rows itself (`ensure_project_map`), and is additive
  (delete_sync forced off on the import path). It uses `setup_token`
  (Visesh's PAT) - which also covers GSF Operations / GS Fairfield that the
  service token cannot see. Note: it will also import the test projects -
  either accept that and archive them in Nexus, or use manual mapping instead.
- The 5 ARCHIVED projects (Offboarding [Blue Elliott], 3x Annual Maintenance,
  GSM Storage Shed - 85 tasks) are NOT covered by import-all. Either
  unarchive them in Asana first (human, in the Asana UI) and rerun import-all
  / pull-new, or create a Nexus project for each and add map rows via
  **PUT /task-config/asana-sync/projects** - CAUTION: that endpoint replaces
  the whole table; send all existing 102 mappings plus the new rows.

**9.2 Additive pull** - `POST /task-config/asana-sync/pull-new` (Manage ->
Two-way Sync -> Pull new only). Background thread, returns immediately,
`pull_running_at` guard refuses overlapping runs (20-min stale window), takes
the Postgres advisory lock per project, commits per project, idempotent -
re-run until the log shows `[pull-new] done: +N created`. Expect roughly the
missing counts of section 3. Do not deploy during the run.

**9.3 Verify** - re-run the missing diff (scratchpad `diff_audit.py` after a
fresh links export, or spot SQL counts): expect ~0 truly missing outside
deliberately skipped projects.

**9.4 Attachment rescue** (before 08/19, after 9.2 so new tasks' files exist):
BUILT as a backend feature on branch `feat/asana-attachment-rescue`
(`backend/asana_rescue.py` + two endpoints in `routers/task_config.py`).
After that branch deploys, trigger it on the prod API (admin/manager auth,
same gating as pull-new):

```
# start (returns immediately; background thread; one-at-a-time guard)
curl -X POST https://<prod-api>/asana-sync/rescue-attachments \
     -H "Authorization: Bearer <token>"
# -> {"started": true}   or   {"started": false, "alreadyRunning": true}

# progress (poll; safe anytime)
curl https://<prod-api>/asana-sync/rescue-status -H "Authorization: Bearer <token>"
# -> {"running": true, "worker": {"state": "running", "done": 120, "total": 466,
#     "rescued": 98, "external_resolved": 7, "failed": 3, "no_gid": 2,
#     "bytes_rescued": 812345678}, "at_risk_remaining": 346, "rescued_total": 105}
```

What it does: for every `task_attachments` row on asanausercontent.com /
app.asana.com it resolves the attachment gid from `asana_attachment_links`,
GETs `/attachments/{gid}` (service token, setup token fallback on 403/404)
for a fresh `download_url`; Asana-hosted files are streamed down and stored
through the existing task-files bucket helpers (files over 32 MB streamed,
over 512 MB skipped and counted); external-host pointers get their underlying
external URL written instead. The pre-rescue URL is kept in the new
`task_attachments.original_asana_url` column; failed rows are left untouched
and counted. Idempotent - run it repeatedly until `at_risk_remaining` stops
falling; whatever remains is in the failed/no-gid buckets. Commits per batch
of 6, max 3 concurrent downloads. Migrations for `rescue_running_at` +
`original_asana_url` are in both of `main.py`'s lists and run on deploy.

**9.5 Assignee fix pass** - `docs/Asana-Assignee-Fix-Aug17.sql` in a psql /
Supabase SQL editor session: run the snapshot SELECT, save its output, then
the guarded transaction (40 gm rows), verify `still_on_gm = 0`, COMMIT.
Optional sections 2 (vinod alias, 56 rows) and 3 (4 blank -> manager rows)
are separate transactions - run or delete per Neil/Charmi's call.
Rollback file: `docs/Asana-Assignee-Rollback-Aug17.sql`.

**9.6 Conflicts + staleness leftovers** - decide the 8 conflicts (section 4
table) and the 6 completed/due stale rows (section 5) by hand in the UI.

**9.7 Visibility fix** - add Ashley/Valinda/Miranda/Amy to their site
projects' members (GSE Operations is missing Amy entirely; GSM IT missing
Miranda), remove gm01-gm04 from all `member_emails`, and re-test as each
manager (NEXUS_DEV_EMAIL impersonation) that their task lists are populated.
This - not missing data - is the likely bulk of "managers can't see tasks."

**9.8 After cancellation** - leave all Asana sync toggles off permanently;
consider clearing `asana_sync_config.token`/`setup_token` and the
`asana_user_tokens` rows once the rescue is confirmed, so nothing can fire at
a dead workspace.

## 10. Artifacts

| Path | What |
|---|---|
| `docs/Asana-Final-Migration-Aug17.md` | this report |
| `docs/Asana-Assignee-Fix-Aug17.sql` | prepared fix (snapshot + 40 guarded UPDATEs; optional sections 2 and 3) - NOT executed |
| `docs/Asana-Assignee-Rollback-Aug17.sql` | exact inverse - NOT executed |
| `docs/Asana-Audit-Aug17-assignee-diff.csv` | all 962 assignee mismatches, categorized |
| `docs/Asana-Audit-Aug17-missing.csv` | all 309 missing tasks with per-task verdicts |
| `docs/Asana-Audit-Aug17-identity-map.csv` | full Asana -> Nexus identity mapping |
| scratchpad `asana-audit/asana/` | full Asana inventory (125 projects, 6,635 tasks, users) |
| scratchpad `asana-audit/nexus/` | prod exports (tasks, links, projects, sections, map, attachments, employees) |
| scratchpad `asana-audit/out/` | diff outputs incl. `summary.json`, `diff_stale.csv`, `missing_detail.json`, `spotcheck.json`, `dead_link_classify.json` |
| scratchpad `asana-audit/*.py` | the scripts (inventory, diff, phase-2 detail, SQL generator) - re-runnable |

Housekeeping noticed during the audit (not acted on): the Aug 15 backup tables
`tasks_bak_aug15`, `asana_task_links_bak_aug15`, `task_projects_bak_aug15`
have **RLS disabled** on prod - anyone with the anon key can read them. Enable
RLS or drop them at the next release.
