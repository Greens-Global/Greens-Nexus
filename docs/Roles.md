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
