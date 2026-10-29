"""The Automations register (spec 6.9): every automation that is NOT a
workflow, on the Workflows screen - the Tasks automation rules with their
own on / off switch (saved through the Tasks rule endpoint, so the same
permission checks run) and the built-in background jobs, read-only, with
what they do, how often and the setting that controls them where one
exists. `jobs()` is written by hand from main.py's `_start_background_jobs`;
a new loop there gets a line here. Each key is also the job's off switch
(Oct 28 2026, job_switch.py): the tick behind it starts with
``if job_switch.off(key)``, and "what" says what "off" leaves waiting when a
job moves data as well as sends - only the sending stops, never the data.
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


def _job(key: str, label: str, what: str, every: str, setting: str = "", switch: bool = True) -> dict:
    # settingLink is a navigate detail (the Automations screen calls navigate(view, sub)); None = no setting.
    # switch=False: the job has switches of its own and the off list never applies to it (the Workflows runner).
    return {"key": key, "label": label, "what": what, "every": every, "switch": switch,
            "settingLink": {"view": "admin", "sub": setting} if setting else None}


def jobs() -> list[dict]:
    """The background loops main.py starts, by hand (spec 6.9 item 6)."""
    return [
        _job("reminders", "Item Reminders", "Due-soon and overdue bells for checked-out items.", "Daily"),
        _job("equipment_reminders", "Equipment Reminders", "Overdue checkouts and asset date alerts.", "Daily"),
        _job("hr_checklists", "Checklist Reminders",
             "The day's onboarding and offboarding checklist reminders; the checklist sync itself keeps running.",
             "Daily", "hiring"),
        _job("hr_probation", "Probation",
             "Passes probation automatically at the end date when nothing was decided, and sends the reminder "
             "before it. Off: neither happens.",
             "Daily", "hiring"),
        _job("hr_record_audit", "Records Audit", "Missing details and expired documents, one bell per company.",
             "Daily"),
        _job("maintenance_services", "Maintenance Reminders",
             "15-day reminders for recurring property maintenance, and a ticket for a service that came due with "
             "none opened.", "Daily"),
        _job("credvault_rotation", "Credential Rotation Reminders",
             "Rotation due, overdue and hard expiry, to the owner and backup owner.", "Daily"),
        _job("kb_daily", "Training Reminders",
             "Training due, policies to sign, and the manager and owner digests; assignment rules and renewals "
             "keep running. Also sends policy signing requests through Nexus Sign.", "Daily", "emails:kb-reminders"),
        _job("ticket_notify", "Ticket Notifications",
             "Ticket email retries, overdue and SLA breach notices, and the auto-close of long-resolved tickets.",
             "Every minute", "notifications:tickets"),
        _job("task_notify", "Task Notifications",
             "Task email batches: off means queued task emails wait, as do due-date reminders and retries; "
             "recurrences and the Tasks clock rules keep running.", "Every minute", "notifications:tasks"),
        _job("long_session", "Long Session Watch", "Flags a clock-in left running too long.", "Every 5 minutes",
             "time-clock"),
        _job("teams_post", "Teams Posts", "Delivers queued Teams posts; off means they wait.", "Every minute"),
        _job("ticket_teams_post", "Ticket Teams Messages",
             "Delivers queued ticket and workflow Teams messages; off means they wait.", "Every minute"),
        _job("daily_briefing", "Daily Briefing", "The morning briefing email.", "Daily", "notifications:briefing"),
        _job("weekly_digest", "Weekly Digest", "The Monday digest email.", "Weekly", "notifications:digest"),
        _job("scorecard", "Workforce Scorecard", "Scores punched hours against expected hours; Monday email.",
             "Weekly", "workforce-analytics"),
        _job("weather_watch", "Weather Advisory", "The rain advisory per shift group.", "Every 30 minutes",
             "shifts:weather"),
        _job("noshow", "No-Show Scan", "One bell per team and day for anyone not clocked in past start + grace.",
             "Every minute", "shifts:attendance"),
        _job("meal_watch", "Meal Break Reminder", "The California meal reminder at 4.5 hours.", "Every minute",
             "time-clock"),
        _job("overtime_watch", "Overtime Alert", "A quiet bell when someone clocked in nears overtime.",
             "Every 5 minutes", "time-clock:overtime"),
        _job("break_watch", "Break Watch", "A nudge, then an escalation, for a break that never ended.",
             "Every 5 minutes", "time-clock"),
        _job("calendar_sync", "Outlook Calendar Sync",
             "Shared shifts onto Outlook calendars; off means the queue waits.", "Every minute", "shifts:calendar"),
        _job("weather_call", "Weather Call Follow-Up", "A second text to anyone silent after 30 minutes.",
             "Every minute", "shifts:weather"),
        _job("interview_followup", "Interview Follow-Up", "Reminds interviewers to leave their vote.", "Hourly",
             "hiring"),
        _job("life_events", "HR Life Events",
             "Files signed HR packets and marks separations complete on their date; off means they wait.",
             "Every minute", "hiring"),
        _job("timesheet_filing", "Time Sheet Filing",
             "Retries signed Time Sheets whose Egnyte filing failed; off means they wait.", "Every minute"),
        _job("hr_letter_filing", "HR Letter Filing", "Files issued HR letters; off means they wait.", "Every minute"),
        _job("leave_year_end", "Leave Year End", "Settles each person's last closed leave year.", "Daily"),
        _job("accounting_sso_sync", "Accounting Sign-In Sync", "Keeps accounting sign-ins in step.", "Every 15 minutes"),
        _job("leasing_sync", "MRI Leasing Sync", "Leases linked to their Intacct customers.", "Daily"),
        _job("recurring_stale", "Possibly Ended Lines", "Flags active lines with nothing posted for N months.", "Daily"),
        _job("period_close", "Pay Period Close Alerts", "One notice per approver per closed period. Off stops the notices only: unsigned corrections are still accepted, stale reviews retired and the Extra Time reminder sent.",
             "Every 30 minutes", "time-clock:payroll"),
        _job("employee_code_sync", "Intacct Employee Codes", "Employee codes from Intacct, nightly.", "Daily",
             "companies"),
        _job("performance", "Performance Reminders", "1:1 agendas and overdue goal check-ins.", "Every 30 minutes",
             "performance"),
        _job("workflows", "Workflows Runner", "Runs the workflows on this screen; its switches are in Settings > Workflows.",
             "Every 5 seconds", "workflows", switch=False),
        _job("task_inbound", "Task Email Replies",
             "The task reply mailbox into comments; off means replies wait in the mailbox.", "Every minute",
             "notifications:tasks"),
        _job("ticket_inbound", "Email To Ticket",
             "The support mailbox into tickets and replies; off means mail waits in the mailbox.", "Every minute",
             "tickets:intake"),
        _job("screenshot_retention", "Monitoring Retention", "Deletes monitoring frames past the retention window.",
             "Daily", "employee-tracking"),
        _job("purge_media", "Build Mode Media Purge", "Purges the media of pins closed 30+ days ago.", "Daily"),
        _job("construction_sweep", "Construction Media Sweep",
             "Files construction media into Egnyte; off means uploads wait as pending.", "Every minute"),
        _job("construction_ai", "Construction AI Jobs", "Transcripts, summaries and the weekly report drafts.",
             "Every minute"),
        _job("m365_pushback", "Microsoft 365 Writeback", "Nexus directory changes back to Microsoft 365, nightly.",
             "Daily", "people-access"),
        _job("m365_contact_sync", "Microsoft 365 Contact Sync", "Contact info both ways.", "Every 15 minutes",
             "people-access"),
        _job("gbp_sync", "Google Business Profile", "Locations and reviews mirror.", "Every 30 minutes", "marketing"),
        _job("google_ads_sync", "Google Ads Mirror", "Spend per campaign per day.", "Every 2 hours", "marketing"),
        _job("cubby_snapshot", "Cubby Sync", "Re-reads the facilities; one snapshot per facility per day.",
             "Every 15 minutes", "operations"),
        _job("stortrack_sync", "StorTrack Rates", "Competitor rates from the StorTrack feed.", "Every few hours",
             "operations"),
        _job("cma_push", "CMA Queued Pushes",
             "Approved rate changes to Cubby on their effective date, only while Push To Cubby is on.", "Hourly",
             "operations"),
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
    import job_switch
    runs = job_switch.last_runs(db)   # jobs that report their last run (job_switch.record_run)
    return {"taskRules": task_rules(db, user), "jobs": [{**j, "lastRun": runs.get(j["key"])} for j in jobs()],
            "taskEngine": {"actor": task_automation.AUTOMATION_ACTOR}}
