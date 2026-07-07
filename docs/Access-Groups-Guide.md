# Access & Groups — Audit, Plan and Walkthrough (Jul 2026)

_The practical companion to `Roles-and-Access-Explained.md`. That doc explains the
philosophy; this one says exactly who should see what, what to click, and what we
fixed in the Jul 7 audit._

---

## 1. How access works (30-second version)

Three layers, checked in this order:

1. **Baseline screens** — every signed-in employee gets these. No setup needed.
2. **Role** (Employee → Supervisor → Manager → IT Admin → Global Admin) — decides
   what someone can *do* (approve, allocate, manage) and unlocks the two admin
   screens. IT/Global Admins see every screen so they can manage access.
3. **Access Group grants** — below IT Admin, restricted screens are visible
   **only via a group grant**. A grant is `screen + level`
   (Viewer / Editor / Full / Owner). Grants are **additive** — they can only ever
   widen access, never take anything away.

> A manager does NOT automatically see HR or Accounting. If it's not baseline,
> it's grant-only. This is deliberate — visibility is an explicit, auditable
> choice per team.

## 2. The screen matrix — who should see what

| Screen | Baseline? | Who should have it | Backend enforcement |
|---|---|---|---|
| Dashboard | ✅ everyone | — | login |
| Time Clock | ✅ everyone (punching must never be blocked) | — | login + scoped admin |
| Item Management | ✅ everyone (requesting) | manage tools appear by role/grant | role-gated writes ✅ |
| Tasks | ✅ everyone _(flipped Jul 7 — own tasks)_ | — | login |
| Knowledge Base | ✅ everyone _(flipped Jul 7 — it's the LMS; assigned courses)_ | authoring = level 3+ | level-gated admin ✅ |
| External Links | ✅ everyone _(flipped Jul 7 — just links)_ | — | n/a |
| Support | ✅ everyone | — | n/a |
| Manager Dashboard | Supervisor+ (role) | supervisors/managers | approval APIs role-gated ✅ |
| HR | ❌ grant-only | **HR team only** (Charmi editor; assistants viewer). NOT managers, NOT GG India | `hr:*` grants ✅ |
| HR — Compensation | ❌ separate `hr_comp` grant | payroll only (today: Global Admins; optionally Charmi) | `hr_comp` grants, owner bypass ✅ |
| E-Sign (inside HR) | follows `hr` grants | HR team | `hr:*` grants ✅ |
| Accounting | ❌ grant-only | accounting team | `accounting:viewer`+ ✅ |
| Asset Management | ❌ grant-only | asset team | **✅ fixed Jul 7** — workspace API now needs `property-asset` grant (was open to all logins, incl. writes) |
| IT | ❌ grant-only | IT staff | UniFi gated ✅; legacy assets API login-only (legacy, folding into Items) |
| Construction / Operations / Development / Marketing / Investor Relations | ❌ grant-only | the respective team | mock data — login-only APIs (acceptable until real) |
| Nexus Access Manager | IT Admin+ (role only, never grantable) | admins | ✅ |

## 3. Target groups (the curated plan)

Baseline needs **no group**. Groups exist per department for their restricted screens:

| Group | Grants | Members (today's names) |
|---|---|---|
| **HR** | `hr: editor` (lead), `hr: viewer` (assistants). `hr_comp` only if they run payroll | **Charmi (missing today — add her!)**, Arnav (viewer, if he assists) |
| **Accounting** | `accounting: editor` | the accounting team |
| **Asset Management** | `property-asset: editor` (team), `full` for the module owners | exists — currently 10 people at `full`; trim most to `editor` |
| **IT** | `it: full` | IT staff below IT-Admin role |
| **Operations (Storage)** | `operations: editor` | site GMs / storage managers |
| **Construction** | `ops: editor` | Aarav Construction leads |
| **Marketing** | `marketing: editor` | marketing folks |
| **Investor Relations** | `investor-relations: viewer` | Neil + leadership only |
| **GG India Team** | keep `development/operations/property-asset/inventory: viewer` if that's their work. **Remove `hr`** (personal data), remove stale `purchase` entry | as-is |

Cleanups from the audit:
- **Charmi (HR lead) currently has NO HR access** — add to HR group.
- **GG India Team has `hr:viewer`** — 5 people can browse every employee's
  personal data. Remove unless someone specifically does HR data entry.
- Empty shell groups (Accounting, Construction, IT, Investor, Leadership,
  Managers) — either fill them per the table or delete to reduce noise.
- **Prod hygiene:** 7 Global Admins exist on dev (the dev team). On prod this
  must be Neil + Visesh (+1 at most) — every Global Admin can read salaries and
  delete core records.

## 4. Walkthrough — doing this in the app

All of it lives in **Nexus Access Manager → Users & Roles** (IT Admin+ only).

**Create / edit a group**
1. Click **Create Group** (or ✏️ on an existing one).
2. Name it after the team, set Department.
3. **Members**: search by name/email, click to add. ✕ removes.
4. **Screens & permission levels**: tick each screen this team needs and pick the
   level — _Viewer_ (see & use), _Editor_ (create/edit), _Full_ (delete),
   _Owner_ (everything + manage access). Unticked = invisible (unless baseline
   or the person is an admin).
5. **Save Changes.** Takes effect on the member's next page load.

**Rules of thumb**
- One group per team; name it what the team is called.
- Grant the *lowest level that lets them work* — start Viewer, raise on request.
- A person can be in many groups; they get the **highest** level any group gives.
- Removing someone from a group removes what it granted — instantly, next load.
- **Bulk role assignment** (bottom of the modal) changes members' global ROLE —
  it is not a screen grant. Never bulk-apply Global Admin.
- Grants can't give the Access Manager itself — that's role-locked, by design.

**Adding a new person (checklist)**
1. They sign in once with their work account (they appear automatically).
2. Set their role: regular staff = Employee; team lead = Supervisor;
   dept head = Manager.
3. Add them to their department's group. Done — baseline + their team's screens.

## 5. Known gaps (accepted for now)

- Mock-data modules (Construction/Operations/Development/Marketing/Investor)
  have login-only APIs. Fine while fake; gate like Accounting when real data lands.
- Legacy IT `hardware_assets` API is login-only; module is being folded into Items.
- `purchase` view is reachable by all (employees raise purchase requests);
  fulfillment endpoints are manager-gated server-side. Intentional.
