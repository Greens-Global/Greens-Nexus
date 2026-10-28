"""The Automations register (spec 6.9): every automation that is NOT a
workflow, on the Workflows screen - the Tasks automation rules with their
own on / off switch (saved through the Tasks rule endpoint, so the same
permission checks run) and the built-in background jobs, read-only, with
what they do, how often and the setting that controls them where one
exists. `jobs()` is written by hand from main.py's `_start_background_jobs`;
a new loop there gets a line here.
"""
from __future__ import annotations

from fastapi import HTTPException

import models
import task_automation

_TRIGGER_WORDS = {
    "created": "When a task is created",
    "status_changed": "When a task's status changes",
    "priority_changed": "When a task's priority changes",
    "assignee_changed": "When a task is assigned",
    "moved_to_project": "When a task moves to a project",
    "completed_early": "When a task is completed before its due date",
    "due_date_arrives": "When a task's due date arrives",
    "custom_field_changed": "When a task's custom field changes",
    "due_date_changed": "When a task's due date changes",
}


def trigger_text(trigger) -> str:
    t = trigger if isinstance(trigger, dict) else {}
    kind = str(t.get("type") or "")
    words = _TRIGGER_WORDS.get(kind, "When a task changes")
    value = t.get("value")
    if kind == "due_date_arrives" and value not in (None, ""):
        try:
            n = int(value)
        except (TypeError, ValueError):
            n = 0
        if n < 0:
            return f"{abs(n)} day{'s' if abs(n) != 1 else ''} before a task's due date"
        if n > 0:
            return f"{n} day{'s' if n != 1 else ''} after a task's due date"
        return "On a task's due date"
    if kind in ("status_changed", "priority_changed", "assignee_changed", "moved_to_project") and value:
        return f"{words} to {value}"
    return words


def task_rules(db, user: dict) -> list[dict]:
    """The Tasks rules the caller may see (the Tasks list route's rule)."""
    from routers.task_config import rule_to_dict
    from routers.task_util import config_admits
    import auth
    scope = auth.company_scope(user, db)
    out = []
    for r in db.query(models.TaskAutomationRule).order_by(models.TaskAutomationRule.name).all():
        company = getattr(r, "company_id", "") or ""
        if not config_admits(company, scope):
            continue
        d = rule_to_dict(r)
        d.update({"triggerText": trigger_text(r.trigger), "companyId": company,
                  "runsLink": {"view": "tasks", "sub": "manage", "ruleId": r.id}})
        out.append(d)
    return out


def set_task_rule_enabled(db, user: dict, rule_id: str, enabled: bool) -> dict:
    """Through the Tasks rule endpoint as the caller (manager tier, the
    rule's own company rule) - never a second write path."""
    from routers.task_config import RuleBody, update_rule
    if int(user.get("level", 0) or 0) < 3:
        raise HTTPException(403, "Only a manager can switch a Tasks rule")
    d = update_rule(rule_id, RuleBody(enabled=bool(enabled)), user, db)
    d.update({"triggerText": trigger_text(d.get("trigger")), "companyId": ""})
    r = db.get(models.TaskAutomationRule, rule_id)
    if r is not None:
        d["companyId"] = getattr(r, "company_id", "") or ""
    return d


def task_rule_runs(db, user: dict, rule_id: str, limit: int = 50) -> list:
    from routers.task_config import list_rule_runs
    return list_rule_runs(rule_id=rule_id, limit=limit, user=user, db=db)


def _job(key: str, label: str, what: str, every: str, setting: str = "") -> dict:
    # settingLink is a navigate detail (the Automations screen calls navigate(view, sub)); None = always on
    return {"key": key, "label": label, "what": what, "every": every,
            "settingLink": {"view": "admin", "sub": setting} if setting else None}


