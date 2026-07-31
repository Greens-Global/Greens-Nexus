# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Greens Global employees, supervisors, managers, and executives in the United States and India. Daily drivers: office staff on desktop (primary), field/site staff on phones (time clock, approvals). Every user lands on the home dashboard after Microsoft sign-in; managers additionally live in approvals and team visibility.

## Product Purpose

Nexus is the company's internal operating platform: items/inventory with checkout+assignment lifecycles, asset management, People (HR) + time clock + payroll timecards, tasks/tickets with two-way Asana sync, knowledge base/SOPs, e-sign documents, marketing analytics, investor relations, credential vault, QA/testing, and role-aware dashboards. Success = employees run their whole workday inside it, and leadership sees a professionally designed product, not stitched-together modules.

## Positioning

One role-aware portal that replaces scattered tools, with deep company integrations (Microsoft Entra SSO, M365, Asana two-way sync, Supabase). Access below admin is grant-driven per module. No competitor inside the company; the bar is "feels like a premium commercial SaaS product."

## Operating Context

- Desktop-first enterprise use (1280–1568px common); real phone use for time clock/approvals.
- Auth: MSAL redirect flow; the login page is the only pre-auth surface.
- Frontend: React 19 + Vite, hand-rolled view switcher in App.jsx (no react-router for the shell), `nexus:navigate` window event bus, inline-style idiom + one global style.css with CSS custom-property tokens, dark mode via `[data-theme="dark"]`.
- CSP `script-src 'self'` — no inline scripts in index.html.
- Live data available to the home screen today: `/dashboards/kpis` (self + team scope), notifications context, time clock status, pending approvals (requisitions, time off, punch requests), e-sign queue, KB assignments, people directory.

## Capabilities and Constraints

- ABSOLUTE: redesigns are presentation-only. Routes, permissions, API calls, workflows, validations must not change.
- Saved dashboard views (personal/department) + drag-resize widget grid exist and must keep working; the "Customize" grid is a power feature layered over the default home.
- Sidebar NAV is the single source for desktop + mobile menus; grouping is by divider, entries are grant-filtered.
- Widgets `team-workload`, `team-projects`, `team-calendar`, `occupancy`, `facilities`, `tasks-list` render SAMPLE data — never present these as live in a redesign.
- `unread_notifications` KPI counts all notifications (backend bug, documented — do not silently fix).

## Brand Commitments

- WHITE-LABEL (owner, Jul 28, 2026): the app must not say "Greens" or "Greens Global"
  anywhere user-visible. Product name is "Nexus" only. New surfaces are already clean;
  legacy module copy (SOP, IT, investor, e-sign, support) still needs a sweep.
- Microsoft sign-in button semantics stay.
- Palette: OWNER-FREED on Jul 28, 2026 — green/emerald is neither required nor banned; the real-estate/land visual direction is explicitly OUT. Pick whatever reads most premium. (User-confirmed.)
- UI labels are sentence case ("Edit template", never "Edit Template"). American English spelling everywhere.
- Incumbent body font is Inter; not a binding commitment.

## Evidence on Hand

- Real KPI/notification/timeclock data flows listed above; zero-states are common on fresh accounts, so the home must look designed at zero.
- No announcements endpoint exists — do not fabricate company news.
- OG screens captured Jul 28, 2026: login = dark particle-network canvas + globe + typewriter "Nexus"; home = white widget cards on pale blue-gray gradient. Owner verdict: to be replaced ("pathetic" interim pass reverted; OG is the redesign baseline).

## Product Principles

1. Function is sacred; presentation is fully replaceable.
2. The first screen must impress leadership and orient an employee in seconds — both, every time.
3. Role-aware density: employees see their day; managers see their team's pulse.
4. Fast and calm beats decorated: motion is purposeful, reduced-motion respected.
5. One product, one visual grammar, across all modules (rollout starts with login + home + shell).

## Accessibility & Inclusion

WCAG 2.2 AA target; keyboard and reduced-motion support are non-negotiable on new surfaces.
