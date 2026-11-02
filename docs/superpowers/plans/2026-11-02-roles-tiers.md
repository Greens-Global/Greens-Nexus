# Roles: Super Administrator / Administrator / Marks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The job title, not the Nexus tier, under a person's name; the two top tiers renamed Super Administrator (level 5, today's "Global Admin" / `owner`) and Administrator (level 4, today's "IT Admin"); Administrator becomes company-walled; a subtle mark tells Super Administrators, Administrators and Managers apart everywhere names appear; the five Super Administrators set.

**Architecture:** Role KEYS in code (`owner`, `administrator`, `manager`) do not change - only labels, copy and two authorization rules. The company wall becomes the rule for level 4 regardless of the `company_walls` switch; the global-admin bypass (`auth.is_global_admin`) becomes level 5 only (plus the flagged group). People payloads gain one small `tier` field so every name can carry its mark. One `TierMark` component draws the three marks.

**Tech Stack:** FastAPI + SQLAlchemy, React 19, vitest, pytest (one file per process).

**Spec:** Neil, 11/02/2026 (chat): "It should not say global admin here under my name ... pull my title ... rename Global Admin to Super Administrator and create an Administrator level ... subtly communicate super admins vs admins vs managers vs regular"; answers: "Administrator is company walled. Super Administrator should be Neil Visesh Charmi Pranshu and Sagar for now. Manager should have a mark too."

## Global Constraints

- Role keys `employee | supervisor | manager | administrator | owner` and levels 1-5 are unchanged everywhere (database rows, `auth._LEVELS`, `roles.ROLE_LEVEL`, `can('owner')`). Only labels change.
- Title Case labels: "Super Administrator", "Administrator", "Manager", "Supervisor", "Employee". No em dashes. American English.
- Company wall for level 4 applies whether or not `company_walls` is on; level 5 is never walled.
- Nothing about the wall for Managers (team scope) or the Access Group grants changes.
- Shared files append only; tests one file per process.
- The five Super Administrators are set by a one-time startup pass on dev and prod, recorded in `nexus_settings`; never by a code default that re-applies.

## Review Focus

1. A level-4 person in company A must get 404 (not 403, the existing wall convention) on a person, ticket, announcement or setting of company B even with `company_walls` off - Task 2.
2. A level-4 person must not be able to create or edit a group with `is_global_admin`, add members to one, change the walls switch, or grant / change the `administrator` or `owner` tier - Task 2.
3. The Super Administrator set pass runs ONCE: a Super Administrator later demoted by a Super Administrator stays demoted after a restart - Task 2.
4. The phone menu and the profile menu show the job title and never the tier word; a person with no job title shows nothing there (no "Employee") - Task 3.
5. `useRole().myLevel` is defined (the latent bug) and the ticket / task settings guards that read it behave for a manager (3) and an employee (1) - Task 3.

---

### Task 1: Labels and copy

