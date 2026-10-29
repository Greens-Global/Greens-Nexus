"""Performance API: goals and 1:1s (Neil, Oct 27 2026). The rules - who sees
and changes what, when meetings fall, the reminders - are performance.py;
this file is shapes and permissions applied through those rules.

Everyone signed in (employees, not externals) reaches it: their own goals and
1:1s, their team's when they manage people, the company's when they are HR.
Every handler checks the row it touches; a goal or 1:1 the caller may not see
answers 404, so existence does not leak."""
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

import models
import perf_metrics
import performance as perf
import scoped_settings
from auth import get_current_user
from database import get_db

router = APIRouter(prefix="/performance", tags=["Performance"], dependencies=[Depends(get_current_user)])


def _now_utc() -> str:
    return perf.utc_str(datetime.now(timezone.utc))


def _me(user: dict) -> str:
    perf.require_internal(user)
    return (user.get("email") or "").strip().lower()


# ── Context ──────────────────────────────────────────────────────────────────

@router.get("/me")
def my_context(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Who the caller is here: their reports, whether they are HR (and for
    which companies), and the settings their company runs on."""
    me = _me(user)
    emp = perf.employee(db, me)
    reports = perf.direct_reports(db, me)
    team = perf.below(db, me)
    reach = perf.hr_reach(db, user)
    mgr = (emp.manager_email or "").strip().lower() if emp else ""
    return {
        "email": me, "name": perf.name_of(db, me),
        "company": (emp.company if emp else "") or "", "department": (emp.department if emp else "") or "",
        "manager": {"email": mgr, "name": perf.name_of(db, mgr)} if mgr else None,
        "reports": [perf.person_out(db, e) for e in reports],
        "team": [perf.person_out(db, e) for e in team],
        "hasTeam": bool(reports),
        "isHr": reach is not False,
        "hrCompanies": perf.companies_out(db, reach) if reach is not False else [],
        "settings": perf.settings_for(db, me),
        "statuses": [{"key": k, "label": perf.STATUS_LABELS[k]} for k in perf.STATUSES],
        "metrics": perf_metrics.catalog(),
        "maxGoals": perf.MAX_OPEN_GOALS,
        "cadences": [{"key": k, "label": perf.CADENCE_LABELS[k]} for k in perf.CADENCES],
    }


# ── Goals ────────────────────────────────────────────────────────────────────

class GoalIn(BaseModel):
    title: str
    description: Optional[str] = ""
    level: Optional[str] = "personal"
    owner_email: Optional[str] = ""
    owner_emails: Optional[list] = None   # the same goal for several direct reports - one row each
    company_id: Optional[str] = ""
    department: Optional[str] = ""
    measure: Optional[str] = "percent"
    metric_key: Optional[str] = ""        # measured by Nexus (perf_metrics.METRICS); '' = by hand
    start_value: Optional[float] = 0
    target_value: Optional[float] = None
    unit: Optional[str] = ""
    start_on: Optional[str] = ""
    due_on: Optional[str] = ""
    parent_id: Optional[str] = ""
    status: Optional[str] = ""            # ignored - status is computed


class GoalPatch(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    owner_email: Optional[str] = None
    metric_key: Optional[str] = None
    measure: Optional[str] = None
    start_value: Optional[float] = None
    target_value: Optional[float] = None
    unit: Optional[str] = None
    start_on: Optional[str] = None
    due_on: Optional[str] = None
    parent_id: Optional[str] = None
    status: Optional[str] = None


class CheckinIn(BaseModel):
    value: Optional[float] = None
    status: Optional[str] = ""
    note: Optional[str] = ""


def _day(s: Optional[str]) -> str:
    v = (s or "").strip()[:10]
    if not v:
        return ""
    try:
        date.fromisoformat(v)
    except ValueError:
        raise HTTPException(400, "Pick a valid date.")
    return v


def _metric_key(key: Optional[str]) -> str:
    k = (key or "").strip()
    if k and k not in perf_metrics.METRICS:
        raise HTTPException(400, "Pick one of the Nexus numbers, or I'll Update It.")
    return k


GOAL_OLDEST_START_DAYS = 3 * 366


def _check_period(start: str, end: str, today: str) -> None:
    from datetime import date as _d
    if end and start and end < start:
        raise HTTPException(400, "The due date is before the goal starts.")
    if start and start < (_d.fromisoformat(today) - timedelta(days=GOAL_OLDEST_START_DAYS)).isoformat():
        raise HTTPException(400, "A goal starts within the last three years.")


def _lock_owners(db: Session, owners: list) -> None:
    """The 5-goal cap, serialized per owner: lock each owner's People row (in
    one order, so two requests never wait on each other) before counting -
    a second create or restore at the same time counts the first."""
    from sqlalchemy import func as _f
    for em in sorted({(o or "").strip().lower() for o in owners if o}):
        (db.query(models.NexusEmployee.id).filter(_f.lower(models.NexusEmployee.work_email) == em)
         .with_for_update().first())


def _default_end(start: str) -> str:
    from datetime import date as _d
    d = _d.fromisoformat(start)
    m = d.month - 1 + perf.DEFAULT_PERIOD_MONTHS
    y, m = d.year + m // 12, m % 12 + 1
    import calendar as _c
    return d.replace(year=y, month=m, day=min(d.day, _c.monthrange(y, m)[1])).isoformat()


def _measure_values(measure: str, start, target) -> tuple:
    if measure not in perf.MEASURES:
        raise HTTPException(400, "Pick Percent, Number or Done / Not Done.")
    if measure == "percent":
        return 0.0, 100.0
    if measure == "done":
        return 0.0, 1.0
    if target is None:
        raise HTTPException(400, "Set the target number.")
    return float(start or 0), float(target)


def _goal_or_404(db: Session, user: dict, gid: str) -> models.PerfGoal:
    g = db.get(models.PerfGoal, gid)
    if g is None or not perf.can_see_goal(db, user, g):
        raise HTTPException(404, "Goal not found")
    return g


def _list_out(db: Session, user: dict, rows: list) -> list:
    names: dict = {}
    parents = {p.id: p for p in db.query(models.PerfGoal)
               .filter(models.PerfGoal.id.in_([g.parent_id for g in rows if g.parent_id] or [""])).all()}
    order = {"company": 0, "department": 1, "personal": 2}
    rows = sorted(rows, key=lambda g: (order.get(g.level, 3), g.due_on or "9999", g.title.lower()))
    today = perf.local_today()
    _prefetch(db, rows, today)
    return [perf.goal_out(db, user, g, names=names, parents=parents, today=today) for g in rows]


def _prefetch(db: Session, rows: list, today: str) -> None:
    """Warm the scorecard memory for every Nexus-measured goal on a list -
    one batched pass per period and source, not one per goal."""
    from datetime import date as _d
    groups: dict = {}
    for g in rows:
        if perf._metric_def(g) is None:
            continue
        start, end = perf.goal_period(g)
        k = (start, end or today)
        groups.setdefault(k, (set(), set()))
        groups[k][0].add(g.owner_email)
        groups[k][1].add(g.metric_key)
    for (start, end), (owners, keys) in groups.items():
        perf_metrics.prefetch(db, owners, keys, start, end, today=_d.fromisoformat(today))


@router.get("/goals")
def list_goals(scope: str = "mine", person: str = "", company: str = "", archived: bool = False,
               user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """scope: mine (my goals, and the company and department goals they line
    up with), team (the people under me), company (HR), person (one person's,
    when I may see them)."""
    me = _me(user)
    emp = perf.employee(db, me)
    q = db.query(models.PerfGoal)
    if not archived:
        q = q.filter(models.PerfGoal.archived_at == "")
    if scope == "mine":
        conds = [models.PerfGoal.owner_email == me]
        if emp and emp.company:
            conds.append((models.PerfGoal.level == "company") & (models.PerfGoal.company_id == emp.company))
            if emp.department:
                conds.append((models.PerfGoal.level == "department") & (models.PerfGoal.company_id == emp.company)
                             & (models.PerfGoal.department == emp.department))
        rows = q.filter(or_(*conds)).all()
    elif scope == "team":
        team = {(e.work_email or "").lower() for e in perf.below(db, me)}
        rows = q.filter(models.PerfGoal.owner_email.in_(sorted(team) or [""]),
                        models.PerfGoal.level != "company").all() if team else []
        return _list_out(db, user, rows)   # everyone below me is in my chain by construction
    elif scope == "company":
        reach = perf.hr_reach(db, user)
        if reach is False:
            raise HTTPException(403, "Company goals across people are for HR.")
        cid = (company or "").strip()
        if cid:
            if not perf.hr_for(db, user, cid):
                raise HTTPException(404, "Company not found")
            q = q.filter(models.PerfGoal.company_id == cid)
        elif reach is not None:
            q = q.filter(models.PerfGoal.company_id.in_(sorted(reach) or [""]))
        return _list_out(db, user, q.all())
    elif scope == "person":
        who = (person or "").strip().lower()
        if not who:
            raise HTTPException(400, "Pick a person.")
        if who != me and not (perf.is_above(db, me, who) or perf.hr_for_person(db, user, who)):
            raise HTTPException(404, "Person not found")
        rows = q.filter(models.PerfGoal.owner_email == who, models.PerfGoal.level == "personal").all()
    else:
        raise HTTPException(400, "Unknown scope")
    return _list_out(db, user, [g for g in rows if perf.can_see_goal(db, user, g, me_emp=emp)])


@router.get("/goals/{gid}")
def get_goal(gid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    g = _goal_or_404(db, user, gid)
    out = perf.goal_out(db, user, g)
    names: dict = {}
    hist = (db.query(models.PerfGoalCheckin).filter(models.PerfGoalCheckin.goal_id == g.id)
            .order_by(models.PerfGoalCheckin.at.desc()).all())
    for c in hist:
        if c.by_email not in names:
            names[c.by_email] = perf.name_of(db, c.by_email)
    out["checkins"] = [{"id": c.id, "at": c.at, "by": c.by_email, "byName": names[c.by_email],
                        "value": c.value, "status": c.status, "statusLabel": perf.STATUS_LABELS.get(c.status, c.status),
                        "note": c.note or ""} for c in hist]
    kids = (db.query(models.PerfGoal).filter(models.PerfGoal.parent_id == g.id, models.PerfGoal.archived_at == "").all())
    today = perf.local_today()

    def kid(k):
        st = perf.computed_status(k, today, perf.refresh_metric(db, k, today))
        return {"id": k.id, "title": k.title, "ownerName": perf.name_of(db, k.owner_email),
                "progress": perf.progress(k), "status": st, "statusLabel": perf.STATUS_LABELS.get(st, st)}
    out["children"] = [kid(k) for k in kids if perf.can_see_goal(db, user, k)]
    return out


def _new_goal(db: Session, user: dict, me: str, body: GoalIn, level: str, owner_email: str) -> models.PerfGoal:
    import notify_rollup
    owner, cid, dept = perf.check_create(db, user, level, owner_email, body.company_id, body.department)
    metric = _metric_key(body.metric_key)
    if metric and level != "personal":
        raise HTTPException(400, "Only a personal goal is measured by a Nexus number.")
    if level == "personal":
        _lock_owners(db, [owner])
    if metric:
        if body.target_value is None:
            raise HTTPException(400, "Set the target.")
        measure, start, target = "number", 0.0, float(body.target_value)
    else:
        measure = (body.measure or "percent").strip()
        start, target = _measure_values(measure, body.start_value, body.target_value)
    if level == "personal" and perf.open_goal_count(db, owner) >= perf.MAX_OPEN_GOALS:
        raise HTTPException(400, f"{'You have' if owner == me else perf.name_of(db, owner) + ' has'} "
                                 f"{perf.MAX_OPEN_GOALS} open goals - finish or archive one first.")
    today = perf.local_today()
    p_start = _day(body.start_on) or today
    p_end = _day(body.due_on) or _default_end(p_start)
    _check_period(p_start, p_end, today)
    gid = perf.new_id()
    now = perf.now_iso()
    proposed = perf.needs_approval(db, me, owner, level)
    g = models.PerfGoal(id=gid, level=level, company_id=cid, department=dept, owner_email=owner,
                        title=(body.title or "").strip()[:300], description=(body.description or "").strip()[:4000],
                        measure=measure, metric_key=metric, start_value=start, target_value=target, current_value=start,
                        unit=("" if metric else (body.unit or "").strip()[:40]), status="on_track",
                        start_on=p_start, due_on=p_end, period_start=p_start, period_end=p_end,
                        parent_id=perf.check_parent(db, user, gid, body.parent_id), created_by=me,
                        approved_at="" if proposed else now, approved_by="" if proposed else me,
                        created_at=now, updated_at=now, last_checkin_at="", checkin_nudged_at="", archived_at="")
    db.add(g)
    if owner != me:
        notify_rollup.upsert_rollup(
            db, recipient=owner, key=f"perf-goal-new:{today}", title="New Goal for You",
            line=f"{perf.name_of(db, me)} set a goal for you: {g.title}.",
            action={"view": "myhr", "sub": "performance"}, company=cid)
    elif proposed:
        mgr = (perf.employee(db, owner).manager_email or "").strip().lower()
        notify_rollup.upsert_rollup(
            db, recipient=mgr, key=f"perf-goal-proposed:{today}", title="Goals to Approve",
            line=f"{perf.name_of(db, owner)} proposed a goal: {g.title}.",
            action={"view": "myhr", "sub": "performance:team"}, company=cid)
    return g


@router.post("/goals", status_code=201)
def create_goal(body: GoalIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """One goal - or, with owner_emails, the same goal for several direct
    reports at once (one row each; every owner is checked the same way)."""
    me = _me(user)
    if not (body.title or "").strip():
        raise HTTPException(400, "Give the goal a title.")
    level = (body.level or "personal").strip()
    owners = [str(e).strip().lower() for e in (body.owner_emails or []) if str(e).strip()]
    if owners:
        if level != "personal":
            raise HTTPException(400, "Only a personal goal is set for several people at once.")
        _lock_owners(db, owners)
        rows = [_new_goal(db, user, me, body, level, o) for o in dict.fromkeys(owners)]
        db.commit()
        today = perf.local_today()
        return {"created": [perf.goal_out(db, user, g, today=today) for g in rows]}
    g = _new_goal(db, user, me, body, level, body.owner_email)
    db.commit()
    return perf.goal_out(db, user, g)


@router.post("/goals/{gid}/approve")
def approve_goal(gid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The manager (anyone above them, or HR) agrees to a goal the person
    proposed for themselves."""
    me = _me(user)
    g = _goal_or_404(db, user, gid)
    if not perf.can_approve_goal(db, user, g):
        raise HTTPException(403, "Only their manager or HR approves this goal.")
    g.approved_at, g.approved_by, g.updated_at = perf.now_iso(), me, perf.now_iso()
    import notify_rollup
    notify_rollup.upsert_rollup(
        db, recipient=g.owner_email, key=f"perf-goal-approved:{perf.local_today()}", title="Goal Approved",
        line=f"{perf.name_of(db, me)} approved your goal: {g.title}.",
        action={"view": "myhr", "sub": f"performance:goal:{g.id}"}, company=g.company_id or "")
    db.commit()
    return perf.goal_out(db, user, g)


