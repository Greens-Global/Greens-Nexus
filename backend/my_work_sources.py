"""My Work - one list of everything that is MINE to do (Neil, 11/13/2026).

    GET /me/work   (routers/my_work.py)

Before this a person had five places to look: the My Work tile (tasks and
tickets), Action Required, Approvals > Yours To Do, Tasks > My Day and My
Briefing - and a course that was due showed in none of them. This is the
registry behind ONE list, the way approvals_inbox is the registry behind one
approvals inbox.

NO NEW RULES. Every source asks the module's OWN "this is yours" rule and
never re-derives it:

  tasks      routers.my_work._my_open_tasks    the caller's open tasks
  tickets    routers.my_work._my_open_tickets  raised, filed or assigned
  todo       approvals_inbox.yours_to_do       Yours To Do: documents and Time
                                               Sheets to sign, items to
                                               accept, swaps, reviews, plans
  timesheet  timesheet_due.due_cached          Submit / Fix / Resubmit, worded
                                               by daily_briefing._due_row
  training   kb_training.my_training_summary   courses assigned and not done;
             kb_core.signoff_state             policies waiting for sign-off

Left out on purpose: a decision on someone ELSE's request stays in Approvals
(a manager's queue is not a to-do list), and a form is something a person
MAY fill - nothing in Nexus says a form is expected of someone, so there is
no rule to ask. A form becomes a source the day it can be assigned.

A source
--------
`fn(db, user, me, ctx) -> list[dict]`, registered with
`@source(key, label)`. `ctx` carries `tz_offset_min` and `today` (the
caller's local day). It returns items built with `item(...)` (tasks and
tickets keep the rows they always returned). The rules:

  * HTTPException = "nothing of yours here" - quiet, never an error.
  * Any other exception is isolated: the source is named in `errors`
    ("Couldn't Load Training") and every other source still shows. A list
    that could not load never looks like an empty one.
  * Scoped queries only - the tile polls this every minute for everyone.
  * `link` is a nexus:navigate target ({view, sub} plus the bell action keys
    lib/openTarget.js reads), so a row opens the screen that owns it. Nothing
    is decided or changed from this list except completing a task.

To add one: write the function here with @source and give its `kind` an icon
in frontend/src/dashboard/essentials/myWorkModel.js. Add a test in
test_my_work_sources.py.
"""
from __future__ import annotations

import logging
from typing import Callable

from fastapi import HTTPException
from sqlalchemy.orm import Session

import cache
import models

log = logging.getLogger(__name__)


class Source:
    __slots__ = ("key", "label", "fn")

    def __init__(self, key: str, label: str, fn: Callable):
        self.key, self.label, self.fn = key, label, fn


SOURCES: list[Source] = []


def source(key: str, label: str):
    """Register a source. Order of registration = order of the filter chips."""
    def deco(fn):
        SOURCES[:] = [s for s in SOURCES if s.key != key] + [Source(key, label, fn)]
        return fn
    return deco


def item(kind: str, rid: str, *, title: str, where: str = "", due_on: str = "", status: str = "",
         status_label: str = "", priority: str = "medium", link: dict | None = None, cta: str = "",
         detail: str = "") -> dict:
    """One My Work row, the shape the task and ticket rows already have.
    `where` is the muted line under the title (the project for a task);
    `cta` names what opening the row does ("Review & Sign")."""
    link = dict(link or {})
    return {"kind": kind, "id": str(rid), "code": "", "title": title or "Untitled", "project": where or "",
            "dueOn": (due_on or "")[:10], "status": status or kind, "statusLabel": status_label or "",
            "priority": priority if priority in ("urgent", "high", "medium", "low") else "medium",
            "unread": False, "view": link.get("view") or "", "sub": link.get("sub") or "",
            "link": link, "cta": cta or "", "detail": detail or ""}


def collect(db: Session, user: dict, me: str, tz_offset_min: int, today: str) -> dict:
    """Every source's items. {"items": [...], "sources": [{key, label,
    count}], "errors": [{source, label}]} - `sources` lists only the ones
    with something in them, in registration order."""
    ctx = {"tz_offset_min": tz_offset_min, "today": today}
    items, sources, errors = [], [], []
    for s in SOURCES:
        try:
            got = list(s.fn(db, user, me, ctx) or [])
        except HTTPException:
            got = []
        except Exception:   # noqa: BLE001 - one module failing never blanks the list
            log.exception("my work source %s failed", s.key)
            try:
                db.rollback()
            except Exception:   # noqa: BLE001
                pass
            errors.append({"source": s.key, "label": s.label})
            continue
        for it in got:
            it["source"] = s.key
        if got:
            sources.append({"key": s.key, "label": s.label, "count": len(got)})
        items += got
    return {"items": items, "sources": sources, "errors": errors}


