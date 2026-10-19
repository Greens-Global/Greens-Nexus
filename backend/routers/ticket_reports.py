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
import ticket_roles
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
    import ticket_notify
    return {"on": ticket_reports.weekly_opted_in(db, user["email"]),
            # Only ticket supervisors are sent the email; the switch is shown to them.
            "eligible": ticket_roles.can_manage_desk(user, db),
            "deskEnabled": bool(ticket_notify.get_settings(db)["enabledEvents"].get("weekly_report", True))}


@router.get("/task-tickets/reports/weekly-email")
def get_weekly_email_pref(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The caller's own Weekly Ticket Report opt-out."""
    return _pref(db, user)


@router.put("/task-tickets/reports/weekly-email")
def put_weekly_email_pref(body: WeeklyPrefBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if body.on is None:
        raise HTTPException(422, "on is required.")
    ticket_reports.set_weekly_opt_in(db, user["email"], body.on)
    return _pref(db, user)
