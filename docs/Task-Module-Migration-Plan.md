# Task Module → Nexus Migration Plan

**Date:** 2026-07-09
**Source:** `C:\Users\Vlow\Desktop\task-module-export` (17,043 lines, 154 `.ts/.tsx` files)
**Target:** `frontend/` (JSX) + `backend/` (FastAPI/Supabase)

## Context

The export is a polished, feature-complete task/project/portfolio management app built as a
**standalone island**: React 19 + TypeScript + Tailwind v4 + React Query + Zustand + Radix, with
**100% client-side localStorage persistence** and Asana-oriented sync metadata (no real backend).
It was designed to drop into a host "Nexus" shell (reads `window.__NEXUS_SSO_ACCOUNT__`, mounts
under `/tasks`, omits its own top bar/login).

Nexus disagrees with it on **every layer**: JSX (no TS), inline-styles + CSS-variable tokens
(no Tailwind), hand-rolled Context providers (no Zustand/React Query), real FastAPI/Supabase
backend via `api.js`. Nexus currently has only a 230-line mock `Tasks.jsx` placeholder, a `tasks`
sidebar entry, 4 demo `/tasks` endpoints, and a flat 11-column `Task` model.

**Decisions taken (this session):**
1. **Full rewrite to Nexus conventions** — TSX→JSX, Tailwind→inline styles, Zustand/React-Query→Context.
2. **Wire the real FastAPI/Supabase backend now** — no localStorage in the shipped module.
3. **Bring everything** — all task views, projects, portfolios, teams, manage, tickets, changelog, etc.
4. **One `Tasks` view with internal tabs** — module keeps its own tab shell under the single sidebar entry.

This is a **multi-week program, not a one-branch task**. It is split into 7 mergeable phases below,
each its own branch born from fresh `dev` and merged within a day or two per the repo workflow.

---

## Target architecture

### Frontend layout
```
frontend/src/
  views/Tasks.jsx                 # thin shell: renders the module tab strip + active sub-view
  tasks/                          # NEW home for the ported module (mirrors export's src/nexus/*)
    TasksContext.jsx              # replaces React Query + Zustand + NexusTaskStore (template: RequisitionContext.jsx)
    theme.js                      # nx-* design tokens → Nexus CSS-var / inline-style helpers
    lib/                          # PORTABLE business logic, ported ~as-is (filters, stats, recurrence, automation rules)
    views/  (List/Board/Calendar/Timeline/Files/Dashboard/Workload)
    detail/ (TaskDetailDrawer + ~15 panels)
    productivity/ (Filter-Sort-Group bar, SavedViews, Templates, IntakeForm, CreateTask, BulkActions)
    projects/ portfolios/ teams/ manage/ tickets/ home/ changelog/ reporting/
    people/ (PeoplePicker → getRolesDirectory)
```

### Backend layout
```
backend/
  models.py            # append ~13 new SQLAlchemy models (append-only; keep existing flat Task or migrate it)
  main.py              # register new routers + add ALTER TABLE migration lines (append-only)
  routers/
    tasks.py           # EXPAND existing (CRUD, subtasks, deps, comments, attachments, activity, bulk, complete/approve)
    task_projects.py   # NEW  (reference implementation: routers/items.py)
    task_portfolios.py # NEW
    task_departments.py# NEW  (+ member requests)
    task_tickets.py    # NEW
    task_config.py     # NEW  (saved views, automation rules, templates, intake forms, custom field defs)
```

### Data model (from export `src/models/*` + `src/nexus/models/task.ts`)
All entities **email-keyed**, not the export's `u1..u7` ids (Nexus convention — see `useRole().myEmail`,
`getRolesDirectory()`). Tables (Postgres, created by `create_all`; **RLS applied on dev + prod**):

| Table | Key columns |
|---|---|
| `tasks` (expand existing) | code, title, description, type, status, priority, assignee_email, project_id, section_id, department_id, parent_task_id, tags(JSON), custom_field_values(JSON), start_on, due_on, estimate_hours, actual_hours, recurrence(JSON), is_milestone, approval_status, access_level, follower_emails(JSON), blocked_by_ids(JSON), blocking_ids(JSON), dependency_types(JSON), completed, completed_at, created_at, modified_at, created_by |
| `task_projects` | name, description, color, owner_email, portfolio_id, department_id, status, start_on, due_on, archived, member_emails(JSON) |
| `task_portfolios` | name, description, color, owner_email, project_ids(JSON, ordered), archived |
| `task_departments` | name, color, icon, member_emails(JSON) |
| `task_comments` | task_id, author_email, body, created_at, edited_at, pinned |
| `task_attachments` | task_id, name, size, kind, url (Supabase storage), added_at |
| `task_activity` | entity_kind, entity_id, entity_code, entity_title, type, actor_email, at, detail |
| `task_tickets` | code, subject, description, status, priority, requester_email, assignee_email, department_id, linked_task_id, tags(JSON), sla_due_on, resolved_at |
| `task_saved_views` | owner_email, name, view, filters(JSON), sort(JSON), group |
| `task_automation_rules` | name, trigger(JSON), actions(JSON), enabled |
| `task_templates` | name, description, patch(JSON), subtask_titles(JSON) |
| `task_intake_forms` | title, fields(JSON), target_project_id |
| `task_custom_fields` | name, description, type, options(JSON) |
| `task_member_requests` | department_id, user_email, kind, requested_by, status, decided_at, decided_by |

Enums ported verbatim from `src/models/enums.ts` / `taskMeta.ts` (Priority, Status, TaskType,
TicketStatus, ApprovalStatus, DependencyType, custom-field types). `STATUS_META`/`PRIORITY_META`
color maps → `theme.js`. **Drop** all Asana `sync`/`SyncMetadata`/`asanaGid` fields (dead weight — no Asana backend).