**Files:**
- Modify: `frontend/src/contexts/RoleContext.jsx` `ROLES` (:81-87): `administrator` label "Administrator" (was "IT Admin"), `owner` label "Super Administrator" (was "Global Admin"); descriptions rewritten: Super Administrator "Runs Nexus for every company: security, tiers, the organization's settings." Administrator "Runs their company: people, settings, modules and approvals inside their company." Manager "Leads a team: approvals and schedules for their people."
- Modify: every frontend copy occurrence of "Global Admin(s)" / "IT Admin(s)" (about 182 + 47 matches; heaviest `support/docsContent.js`, `views/RolesAccess.jsx`, `support/implementationContent.js`, `api.js` comments, `kb/components/PeoplePick.jsx:90`, `workflows/lib/text.js:29` + `text.builder-helpers.js:37` recipient kind label "Super Administrators") - code keys like `global_admins` stay
- Modify: every backend USER-FACING string (the 28 error messages listed in the role map: `roles.py:198,209`; `groups.py:293,306`; `jobroles.py:224,433,438,529,556`; `role_change.py:215,225,281,293`; `workflows.py:84,100,522,644,715,939`; `dev_notes.py:490,1143,1372`; `timeclock.py:2449`; `timesheet_review.py:1258`; `extra_time.py:415`; `ticket_inbound.py:179`; `task_util.py:838`; `task_config.py:1045`; `workflows/engine.py:564`), bell titles / bodies and emails that say "Global Admin"; comments may keep the old word with "(now Super Administrator)" where it aids history; `CLAUDE.md:598`, `docs/Workflows.md`, `docs/Build-Mode.md`
- Modify: the tests that assert the old copy (`RolesAccess.assignReason.test.jsx:62`, `SecuritySettings.test.jsx:111`, `OpsSettings.test.jsx:48`, `HrReminderSettings.test.jsx:109`, `RoleChangeRequests.test.jsx:74`, `workflows/Catalog.test.jsx:74`, `WorkflowsSettings.test.jsx:112`, `Workflows.test.jsx:229-234`, `Builder.test.jsx:355-361`, `workflows/lib/text.test.js:184`, `test_team_alert_recipients.py:48` and any backend test asserting the strings)
- Create: `frontend/scripts/check-role-copy.mjs` wired into `npm run lint`: fails on "Global Admin" or "IT Admin" in any `src/**` string literal or JSX text (comments exempt)

- [ ] **Steps:** add the guard script first (it fails), rename until it passes, run the touched tests, commit `feat(roles): Super Administrator and Administrator labels everywhere (Neil, 11/02/2026)`.

### Task 2: Administrator is company-walled; Super Administrator set

