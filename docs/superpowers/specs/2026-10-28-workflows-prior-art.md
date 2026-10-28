# Prior art survey (Oct 28 2026) - what enterprise builders do, and what fits Nexus

Sources read: ServiceNow Flow Designer docs/community, Microsoft Power Automate (Learn + community standards),
Salesforce Flow (Trailhead, developer blog), Workato docs (version management, recipe diff, RLCM),
Rippling Workflow Studio, Jira Automation (service limits, branches, smart values), monday.com AI workflow builder,
Workday Business Process Framework docs, n8n 2.x, HubSpot workflows KB, Zapier glossary/learn, Asana rules.

## Features that recur across the serious platforms (and belong in Nexus)
1. Trigger kinds: record event (created / field changed / status changed), schedule (daily/weekly at a time, company time zone),
   date-relative ("N days before/after a date field" - Salesforce scheduled paths, Rippling start-date triggers), manual ("run on this record"),
   inbound (form/email/webhook).  Jira/Asana/Salesforce all expose field-change with from/to values.
2. Conditions: AND/OR groups (Asana, Workday), with "changed from X to Y" operators; evaluate against the record AFTER the change (Tasks engine already does this).
3. Actions beyond the record itself: notify / email / chat post / create task / create ticket / assign / set field / add comment / start a checklist / webhook (Rippling, Power Automate, Jira).
4. Human-in-the-loop: "Ask for approval and wait" with approval types - everyone must approve, first to respond, sequential, custom responses (Power Automate), approve / deny / send back (Workday). ServiceNow "Wait for condition" with timeout. Our Approvals inbox is the natural surface.
5. Time: delay N (minutes/hours/days), "wait until" a date/time, business-hours awareness; run later as a scheduled path, not inside the triggering transaction (Salesforce).
6. Branching: if/else blocks; "for each" over related records (Jira advanced branching); fault path / error handler branch (Salesforce fault paths, ServiceNow error handler, n8n error workflow).
7. Templating: smart values / expressions in text - {{employee.name}}, {{fieldChange.from}} -> {{fieldChange.to}} (Jira), with a picker, never free-form code for business users.
8. Versioning: every publish is a version; draft vs published (n8n 2.x, Workato); diff between versions (Workato recipe diff); rollback.
9. Testing before go-live: debug with a sample record (Salesforce Debug), pinned/replayed data (n8n), "test flow" and execution details (ServiceNow). Dry run must show what WOULD happen.
10. Run history: per-run, per-step status with inputs/outputs and the error on the failing step (Zapier Zap history, Power Automate run history); replay a failed run after fixing it.
11. Governance and limits: throttle + auto-disable a runaway rule and mark it THROTTLED in the audit log (Jira service limits); per-hour execution caps; concurrency cap; regex/expression timeout.
    One accountable owner per workflow, inventory with purpose + review date, least privilege, "run as" a defined user (Salesforce Default Workflow User runs scheduled paths when the author is inactive).
12. Reuse: subflows / child flows with inputs and outputs (ServiceNow, Power Automate); rule bundles applied to many projects (Asana); template gallery (Rippling "hundreds of templates").
13. Enrollment semantics (HubSpot): re-enrollment rules, suppression (never run for X), goal-based unenrollment; "once per record" vs "every time".
14. Natural-language creation: describe it in plain English -> a draft recipe (monday.com AI builder). We already have ANTHROPIC_API_KEY in ai_assistant.py.
15. Ownership of side effects: automated changes attributed to a visible actor ("Automation") in the record's history (Tasks engine already does; Jira audit log).

## What NOT to copy
- A node canvas (monday AI blocks, n8n). Nexus has ~150 KB bundle headroom and no canvas lib; a vertical "When / Check / Do" list (Asana) is faster to read and builds on the Tasks RuleModal pattern. Branches render as indented blocks.
- Unlimited chaining. Jira's throttling exists because chains run away. Keep the Tasks engine rule: an automated change does not fire other workflows unless the workflow opts in, depth capped.
- Free-form code steps (Power Automate expressions, n8n Code nodes). Expression picker + fixed operators only.
- Separate "connections"/credentials UI. Nexus is single-tenant; outbound webhooks are Global Admin only with an allow-list.
