# Tiers in Nexus

Neil, 11/02/2026. Code keys in parentheses; the words are what people see.

| Tier | Level | Can |
|---|---|---|
| Super Administrator (`owner`) | 5 | Everything, for every company: security settings, the company walls, who holds which tier (incl. Administrator and Super Administrator), groups that pass the walls, Personal Financial Statements without a grant, deleting people, Workflows' organization face, Act As anyone below them. |
| Administrator (`administrator`) | 4 | Runs their company: people, settings, modules and approvals inside their company once the walls switch is on; with it off they see every company (Pranshu, 11/11/2026). One exception: the Tickets desk, where an Administrator sees and works every company's tickets (hotfix 11/04/2026; Ask HR tickets stay HR's). Grants tiers up to Manager. Cannot touch another Administrator or a Super Administrator, security settings, the walls, or a group that passes the walls. Acts As managers and below. |
| Manager (`manager`) | 3 | Leads a team: approvals, schedules and People for their own reporting line. |
| Supervisor (`supervisor`) | 2 | Sees the supervisor screens (Insights, Documents) their grants open. |
| Employee (`employee`) | 1 | Their own work. |

Access Group grants (`require_module_grant`) open single modules on top of
any tier; an Administrator passes every grant inside their company.

With the walls on, an Administrator whose own People record has no company sees only shared
rows (records that belong to no company) - the walls fail closed, they never
open every company.

## Grant Levels

Pranshu, 11/12/2026. A grant is a module plus ONE of three levels
(`auth.MODULE_LEVELS`):

| Level | Means |
|---|---|
| Viewer | Reads the module and works their own records in it. |
| Editor | Creates and edits records in it. |
| Full | Manages everything in the module inside their scope, deletes included. |

**Owner is retired.** A stored `:owner` reads as Full, and a one-time startup
pass (`super_admins_seed.retire_owner_level_once`, mark
`roles.owner_level_retired_2026_11_12`) rewrites every group and job role to
`:full` and drops the dead `development` and `purchase` grants. The tier KEY
`owner` (Super Administrator, level 5) is untouched.

**Tiers still gate on top of grants.** A Full grant never replaces a
Manager or Administrator tier check: Act As at the Manager tier reaches only
the caller's own reporting line, and below the Manager tier a What's New
entry is a submission (Pending Review) - edit and delete need Manager.

**Super Administrator by tier, no grant:** deleting a person, and the
Workflows organization-wide controls ("Every company" scope, webhooks,
Settings > Workflows).

Every module row in Settings > People & Access > Roles & Access has a
"What does this unlock?" link that opens the Level Guide on the Matrix tab:
the Viewer / Editor / Full lines plus what still needs the Manager,
Administrator or Super Administrator tier. The text comes from
`frontend/src/lib/moduleCapabilities.js` - the one source for these
descriptions; a changed gate changes it in the same PR.

| Module | Viewer | Editor | Full | Still tier-only |
|---|---|---|---|---|
| Tasks | Sees tasks assigned to or shared with them; does not create tasks | Creates, edits and completes tasks | Acts as a manager inside Tasks (was Owner) | - |
| Credentials | see the Level Guide | see the Level Guide | Manages every credential | - |
| Testing | see the Level Guide | see the Level Guide | Deletes runs | - |
| Files | Reads | Writes | Deletes | - |
| Build Mode | Reads | Works their own pins | Works anyone's pins | - |
| Workforce Analytics | Direct reports | Whole reporting line | Whole company | - |
| Documents (on top of the People grants) | Views and signs | Sends for signature | Voids and deletes | - |
| Workflows | Sees workflows and runs in scope | Builds, tests and publishes their own | Manages everyone's in scope and the company's templates | "Every company" scope, webhooks, Settings > Workflows: Super Administrator |
| People | see the Level Guide | see the Level Guide | see the Level Guide | Deleting a person: Super Administrator |
| Every other module | see the Level Guide in Roles & Access | | | |

## Who is a Super Administrator

Set once on 11/02/2026 (`backend/super_admins_seed.py`): Neil Kadakia,
Visesh Lodha, Charmi, Pranshu Pandey, Sagar Shoundik. Every other person who
held the old top tier became an Administrator. Change it later in Settings >
People & Access; the seed never runs again.

The same startup file clears the old tier words out of the data once (mark
`roles.tier_words_cleared_2026_11_02`): job roles named "Global Admin" /
"IT Admin" became "Super Administrators" / "Administrators", every job title
that was a tier word was cleared (a tier word is never a job title), and Neil's
job title became "Managing Principal". Both passes run on every boot, guarded
by their marks.

## What people see

- Under a person's name: their job title, never the tier.
- A small mark after the name, with the tier word on hover / for screen
  readers: a filled shield (Super Administrator), an outline shield
  (Administrator), a small people glyph (Manager), nothing for anyone else.
  Profile menu, phone menu, hover card, Directory, People list, org charts,
  the Act As list.
- Settings > People & Access still shows the tier as a chip - that screen is
  where tiers are managed.

## Decisions owed (Neil)

1. **Organization-scope settings.** Should the settings that apply to the
   whole organization - branding, the email theme, publishing a policy, the
   weekly digest, the daily briefing, the Workforce Scorecard configuration -
   be Super Administrator only, since an Administrator otherwise changes
   them for every company?
2. **Now Super Administrator only.** Microsoft 365 sync, creating and
   deleting a company, and naming a group's managers now require a Super
   Administrator. Sam, Pankaj and Viral (Administrators since 11/02/2026)
   lose them - confirm that is intended, or name who keeps them.
