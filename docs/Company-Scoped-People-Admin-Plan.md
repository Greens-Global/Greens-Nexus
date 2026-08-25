# Company-Scoped People Admins - Plan (Neil, Aug 25)

> Neil (Teams, 08/25 19:50): "another layer of access / company admin where
> you can be a people admin but company specific. Can't make or see changes
> on certain people. I wouldn't want Sacred Natural admin making changes to
> scmedicenter and vice versa. We are a family office - a group of companies."

Decisions (Visesh, Aug 25):
- Scope the HR-ADMIN surfaces; the general people directory / pickers / task
  assignment stay company-wide (the family office collaborates daily).
- Assignment is PER PERSON on their Access tab (reuse the access-scope
  machinery), not per job role.
- ONE release: People + Time + Leave + payroll + monitoring together.

## Mechanism

Reuse `nexus_access_scopes` (exists; admin-managed via /access-scopes):
rows `{email, module_id='hr', scope_type='entity', scope_id=<HrEntity.id>}`.

New central helper (backend/auth.py, beside scoped_ids):

    def hr_scope(user, db) -> set[str] | None
        # None  = unrestricted (no 'hr' scope rows, or level >= administrator)
        # set() = allowed HrEntity ids - filter everything People-ish on it

Semantics:
- Level >= 4 (IT Admin / Global Admin) is ALWAYS unrestricted - the scope is
  a narrowing on the HR grant, not a new grant.
- An internal hr/hr_comp grant holder WITH 'hr' entity scopes sees/touches
  only employees whose `NexusEmployee.company` is in the set.
- Employees with company == '' (untagged) are visible ONLY to unrestricted
  admins - untagged people must not leak to every scoped admin.
- Denials on {eid}-addressed endpoints return 404, not 403 - existence must
  not leak.
- NOTE (discovered): the current external "Company access" box writes
  module_id='company' rows that NOTHING enforces (zero backend consumers).
  Separate follow-up; this feature deliberately uses module_id='hr'.
- NOTE (discovered): auth.scoped_ids fails closed only for identity_type
  'external', not 'guest' - separate hardening item.

## Enforcement points

### hr.py (the 60-endpoint table lives in the recon; the shapes)
1. `GET /employees` - THE read path (no single-get exists; detail cards feed
   from it): filter internal+external rows by company-in-scope. Also the
   deleted list.
2. ~25 `{eid}`-addressed endpoints (update, photo, docs, paystubs, comp,
   provision, push-to-entra, welcome, status/offboard, bod, assets,
   mailbox-export): shared `_assert_hr_scope(db, user, emp)` -> 404.
3. `PATCH /employees/{eid}`: validate BOTH the current company and any
   REQUESTED `company` value against the scope (blocks the re-tag escape).
4. Id-addressed joins (no eid in path): `/documents/{did}*` via
   HrDocument.employee_id; `/requests/{rid}*` via the requester;
   `/mailbox-exports/{job_id}*` via the job's employee.
5. List endpoints with employee data: `/leave*` (join employee company),
   `/requests` (requester company), `/candidates*` - HrCandidate has NO
   company column: ADD `company` (model + BOTH main.py migration lists +
   pre-apply on dev/prod + a field on the hiring form); '' = unrestricted-
   only, same as employees.
6. Unrestricted-ONLY (403 for scoped admins, clear message): the four
   `sync-m365*` bulk endpoints (whole-tenant by nature), `PUT /group-manager`,
   entities CREATE/DELETE. `GET /entities` filters to scoped companies;
   `PATCH /entities/{id}` scoped-allowed for own companies (domains edits
   re-tag only their people - verify _assign_company_by_domain respects it).
7. Departments + work sites: filter by company; mutations require the
   site's/department's company in scope; company-less work sites readable
   (geofence display) but unrestricted-only to mutate.

### timeclock.py - the phase-everything surfaces
8. `_visible_emails(db, user)` (the ~30-call-site visibility root for team
   timesheet, payroll, exceptions, screenshots, monitoring coverage,
   timeoff): today ANY hr:viewer grant returns None (whole company). Change:
   when `hr_scope` returns a set, return {emails of employees whose company
   in scope} UNION direct reports UNION self. One function scopes them all.