**Files:**
- Modify: `backend/auth.py` - `is_global_admin` (:832-853): level 5, or a member of a group flagged `is_global_admin`; the level >= 4 fallback is REMOVED; `hr_scope` (:659-690): level 4 no longer unrestricted - it defers to `company_scope` always; `company_scope` (:856-893): applies to level <= 4 whether or not the walls are on (the `company_walls` switch keeps its meaning for levels 1-3 as today; document it); keep `_company_walls_on` for the lower tiers
- Modify: `backend/routers/groups.py` (:151, :183 create/edit with `is_global_admin`, :239 members of such a group -> `require_owner`; a level-4 caller editing a plain group is unchanged), `backend/routers/access_scopes.py:100` (`set_walls` -> `require_owner`), `backend/routers/roles.py:197-209` and `groups.py:290-306`, `jobroles.py:220-225, 431-438, 555` (already owner-only for granting at or above own level - keep; add a test), `backend/act_as.py` (unchanged: strictly-below rule already means Administrators act only as managers and below)
- Create: `backend/super_admins_seed.py` `apply_once(db)`: mark `roles.super_admins_set_2026_11_02` in `nexus_settings`; when absent, set `nexus_roles.role = 'owner'` for the five emails (neil, visesh.lodha, charmi, pranshu.pandey, sagar.shoundik @greensglobal.com, exactly as the rows read on dev) with `tier_pinned = True`, set every OTHER `owner` row to `administrator` (Viral on dev), invalidate the role cache, write the mark; called from `main.py` startup after the migrations; a run with the mark present does nothing
- Modify: `backend/routers/roles.py` `/roles/me` adds `level` (int) and `title` (the employee's `job_title`, "" when none)
- Test: `backend/test_roles_tiers.py` (Review Focus 1-3: level 4 of company A gets 404 on company B's person / ticket / announcement / setting with walls OFF; level 4 cannot flag a group, add members to a flagged group, set walls, or grant administrator / owner; level 5 can; the seed pass sets the five and demotes the rest once; a later demotion survives a second pass; `/roles/me` carries `level` and `title`); update `test_company_walls.py:317-327` (the level-4 bootstrap case is gone) and `test_auth_access.py` as needed; `test_act_as_targets.py` unchanged

- [ ] **Steps:** failing tests, implement, run every test file that mentions `administrator` or `owner` in backend/ one per process (the role map counts 139 + 63 files - run them all in a loop, one process each, and report the counts), `ruff`, commit `feat(roles): Administrator is company-walled, Super Administrator only passes the walls; the five Super Administrators set once (Neil, 11/02/2026)`.

### Task 3: Title under the name, the marks

**Files:**
- Create: `frontend/src/components/TierMark.jsx` - `TierMark({ tier, size = 14, title })`: `super` -> lucide `ShieldCheck` filled with the brand tint (`color: var(--wk-brand)`, `fill: color-mix(in srgb, var(--wk-brand) 18%, transparent)`), `admin` -> `Shield` outline slate (`#64748b`), `manager` -> `Users` small muted (`var(--muted)`), anything else renders nothing; `aria-label` and `title` = "Super Administrator" / "Administrator" / "Manager"; inline, `verticalAlign: middle`, `marginLeft: 5`; never a chip, never text
- Modify: `frontend/src/components/MobileMenu.jsx:199-200` - the line under the name = the job title (from `/roles/me.title`), nothing when blank; `TierMark` after the name; `frontend/src/components/TopHeader.jsx` - pill (:394-395) keeps `myTitle` (no role fallback: blank when no title), dropdown card: name + `TierMark` (:422-424), title line (:427-431), the Shield badge row with `roleMeta.label` (:432-437) REMOVED; avatar background stops using `roleMeta.color` (:412) - a neutral tint; `frontend/src/components/MyProfileModal.jsx:200-201` unchanged
- Modify: `frontend/src/contexts/RoleContext.jsx` - export `myLevel` (:366 -> the context value :380-386) and `myTier` (`super | admin | manager | ''` from the level), `myTitle` from `/roles/me.title`
- Modify: people payloads carry `tier`: `backend/routers/myhr.py` `/myhr/person` (hover card) and `/myhr/directory`, `backend/routers/directory.py` roster (:180-183), `backend/routers/hr.py` `_serialize` (:195-245), `backend/act_as.py` eligible targets (:157-159) - one helper `tier_of(level) -> 'super'|'admin'|'manager'|''` in `auth.py`; the full role map `GET /roles` stays administrator-only
- Modify: `frontend/src/components/PersonHoverCard.jsx:161` (mark after the name), `views/Directory.jsx:488-489` (after the name, before the Lead/Backup `RoleBadge`), `directory/OrgChartLens.jsx:210` and `views/HR.jsx:2714` (org cards), `views/HR.jsx:6009, 6058` (People list rows, beside `ExternalBadge`), `views/HR.jsx:1896` (person header), `components/ToolsMenu.jsx:61` (Act As list: mark instead of `roleLabel`), `views/RolesAccess.jsx:103-112` `TierBadge` (keeps its chip - it IS the tier screen - with the new labels)
- Test: `TierMark.test.jsx` (three marks, nothing for employee / supervisor, labels), `MobileMenu` test (title shown, no tier word, blank title -> nothing; update `MobileMenu.externalLabel.test.jsx:44-49` which asserts "Employee"), `TopHeader` test (no Shield badge row), `RoleContext` test (`myLevel` defined), `PersonHoverCard` / `Directory` tests (mark renders from `tier`), `RolesAccess.roleMenu.test.jsx` (`myLevel` from the provider, not a mock)

- [ ] **Steps:** failing tests, implement, `npx vitest run` on the touched areas, lint, build, commit `feat(roles): job title under the name, tier marks for Super Administrators, Administrators and Managers (Neil, 11/02/2026)`.

### Task 4: Docs

- [ ] CLAUDE.md: a "Tiers (Neil, 11/02/2026)" bullet: labels, Administrator walled always, Super Administrator = level 5 only passes the walls, the five names set once by `super_admins_seed`, marks via `TierMark` only (never text), `myLevel` exported; replace the "Global Admins" wording in the Timesheets / Probation / Extra Time bullets with "Super Administrators". `docs/Roles.md`: what each tier can do, in a table. Commit `docs: tiers`.

## Self-review
- Spec: title under the name (3), rename (1), Administrator level with meaning (2), marks incl. Manager (3), the five Super Administrators (2).
- Keys unchanged; only labels, two rules, one seed, one field, one component.
- Review Focus tests in Tasks 2 and 3.
