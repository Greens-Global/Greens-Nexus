# Ticketing System — Implementation Plan

Turn the task module's **Tickets** tab into a full ticketing / issue-tracking system.
Built as *functionality* inspired by common issue trackers — not a copy of any product's UI/branding.

## Principle: reuse the task module's infra
Tickets live in the same module as tasks, so most heavy machinery already exists and just
needs to be pointed at tickets:
- `task_comments`, `task_attachments` — keyed by a string id; reuse with the ticket id.
- `task_activity` — already generic (`entity_kind` = task|project); add `ticket`.
- Board (drag/columns), custom fields, automation, dashboards/charts, server-side `_notify`.

Current `task_tickets`: id, code (TKT-###), subject, description, status
(new→open→in_progress→on_hold→resolved→closed→reopened), priority, requester_email,
assignee_email, department_id, linked_task_id, tags, images, sla_due_on, resolved_at, timestamps.
Current UI (`TicketsView.jsx`): List view + filters/search + small create/detail modals.

---

## Phase 1 — Core UX (makes it a real tracker)
**Backend**
- `task_tickets.type` column: `bug | incident | service_request | task | question` (default `request`). Migration (sqlite+pg) + serializer/body.
- **Comments**: `GET/POST/DELETE /task-tickets/{id}/comments` — reuse `TaskComment` (its `task_id` holds the ticket id; ids are globally unique so no collision).
- **Attachments**: `GET/POST/DELETE /task-tickets/{id}/attachments` — reuse `TaskAttachment` the same way (inline data-URL for small files, matching tasks).
- **Activity**: log on create/update (created, status-changed, assigned, priority-changed, resolved) via `log_activity(entity_kind="ticket")`; `GET /task-tickets/{id}/activity`.

**Frontend**
- `api.js` + store helpers for ticket comments/attachments/activity.
- `TICKET_TYPE_META` (icon/label/color) + a **Type** field in create/detail.
- **`TicketDetailDrawer`** replacing the small detail modal: header (code · type · subject), a
  fields sidebar (status/priority/assignee/requester/team/SLA/linked task), and a body with
  **Conversation** (comment thread), **Attachments**, and **Activity**.

## Phase 2 — Workflow
- **Board (Kanban)** view for tickets by status (reuse the task Board; columns = statuses incl. custom).
- **Resolution** field on close: `fixed | wont_fix | duplicate | cannot_reproduce | done`.
- **Watchers** + **notifications** (server-side `_notify`, targeted): on assign, status change, new comment, resolve.
- **Filter / Sort / Group / Saved Views** for tickets (extend the existing filter bar; reuse `ProductivityBar` patterns) — group by status/assignee/priority/type/team.
- Bulk actions (assign / close / tag selected).

## Phase 3 — SLA & insights
- **SLA policies**: response + resolution targets per priority; compute breach/at-risk from `sla_due_on`; badges + a "breaching" filter.
- **Custom fields** for tickets (reuse the Manage custom-field infra).
- **Reporting**: open-by-status, by-assignee, by-type, avg resolution time, SLA compliance (reuse Dashboard/charts).

## Phase 4 — Advanced
- Ticket ↔ ticket **links** (duplicate / blocks / relates).
- **Components / categories**.
- **Intake form → ticket** (reuse task intake forms) and (optional) email-to-ticket.
- **Escalation** via automation rules; CSAT rating on resolution.

---

## Data-model summary (new)
- `task_tickets`: + `type`, (Phase 2) `resolution`, `watcher_emails`, (Phase 3) `custom_field_values`, (Phase 4) `links`, `component`.
- Reuse `task_comments` / `task_attachments` (by ticket id), `task_activity` (`entity_kind="ticket"`).

## Verification (per phase)
`npm run build` green each step; drive the flow on the isolated skip-auth stack + Playwright
(create ticket → set type → comment → attach → check activity; later: board drag, SLA badge, reports).

## Sequencing
Ship **one phase per branch/PR**. Order: **Phase 1 → 2 → 3 → 4**. This doc tracks status.

**Status:**
- Phase 1 — ✅ done (issue types, ticket detail drawer with Conversation/Attachments/Activity,
  activity logging on create/update). Verified end-to-end (8/8).
- Phase 2 — ✅ done. Delivered:
  - **Board (Kanban)** by status with drag-to-move (List/Board toggle in the toolbar).
  - **Resolution** field on close (`fixed | done | wont_fix | duplicate | cannot_reproduce`),
    shown in the resolved banner; cleared automatically on reopen.
  - **Watchers** UI in the drawer (add/remove people) → `watcher_emails`.
  - **Notifications** (server-side `task_notify`, targeted): assign, resolve→requester,
    status change→participants, new comment→participants (watchers+assignee+requester,
    never the actor).
  - **Filter / Group** (status/priority/type/assignee/team) in the list view.
  - **Bulk actions**: multi-select rows → set status / set priority / assign / resolve / delete.
  - Verified: board render + grouping (screenshots); resolution round-trip, reopen-clears,
    assign/status/comment notifications (DB); watcher persist + bulk apply (Playwright, 7/8 —
    the 1 miss was an avatar-initials text-match artifact, feature confirmed).
- Phase 3 — ✅ done. Delivered:
  - **SLA policy**: default resolution targets per priority (`urgent 4h / high 24h /
    medium 72h / low 120h`); auto-sets `sla_due_on` on create when unset. `slaState()`
    flags **breached / due-soon / on-track**; badges in list + board, and an **SLA filter**
    in the toolbar.
  - **Custom fields** for tickets — reuses the Manage custom-field definitions; new
    `task_tickets.custom_field_values` column; editable in the drawer.
  - **Reports** view (List/Board/**Reports** toggle): stat cards (total, open, SLA breached,
    due soon, avg resolution days, SLA compliance %) + charts (by status donut, by type,
    by priority, open by assignee) — reuses the dashboard `Card`/`LightBar`/`Donut` primitives.
  - Verified: custom-field create+patch round-trip (API); SLA filter + custom-field persist +
    Reports render (Playwright 10/13 — the 3 misses were a hidden-`<option>` text collision,
    all confirmed via the Reports screenshot showing breached=1 / due-soon=1).
- Lifecycle gaps — ✅ quick wins done (from the tickets-vs-tasks lifecycle review). Delivered:
  - **Requester acknowledgment** — `ticket_received` "We received your ticket" notification on
    intake when a ticket is logged for someone else (closes the "did it land?" gap).
  - **Scope toggle** — All / **My Requests** (requester = me) / **Assigned to Me**, so requesters
    can see their tickets' status without asking.
  - **Reports cuts** — added **By component/category**, **By team/facility**, and a
    **Recurring issues** panel (clusters by normalised subject; 2+ = a fix-once/capital-replacement
    signal, e.g. "×3 keypad").
  - **Ticket → many tasks** — new `task_tickets.task_ids`; a **Create Task from Ticket** action
    spawns a prefilled task and links it, plus "link existing"; the drawer lists all linked tasks
    (the storm-damage → N repair tasks pattern). Legacy single `linked_task_id` folded into the list.
  - Verified: ack notification + task_ids round-trip (API/DB); scope toggle, spawn-task, and the
    new report cards + recurrence (Playwright 13/13).
  - Still deferred (heavier, tracked separately): SLA-pause on "waiting on requester",
    requester confirm/auto-close, and the intake form/email → ticket pipelines.
- Phase 4 — ✅ (partial, by design). Delivered:
  - **Ticket ↔ ticket links** — `relates / duplicate / blocks / blocked_by`; adding a link
    writes the **inverse** on the other ticket; managed in the drawer (add/remove).
    New `task_tickets.links` column.
  - **Components / categories** — new `task_ticket_components` table + CRUD; `component`
    field on tickets (self-populating datalist in create form + drawer); component **filter**
    and **group-by**; shown on the list row.
  - **Escalation** (pragmatic, no rule engine) — an **Escalate** action bumps priority one
    rung and notifies assignee + watchers + managers (`_notify_participants` + `admins`
    fan-out); logs an `escalated` activity.
  - **CSAT** — 1-5 star rating + optional comment on resolved/closed tickets (requester-gated);
    `csat_rating` / `csat_comment` columns; **Avg CSAT** stat in Reports.
  - Verified: links+inverse, component CRUD, escalate ladder, CSAT round-trip (API);
    links UI, escalate, component filter, CSAT widget, Avg-CSAT stat (Playwright 12/13 — the
    1 miss was the hidden-`<option>` text collision; confirmed via the Reports screenshot).
  - **Deferred** (each is a net-new engine with no existing base, better as its own task):
    - **Intake form → ticket** — the intake forms are stored but there is **no submission /
      conversion pipeline** anywhere yet; building it means building the whole intake-submit flow.
    - **Automation-driven escalation & email-to-ticket** — automation rules are CRUD-only data
      today; nothing evaluates them (`fire_task_event` only pings realtime). A rule executor
      (and an inbound-email gateway) are separate subsystems. The manual **Escalate** action
      above covers the escalation need in the meantime.
