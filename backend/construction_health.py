"""Construction - a job's health at a glance (Neil, 11/03/2026, plan
https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr, phase 1 item 15).

"Nothing answers what is late, blocked or needs me": a project 3 days past
due at 94% looked healthy, an RFI 14 days overdue showed nothing. Every
project card and the project page now carry one health row, and the
dashboard lists projects worst first. ONE calculation, here, from the rows
themselves - nothing is guessed:

  Late      past its target finish and not complete.
  At Risk   the next milestone is within 7 days while progress is behind
            where the schedule says it should be (percent complete below the
            share of start -> target finish already elapsed), or an RFI is
            past its response date.
  On Track  everything else (a project with no dates can only be at risk
            through an overdue RFI - its schedule is not known).

Plus the facts a manager acts on: the next milestone and the days to it,
how many RFIs are overdue, and the last daily log ("No log in 3 days").
Pure functions - the router passes the rows and the jobsite's today.
"""
from __future__ import annotations

from datetime import date

ORDER = {"late": 0, "at_risk": 1, "on_track": 2, "complete": 3}
RISK_DAYS = 7
OPEN_SUBMITTALS = ("pending", "submitted")


def _day(v):
    try:
        return date.fromisoformat(str(v or "")[:10])
    except ValueError:
        return None


def expected_progress(project, today: date):
    """Share (0-1) of the start -> target finish span already elapsed, or
    None when either date is missing or the span is empty."""
    start, finish = _day(project.start_on), _day(project.target_finish_on)
    if not start or not finish or finish <= start:
        return None
    return min(1.0, max(0.0, (today - start).days / (finish - start).days))


def health(project, *, milestones=(), rfis=(), last_log_date: str = "", today: date) -> dict:
    """The health row for one project (see the module docstring)."""
    complete = (project.status or "active") == "complete" or (project.percent_complete or 0) >= 100
    finish = _day(project.target_finish_on)
    upcoming = sorted((m for m in milestones
                       if (m.status or "upcoming") in ("upcoming", "at_risk") and _day(m.target_date)),
                      key=lambda m: m.target_date)
    nxt = next((m for m in upcoming if _day(m.target_date) >= today), None)
    overdue_rfis = [r for r in rfis if (r.status or "open") == "open" and _day(r.due_on) and _day(r.due_on) < today]
    exp = expected_progress(project, today)
    behind = exp is not None and (project.percent_complete or 0) / 100.0 < exp
    reasons = []
    if complete:
        state = "complete"
    elif finish and finish < today:
        state = "late"
        reasons.append(f"{(today - finish).days} day{'s' if (today - finish).days != 1 else ''} past the target finish")
    else:
        soon = nxt is not None and (_day(nxt.target_date) - today).days <= RISK_DAYS
        if soon and behind:
            reasons.append("the next milestone is close and progress is behind schedule")
        if overdue_rfis:
            reasons.append(f"{len(overdue_rfis)} RFI{'s' if len(overdue_rfis) != 1 else ''} overdue")
        state = "at_risk" if reasons else "on_track"
    last = _day(last_log_date)
    return {
        "state": state,
        "reasons": reasons,
        "nextMilestone": ({"id": nxt.id, "name": nxt.name or "", "targetDate": nxt.target_date,
                           "days": (_day(nxt.target_date) - today).days} if nxt else None),
        "overdueRfis": len(overdue_rfis),
        "lastLogDate": last.isoformat() if last else "",
        "daysSinceLog": (today - last).days if last else None,
        "expectedPercent": round(exp * 100) if exp is not None else None,
        "daysPastTarget": (today - finish).days if (finish and finish < today and not complete) else 0,
        "today": today.isoformat(),
    }


def sort_key(project_dict: dict):
    """Worst first: Late, At Risk, On Track, Complete; then by name."""
    h = project_dict.get("health") or {}
    return (ORDER.get(h.get("state"), 2), (project_dict.get("name") or "").lower())


def target_moves(db, project) -> list:
    """Every time the job's target finish moved (Round Two, 11/05/2026): the
    activity rows Edit Job writes with the reason it asked for - a baseline
    plus a logged reason for every slip. Oldest first."""
    import models
    A = models.ConstructionActivity
    rows = (db.query(A).filter(A.project_id == project.id, A.entity_kind == "project", A.type == "target_moved")
            .order_by(A.at).all())
    return [{"from": (r.before or {}).get("target_finish_on", ""), "to": (r.after or {}).get("target_finish_on", ""),
             "reason": (r.after or {}).get("reason", ""), "at": r.at or "", "by": r.actor_email or ""} for r in rows]