@router.patch("/goals/{gid}")
def update_goal(gid: str, body: GoalPatch, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    g = _goal_or_404(db, user, gid)
    if not perf.can_edit_goal(db, user, g):
        raise HTTPException(403, "You can't change this goal.")
    data = body.model_dump(exclude_unset=True)
    before = (g.title, g.target_value, g.due_on, g.start_on, g.metric_key, g.measure)
    if "title" in data:
        t = (data["title"] or "").strip()
        if not t:
            raise HTTPException(400, "Give the goal a title.")
        g.title = t[:300]
    if "description" in data:
        g.description = (data["description"] or "").strip()[:4000]
    if "owner_email" in data and (data["owner_email"] or "").strip().lower() != (g.owner_email or ""):
        if g.level == "personal":
            raise HTTPException(400, "A personal goal stays with its person - set a new one for someone else.")
        owner, cid, dept = perf.check_create(db, user, g.level, data["owner_email"], g.company_id, g.department)
        g.owner_email = owner
    if "metric_key" in data:
        if data["metric_key"] and g.level != "personal":
            raise HTTPException(400, "Only a personal goal is measured by a Nexus number.")
        g.metric_key = _metric_key(data["metric_key"])
        if g.metric_key:
            g.measure, g.start_value, g.unit = "number", 0.0, ""
            if data.get("target_value") is not None:
                g.target_value = float(data["target_value"])
        data.pop("measure", None)
    if g.metric_key:
        if data.get("target_value") is not None:
            g.target_value = float(data["target_value"])
    elif "measure" in data or "target_value" in data or "start_value" in data:
        measure = data.get("measure") or g.measure
        start, target = _measure_values(measure, data.get("start_value", g.start_value),
                                        data.get("target_value", g.target_value if measure == g.measure else None))
        if measure != g.measure:
            g.current_value = start
        g.measure, g.start_value, g.target_value = measure, start, target
    if "unit" in data:
        g.unit = (data["unit"] or "").strip()[:40]
    if "start_on" in data:
        g.start_on = g.period_start = _day(data["start_on"]) or g.period_start
    if "due_on" in data:
        g.due_on = g.period_end = _day(data["due_on"]) or g.period_end
    if "start_on" in data or "due_on" in data:
        _check_period(g.period_start or g.start_on, g.period_end or g.due_on, perf.local_today())
    if "parent_id" in data:
        g.parent_id = perf.check_parent(db, user, g.id, data["parent_id"])
    # The status is computed - one sent is ignored.
    g.status = perf.computed_status(g)
    g.updated_at = perf.now_iso()
    # The person changing what was agreed sends it back for approval.
    me = (user.get("email") or "").strip().lower()
    changed = before != (g.title, g.target_value, g.due_on, g.start_on, g.metric_key, g.measure)
    if g.approved_at and me == (g.owner_email or "") and changed \
            and perf.needs_approval(db, me, g.owner_email, g.level):
        g.approved_at, g.approved_by = "", ""
        import notify_rollup
        mgr = (perf.employee(db, g.owner_email).manager_email or "").strip().lower()
        notify_rollup.upsert_rollup(
            db, recipient=mgr, key=f"perf-goal-proposed:{perf.local_today()}", title="Goals to Approve",
            line=f"{perf.name_of(db, g.owner_email)} changed a goal: {g.title}.",
            action={"view": "myhr", "sub": "performance:team"}, company=g.company_id or "")
    db.commit()
    return perf.goal_out(db, user, g)


@router.post("/goals/{gid}/checkins", status_code=201)
def check_in(gid: str, body: CheckinIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    g = _goal_or_404(db, user, gid)
    if not perf.can_edit_goal(db, user, g):
        raise HTTPException(403, "You can't check in on this goal.")
    if body.value is None and not (body.note or "").strip():
        raise HTTPException(400, "Add the new number or a note.")
    perf.apply_checkin(db, g, me, body.value, (body.status or "").strip(), body.note or "")
    db.commit()
    return get_goal(gid, user, db)


@router.post("/goals/{gid}/archive")
def archive_goal(gid: str, restore: bool = False, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Goals are never deleted - archived (and restored) instead."""
    me = _me(user)
    g = _goal_or_404(db, user, gid)
    if restore:
        if g.level == "personal":
            _lock_owners(db, [g.owner_email])
        g.archived_at, g.archived_by = "", ""
        if not perf.can_edit_goal(db, user, g):
            raise HTTPException(403, "You can't change this goal.")
        if g.level == "personal" and perf.is_open(g) and perf.open_goal_count(db, g.owner_email, exclude_id=g.id) >= perf.MAX_OPEN_GOALS:
            raise HTTPException(400, f"{perf.MAX_OPEN_GOALS} open goals already - finish or archive one first.")
    else:
        if not perf.can_edit_goal(db, user, g):
            raise HTTPException(403, "You can't change this goal.")
        g.archived_at, g.archived_by = perf.now_iso(), me
    g.updated_at = perf.now_iso()
    db.commit()
    return perf.goal_out(db, user, g)


# ── My team ──────────────────────────────────────────────────────────────────

HIGHLIGHTS = 3
SCORECARD_MAX_DAYS = 396      # a custom My Numbers range: 13 months at most
SCORECARD_OLDEST_DAYS = 3 * 366


def _highlights(db: Session, emails: list) -> dict:
    """{email: the first few of their numbers that apply to them} this
    quarter - the whole team in one batched pass."""
    from datetime import date as _d
    today = _d.fromisoformat(perf.local_today())
    start, end = perf_metrics.quarter_period(today)
    cards = perf_metrics.scorecards(db, emails, start, end, today=today)
    return {em: [{k: m[k] for k in ("key", "label", "display", "good")} for m in card["metrics"] if m["available"]][:HIGHLIGHTS]
            for em, card in cards.items()}


@router.get("/team")
def my_team(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """My direct reports (Neil, Oct 29 2026: the manager's own team): a few
    of their Nexus numbers, their goals by status, the review they are in,
    the goals waiting on my Approve, and our next 1:1."""
    me = _me(user)
    people = perf.direct_reports(db, me)
    emails = sorted({(e.work_email or "").lower() for e in people})
    goals = (db.query(models.PerfGoal).filter(models.PerfGoal.owner_email.in_(emails or [""]),
                                              models.PerfGoal.archived_at == "",
                                              models.PerfGoal.level == "personal").all()) if emails else []
    by: dict = {}
    for g in goals:
        by.setdefault(g.owner_email, []).append(g)
    series = (db.query(models.PerfOneOnOne).filter(models.PerfOneOnOne.manager_email == me,
                                                   models.PerfOneOnOne.status == "active").all())
    nxt: dict = {}
    now = _now_utc()
    for s in series:
        m = (db.query(models.PerfMeeting).filter(models.PerfMeeting.series_id == s.id,
                                                 models.PerfMeeting.status == "scheduled",
                                                 models.PerfMeeting.at >= now)
             .order_by(models.PerfMeeting.at).first())
        if m and (s.report_email not in nxt or not nxt[s.report_email]["at"] or m.at < nxt[s.report_email]["at"]):
            nxt[s.report_email] = {"seriesId": s.id, "at": m.at, "label": perf.local_label(m.at, s.time_zone)}
        elif s.report_email not in nxt:
            nxt[s.report_email] = {"seriesId": s.id, "at": "", "label": ""}
    import perf_reviews as pr
    open_reviews: dict = {}
    for r in (db.query(models.PerfReview).filter(models.PerfReview.employee_email.in_(emails or [""]),
                                                 models.PerfReview.stage != "removed").all() if emails else []):
        c = db.get(models.PerfReviewCycle, r.cycle_id)
        if c is None or c.status != "active":
            continue
        open_reviews[r.employee_email] = {"id": r.id, "stage": r.stage, "stageLabel": pr.STAGE_LABELS.get(r.stage, r.stage),
                                          "cycleName": c.name, "yours": (r.manager_email or "") == me}
    today = perf.local_today()
    numbers = _highlights(db, emails)
    _prefetch(db, goals, today)
    out = []
    for e in people:
        em = (e.work_email or "").lower()
        gs = [g for g in by.get(em, []) if perf.is_open(g, today) or perf.computed_status(g, today) == "done"]
        st = {}
        for g in gs:
            k = perf.computed_status(g, today, perf.refresh_metric(db, g, today))
            st[k] = st.get(k, 0) + 1
        out.append({**perf.person_out(db, e), "direct": True,
                    "numbers": numbers.get(em, []),
                    "goals": {"total": len(gs), "onTrack": st.get("on_track", 0), "atRisk": st.get("at_risk", 0),
                              "behind": st.get("behind", 0), "done": st.get("done", 0),
                              "proposed": sum(1 for g in gs if not g.approved_at),
                              "progress": round(sum(perf.progress(g) for g in gs) / len(gs)) if gs else 0},
                    "review": open_reviews.get(em),
                    "nextOneOnOne": nxt.get(em)})
    out.sort(key=lambda r: r["name"].lower())
    return out


# ── My Numbers ───────────────────────────────────────────────────────────────

@router.get("/scorecard")
def scorecard(email: str = "", period: str = "quarter", start: str = "", end: str = "",
              user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """A person's Nexus numbers (perf_metrics.scorecard) for This Month, This
    Quarter, This Review (their latest review's period) or a given range.
    The person, their reporting chain and HR only - anyone else 404."""
    me = _me(user)
    who = (email or me).strip().lower()
    if not perf.can_see_person(db, user, who):
        raise HTTPException(404, "Person not found")
    from datetime import date as _d
    today = _d.fromisoformat(perf.local_today())
    if start or end:
        s, e = _day(start), _day(end)
        if not (s and e) or e < s:
            raise HTTPException(400, "Pick a start and an end.")
        # Bounded work: 13 months at most, and nothing older than three years
        # (every week of the span is a Workforce Scorecard pass).
        if (_d.fromisoformat(e) - _d.fromisoformat(s)).days > SCORECARD_MAX_DAYS:
            raise HTTPException(400, "Pick 13 months or less.")
        if s < (today - timedelta(days=SCORECARD_OLDEST_DAYS)).isoformat():
            raise HTTPException(400, "Pick a start within the last three years.")
    elif period == "month":
        s, e = perf_metrics.month_period(today)
    elif period == "review":
        import perf_reviews as pr
        s, e = pr.review_period_for(db, who) or perf_metrics.quarter_period(today)
    else:
        s, e = perf_metrics.quarter_period(today)
    card = perf_metrics.scorecard(db, who, s, e, today=today)
    return {**card, "email": who, "name": perf.name_of(db, who), "periodKind": "custom" if (start or end) else period}


# ── 1:1s ─────────────────────────────────────────────────────────────────────

class OneOnOneIn(BaseModel):
    report_email: str
    start_local: str                      # YYYY-MM-DDTHH:MM on `time_zone`'s clock
    time_zone: Optional[str] = perf.DEFAULT_TZ
    cadence: Optional[str] = "once"
    duration_min: Optional[int] = 30
    title: Optional[str] = ""


class MeetingPatch(BaseModel):
    shared_notes: Optional[str] = None
    private_notes: Optional[str] = None
    status: Optional[str] = None
    notes_at: Optional[str] = None        # the shared notes' notesAt the editor started from


class AgendaIn(BaseModel):
    text: str


class AgendaPatch(BaseModel):
    text: Optional[str] = None
    done: Optional[bool] = None


class ActionIn(BaseModel):
    text: str
    owner_email: Optional[str] = ""
    due_on: Optional[str] = ""
    make_task: Optional[bool] = True


class ActionPatch(BaseModel):
    done: Optional[bool] = None


def _series_or_404(db: Session, user: dict, sid: str) -> tuple:
    s = db.get(models.PerfOneOnOne, sid)
    side = perf.require_side(s, user)
    return s, side


def _meeting_or_404(db: Session, user: dict, mid: str) -> tuple:
    m = db.get(models.PerfMeeting, mid)
    if m is None:
        raise HTTPException(404, "1:1 not found")
    s, side = _series_or_404(db, user, m.series_id)
    return m, s, side


def _task_done(db: Session, a: models.PerfActionItem) -> bool:
    if a.task_id:
        t = db.get(models.Task, a.task_id)
        if t is not None:
            return bool(t.completed)
    return bool(a.done)


def _meeting_out(db: Session, s: models.PerfOneOnOne, m: models.PerfMeeting, side: str, names: dict, *, full: bool) -> dict:
    out = {"id": m.id, "at": m.at, "label": perf.local_label(m.at, s.time_zone), "status": m.status,
           "doneAt": m.done_at or ""}
    if not full:
        return out
    agenda = (db.query(models.PerfAgendaItem).filter(models.PerfAgendaItem.meeting_id == m.id)
              .order_by(models.PerfAgendaItem.position, models.PerfAgendaItem.created_at).all())
    actions = (db.query(models.PerfActionItem).filter(models.PerfActionItem.meeting_id == m.id)
               .order_by(models.PerfActionItem.created_at).all())
    for e in [a.by_email for a in agenda] + [a.owner_email for a in actions]:
        if e and e not in names:
            names[e] = perf.name_of(db, e)
    tasks = {t.id: t for t in db.query(models.Task).filter(models.Task.id.in_([a.task_id for a in actions if a.task_id] or [""])).all()}
    out.update({
        "sharedNotes": m.shared_notes or "", "notesBy": m.notes_by or "", "notesAt": m.notes_at or "",
        "agenda": [{"id": a.id, "text": a.text or "", "by": a.by_email, "byName": names.get(a.by_email, a.by_email),
                    "done": bool(a.done), "mine": a.by_email == (s.manager_email if side == "manager" else s.report_email)}
                   for a in agenda],
        "actions": [{"id": a.id, "text": a.text or "", "owner": a.owner_email, "ownerName": names.get(a.owner_email, a.owner_email),
                     "dueOn": a.due_on or "", "taskId": a.task_id or "",
                     "taskCode": (tasks[a.task_id].code if a.task_id in tasks else ""),
                     "done": bool(tasks[a.task_id].completed) if a.task_id in tasks else bool(a.done)}
                    for a in actions],
    })
    # The manager's private notes go to the manager only - never in the
    # report's response at all, not even as an empty key.
    if side == "manager":
        out["privateNotes"] = m.private_notes or ""
    return out


def _series_out(db: Session, s: models.PerfOneOnOne, side: str, *, meetings: bool = False) -> dict:
    names = {s.manager_email: perf.name_of(db, s.manager_email), s.report_email: perf.name_of(db, s.report_email)}
    rows = (db.query(models.PerfMeeting).filter(models.PerfMeeting.series_id == s.id)
            .order_by(models.PerfMeeting.at.desc()).all())
    now = _now_utc()
    upcoming = [m for m in rows if m.status == "scheduled" and m.at >= now]
    nxt = min(upcoming, key=lambda m: m.at) if upcoming else None
    past = [m for m in rows if not (m.status == "scheduled" and m.at >= now)]
    out = {"id": s.id, "title": s.title or "", "cadence": s.cadence, "cadenceLabel": perf.CADENCE_LABELS.get(s.cadence, s.cadence),
           "managerEmail": s.manager_email, "managerName": names[s.manager_email],
           "reportEmail": s.report_email, "reportName": names[s.report_email], "side": side,
           "withEmail": s.report_email if side == "manager" else s.manager_email,
           "withName": names[s.report_email] if side == "manager" else names[s.manager_email],
           "joinUrl": s.join_url or "", "teamsMeeting": bool(s.event_id), "graphError": s.graph_error or "",
           "status": s.status, "timeZone": s.time_zone, "durationMin": s.duration_min or 30,
           "current": s.status == "active" and perf.pair_current(db, s),
           "next": _meeting_out(db, s, nxt, side, names, full=False) if nxt else None,
           "last": _meeting_out(db, s, past[0], side, names, full=False) if past else None}
    if meetings:
        out["meetings"] = [_meeting_out(db, s, m, side, names, full=True) for m in rows]
    return out


@router.get("/one-on-ones")
def list_one_on_ones(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    rows = (db.query(models.PerfOneOnOne)
            .filter(or_(models.PerfOneOnOne.manager_email == me, models.PerfOneOnOne.report_email == me)).all())
    changed = False
    for s in rows:
        if perf.ensure_upcoming(db, s):
            changed = True
    if changed:
        db.commit()
    out = [_series_out(db, s, perf.series_side(s, me)) for s in rows]
    out.sort(key=lambda r: (r["status"] != "active", (r["next"] or {}).get("at") or "9999"))
    return out


@router.post("/one-on-ones", status_code=201)
def create_one_on_one(body: OneOnOneIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """A manager sets up a 1:1 with a direct report. The Teams meeting (a
    series when it repeats) goes on the manager's calendar through Microsoft
    Graph; if Graph refuses (no consent yet, no secret), the 1:1 is still
    made in Nexus and says why there is no Teams link."""
    me = _me(user)
    report = (body.report_email or "").strip().lower()
    emp = perf.employee(db, report)
    if emp is None or (emp.manager_email or "").strip().lower() != me or report == me:
        raise HTTPException(403, "1:1s are set up by a manager with someone who reports to them.")
    cadence = (body.cadence or "once").strip()
    if cadence not in perf.CADENCES:
        raise HTTPException(400, "Pick how often it repeats.")
    tz = (body.time_zone or perf.DEFAULT_TZ).strip()
    perf.zone(tz)
    local = perf.parse_local(body.start_local)
    if cadence == "monthly" and local.day > 28:
        raise HTTPException(400, "Start a monthly 1:1 on the 1st to the 28th - every month has those days.")
    first = perf.to_utc(local, tz)
    duration = max(15, min(240, int(body.duration_min or 30)))
    now = perf.now_iso()
    s = models.PerfOneOnOne(id=perf.new_id(), company_id=emp.company or "", manager_email=me, report_email=report,
                            title=((body.title or "").strip() or f"1:1 - {perf.name_of(db, me)} / {perf.name_of(db, report)}")[:200],
                            cadence=cadence, first_local=local.strftime("%Y-%m-%dT%H:%M"), time_zone=tz,
                            duration_min=duration, status="active", created_by=me, created_at=now, updated_at=now,
                            event_id="", join_url="", graph_error="", ended_at="", ended_by="")
    db.add(s)
    db.add(models.PerfMeeting(id=perf.new_id(), series_id=s.id, at=perf.utc_str(first), status="scheduled",
                              created_at=now, agenda_nudged_at=""))
    # Graph (blocking HTTP) - this is a sync endpoint, so FastAPI already runs
    # it in a worker thread, never on the event loop.
    from routers.hr_interviews import _graph_create_meeting
    try:
        meeting = _graph_create_meeting(
            me, s.title,
            f"1:1 between {perf.name_of(db, me)} and {perf.name_of(db, report)}. "
            "The shared agenda and notes are in Nexus: Workday > Performance.",
            report, perf.name_of(db, report), local.strftime("%Y-%m-%dT%H:%M:00"), duration,
            time_zone=tz, recurrence=perf.graph_recurrence(s))
        s.event_id, s.join_url = meeting.get("eventId", ""), meeting.get("joinUrl", "")
    except HTTPException as e:
        s.graph_error = str(e.detail)[:400]
    except Exception as e:   # noqa: BLE001 - Graph down must never lose the 1:1
        s.graph_error = f"Teams did not answer ({type(e).__name__})"
    import notify_rollup
    notify_rollup.upsert_rollup(
        db, recipient=report, key=f"perf-1on1:{s.id}", title="1:1 Scheduled",
        line=(f"{perf.name_of(db, me)} set up a 1:1 with you - {perf.CADENCE_LABELS[cadence].lower()}, "
              f"first on {perf.local_label(perf.utc_str(first), tz)}. Add what you want to talk about to the agenda."),
        action={"view": "myhr", "sub": f"performance:1on1:{s.id}"}, company=s.company_id or "", replace=True)
    db.commit()
    return _series_out(db, s, "manager", meetings=True)


@router.get("/one-on-ones/{sid}")
def get_one_on_one(sid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    s, side = _series_or_404(db, user, sid)
    if perf.ensure_upcoming(db, s):
        db.commit()
    return _series_out(db, s, side, meetings=True)


def _graph_end_series(s: models.PerfOneOnOne) -> str:
    """Take the 1:1 off both calendars from today on: a recurring series gets
    an end date (its past meetings stay on the calendars, as they happened);
    a one-off still to come is withdrawn. '' = ok, else why not."""
    if not s.event_id:
        return ""
    from routers.hr_interviews import _graph_cancel_meeting
    rec = perf.graph_recurrence(s)
    if rec is None:
        first = perf.occurrence(s, 0)
        if first and first <= datetime.now(timezone.utc):
            return ""                      # already happened - nothing to withdraw
        return _graph_cancel_meeting(s.manager_email, s.event_id)
    import httpx
    from routers.hr import _GRAPH, _graph_token
    end = datetime.now(timezone.utc).astimezone(perf.zone(s.time_zone)).date()
    start = date.fromisoformat(rec["range"]["startDate"])
    if end < start:
        return _graph_cancel_meeting(s.manager_email, s.event_id)
    rec["range"] = {"type": "endDate", "startDate": start.isoformat(), "endDate": end.isoformat()}
    try:
        r = httpx.patch(f"{_GRAPH}/users/{s.manager_email}/events/{s.event_id}",
                        headers={"Authorization": f"Bearer {_graph_token()}", "Content-Type": "application/json"},
                        json={"recurrence": rec}, timeout=20)
        return "" if r.status_code in (200, 404) else f"Teams series not ended ({r.status_code})"
    except Exception as e:   # noqa: BLE001 - the 1:1 ends in Nexus either way
        return f"Teams series not ended ({type(e).__name__})"


@router.post("/one-on-ones/{sid}/end")
def end_one_on_one(sid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The manager ends the series: the Teams series is withdrawn, meetings
    still to come are canceled, every past one stays as history."""
    me = _me(user)
    s, side = _series_or_404(db, user, sid)
    if side != "manager":
        raise HTTPException(403, "Only the manager can end a 1:1.")
    if s.status != "active":
        return _series_out(db, s, side, meetings=True)
    err = _graph_end_series(s)
    now = perf.now_iso()
    s.status, s.ended_at, s.ended_by, s.updated_at = "ended", now, me, now
    if err:
        s.graph_error = err[:400]
    cut = _now_utc()
    for m in db.query(models.PerfMeeting).filter(models.PerfMeeting.series_id == s.id,
                                                 models.PerfMeeting.status == "scheduled",
                                                 models.PerfMeeting.at >= cut).all():
        m.status = "canceled"
    import notify_rollup
    notify_rollup.upsert_rollup(
        db, recipient=s.report_email, key=f"perf-1on1:{s.id}", title="1:1 Ended",
        line=f"{perf.name_of(db, me)} ended the 1:1 \"{s.title}\". Its past notes stay in Workday > Performance.",
        action={"view": "myhr", "sub": f"performance:1on1:{s.id}"}, company=s.company_id or "", replace=True)
    db.commit()
    return _series_out(db, s, side, meetings=True)


def _graph_cancel_occurrence(s: models.PerfOneOnOne, m: models.PerfMeeting) -> str:
    """Take ONE meeting of a 1:1 off both calendars (Cancel This One): a
    one-off is the event itself; a meeting of a series is its occurrence,
    found by its start. '' = ok, else why not."""
    if not s.event_id:
        return ""
    from routers.hr_interviews import _graph_cancel_meeting
    if s.cadence == "once":
        return _graph_cancel_meeting(s.manager_email, s.event_id)
    at = perf.parse_utc(m.at)
    if at is None:
        return ""
    import httpx
    from datetime import timedelta
    from routers.hr import _GRAPH, _graph_token
    try:
        r = httpx.get(f"{_GRAPH}/users/{s.manager_email}/events/{s.event_id}/instances",
                      params={"startDateTime": perf.utc_str(at - timedelta(minutes=1)),
                              "endDateTime": perf.utc_str(at + timedelta(minutes=int(s.duration_min or 30) + 1)),
                              "$select": "id,start"},
                      headers={"Authorization": f"Bearer {_graph_token()}"}, timeout=20)
        if r.status_code != 200:
            return f"Teams meeting not canceled ({r.status_code})"
        items = (r.json() or {}).get("value") or []
    except Exception as e:   # noqa: BLE001 - the meeting is canceled in Nexus either way
        return f"Teams meeting not canceled ({type(e).__name__})"
    if not items:
        return ""
    return _graph_cancel_meeting(s.manager_email, items[0].get("id", ""))


@router.patch("/meetings/{mid}")
def update_meeting(mid: str, body: MeetingPatch, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    m, s, side = _meeting_or_404(db, user, mid)
    perf.require_live(db, s)
    data = body.model_dump(exclude_unset=True)
    if ("shared_notes" in data and data.get("notes_at") is not None
            and (m.notes_at or "") != (data["notes_at"] or "") and (m.shared_notes or "") != (data["shared_notes"] or "")):
        # Both typing at once: never overwrite the other person's save.
        raise HTTPException(409, f"{perf.name_of(db, m.notes_by)} changed the shared notes while you were typing - "
                                 "copy your text, reopen the 1:1 and add it again.")
    if "private_notes" in data:
        if side != "manager":
            raise HTTPException(403, "Private notes are the manager's.")
        m.private_notes = (data["private_notes"] or "")[:20000]
    if "shared_notes" in data:
        m.shared_notes = (data["shared_notes"] or "")[:20000]
        m.notes_by, m.notes_at = me, perf.now_iso()
    if data.get("status"):
        st = data["status"]
        if st not in ("scheduled", "done", "canceled"):
            raise HTTPException(400, "Unknown status")
        if (st == "canceled" or m.status == "canceled") and side != "manager":
            raise HTTPException(403, "Only the manager can cancel a meeting or bring one back.")
        if st == "canceled" and m.status != "canceled":
            err = _graph_cancel_occurrence(s, m)
            if err:
                s.graph_error = err[:400]
        m.status = st
        m.done_at = perf.now_iso() if st == "done" else ""
        db.flush()
        perf.ensure_upcoming(db, s)
    s.updated_at = perf.now_iso()
    db.commit()
    return _series_out(db, s, side, meetings=True)


@router.post("/meetings/{mid}/agenda", status_code=201)
def add_agenda(mid: str, body: AgendaIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    m, s, side = _meeting_or_404(db, user, mid)
    perf.require_live(db, s)
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "Type the talking point.")
    if m.status == "canceled":
        raise HTTPException(409, "This meeting was canceled.")
    n = db.query(models.PerfAgendaItem).filter(models.PerfAgendaItem.meeting_id == m.id).count()
    db.add(models.PerfAgendaItem(id=perf.new_id(), meeting_id=m.id, text=text[:2000], by_email=me, done=False,
                                 position=float(n + 1), created_at=perf.now_iso()))
    db.commit()
    return _series_out(db, s, side, meetings=True)


@router.patch("/agenda/{aid}")
def update_agenda(aid: str, body: AgendaPatch, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    a = db.get(models.PerfAgendaItem, aid)
    if a is None:
        raise HTTPException(404, "Not found")
    m, s, side = _meeting_or_404(db, user, a.meeting_id)
    perf.require_live(db, s)
    if body.done is not None:
        a.done = bool(body.done)
    if body.text is not None:
        if a.by_email != me:
            raise HTTPException(403, "Only whoever added a talking point can reword it.")
        t = body.text.strip()
        if not t:
            raise HTTPException(400, "Type the talking point.")
        a.text = t[:2000]
    db.commit()
    return _series_out(db, s, side, meetings=True)


@router.delete("/agenda/{aid}")
def remove_agenda(aid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    a = db.get(models.PerfAgendaItem, aid)
    if a is None:
        raise HTTPException(404, "Not found")
    m, s, side = _meeting_or_404(db, user, a.meeting_id)
    perf.require_live(db, s)
    if a.by_email != me:
        raise HTTPException(403, "Only whoever added a talking point can take it off.")
    if m.status != "scheduled":
        raise HTTPException(409, "The meeting is over - its agenda is kept as it was.")
    db.delete(a)
    db.commit()
    return _series_out(db, s, side, meetings=True)


@router.post("/meetings/{mid}/actions", status_code=201)
def add_action(mid: str, body: ActionIn, background_tasks: BackgroundTasks,
               user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """An action item. With make_task (the default) it becomes a Task made by
    the task module's own create (tasks._create_task - same rules, same
    notices), private to the two of them: Restricted, the owner assigned and
    the other person a collaborator."""
    me = _me(user)
    m, s, side = _meeting_or_404(db, user, mid)
    perf.require_live(db, s)
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "Type the action item.")
    owner = (body.owner_email or me).strip().lower()
    if owner not in (s.manager_email, s.report_email):
        raise HTTPException(400, "An action item belongs to one of the two of you.")
    due = _day(body.due_on)
    a = models.PerfActionItem(id=perf.new_id(), meeting_id=m.id, series_id=s.id, text=text[:2000], owner_email=owner,
                              due_on=due, task_id="", done=False, by_email=me, created_at=perf.now_iso())
    db.add(a)
    if not body.make_task:
        db.commit()
        return _series_out(db, s, side, meetings=True)
    from routers import tasks as tasks_router
    other = s.report_email if owner == s.manager_email else s.manager_email
    payload = tasks_router.TaskCreate(
        title=text[:300],
        description=(f"Action item from the 1:1 between {perf.name_of(db, s.manager_email)} and "
                     f"{perf.name_of(db, s.report_email)} on {perf.local_label(m.at, s.time_zone)}."),
        assignee_emails=[owner], follower_emails=[other], due_on=due, access_level="restricted",
        priority="medium", tags=["1:1"])

    def link(t):
        a.task_id = t.id

    tasks_router._create_task(payload, background_tasks, user, db, before_commit=link)
    return _series_out(db, s, side, meetings=True)


@router.patch("/actions/{aid}")
def update_action(aid: str, body: ActionPatch, background_tasks: BackgroundTasks,
                  user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Tick an action item. One that is a Task is completed through the task
    module's own update, so the task's rules (who may complete it) apply."""
    _me(user)
    a = db.get(models.PerfActionItem, aid)
    if a is None:
        raise HTTPException(404, "Not found")
    m, s, side = _meeting_or_404(db, user, a.meeting_id)
    perf.require_live(db, s)
    if body.done is None:
        return _series_out(db, s, side, meetings=True)
    t = db.get(models.Task, a.task_id) if a.task_id else None
    if t is not None:
        from routers import tasks as tasks_router
        tasks_router.update_task(t.id, tasks_router.TaskUpdate(status="completed" if body.done else "not_started"),
                                 background_tasks, user, db)
    a = db.get(models.PerfActionItem, aid)
    a.done = bool(body.done)
    db.commit()
    return _series_out(db, s, side, meetings=True)


# ── Settings (Settings > Performance) ────────────────────────────────────────

class SettingsIn(BaseModel):
    company: Optional[str] = ""
    settings: Optional[dict] = None
    reset: Optional[bool] = False


def _settings_payload(db: Session, user: dict, company: str) -> dict:
    reach = perf.hr_reach(db, user)
    cfg = perf.settings_for_company(db, company)
    return {"settings": cfg, "company": company, "override": scoped_settings.has_override(db, perf.SETTINGS_KEY, company),
            "canEdit": reach is None or (bool(company) and reach is not False and company in reach),
            "canEditDefault": reach is None, "companies": perf.companies_out(db, reach) if reach is not False else []}


@router.get("/settings")
def get_settings(company: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    if perf.hr_reach(db, user) is False:
        raise HTTPException(403, "Performance settings are HR's.")
    cid = (company or "").strip()
    if cid and not perf.hr_for(db, user, cid):
        raise HTTPException(404, "Company not found")
    return _settings_payload(db, user, cid)


@router.put("/settings")
def save_settings(body: SettingsIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The default for every company needs HR across every company; a company's
    own, HR for that company."""
    me = _me(user)
    reach = perf.hr_reach(db, user)
    cid = (body.company or "").strip()
    if reach is False or (not cid and reach is not None) or (cid and not perf.hr_for(db, user, cid)):
        raise HTTPException(403, "Only HR for every company can change the default." if not cid
                            else "Only HR for this company can change its settings.")
    if body.reset and cid:
        scoped_settings.reset(db, perf.SETTINGS_KEY, cid)
    else:
        merged = {**perf.settings_for_company(db, cid), **(body.settings or {})}
        scoped_settings.save(db, perf.SETTINGS_KEY, cid, perf.clean_settings(merged), me)
    db.commit()
    return _settings_payload(db, user, cid)