---

## Cross-cutting rewrites (the actual cost)

1. **Styling (biggest item):** ~1,775 `className=` Tailwind usages across 91 files → inline styles.
   Build `tasks/theme.js` once mapping the module's `--color-nx-*` hex palette onto Nexus tokens
   (`--card`, `--line`, `--ink`, `--muted`, `--color-*` HSL triples, Inter, `--transition-*`,
   `fadeIn`). Provide helpers for the repeated patterns (surface card, tab pill, status/priority chip)
   so panels convert mechanically. Radix `components/ui/*` (button/input/dialog/select) → Nexus's
   existing inline-style form idiom + native/existing modal pattern.
2. **State:** `NexusTaskStore` (context) + React Query bridge + 2 Zustand stores → a single
   `TasksContext.jsx` following `RequisitionContext.jsx`: `api.*` calls, snake↔camel mappers,
   optimistic local updates + server reconcile, Supabase-ping table + adaptive poll for realtime.
   Portable pure logic in `src/nexus/lib/*`, `mutations.ts`, `createActions.ts` (filters, stats,
   recurrence, `runRules` automation, `maybeFlagEarlyCompletion`) ports with only type-stripping.
3. **Routing:** the export's nested `react-router` `<Routes>` → internal `activeSub` tab state inside
   `Tasks.jsx`. Wire `case "tasks"` in `App.jsx` to pass `activeSub`/`onSubChange`/`onNavigate`
   (today it is prop-less). Cross-module jumps use `nexus:navigate`.
4. **Identity:** `getSsoAccount()`/`resolveCurrentUserId(by email)` → `useRole().myEmail` + `useMsal()`
   name; people directory from `api.getRolesDirectory()`. Delete `DevUserSwitcher`, `authSession`, mock account.
5. **Integrations:** Teams profile/presence (`teamsProfileService`) → Nexus directory + `teamsGraph.js`;
   Outlook notifier + the module's own `NotificationBell`/`AppNotification` → Nexus **server-side**
   `_notify` (per CLAUDE.md, client notification POST 403s for employees) + existing `NotificationBell`.
6. **Toast/Confirm:** module's `ToastStore`/`ConfirmStore` → reuse Nexus `NotificationToasts` +
   a small shared confirm (or port the 142-line stores as-is; they're framework-neutral).
7. **TS→JS:** strip all types; no TS toolchain exists in `frontend/`. Keep JSDoc on the model mappers.

---

## Phased delivery (each = one branch off fresh `dev`)

- **Phase 0 — Scaffolding:** `tasks/` folder, `theme.js` token bridge, empty `TasksContext`, convert
  the shell so the existing `Tasks.jsx` still renders (no behaviour change yet). Confirms build + tab wiring.
- **Phase 1 — Backend core:** models (tasks expand, projects, portfolios, departments) + `create_all` +
  `ALTER TABLE` migration lines + `api.js` endpoints + RLS on dev. `routers/*` modeled on `items.py`.
- **Phase 2 — Frontend core:** `TasksContext` + `Tasks.jsx` shell + **List** & **Board** views +
  **Task Detail drawer** (all ~15 panels), styled to Nexus, wired to Phase-1 backend end-to-end.
- **Phase 3 — Views & productivity:** Calendar, Timeline, Files, Dashboard, Workload + Filter/Sort/Group,
  Saved Views, Templates, Intake Forms, Bulk actions, Create modal.
- **Phase 4 — Org surfaces:** Projects, Portfolios, Teams, My Tasks, Home pages (+ their backend).
- **Phase 5 — Admin & workflow:** Manage (Departments, Automation Rules, Activity Log), Tickets,
  Custom Fields, Member Requests, Reporting/CSV export, server-side notifications wired.
- **Phase 6 — Extras & polish:** Changelog/docs feature, Report-Bug, mobile pass (`.stack-table`,
  bottom-sheets, `MobileNav` actions), accessibility, empty/loading/error states.
- **Phase 7 — Prod release:** apply schema + RLS on **prod**, `dev→main` PR, verify.

---

## Ownership & guardrails
- `Tasks.jsx` is not in the CLAUDE.md ownership table; you (Visesh, owner) own this work — you work
  straight on `dev`, PRs only for `dev→main`.
- **Shared files are append-only, minimal diff:** `models.py`, `main.py` migrations list, `api.js`,
  `App.jsx`, `Sidebar.jsx`, `RoleContext.jsx` MODULES. Do not reorder.
- Every new table gets **RLS on dev immediately and prod at release** (established security pattern).
- Notifications **server-side only** via `_notify`, targeted at a recipient email.
- New columns need both a `models.py` field **and** an `ALTER TABLE ... IF NOT EXISTS` line in `main.py`.

## Verification (per phase)
- Backend: `cd backend && uvicorn main:app --reload` with `NEXUS_SKIP_AUTH=true` + `NEXUS_DEV_EMAIL`;
  exercise each endpoint (create/list/update/delete, subtasks, comments, bulk) and confirm rows in Supabase dev.
- Frontend: `cd frontend && npm run dev`, drive the real flow in-app (create task → assign → comment →
  complete → verify notification + activity), then `npm run build` before every commit.
- Cross-check RLS with `get_advisors` on the dev Supabase project after each schema phase.

## Open items to resolve before Phase 1
- **Existing `Task` table:** expand in place (keep the 8 demo rows) vs. drop & replace with the rich schema.
- **Changelog overlap:** the export's changelog/docs feature vs. Nexus's existing KB/SOP — port fully, or
  fold into the existing module? (Affects Phase 6 scope.)
- **Attachments:** confirm Supabase storage bucket (reuse existing upload helpers, `cacheControl 31536000`).
