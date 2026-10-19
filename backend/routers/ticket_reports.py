"""Ticket Reports - routes (Oct 2026). The numbers are ticket_reports.py's
build_report, the one builder the screen, the CSV and the Monday email share.

Who may open them: whoever can open the Tickets screen and its Reports tab
today - a tasks or tickets Access Group grant, or an administrator
(App.jsx VIEW_MIN_ROLES / Sidebar, mirrored by require_any_module_grant on
the task-family routers). What they see inside is the ticket list's own
visibility (routers/tickets.ListScope): a desk agent the whole queue within
their company wall, anyone else only the tickets they may open.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

import ticket_reports
from auth import get_current_user, require_any_module_grant
from database import get_db

router = APIRouter(tags=["Tickets"], dependencies=[Depends(get_current_user),
                                                   Depends(require_any_module_grant("tasks", "tickets"))])


def _report(db: Session, user: dict, start: str, end: str, filters: dict, include_tickets: bool = False) -> dict:
    try:
        return ticket_reports.build_report(db, user["email"], start=start, end=end, filters=filters,
                                           user=user, include_tickets=include_tickets)
    except ticket_reports.RangeError as e:
        raise HTTPException(422, str(e))


def _filters(company: str, department: str, type: str, priority: str, assignee: str, service_area: str) -> dict:
    return {"company": company, "department": department, "type": type, "priority": priority,
            "assignee": assignee, "service_area": service_area}


@router.get("/task-tickets/reports")
def get_ticket_report(start: str = "", end: str = "", company: str = "", department: str = "",
                      type: str = "", priority: str = "", assignee: str = "", service_area: str = "",
                      user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _report(db, user, start, end, _filters(company, department, type, priority, assignee, service_area))


@router.get("/task-tickets/reports.csv")
def get_ticket_report_csv(start: str = "", end: str = "", company: str = "", department: str = "",
                          type: str = "", priority: str = "", assignee: str = "", service_area: str = "",
                          user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    report = _report(db, user, start, end, _filters(company, department, type, priority, assignee, service_area),
                     include_tickets=True)
    return Response(content=ticket_reports.to_csv(report), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{ticket_reports.csv_filename(report)}"'})


class WeeklyPrefBody(BaseModel):
    on: Optional[bool] = None


def _pref(db: Session, user: dict) -> dict:
    return ticket_reports.weekly_status(db, user["email"])


@router.get("/task-tickets/reports/meta")
def get_ticket_report_meta(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """What the Reports tab needs before its first report: the viewer's
    zone and today's date there (the date presets are counted from it, the
    same days the server buckets by), and their Weekly Email switch."""
    import ticket_notify
    import ticket_sla
    zone = ticket_notify._zone_for(db, user["email"])
    today = ticket_sla.utcnow().astimezone(ticket_reports._zone(zone)).date()
    return {"zone": zone, "today": today.isoformat(), "weeklyEmail": _pref(db, user)}


@router.put("/task-tickets/reports/weekly-email")
def put_weekly_email_pref(body: WeeklyPrefBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The caller's own Weekly Ticket Report choice."""
    if body.on is None:
        raise HTTPException(422, "on is required.")
    if not _pref(db, user)["eligible"]:
        raise HTTPException(403, "The weekly ticket report goes to desk supervisors only.")
    ticket_reports.set_weekly_opt_in(db, user["email"], body.on)
    return _pref(db, user)