9. `/timeclock/timeoff` name map builds from NexusEmployee.all() - restrict
   to the visible set.
10. egnyte.py `/person/{email}` (HR-grant private-folder resolution): assert
    scope on the target.

### Cache correctness
11. access_scopes POST/DELETE currently invalidate nothing - add
    `invalidate_role_cache(email)` + `cache.module_grants.invalidate(email)`
    and read scopes LIVE in hr_scope (no new cache) so changes bite within a
    request, not 120s later. Frontend: entities client cache is 120s -
    acceptable.

### Explicitly UNCHANGED (per the visibility decision)
- `/myhr/directory`, `/myhr/person`, `/roles/directory`, name resolution,
  photo maps, people pickers, task/ticket assignment - company-wide for
  everyone, as today. Document this in the module capability copy so nobody
  mistakes the scope for full invisibility.
- Act As eligibility stays level-based (optional hardening later: filter a
  scoped admin's targets to their companies).
- external_users endpoints are administrator-gated = unrestricted by rule.

## Frontend

- Roles & Access / People Access tab (HR.jsx EmployeeAccess): the company-
  scope box currently renders only for externals. Add a parallel box for
  INTERNAL users (admin-only): "People admin companies - with none set, an
  HR grant covers every company; add companies to limit it." Writes
  module_id='hr' scopes via the existing api.addAccessScope/delete.
- Expose the caller's own scope: add `hrScopeCompanies` to /roles/me ->
  RoleContext -> UI gating:
  * Hide Sync M365 + Company setup create/delete + group-manager for scoped
    admins; work-site/department editors constrain company selects.
  * Directory/stat cards get a scope chip ("Showing: Sacred Natural") so
    "Total headcount" reads honestly.
  * EmployeeFormModal company select limited to scoped companies.
- Org chart: fed by the filtered employees array; managers outside scope
  render via the existing email-derived name fallback (dangling links are
  acceptable; do not leak their profiles).
- Documents e-sign internal-signer picker uses /hr/employees - a scoped
  admin sees only their companies' people as signers. Accepted consequence.

## Files

backend/auth.py (hr_scope + scoped_ids guest note), backend/routers/hr.py
(helper + ~30 touch points), backend/routers/timeclock.py (_visible_emails,
timeoff name map), backend/routers/egnyte.py (person assert),
backend/routers/access_scopes.py (invalidation), backend/routers/roles.py
(me payload), backend/models.py + backend/main.py (HrCandidate.company),
frontend/src/views/HR.jsx (EmployeeAccess box, UI gating, scope chip,
form selects), frontend/src/contexts/RoleContext.jsx, frontend/src/api.js.

## Verification

- New backend/test_hr_scope.py: matrix - scoped admin lists only own
  company; 404 on foreign eid across docs/comp/status; re-tag escape
  blocked; company-less hidden; unrestricted admin unchanged; sync
  endpoints 403; _visible_emails returns the scoped email set; timeoff
  list filtered; document-id/request-id/mailbox-job joins enforced.
- Existing suites (backend externals 35, frontend 158) stay green.
- Manual on dev: create a test job-role person with hr:editor + a single
  'hr' entity scope (e.g. Sacred Natural); walk People, Time, Leave,
  monitoring, e-sign picker; confirm SC Medi Center people invisible on
  HR surfaces but still assignable in Tasks.
- Pre-apply HrCandidate.company on dev+prod before deploy; RLS advisors
  after release (no new tables).

## Estimate & risks

~2-3 days build + test. Risks: the hr.py touch-point count (mitigate with
the single _assert helper + the test matrix); _visible_emails is
load-bearing for ~30 call sites (one change, wide blast - the test matrix
covers the big five: timesheet, payroll, exceptions, screenshots, timeoff);
scoped admins holding OTHER modules (items, tickets) are unaffected by
design - HR scope narrows only HR surfaces.
