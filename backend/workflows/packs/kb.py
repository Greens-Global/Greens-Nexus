"""Knowledge Base pack (11/05/2026): the training action a workflow may take.

Assign A Training Course - the Training screen's own "Assign" (routers/
kb_training.py `assign_course`) as the workflow's owner, with the same three
gates that route has: the owner is a course author (a manager, or the
Knowledge Base editor grant - `kb_access.is_author`), the course is
published and visible to them (`kb_access.get_course`), and each person is
inside the owner's company wall (`kb_access.in_scope`) - someone outside it
is skipped, never assigned across the wall. A person who already has the
course keeps their assignment as it is (a workflow never moves someone's
due date). The bell is the screen's "Training Assigned" one; the daily pass
(kb_daily) sends the due-soon / overdue reminders and the escalation as for
any other assignment.

The run is idempotent without bookkeeping: an assignment that exists is
never made twice, so a retried step only assigns the people it missed.
"""
from __future__ import annotations

import models
from workflows.catalog import P, action, option_source

MODULE = "kb"


def _courses(db) -> list:
    rows = (db.query(models.KbCourse).filter(models.KbCourse.status == "published")
            .order_by(models.KbCourse.title).all())
    return [{"value": r.id, "label": r.title or r.id} for r in rows]


option_source("kb_courses", _courses)


def _course_id(params) -> str:
    v = params.get("course")
    if isinstance(v, dict):
        v = v.get("id") or v.get("value")
    return str(v or "").strip()


def _course(ctx, params):
    """The course as the owner may see it; ValueError with a readable reason."""
    import kb_access
    from fastapi import HTTPException
    cid = _course_id(params)
    if not cid:
        raise ValueError("Pick the course to assign")
    if ctx.run_as is None:
        raise ValueError("Assigning training needs a person's identity")
    try:
        c = kb_access.get_course(ctx.db, cid, ctx.run_as)
    except HTTPException:
        raise ValueError("The course is gone or the owner can no longer see it") from None
    if (c.status or "") != "published":
        raise ValueError(f"{c.title} is not published")
    return c


def _due_days(params):
    raw = params.get("due_days")
    if raw in (None, ""):
        return None
    try:
        return max(0, int(float(raw)))
    except (TypeError, ValueError):
        return None


def _due(db, course, email: str, params) -> str:
    """Due date for one person: the step's days, else the course's default
    days, counted from that person's own today; none when neither is set."""
    import kb_core
    days = _due_days(params)
    if days is None:
        days = int(course.default_due_days or 0)
    return kb_core.add_days(kb_core.today_for(db, email), days) if days else ""


def _allowed(ctx, params) -> str:
    import kb_access
    if ctx.run_as is None:
        return "Assigning training needs a person's identity"
    if not kb_access.is_author(ctx.run_as, ctx.db):
        return "The owner needs the Knowledge Base editor grant (or to be a manager) to assign training"
    try:
        _course(ctx, params)
    except ValueError as e:
        return str(e)
    return ""


def _plan(ctx, params) -> str:
    from workflows.packs.core import _dropped_note, _names, resolve_to
    try:
        c = _course(ctx, params)
    except ValueError as e:
        return str(e)
    to, dropped = resolve_to(ctx, params.get("to"))
    days = _due_days(params)
    if days is None:
        days = int(c.default_due_days or 0)
    due = f", due in {days} days" if days else ""
    return f"Would assign {c.title} to {_names(ctx, to)}{due}{_dropped_note(dropped)}"


def _run(ctx, params) -> dict:
    import kb_access
    import kb_core
    from workflows.context import person_name
    from workflows.packs.core import _dropped_note, _names, resolve_to
    reason = _allowed(ctx, params)
    if reason:
        raise PermissionError(reason)
    c = _course(ctx, params)
    me = (ctx.run_as.get("email") or "").lower()
    sc = kb_access.scope(ctx.run_as, ctx.db)
    to, dropped = resolve_to(ctx, params.get("to"))
    made, had, walled = [], [], []
    for email in to:
        if not kb_access.in_scope(ctx.db, email, sc):
            walled.append(email)
            continue
        have = (ctx.db.query(models.KbCourseAssignment)
                .filter(models.KbCourseAssignment.course_id == c.id,
                        models.KbCourseAssignment.user_email == email).first())
        if have is not None:
            had.append(email)
            continue
        due = _due(ctx.db, c, email, params)
        ctx.db.add(models.KbCourseAssignment(
            id=kb_core.new_id("asn"), course_id=c.id, user_email=email, user_name=person_name(ctx.db, email),
            due_date=due, assigned_by=me, created_at=kb_core.now(), source="workflow"))
        kb_core.notify(ctx.db, recipient=email, ntype="kb_course_assigned", title="Training Assigned",
                       body=c.title + (f" - due {kb_core_us(due)}" if due else ""), ref_id=c.id,
                       item_name=c.title, sub=f"course:{c.id}", requested_by=me)
        ctx.db.flush()       # autoflush is off: the next person's lookup must see this row
        made.append(email)
    line = f"Assigned {c.title} to {_names(ctx, made)}" if made else f"Nobody new was assigned {c.title}"
    notes = []
    if had:
        notes.append(f"{len(had)} already had it")
    if walled:
        notes.append(f"{len(walled)} outside the owner's companies")
    if notes:
        line += " (" + ", ".join(notes) + ")"
    line += _dropped_note(dropped)
    return {"line": line, "sent": made, "affected": [{"entity": "kb_course", "id": c.id, "label": c.title}]}


def kb_core_us(iso: str) -> str:
    from kb_daily import _us
    return _us(iso)


action("kb.assign_course", label="Assign A Training Course", module=MODULE,
       params=[P("course", "Course", "select", options="kb_courses", hint="Published courses only"),
               P("to", "Assign To", "recipients"),
               P("due_days", "Due In Days", "number", required=False,
                 hint="Counted from each person's today. Blank uses the course's own default.")],
       plan=_plan, run=_run, allowed=_allowed)
