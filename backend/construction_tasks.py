"""Construction <-> Tasks: a Job's own task project (Neil, 11/03/2026, plan
https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr, phase 2 "The Job,
Connected"; Neil: jobs connect to Tasks FULLY, as needed - this replaces
Sagar's 08/04/2026 rule that kept them apart).

ONE TASK PROJECT PER JOB, on `construction_projects.task_project_id` (a
column, not a link table: exactly one per job, read on every Job page). It
holds the job's schedule (start / due dates, dependencies), its milestones
(`Task.is_milestone`), its punch list (the "Punch" section) and feeds the
two-week look-ahead. The Tasks module owns every row; Construction only
reads them and writes through the Tasks module's own paths:

  * STAMPING - the project is built from a Tasks project TEMPLATE, through
    the templates mechanism itself (`task_projects._build_from_payload`,
    exactly what "Use Template" runs - a template build makes its rows in
    one go, sends nothing, and counts the use). One template per job type
    and company: "Work Order" (assess, parts, repair, verify, closeout) and
    "Construction Project" (preconstruction, permits, site work, framing and
    structure, MEP, finishes, punch, closeout). They are ordinary Tasks
    templates (category "Construction Work Order" / "Construction
    Project"), made the first time a company stamps a job of that type and
    owned by the person who did, so the company's managers see and edit
    them on Tasks > Templates like any other. A template someone deleted is
    never brought back: the job is stamped from the built-in default.
  * EVERY OTHER TASK WRITE goes through `routers.tasks._create_task` /
    `update_task` (punch items, Done, Verified, the milestone move) - never
    a second write path. Bulk adds go through POST /tasks/import.

PUNCH, two steps. A punch item is a task in the "Punch" section. The crew
marks it Done (completed); a job reviewer marks it Verified - the
project's custom status "Verified" (TaskCustomStatus, made by the template
by label) set WITH completed, so it stays done everywhere Tasks counts done.
No new task column: the existing custom-status mechanism fits.

MILESTONES MOVED. Each live ConstructionMilestone row becomes a milestone
task in the job's project, once (`migrate_milestones`, idempotent on
`construction_milestones.migrated_task_id`; the old table and rows are
kept as the record). Health, the weekly report and the Job page read
milestones from the task project (`task_milestones`) once a job has one.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlalchemy.orm import Session

import models

VERIFIED = "Verified"
PUNCH = "Punch"
CATEGORY = {"work_order": "Construction Work Order", "project": "Construction Project"}
TEMPLATE_NAME = {"work_order": "Work Order", "project": "Construction Project"}
JOB_TYPES = ("work_order", "project")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def job_type_of(job) -> str:
    t = (getattr(job, "job_type", "") or "project").strip()
    return t if t in JOB_TYPES else "project"


# ── The two default templates (Tasks template payload, version 2) ────────────

def _payload(sections: list, tasks: list) -> dict:
    """A blueprint payload in the Tasks templates' own shape
    (task_projects._snapshot_project): sections and tasks keyed by index,
    offsets in days from the anchor (the job's start)."""
    sec_key = {name: i for i, name in enumerate(sections)}
    title_key = {}
    out_tasks = []
    for i, t in enumerate(tasks):
        title_key[t["title"]] = i
        blocked = [title_key[b] for b in t.get("after", ()) if b in title_key]
        out_tasks.append({
            "key": i, "parentKey": None, "sectionKey": sec_key[t["section"]],
            "title": t["title"], "description": t.get("description", ""), "type": "task",
            "status": "", "statusKey": None, "priority": t.get("priority", "medium"), "tags": [],
            "assigneeEmail": "", "assigneeEmails": [], "followerEmails": [], "estimateHours": None,
            "isMilestone": bool(t.get("milestone")), "cardPreview": "", "accessLevel": "",
            "customFieldValues": {}, "startOffset": t.get("start"), "dueOffset": t.get("due"),
            "blockedByKeys": blocked, "dependencyTypes": {str(k): "FS" for k in blocked},
            "checklist": list(t.get("checklist", ())),
        })
    return {
        "version": 2, "blueprint": True, "anchor": "2026-01-01",
        "project": {"name": "", "description": "", "color": "", "icon": "", "startOffset": 0,
                    "dueOffset": max([t.get("due") or 0 for t in tasks] or [0]), "customFieldValues": {}},
        "customFields": [],
        "customStatuses": [{"key": 0, "label": VERIFIED, "color": "#16a34a", "position": 90, "scoped": True}],
        "sections": [{"key": i, "name": n, "position": i, "custom": False} for i, n in enumerate(sections)],
        "tasks": out_tasks,
        "colorRules": [],
    }


CLOSEOUT_WORK_ORDER = ["After photos taken", "Area cleaned up", "Equipment and parts returned",
                       "Requester told the work is done", "Hours and parts recorded"]
CLOSEOUT_PROJECT = ["As-built drawings filed", "Warranties collected", "Operation and maintenance manuals",
                    "Final lien waivers", "Owner walk-through and training", "Keys and access handed over"]


def default_payload(job_type: str) -> dict:
    if job_type == "work_order":
        return _payload(
            ["Assess", "Parts", "Repair", "Verify", PUNCH, "Closeout"],
            [
                {"section": "Assess", "title": "Assess the problem on site", "start": 0, "due": 0},
                {"section": "Assess", "title": "Photograph the condition before work", "start": 0, "due": 0},
                {"section": "Parts", "title": "List the parts and materials needed", "start": 0, "due": 1},
                {"section": "Parts", "title": "Get the parts (order or check out)", "start": 1, "due": 1},
                {"section": "Repair", "title": "Make the repair", "start": 1, "due": 2},
                {"section": "Verify", "title": "Test the fix", "start": 2, "due": 2},
                {"section": "Verify", "title": "Repair Verified", "due": 2, "milestone": True},
                {"section": "Closeout", "title": "Closeout checklist", "start": 2, "due": 3,
                 "checklist": CLOSEOUT_WORK_ORDER},
            ])
    return _payload(
        ["Preconstruction", "Permits", "Site Work", "Framing and Structure", "MEP", "Finishes", PUNCH, "Closeout"],
        [
            {"section": "Preconstruction", "title": "Kickoff meeting", "start": 0, "due": 0},
            {"section": "Preconstruction", "title": "Confirm scope, budget and schedule", "start": 0, "due": 7},
            {"section": "Preconstruction", "title": "Award subcontracts", "start": 0, "due": 14},
            {"section": "Preconstruction", "title": "Preconstruction Complete", "due": 14, "milestone": True},
            {"section": "Permits", "title": "Submit permit applications", "start": 7, "due": 14},
            {"section": "Permits", "title": "Permits Issued", "due": 30, "milestone": True},
            {"section": "Site Work", "title": "Mobilize and prepare the site", "start": 30, "due": 37},
            {"section": "Site Work", "title": "Excavation and grading", "start": 37, "due": 50},
            {"section": "Site Work", "title": "Foundations", "start": 50, "due": 65},
            {"section": "Site Work", "title": "Foundation Complete", "due": 65, "milestone": True,
             "after": ("Permits Issued",)},
            {"section": "Framing and Structure", "title": "Framing", "start": 65, "due": 95},
            {"section": "Framing and Structure", "title": "Roofing and dry-in", "start": 95, "due": 110},
            {"section": "Framing and Structure", "title": "Dried In", "due": 110, "milestone": True,
             "after": ("Foundation Complete",)},
            {"section": "MEP", "title": "Mechanical rough-in", "start": 100, "due": 125},
            {"section": "MEP", "title": "Electrical rough-in", "start": 100, "due": 125},
            {"section": "MEP", "title": "Plumbing rough-in", "start": 100, "due": 125},
            {"section": "MEP", "title": "MEP Rough-In Inspections Passed", "due": 130, "milestone": True,
             "after": ("Dried In",)},
            {"section": "Finishes", "title": "Drywall", "start": 130, "due": 150},
            {"section": "Finishes", "title": "Paint", "start": 150, "due": 160},
            {"section": "Finishes", "title": "Flooring and trim", "start": 160, "due": 175},
            {"section": "Finishes", "title": "Fixtures and equipment", "start": 170, "due": 180},
            {"section": "Finishes", "title": "Finishes Complete", "due": 180, "milestone": True,
             "after": ("MEP Rough-In Inspections Passed",)},
            {"section": "Closeout", "title": "Punch walk (add each item to the Punch list)", "start": 180, "due": 182},
            {"section": "Closeout", "title": "Final Inspection Passed", "due": 190, "milestone": True,
             "after": ("Finishes Complete",)},
            {"section": "Closeout", "title": "Closeout checklist", "start": 185, "due": 195,
             "checklist": CLOSEOUT_PROJECT},
        ])


# ── Templates: one per job type and company, ordinary Tasks templates ────────

def template_id(job_type: str, company_id: str) -> str:
    """The one id a company's template for a job type has: the company is
    in the id, so a lookup never depends on who owns the row."""
    return f"cxtpl-{job_type}-{company_id or 'org'}"[:120]


def template_owner(db: Session, job, company_id: str) -> str:
    """Who a new company template belongs to: a manager-tier person of that
    company - the job's own managers first, else the company's manager tier
    (construction_notify.reviewers) - never a crew member. '' (the system)
    when the company has none; the template wall reads the owner's company."""
    import auth
    from construction_notify import reviewers
    for em in reviewers(db, job):
        em = (em or "").strip().lower()
        if not em:
            continue
        _role, level = auth._role_for(em, db)
        if level >= auth._LEVELS["manager"] and (auth.company_of(em, db) or "") == (company_id or ""):
            return em
    return ""


def template_for(db: Session, job_type: str, company_id: str, job=None):
    """(template row or None, payload) for stamping a job of this type in
    this company. Looked up by its deterministic id (template_id); made the
    first time, owned by a manager of the company (template_owner). One a
    manager deleted or archived is never brought back - the built-in default
    stands in."""
    T = models.TaskProjectTemplate
    tid = template_id(job_type, company_id)
    t = db.query(T).filter(T.id == tid).execution_options(include_deleted=True).first()
    if t is not None:
        if (t.deleted_at or "") or t.archived:
            return None, default_payload(job_type)
        return t, (t.payload if isinstance(t.payload, dict) else default_payload(job_type))
    if job is None:
        return None, default_payload(job_type)
    owner = template_owner(db, job, company_id)
    now = _now()
    t = T(id=tid, name=TEMPLATE_NAME[job_type],
          description=("Stamped onto every new Work Order job. Edit it on Tasks > Templates."
                       if job_type == "work_order" else
                       "Stamped onto every new Construction Project job. Edit it on Tasks > Templates."),
          color="#16a34a" if job_type == "work_order" else "#2563eb", category=CATEGORY[job_type],
          source_project_id="", source_project_name="", payload=default_payload(job_type),
          access_level="org", owner_email=owner, archived=False,
          use_count=0, last_used_at="", created_at=now, modified_at=now,
          created_by=owner or "system", deleted_at="", deleted_by="")
    db.add(t)
    db.flush()
    return t, t.payload


# ── The job's task project ───────────────────────────────────────────────────

def _emails(v) -> list:
    out = []
    for e in v or []:
        e = (e or "").strip().lower()
        if e and e not in out:
            out.append(e)
    return out


def actor_for(db: Session, job, user: dict | None = None) -> dict | None:
    """Who the Tasks writes run as: the caller when there is one, else the
    job's first manager, else its creator (a current directory person)."""
    if user and user.get("email"):
        return user
    import task_automation
    for em in _emails(job.manager_emails) + _emails([job.created_by]):
        u = task_automation._person_user(db, em)
        if u and not u.get("external"):
            return u
    return None


def task_project(db: Session, job):
    """The job's live task project, or None."""
    pid = (getattr(job, "task_project_id", "") or "").strip()
    if not pid:
        return None
    return db.query(models.TaskProject).filter(models.TaskProject.id == pid).first()


def sync_members(job, project) -> None:
    """The job's managers and crew are editors on its task project (the crew
    marks punch items Done; reviewers verify). Only adds - a person someone
    added on Tasks stays."""
    roles = dict(project.member_roles or {})
    members = list(project.member_emails or [])
    for em in _emails(job.manager_emails) + _emails(job.worker_emails):
        if em not in members:
            members.append(em)
        roles.setdefault(em, "editor")
    project.member_emails = members
    project.member_roles = roles


def picked_template(db: Session, template_id: str, user: dict):
    """A Tasks project template the caller picked on New Job - one they may
    use (the templates' own wall and visibility rules), else None."""
    if not template_id:
        return None
    from routers import task_projects
    from routers.task_util import wall_rows
    t = db.query(models.TaskProjectTemplate).filter(models.TaskProjectTemplate.id == template_id).first()
    if t is None or t.archived or not wall_rows(db, user, [t]) or not task_projects._template_visible(t, user):
        return None
    return t


def has_old_milestones(db: Session, job) -> bool:
    M = models.ConstructionMilestone
    return db.query(M.id).filter(M.project_id == job.id, M.deleted_at == "").first() is not None


def ensure_task_project(db: Session, job, user: dict | None = None, template_id: str = "",
                        include_tasks: bool | None = None):
    """The job's task project, stamped from its type's template the first
    time (or the template picked on New Job). Does NOT commit; returns the
    TaskProject or None when nobody can act for the job.

    `include_tasks` None = the template's tasks only for a job that has not
    started: no milestones of its own and no start date in the past. A job
    already under way (made before 11/03/2026, or started) gets the
    template's sections and statuses only - its own milestones are moved in,
    and no template task is dated from a start that has passed. The punch
    list's first item passes False (sections only, always).

    Two requests at once never build two projects: the job row is locked
    and task_project_id read again before anything is built."""
    p = task_project(db, job)
    if p is not None:
        return p
    P = models.ConstructionProject
    locked = (db.query(P).filter(P.id == job.id).with_for_update().populate_existing().first())
    if locked is not None:
        job = locked
        p = task_project(db, job)
        if p is not None:
            return p
    actor = actor_for(db, job, user)
    if actor is None:
        return None
    from routers import task_projects
    jt = job_type_of(job)
    tpl = picked_template(db, template_id, actor)
    if tpl is not None:
        payload = tpl.payload if isinstance(tpl.payload, dict) else default_payload(jt)
    else:
        tpl, payload = template_for(db, jt, job.company_id or "", job)
    owner = (_emails(job.manager_emails) or [(actor.get("email") or "").lower()])[0]
    members = _emails(job.manager_emails) + _emails(job.worker_emails)
    settings = task_projects.ProjectSettings(
        name=job.name, description=(job.description or "")[:2000],
        owner_email=owner, member_emails=members,
        member_roles={em: "editor" for em in members if em != owner},
        access_level="restricted",
        start_on=(job.start_on or date.today().isoformat()),
    )
    if include_tasks is None:
        started = bool(job.start_on) and str(job.start_on)[:10] < date.today().isoformat()
        include_tasks = not has_old_milestones(db, job) and not started
    p = task_projects._build_from_payload(db, payload, actor, settings=settings, include_tasks=bool(include_tasks),
                                          reset_status=True, force_blueprint=True)
    if tpl is not None:
        tpl.use_count = (tpl.use_count or 0) + 1
        tpl.last_used_at = _now()
    job.task_project_id = p.id
    db.flush()
    return p


# ── Sections, statuses ───────────────────────────────────────────────────────

def punch_section(db: Session, project, create: bool = True):
    S = models.TaskSection
    rows = db.query(S).filter(S.project_id == project.id).all()
    for s in rows:
        if (s.name or "").strip().lower() == PUNCH.lower():
            return s
    if not create:
        return None
    s = S(id=f"sec-{project.id[:8]}-{len(rows)}-punch", project_id=project.id, name=PUNCH,
          position=max([r.position or 0 for r in rows] or [0]) + 1, created_at=_now(), custom=False)
    if db.get(S, s.id) is not None:
        import uuid
        s.id = str(uuid.uuid4())
    db.add(s)
    db.flush()
    return s


def verified_status(db: Session, project, create: bool = True):
    """The custom status "Verified" this project uses (matched by label, the
    way templates match statuses), scoped to it when made here."""
    rows = db.query(models.TaskCustomStatus).all()
    hit = None
    for s in rows:
        if (s.label or "").strip().lower() != VERIFIED.lower():
            continue
        scope = list(s.project_ids or [])
        if project.id in scope:
            return s
        if not scope and hit is None:
            hit = s
    if hit is not None or not create:
        return hit
    import uuid
    s = models.TaskCustomStatus(id=str(uuid.uuid4()), label=VERIFIED, color="#16a34a", position=90,
                                project_ids=[project.id], asana_option_gid="", asana_option_gids=[],
                                company_id=project.company_id or "")
    db.add(s)
    db.flush()
    return s


def project_tasks(db: Session, project) -> list:
    """Every live top-level task of the project (subtasks reach it through
    their parent, and the schedule draws the parent)."""
    T = models.Task
    return (db.query(T).filter(T.project_id == project.id).all())


def task_milestones(db: Session, job) -> list:
    """The job's milestones from its task project as milestone-shaped rows
    (id, name, target_date, status, critical) - what construction_health
    and the weekly report read once a job has a project. [] without one."""
    from types import SimpleNamespace
    p = task_project(db, job)
    if p is None:
        return None
    today = date.today().isoformat()
    out = []
    for t in project_tasks(db, p):
        if not t.is_milestone:
            continue
        due = (t.due_on or "")[:10]
        status = "hit" if t.completed else ("missed" if due and due < today else "upcoming")
        out.append(SimpleNamespace(id=t.id, name=t.title or "", target_date=due, status=status,
                                   critical=False, actual_date=(t.completed_at or "")[:10],
                                   description=""))
    return out


RISK_DAYS = 7


def risky_milestones(db: Session, jobs) -> list:
    """[(job, task, 'missed' | 'at_risk')] - the open milestones of these jobs'
    task projects that are past due (missed) or due within RISK_DAYS (at
    risk), against each jobsite's own today. Insights' At-Risk Milestones
    reads this - ONE source, the task project (Neil, 11/03/2026); the old
    construction_milestones rows were moved in and are kept as the record."""
    import construction_company
    by_tp = {j.task_project_id: j for j in jobs if (getattr(j, "task_project_id", "") or "")}
    if not by_tp:
        return []
    T = models.Task
    out = []
    today_of = {}
    for t in db.query(T).filter(T.project_id.in_(sorted(by_tp)), T.is_milestone.is_(True)).all():
        if t.completed or not (t.due_on or ""):
            continue
        job = by_tp[t.project_id]
        if job.id not in today_of:
            today_of[job.id] = construction_company.local_today(db, job)
        today = today_of[job.id]
        try:
            due = date.fromisoformat((t.due_on or "")[:10])
        except ValueError:
            continue
        if due < today:
            out.append((job, t, "missed"))
        elif (due - today).days <= RISK_DAYS:
            out.append((job, t, "at_risk"))
    out.sort(key=lambda x: (x[1].due_on or ""))
    return out


# ── The one-time milestone move ──────────────────────────────────────────────

class _Now:
    """BackgroundTasks stand-in (as cubby_tasks): runs what is queued now."""
    def add_task(self, fn, *a, **kw):
        try:
            fn(*a, **kw)
        except Exception as e:   # noqa: BLE001 - an email never fails the move
            print(f"[construction-tasks] background: {e}")


def migrate_milestones(db: Session, job, user: dict | None = None) -> int:
    """Move the job's live construction milestones into its task project as
    milestone tasks. Idempotent: a row already moved (migrated_task_id) is
    skipped, and the old row is kept. Writes through _create_task (and
    update_task for a hit milestone); commits per row. Returns how many."""
    M = models.ConstructionMilestone
    def pending():
        return (db.query(M).filter(M.project_id == job.id, M.deleted_at == "",
                                   (M.migrated_task_id == "") | (M.migrated_task_id.is_(None)))
                .order_by(M.target_date).all())
    if not pending():
        return 0
    actor = actor_for(db, job, user)
    if actor is None:
        return 0
    p = ensure_task_project(db, job, actor, include_tasks=False)
    if p is None:
        return 0
    db.commit()
    rows = pending()
    from routers import tasks as tasks_router
    n = 0
    for m in rows:
        notes = [m.description or ""]
        if m.critical:
            notes.append("On the critical path.")
        notes.append("Moved from the Construction milestones list on 11/03/2026.")
        body = tasks_router.TaskCreate(title=m.name or "Milestone", is_milestone=True, project_id=p.id,
                                       due_on=(m.target_date or "")[:10],
                                       description="\n".join(x for x in notes if x))

        def stamp(t, m=m):
            # Locked, re-read: a second start moving the same row at once finds it taken.
            row = db.query(M).filter(M.id == m.id).with_for_update().populate_existing().first()
            if row is None or (row.migrated_task_id or ""):
                raise RuntimeError("already moved")
            row.migrated_task_id = t.id
            row.modified_at = _now()
            # A hit milestone is done in the SAME transaction as its stamp
            # (the Tasks completion fields, as _apply_completion lands them) -
            # a stamped row is never left half moved.
            if (m.status or "") == "hit":
                t.completed = True
                t.status = "completed"
                t.completed_at = ((m.actual_date or m.target_date or "")[:10] + "T00:00:00+00:00") if (m.actual_date or m.target_date) else _now()
        try:
            tasks_router._create_task(body, _Now(), actor, db, before_commit=stamp, quiet=True)
            n += 1
        except Exception as e:   # noqa: BLE001 - one row never stops the rest; tried again next start
            db.rollback()
            print(f"[construction-tasks] milestone {m.id}: {getattr(e, 'detail', e)}")
    return n


def migrate_all(db: Session) -> int:
    """Startup pass: every live job with milestones not yet moved."""
    M, P = models.ConstructionMilestone, models.ConstructionProject
    ids = {r[0] for r in db.query(M.project_id).filter(
        M.deleted_at == "", (M.migrated_task_id == "") | (M.migrated_task_id.is_(None))).all()}
    n = 0
    for job in db.query(P).filter(P.id.in_(sorted(ids)), P.deleted_at == "").all() if ids else []:
        n += migrate_milestones(db, job)
    return n


# ── Read model for the Job page ──────────────────────────────────────────────

def look_ahead(tasks: list, today: date, days: int = 14) -> list:
    """Open tasks working in the next two weeks (start or due within the
    window, or already running), by date."""
    end = (today + timedelta(days=days)).isoformat()
    t0 = today.isoformat()
    out = []
    for t in tasks:
        if t.completed:
            continue
        s, d = (t.start_on or "")[:10], (t.due_on or "")[:10]
        if not s and not d:
            continue
        first, last = s or d, d or s
        if first <= end and last >= t0:
            out.append(t)
    return sorted(out, key=lambda t: ((t.start_on or t.due_on or ""), t.title or ""))


def punch_counts(tasks: list, section_id: str, verified_id: str) -> dict:
    items = [t for t in tasks if section_id and t.section_id == section_id]
    verified = [t for t in items if verified_id and t.status == verified_id]
    done = [t for t in items if t.completed and t not in verified]
    return {"open": len([t for t in items if not t.completed]), "done": len(done),
            "verified": len(verified), "total": len(items)}


def job_for_task_project(db: Session, project_id: str):
    """The job a task project belongs to (the Job chip on a task)."""
    if not project_id:
        return None
    P = models.ConstructionProject
    return db.query(P).filter(P.task_project_id == project_id, P.deleted_at == "").first()
