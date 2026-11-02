# Tiers in Nexus

Neil, 11/02/2026. Code keys in parentheses; the words are what people see.

| Tier | Level | Can |
|---|---|---|
| Super Administrator (`owner`) | 5 | Everything, for every company: security settings, the company walls, who holds which tier (incl. Administrator and Super Administrator), groups that pass the walls, Personal Financial Statements without a grant, deleting people, Workflows' organization face, Act As anyone below them. |
| Administrator (`administrator`) | 4 | Runs their company: people, settings, modules and approvals inside their company walls, always (whether or not the walls switch is on). Grants tiers up to Manager. Cannot touch another Administrator or a Super Administrator, security settings, the walls, or a group that passes the walls. Acts As managers and below. |
| Manager (`manager`) | 3 | Leads a team: approvals, schedules and People for their own reporting line. |
| Supervisor (`supervisor`) | 2 | Sees the supervisor screens (Insights, Documents) their grants open. |
| Employee (`employee`) | 1 | Their own work. |

Access Group grants (`require_module_grant`) open single modules on top of
any tier; an Administrator passes every grant inside their company.

## Who is a Super Administrator

Set once on 11/02/2026 (`backend/super_admins_seed.py`): Neil Kadakia,
Visesh Lodha, Charmi, Pranshu Pandey, Sagar Shoundik. Every other person who
held the old top tier became an Administrator. Change it later in Settings >
People & Access; the seed never runs again.

## What people see

- Under a person's name: their job title, never the tier.
- A small mark after the name, with the tier word on hover / for screen
  readers: a filled shield (Super Administrator), an outline shield
  (Administrator), a small people glyph (Manager), nothing for anyone else.
  Profile menu, phone menu, hover card, Directory, People list, org charts,
  the Act As list.
- Settings > People & Access still shows the tier as a chip - that screen is
  where tiers are managed.