# ── Tasks and tickets (the rows the tile always had) ─────────────────────────

@source("tasks", "Tasks")
def _tasks(db: Session, user: dict, me: str, ctx: dict) -> list:
    from routers import my_work
    return my_work._my_open_tasks(db, user, me)


@source("tickets", "Tickets")
def _tickets(db: Session, user: dict, me: str, ctx: dict) -> list:
    from routers import my_work
    return my_work._my_open_tickets(db, user, me, ctx.get("tz_offset_min") or 0)


# ── Yours To Do (Approvals' own rows) ────────────────────────────────────────

def _open_label(r: dict) -> str:
    """What opening the row does - the label of its Open action ("Review &
    Sign"), else of its first action."""
    acts = r.get("actions") or []
    for a in acts:
        if a.get("key") == "open" and a.get("label") and a["label"] != "Open":
            return a["label"]
    return (acts[0].get("label") if acts else "") or ""


@source("todo", "Yours To Do")
def _yours_to_do(db: Session, user: dict, me: str, ctx: dict) -> list:
    import approvals_inbox
    got = approvals_inbox.yours_to_do(db, user)
    out = [item("todo", r["key"], title=r["title"], where=r.get("sourceLabel") or "", due_on=r.get("due") or "",
                status="todo", status_label="Waiting on You", priority=r.get("priority") or "medium",
                link=r.get("link") or {}, cta=_open_label(r), detail=r.get("detail") or "")
           for r in got["rows"]]
    if got["errors"] and not out:
        # Nothing to show and a module failed: say so rather than look empty.
        raise RuntimeError("yours to do: " + ", ".join(e["source"] for e in got["errors"]))
    return out


# ── Time Sheet (timesheet_due - the one reminder rule) ───────────────────────

@source("timesheet", "Time Sheet")
def _timesheet(db: Session, user: dict, me: str, ctx: dict) -> list:
    import daily_briefing
    import timesheet_due
    out = []
    for d in timesheet_due.due_cached(db, me):
        if d.get("state") not in timesheet_due.ACTION_STATES:
            continue            # with the manager / being corrected: an update, not a to-do
        r = daily_briefing._due_row(d)   # the briefing's own words - never a second wording
        cta = (r.get("cta") or ("", ""))[0]
        link = {"view": "timeclock", "sub": "timesheet", "start": d["start"], "payType": d.get("payType") or ""}
        if "do=submit" in (r.get("url") or ""):
            link["submit"] = True
        out.append(item("timesheet", f"{d['start']}:{d.get('payType') or ''}", title=r.get("title") or "Submit Your Time Sheet",
                        where="Time Sheet", due_on=d.get("end") or "", status="timesheet",
                        status_label="Closes Today" if d["state"] == "closes_today" else "Not Submitted",
                        priority="high", link=link, cta=cta, detail=r.get("detail") or ""))
    return out


# ── Training (courses assigned, policies to sign) ────────────────────────────

# One person's training rows for a minute: a course card costs a few queries
# and the tile polls. Dropped by nothing - a finished course leaves the list
# within the minute.
_training_cache = cache.TTLCache("my_work_training", ttl=60)


def _training_rows(db: Session, user: dict, me: str) -> list:
    import kb_access
    import kb_core
    from routers import kb_training
    out = []
    for c in kb_training.my_training_summary(db, me)["due"]:
        if not c.get("assigned"):
            continue            # a course they opened by themselves is theirs to finish or not
        status = c.get("my_status") or "Not Started"
        out.append(item("course", c["id"], title=c.get("title") or "Course", where="Training",
                        due_on=c.get("due_date") or "", status="in_progress" if status == "In Progress" else "not_started",
                        status_label="In Progress" if status == "In Progress" else "Not Started",
                        link={"view": "sop", "sub": f"course:{c['id']}"},
                        cta="Continue" if status == "In Progress" else "Start"))
    docs = (db.query(models.KbDocument)
            .filter(models.KbDocument.status == "approved", models.KbDocument.require_ack.is_(True)).all())
    for d in kb_access.wall_rows(docs, user, db):
        st = kb_core.signoff_state(db, d, me)
        if st["required"] and not st["signed"]:
            out.append(item("policy", d.id, title=d.title or "Policy", where="Policy to Sign",
                            due_on=st.get("due") or "", status="todo", status_label="Waiting on You",
                            link={"view": "sop", "sub": f"page:{d.id}"}, cta="Read & Sign"))
    return out


@source("training", "Training")
def _training(db: Session, user: dict, me: str, ctx: dict) -> list:
    # Copies: collect() stamps each item with its source, and a cached row
    # must not carry one caller's stamp into the next read.
    return [dict(r) for r in _training_cache.get_or_load(me, lambda: _training_rows(db, user, me))]