def jobs() -> list[dict]:
    """The background loops main.py starts, by hand (spec 6.9 item 6)."""
    return [
        _job("reminders", "Item Reminders", "Due-soon and overdue bells for checked-out items.", "Hourly"),
        _job("ticket_notify", "Ticket Notifications", "Ticket emails, SLA and escalation notices.", "Every minute",
             "notifications:tickets"),
        _job("task_notify", "Task Notifications", "Batched task emails and the task email queue.", "Every minute",
             "notifications:tasks"),
        _job("long_session", "Long Session Watch", "Flags a clock-in left running too long.", "Every 5 minutes",
             "time-clock"),
        _job("teams_post", "Teams Posts", "Delivers queued Teams posts.", "Every minute"),
        _job("ticket_teams_post", "Ticket Teams Messages", "Delivers queued ticket and workflow Teams messages.",
             "Every minute"),
        _job("daily_briefing", "Daily Briefing", "The morning briefing email.", "Daily", "notifications:briefing"),
        _job("weekly_digest", "Weekly Digest", "The Monday digest email.", "Weekly", "notifications:digest"),
        _job("scorecard", "Workforce Scorecard", "Scores punched hours against expected hours; Monday email.",
             "Weekly", "workforce-analytics"),
        _job("weather_watch", "Weather Advisory", "The rain advisory per shift group.", "Every 30 minutes",
             "shifts:weather"),
        _job("noshow", "No-Show Scan", "One bell per team and day for anyone not clocked in past start + grace.",
             "Every minute", "shifts:attendance"),
        _job("overtime_watch", "Overtime Alert", "A quiet bell when someone clocked in nears overtime.",
             "Every 5 minutes", "time-clock:overtime"),
        _job("calendar_sync", "Outlook Calendar Sync", "Shared shifts onto Outlook calendars.", "Every minute",
             "shifts:calendar"),
        _job("weather_call", "Weather Call Follow-Up", "A second text to anyone silent after 30 minutes.",
             "Every minute", "shifts:weather"),
        _job("interview_followup", "Interview Follow-Up", "Reminds interviewers to leave their vote.", "Hourly",
             "hiring"),
        _job("life_events", "HR Life Events", "Advances probation, hiring and separation processes.", "Hourly",
             "hiring"),
        _job("accounting_sso_sync", "Accounting Sign-In Sync", "Keeps accounting sign-ins in step.", "Every 15 minutes"),
        _job("leasing_sync", "MRI Leasing Sync", "Leases linked to their Intacct customers.", "Daily"),
        _job("recurring_stale", "Possibly Ended Lines", "Flags active lines with nothing posted for N months.", "Daily"),
        _job("period_close", "Pay Period Close Alerts", "One notice per approver per closed period.",
             "Every 30 minutes", "time-clock:payroll"),
        _job("employee_code_sync", "Intacct Employee Codes", "Employee codes from Intacct, nightly.", "Daily",
             "companies"),
        _job("performance", "Performance Reminders", "1:1 agendas and overdue goal check-ins.", "Every 30 minutes",
             "performance"),
        _job("workflows", "Workflows Runner", "Runs the workflows on this screen.", "Every 5 seconds", "workflows"),
        _job("task_inbound", "Task Email Replies", "The task reply mailbox into comments.", "Every minute",
             "notifications:tasks"),
        _job("ticket_inbound", "Email To Ticket", "The support mailbox into tickets and replies.", "Every minute",
             "tickets:intake"),
        _job("screenshot_retention", "Monitoring Retention", "Deletes monitoring frames past the retention window.",
             "Daily", "employee-tracking"),
        _job("purge_media", "Build Mode Media Purge", "Purges the media of pins closed 30+ days ago.", "Daily"),
        _job("construction_sweep", "Construction Media Sweep", "Moves construction media into storage.", "Hourly"),
        _job("m365_pushback", "Microsoft 365 Writeback", "Nexus directory changes back to Microsoft 365, nightly.",
             "Daily", "people-access"),
        _job("m365_contact_sync", "Microsoft 365 Contact Sync", "Contact info both ways.", "Every 15 minutes",
             "people-access"),
        _job("gbp_sync", "Google Business Profile", "Locations and reviews mirror.", "Every 30 minutes", "marketing"),
        _job("google_ads_sync", "Google Ads Mirror", "Spend per campaign per day.", "Every 2 hours", "marketing"),
        _job("cubby_snapshot", "Cubby Sync", "Re-reads the facilities; one snapshot per facility per day.",
             "Every 15 minutes", "operations"),
        _job("third_party_fetch", "Third-Party Properties", "Nightly fetch of third-party property data.", "Daily",
             "operations"),
        _job("market_watch", "Market Watch", "Reads each watched competitor's public pricing page.", "Daily",
             "operations"),
        _job("ops_budget", "Ops Budget Snapshot", "This month's actuals from the synced Cubby tables.",
             "Every 15 minutes", "operations"),
        _job("asset_geocode", "Asset Map Points", "Looks each asset's address up once.", "Continuous"),
        _job("trash_purge", "Task Trash Purge", "Permanently purges tasks deleted 90+ days ago.", "Daily"),
        _job("notification_retention", "Notification Retention", "Removes closed notices after 30 days.", "Daily"),
        _job("changelog_generate", "What's New Drafts", "Drafts What's New from git after each merge.", "Daily"),
        _job("ops_report_schedule", "Ops Report Schedules", "Saved reports emailed weekly or monthly.", "Hourly",
             "operations"),
        _job("ticket_report", "Weekly Ticket Report", "The weekly ticket report email.", "Weekly", "tickets:reports"),
        _job("customer_geo", "Customer Map", "Current customers' map points.", "Continuous", "operations"),
    ]


def register(db, user: dict) -> dict:
    return {"taskRules": task_rules(db, user), "jobs": jobs(),
            "taskEngine": {"actor": task_automation.AUTOMATION_ACTOR}}
