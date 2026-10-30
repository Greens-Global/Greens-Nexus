"""Cubby tasks -> Nexus Tasks, and completions both ways (Neil, call of
10/30/2026 - "we have tasks on our side, we have tasks in Cubby, we have no
connection between these two pieces").

Cubby raises tasks of its own ("Remind Tenant of POI Obligation", "30th -
Final Collection Call") and managers add more by hand. Nobody sees them
without signing in to Cubby, so a person's workload was never in one place.
Now, after every 15-minute Cubby sync (cubby_sync.run_claimed calls
`after_sync` in the sync's own thread), each open Cubby task becomes ONE
Nexus task, linked by Cubby's task id (cubby_task_links; the task carries
`cubby_task_id`):

  * ONE WAY for content. Cubby -> Nexus only: a task made in Nexus never goes
    to Cubby (Neil: "100 items will instantly pop in Cubby"). Only Cubby's own
    fields are refreshed from Cubby - title, description, due date - and
    whatever Nexus adds (comments, files, subtasks, more people) stays here.
  * WHERE it lands. A task assigned to people in Cubby goes to those people,
    in the facility's project; one assigned to a group (every automated task
    is assigned to the "Operations" group) or to nobody goes to the facility's
    project unassigned, for the facility manager to pick up. The facility ->
    project map is Settings > Operations > Cubby Tasks; a facility with no
    project is skipped and counted, never guessed.
  * WHO. Cubby's API has no assignee. Cubby's reporting warehouse does
    (cubby_warehouse.task_rows: `assigned_managers` are staff NAMES, and the
    `managers` table maps a name to a work email) - read once per sync and
    matched to current Nexus people by work email. No warehouse key = no
    assignees, facility routing still works. Someone assigned in Cubby with
    no Nexus account is named in the task's history, never dropped silently.
  * DONE both ways, for Cubby tasks only. Closed in Cubby (it leaves Cubby's
    open list and Cubby says COMPLETED, or it was archived / deleted) ->
    closed here, with a history line saying so. Closed or reopened in Nexus,
    by ANY path (the drawer, a bulk edit, a board drag, an automation rule) ->
    the before_flush hook below queues it on the link and `push_pending`
    (cubby_task_push_loop, every minute) sends it to Cubby through
    ops_cubby_push.set_task_status - behind ITS OWN switch, "Close Tasks in
    Cubby", off by default (Visesh, Oct 20-21 2026: nothing is written to
    Cubby unless a switch under Settings says so; this is a second switch,
    never the rate-and-rent one), and the Manager-role key. Off: the queue
    waits, and Settings shows how many are waiting.

Every Nexus write goes through the Tasks module's own paths
(routers.tasks._create_task / update_task), so bells, history, workflows
events and automation rules behave exactly as for a person's change. The
tasks are created AS a person (the facility project's owner, else whoever
saved these settings): a task needs a creator on its side of the company
wall. Blocking I/O only - every public function here runs in a thread.
"""
from __future__ import annotations

import copy
import json
import threading
import traceback
from datetime import datetime, timedelta, timezone

from sqlalchemy import event, func, inspect

import job_switch

SETTINGS_KEY = "cubby_tasks"
LAST_RUN_KEY = "cubby_tasks.last_run"
JOB_KEY = "cubby_tasks"
AUDIT_ACTION = "cubby_tasks_settings_changed"
DEFAULTS = {"on": False, "closeInCubby": False, "projects": {}}
TAG = "Cubby"
AUTO_TAG = "Automated"
CUBBY_ACTOR = "cubby@nexus"            # the history actor for what Cubby did
WAREHOUSE_LOOKBACK_DAYS = 14           # completions older than this are found through the API
PUSH_MAX_ATTEMPTS = 12                 # a push Cubby keeps refusing stops after this many minutes
PUSH_EVERY_SEC = 60
PUSH_FIRST_DELAY_SEC = 240
FROM_CUBBY = "_from_cubby"             # set on a Task instance while THIS module changes it
GONE = "GONE"                          # Cubby no longer returns the task at all

_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class _Now:
    """BackgroundTasks' add_task for code running on a worker thread: run it
    now, and never let a mail or bell failure stop the sync."""
    def add_task(self, fn, *args, **kwargs):
        try:
            fn(*args, **kwargs)
        except Exception as e:  # noqa: BLE001
            print(f"[cubby-tasks] after-commit step {getattr(fn, '__name__', fn)} failed: {type(e).__name__}")


# ── Settings ─────────────────────────────────────────────────────────────────

def _load(db) -> dict:
    import models
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTINGS_KEY).first()
    cfg = copy.deepcopy(DEFAULTS)
    meta = {"updatedBy": "", "updatedAt": ""}
    if row and row.value:
        try:
            saved = json.loads(row.value)
        except (TypeError, ValueError):
            saved = {}
        if isinstance(saved, dict):
            for k in ("on", "closeInCubby"):
                if isinstance(saved.get(k), bool):
                    cfg[k] = saved[k]
            if isinstance(saved.get("projects"), dict):
                cfg["projects"] = {str(k): str(v) for k, v in saved["projects"].items() if v}
        meta = {"updatedBy": row.updated_by or "", "updatedAt": row.updated_at or ""}
    return {**cfg, **meta}


def settings(db) -> dict:
    """{on, closeInCubby, projects: {facilityId: projectId}, updatedBy, updatedAt}.
    Read fresh every time: a write decision must never come from a cache."""
    return _load(db)


def is_on(db) -> bool:
    try:
        return bool(_load(db)["on"])
    except Exception:  # noqa: BLE001 - when in doubt, nothing is synced
        return False


def close_in_cubby_on(db) -> bool:
    """The gate ops_cubby_push.set_task_status runs behind."""
    try:
        return bool(_load(db)["closeInCubby"])
    except Exception:  # noqa: BLE001
        return False


def save(db, patch: dict, user: dict) -> dict:
    """Apply {on?, closeInCubby?, projects?} and commit, with an audit row
    (who, when, what changed). A project id that is not a live project is
    refused."""
    import models
    before = _load(db)
    nxt = {k: before[k] for k in ("on", "closeInCubby", "projects")}
    for k in ("on", "closeInCubby"):
        if k in patch:
            if not isinstance(patch[k], bool):
                raise ValueError(f"{k} must be true or false")
            nxt[k] = patch[k]
    if "projects" in patch:
        projects = patch["projects"]
        if not isinstance(projects, dict):
            raise ValueError("projects must be a map of facility id to project id")
        clean = {}
        for fid, pid in projects.items():
            fid, pid = str(fid or "").strip(), str(pid or "").strip()
            if not fid or not pid:
                continue
            p = db.query(models.TaskProject).filter(models.TaskProject.id == pid).first()
            if p is None or bool(p.archived):
                raise ValueError("That project is not available")
            clean[fid] = pid
        nxt["projects"] = clean
    now = _now()
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTINGS_KEY).with_for_update().first()
    if not row:
        row = models.NexusSetting(key=SETTINGS_KEY)
        db.add(row)
    row.value = json.dumps(nxt)
    row.updated_by = user["email"]
    row.updated_at = now
    changed = {k: {"from": before[k], "to": nxt[k]} for k in nxt if before[k] != nxt[k]}
    db.add(models.AuditLog(
        timestamp=now, user_email=user["email"], user_role=user.get("role", ""),
        action=AUDIT_ACTION, resource_type="settings", resource_id=SETTINGS_KEY,
        details=json.dumps(changed)))
    db.commit()
    try:
        import cache
        cache.settings_config.invalidate(SETTINGS_KEY)
    except Exception:  # noqa: BLE001
        pass
    return _load(db)


def last_run(db) -> dict:
    import models
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == LAST_RUN_KEY).first()
    if not row or not row.value:
        return {}
    try:
        return json.loads(row.value) or {}
    except (TypeError, ValueError):
        return {}


def _record_run(db, summary: dict) -> None:
    import models
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == LAST_RUN_KEY).first()
    if not row:
        row = models.NexusSetting(key=LAST_RUN_KEY)
        db.add(row)
    row.value = json.dumps(summary, default=str)[:20000]
    row.updated_at = summary.get("at") or _now()
    db.commit()


# ── People ───────────────────────────────────────────────────────────────────

def _staff_map(rows: list[dict]) -> dict:
    """Cubby staff name (lowercased) -> work email."""
    out = {}
    for r in rows or []:
        name = str(r.get("manager_name") or "").strip().lower()
        email = str(r.get("manager_email") or "").strip().lower()
        if name and email and "@" in email:
            out[name] = email
    return out


def _nexus_person(db, email: str, cache: dict) -> str:
    """The email as a CURRENT Nexus person (active or onboarding), else ''."""
    import models
    key = (email or "").strip().lower()
    if not key:
        return ""
    if key in cache:
        return cache[key]
    emp = (db.query(models.NexusEmployee)
           .filter(func.lower(models.NexusEmployee.work_email) == key).first())
    ok = emp is not None and (emp.status or "active") in ("active", "onboarding")
    cache[key] = key if ok else ""
    return cache[key]


def resolve_assignees(db, names: list[str], staff: dict, cache: dict) -> tuple[list[str], list[str]]:
    """Cubby assignee names -> (Nexus emails, names nobody matched)."""
    emails, missing = [], []
    for n in names or []:
        email = staff.get(str(n).strip().lower(), "")
        who = _nexus_person(db, email, cache) if email else ""
        if who and who not in emails:
            emails.append(who)
        elif not who:
            missing.append(str(n).strip())
    return emails, missing


def _run_as(db, cfg: dict, project) -> dict | None:
    """Who the Tasks module acts as: the facility project's owner, else the
    person who saved these settings. A current directory person, with their
    real role, so every permission check and the company wall apply as they
    would to that person."""
    import task_automation
    for email in ((project.owner_email if project is not None else ""), cfg.get("updatedBy", "")):
        u = task_automation._person_user(db, email) if email else None
        if u and not u.get("external"):
            return u
    return None


# ── Cubby's answers ──────────────────────────────────────────────────────────

def _warehouse() -> tuple[dict, dict, str]:
    """(tasks by Cubby id, staff name -> email, note). The note says why
    there are no assignees when there are none: not configured, or the
    warehouse's error. Never raises."""
    import cubby_warehouse
    if not cubby_warehouse.configured():
        return {}, {}, "warehouse not connected"
    since = datetime.now(timezone.utc) - timedelta(days=WAREHOUSE_LOOKBACK_DAYS)
    try:
        tasks = {str(r.get("task_id") or ""): r for r in cubby_warehouse.task_rows(since)}
        staff = _staff_map(cubby_warehouse.manager_rows())
    except cubby_warehouse.WarehouseError as e:
        return {}, {}, str(e)[:300]
    except Exception as e:  # noqa: BLE001
        return {}, {}, f"warehouse: {type(e).__name__}"
    tasks.pop("", None)
    return tasks, staff, ""


def cubby_status(task_id: str) -> str:
    """What Cubby says a task is now: OPEN / COMPLETED / ARCHIVED, or GONE.
    A search-only call (cubby._post); raises cubby.CubbyError."""
    import cubby
    rows = cubby._post("tasks/search", {"taskId": task_id}).get("tasks") or []
    for r in rows:
        if str(r.get("id") or r.get("taskId") or "") == task_id:
            return str(r.get("status") or "").upper() or GONE
    return GONE


# ── The sync ─────────────────────────────────────────────────────────────────

def after_sync(facility_ids: list[str] | None = None, trigger: str = "schedule") -> dict:
    """Called by cubby_sync.run_claimed once the cubby_tasks rows are fresh
    (the facilities whose rows were saved), and by Sync Now from Settings.
    Blocking; one at a time. Returns the run summary."""
    if trigger == "schedule" and job_switch.off(JOB_KEY):
        return {"status": "off"}
    if not _lock.acquire(blocking=False):
        return {"status": "busy"}
    from database import SessionLocal
    db = SessionLocal()
    try:
        cfg = settings(db)
        if not cfg["on"]:
            return {"status": "off"}
        summary = _sync(db, cfg, facility_ids)
        summary["trigger"] = trigger
        _record_run(db, summary)
        return summary
    except Exception as e:  # noqa: BLE001 - the run's own problem, never the Cubby sync's
        db.rollback()
        summary = {"at": _now(), "status": "failed", "error": f"{type(e).__name__}: {str(e)[:200]}", "trigger": trigger}
        print(f"[cubby-tasks] run failed: {summary['error']}\n{traceback.format_exc()[-800:]}")
        try:
            _record_run(db, summary)
        except Exception:  # noqa: BLE001
            db.rollback()
        return summary
    finally:
        db.close()
        _lock.release()


def _open_rows(db, facility_ids) -> dict:
    """Cubby's open tasks as the last sync saved them, by Cubby task id."""
    import models
    q = db.query(models.CubbyTask)
    if facility_ids is not None:
        q = q.filter(models.CubbyTask.facility_id.in_(list(facility_ids)))
    out = {}
    for row in q.all():
        data = row.data or {}
        tid = str(data.get("id") or data.get("taskId") or row.task_id or "")
        if tid:
            out[tid] = (row, data)
    return out


def _sync(db, cfg: dict, facility_ids) -> dict:
    import models
    at = _now()
    if facility_ids is None:
        facility_ids = [f.facility_id for f in db.query(models.CubbyFacility)
                        .filter(models.CubbyFacility.enabled.is_(True)).all()]
    facility_ids = list(facility_ids)
    fac_names = {f.facility_id: (f.name or f.facility_id) for f in db.query(models.CubbyFacility).all()}
    units = {u.id: (u.unit_name or u.unit_id or "") for u in db.query(models.CubbyUnit)
             .filter(models.CubbyUnit.facility_id.in_(facility_ids)).all()} if facility_ids else {}
    projects = {p.id: p for p in db.query(models.TaskProject)
                .filter(models.TaskProject.id.in_(list(set(cfg["projects"].values())) or [""])).all()}
    wh_tasks, staff, wh_note = _warehouse()
    people_cache: dict = {}
    open_rows = _open_rows(db, facility_ids)
    links = {l.task_id: l for l in db.query(models.CubbyTaskLink).all()}
    s = {"at": at, "status": "ok", "facilities": len(facility_ids), "open": len(open_rows),
         "created": 0, "updated": 0, "reassigned": 0, "completedFromCubby": 0, "reopenedFromCubby": 0,
         "unmapped": {}, "noCreator": [], "unmatchedPeople": {}, "errors": [], "warehouse": wh_note or "ok"}

    def fail(what: str, e: Exception) -> None:
        db.rollback()
        detail = getattr(e, "detail", None) or str(e)
        s["errors"].append(f"{what}: {str(detail)[:200]}")

    # 1. Every open Cubby task: new -> create; known -> refresh, and reopen if
    #    Cubby reopened it.
    for tid, (row, data) in sorted(open_rows.items()):
        fid = row.facility_id
        wh = wh_tasks.get(tid)
        names = list(wh["assigned_managers"]) if wh else []
        groups = list(wh["assigned_manager_groups"]) if wh else []
        emails, missing = resolve_assignees(db, names, staff, people_cache)
        for m in missing:
            s["unmatchedPeople"][m] = s["unmatchedPeople"].get(m, 0) + 1
        fields = {
            "facility_id": fid, "title": (data.get("title") or "").strip() or "Cubby task",
            "due_date": (data.get("dueDate") or "")[:10], "unit_id": data.get("unitId") or "",
            "unit_name": units.get(f"{fid}:{data.get('unitId') or ''}", ""),
            "customer_id": data.get("customerId") or "",
            "assigned_names": names, "group_names": groups,
            "created_by_name": (wh or {}).get("created_by") or "",
            "workflow_generated": bool((wh or {}).get("is_workflow_generated")),
            "cubby_created_at": data.get("createdAt") or "", "cubby_updated_at": data.get("updatedAt") or "",
        }
        link = links.get(tid)
        try:
            if link is None:
                pid = cfg["projects"].get(fid, "")
                project = projects.get(pid)
                if project is None:
                    s["unmapped"][fid] = s["unmapped"].get(fid, 0) + 1
                    continue
                user = _run_as(db, cfg, project)
                if user is None:
                    if fid not in s["noCreator"]:
                        s["noCreator"].append(fid)
                    continue
                link = _create(db, user, project, tid, data, fields, emails, missing, fac_names.get(fid, fid), wh)
                links[tid] = link
                s["created"] += 1
                continue
            t = db.query(models.Task).filter(models.Task.id == link.nexus_task_id).first()
            cubby_changed = (data.get("updatedAt") or "") != (link.cubby_updated_at or "")
            for k, v in fields.items():
                setattr(link, k, v)
            link.last_seen_at = at
            if t is None:                     # binned or purged in Nexus: nothing to mirror into
                link.status = "OPEN"
                db.commit()
                continue
            user = _run_as(db, cfg, projects.get(cfg["projects"].get(fid, "")) or _project_of(db, t))
            if user is None:
                if fid not in s["noCreator"]:
                    s["noCreator"].append(fid)
                db.commit()
                continue
            if link.status != "OPEN":
                _set_completed(db, user, t, False, "reopened in Cubby")
                s["reopenedFromCubby"] += 1
            if cubby_changed and _refresh_fields(db, user, t, data):
                s["updated"] += 1
            if wh is not None and _reassign(db, user, link, t, emails, missing):
                s["reassigned"] += 1
            link.status = "OPEN"
            if link.push_status == "COMPLETED" and not bool(t.completed):
                link.push_status = ""            # Cubby and Nexus agree again
            link.updated_at = at
            db.commit()
        except Exception as e:  # noqa: BLE001 - one task never stops the rest
            fail(f"{fields['title']} ({fac_names.get(fid, fid)})", e)

    # 2. A linked task that left Cubby's open list: find out why, and close
    #    it here when Cubby closed it.
    for tid, link in list(links.items()):
        if link.status != "OPEN" or tid in open_rows or link.facility_id not in facility_ids:
            continue
        if link.push_status == "COMPLETED":
            # Nexus closed it first and the push landed (or is landing): Cubby
            # dropping it from the open list is that, not news.
            continue
        wh = wh_tasks.get(tid)
        final = str((wh or {}).get("status") or "").upper()
        if final in ("", "OPEN"):
            try:
                final = cubby_status(tid)
            except Exception as e:  # noqa: BLE001 - ask again next run
                s["errors"].append(f"{link.title}: Cubby did not answer ({type(e).__name__})")
                continue
        if final == "OPEN":
            continue                         # a facility whose rows failed to save this run
        try:
            t = db.query(models.Task).filter(models.Task.id == link.nexus_task_id).first()
            link.status = final
            link.updated_at = at
            if t is not None and not bool(t.completed):
                user = _run_as(db, cfg, _project_of(db, t))
                if user is None:
                    db.rollback()
                    if link.facility_id not in s["noCreator"]:
                        s["noCreator"].append(link.facility_id)
                    continue
                why = {"COMPLETED": "completed in Cubby", "ARCHIVED": "archived in Cubby (dismissed, not done)"}.get(
                    final, "removed in Cubby")
                _set_completed(db, user, t, True, why)
                s["completedFromCubby"] += 1
            db.commit()
        except Exception as e:  # noqa: BLE001
            fail(f"{link.title}", e)

    if s["errors"]:
        s["status"] = "partial"
    print(f"[cubby-tasks] {s['status']}: {s['created']} created, {s['updated']} updated, "
          f"{s['completedFromCubby']} completed from Cubby, {len(s['errors'])} error(s)")
    return s


def _project_of(db, t):
    import models
    return db.query(models.TaskProject).filter(models.TaskProject.id == t.project_id).first() if t.project_id else None


def _cubby_note(db, t, detail: str) -> None:
    """A history line for what Cubby did, in Cubby's name."""
    from routers.task_util import log_activity
    t.activity_ids = list(t.activity_ids or []) + [log_activity(
        db, type="automation", actor_email=CUBBY_ACTOR, entity_id=t.id, entity_code=t.code,
        entity_title=t.title, detail=detail)]


def _create(db, user: dict, project, tid: str, data: dict, fields: dict, emails: list[str],
            missing: list[str], facility_name: str, wh):
    import models
    from routers import tasks as tasks_router
    tags = [TAG] + ([AUTO_TAG] if fields["workflow_generated"] else [])
    body = tasks_router.TaskCreate(
        title=fields["title"], description=(data.get("description") or "").strip(),
        project_id=project.id, assignee_emails=emails, due_on=fields["due_date"], tags=tags)
    link = models.CubbyTaskLink(task_id=tid, status="OPEN", assignee_snapshot=list(emails),
                                created_at=_now(), updated_at=_now(), last_seen_at=_now(), **fields)
    where = facility_name + (f", unit {fields['unit_name']}" if fields["unit_name"] else "")
    who = ("raised by a Cubby automation" if fields["workflow_generated"]
           else f"created in Cubby by {fields['created_by_name']}" if fields["created_by_name"] else "created in Cubby")
    extra = ""
    if fields["group_names"]:
        extra += f"; assigned in Cubby to the {', '.join(fields['group_names'])} group"
    if missing:
        extra += f"; assigned in Cubby to {', '.join(missing)}, who {'has' if len(missing) == 1 else 'have'} no Nexus account"
    if wh is None:
        extra += "; assignees unknown (warehouse not read)"

    def before_commit(t):
        t.cubby_task_id = tid
        link.nexus_task_id = t.id
        db.add(link)
        _cubby_note(db, t, f"Imported from Cubby ({where}) - {who}{extra}")

    tasks_router._create_task(body, _Now(), user, db, before_commit=before_commit, check_people=True,
                              quiet=not emails)
    return link


def _refresh_fields(db, user: dict, t, data: dict) -> bool:
    """Cubby's own fields, once Cubby's updatedAt moved since the last sync -
    so a title or date edited in Nexus stands until Cubby itself changes it,
    and everything else Nexus adds is never touched."""
    from routers import tasks as tasks_router
    upd = {}
    title = (data.get("title") or "").strip()
    if title and title != (t.title or ""):
        upd["title"] = title
    desc = (data.get("description") or "").strip()
    if desc and desc != (t.description or ""):
        upd["description"] = desc
    due = (data.get("dueDate") or "")[:10]
    if due and due != (t.due_on or "")[:10]:
        upd["due_on"] = due
    if not upd:
        return False
    setattr(t, FROM_CUBBY, True)
    try:
        tasks_router.update_task(t.id, tasks_router.TaskUpdate(**upd), _Now(), user, db)
        _cubby_note(db, t, "Updated from Cubby: " + ", ".join(
            {"title": "title", "description": "description", "due_on": "due date"}[k] for k in upd))
        db.commit()
    finally:
        setattr(t, FROM_CUBBY, False)
    return True


def _reassign(db, user: dict, link, t, emails: list[str], missing: list[str]) -> bool:
    """Follow Cubby's assignment: people Cubby added join, people Cubby took
    off leave - and people added in Nexus stay."""
    from routers import tasks as tasks_router
    from routers.task_util import task_assignees
    snapshot = set(link.assignee_snapshot or [])
    wanted = set(emails)
    if snapshot == wanted:
        return False
    current = task_assignees(t)
    keep = [e for e in current if e not in snapshot or e in wanted]
    nxt = keep + [e for e in emails if e not in keep]
    link.assignee_snapshot = list(emails)
    if set(nxt) == set(current):
        return False
    setattr(t, FROM_CUBBY, True)
    try:
        tasks_router.update_task(t.id, tasks_router.TaskUpdate(assignee_emails=nxt), _Now(), user, db)
        note = "Assignment changed in Cubby"
        if missing:
            note += f" - assigned there to {', '.join(missing)}, who {'has' if len(missing) == 1 else 'have'} no Nexus account"
        _cubby_note(db, t, note)
        db.commit()
    finally:
        setattr(t, FROM_CUBBY, False)
    return True


def _set_completed(db, user: dict, t, done: bool, why: str) -> None:
    """Complete or reopen the Nexus task because Cubby did - through
    update_task, so history, bells and the recurring roll-forward happen as
    for a person, but flagged so the push hook does not send it back."""
    from routers import tasks as tasks_router
    setattr(t, FROM_CUBBY, True)
    try:
        tasks_router.update_task(t.id, tasks_router.TaskUpdate(completed=done), _Now(), user, db)
        _cubby_note(db, t, ("Completed" if done else "Reopened") + f" - {why}")
        db.commit()
    finally:
        setattr(t, FROM_CUBBY, False)


# ── Nexus -> Cubby: completions and reopenings ───────────────────────────────

def wire(session_factory) -> None:
    """A Cubby-linked task completed or reopened by ANY path queues the
    change on its link (database.py wires this once)."""
    @event.listens_for(session_factory, "before_flush")
    def _queue_completion(session, _ctx, _instances):
        import models
        for obj in list(session.dirty):
            if not isinstance(obj, models.Task) or not (getattr(obj, "cubby_task_id", "") or ""):
                continue
            if getattr(obj, FROM_CUBBY, False):
                continue
            hist = inspect(obj).attrs.completed.history
            if not hist.has_changes():
                continue
            before = bool(hist.deleted[0]) if hist.deleted else None
            after = bool(obj.completed)
            if before is not None and before == after:
                continue
            try:
                link = session.query(models.CubbyTaskLink).filter(models.CubbyTaskLink.task_id == obj.cubby_task_id).first()
                if link is None:
                    continue
                want = "COMPLETED" if after else "OPEN"
                if link.status == want and not link.push_status:
                    continue                 # Cubby already says so
                link.push_status = want
                link.push_attempts = 0
                link.push_error = ""
                link.updated_at = _now()
            except Exception as e:  # noqa: BLE001 - the queue must never fail the task save
                print(f"[cubby-tasks] queue {obj.id}: {type(e).__name__}")


def push_pending(limit: int = 50) -> dict:
    """Send queued completions / reopenings to Cubby. Off (the switch, the
    job switch) = everything waits. Blocking."""
    import models
    import ops_cubby_push
    from database import SessionLocal
    if job_switch.off(JOB_KEY):
        return {"status": "off", "sent": 0}
    db = SessionLocal()
    try:
        if not close_in_cubby_on(db):
            return {"status": "waiting", "sent": 0}
        if not ops_cubby_push.write_configured():
            return {"status": "no-key", "sent": 0}
        rows = (db.query(models.CubbyTaskLink)
                .filter(models.CubbyTaskLink.push_status != "",
                        models.CubbyTaskLink.push_attempts < PUSH_MAX_ATTEMPTS)
                .order_by(models.CubbyTaskLink.updated_at).limit(limit).all())
        sent = failed = 0
        for link in rows:
            want = link.push_status
            try:
                ops_cubby_push.set_task_status(db, link.task_id, want, close_in_cubby_on)
            except ops_cubby_push.PushOff:
                break
            except Exception as e:  # noqa: BLE001 - CubbyError and anything on the way
                link.push_attempts = int(link.push_attempts or 0) + 1
                link.push_error = f"{getattr(e, 'message', '') or type(e).__name__}"[:300]
                link.updated_at = _now()
                failed += 1
                db.commit()
                continue
            link.status = want
            link.push_status = ""
            link.push_error = ""
            link.pushed_at = _now()
            link.updated_at = link.pushed_at
            sent += 1
            db.commit()
            t = db.query(models.Task).filter(models.Task.id == link.nexus_task_id).first()
            if t is not None:
                _cubby_note(db, t, "Completed in Cubby" if want == "COMPLETED" else "Reopened in Cubby")
                db.commit()
        return {"status": "ok", "sent": sent, "failed": failed}
    finally:
        db.close()


async def cubby_task_push_loop():
    """Deployed worker only (main.py). Every minute, in a thread."""
    import asyncio
    await asyncio.sleep(PUSH_FIRST_DELAY_SEC)
    while True:
        try:
            r = await asyncio.to_thread(push_pending)
            if r.get("sent"):
                print(f"[cubby-tasks] sent {r['sent']} change(s) to Cubby")
        except Exception as e:  # noqa: BLE001
            print(f"[cubby-tasks] push loop error: {type(e).__name__}")
        await asyncio.sleep(PUSH_EVERY_SEC)


# ── What a screen asks ───────────────────────────────────────────────────────

def link_for_task(db, nexus_task_id: str) -> dict | None:
    """The drawer's "From Cubby" row."""
    import models
    link = db.query(models.CubbyTaskLink).filter(models.CubbyTaskLink.nexus_task_id == nexus_task_id).first()
    if link is None:
        return None
    fac = db.query(models.CubbyFacility).filter(models.CubbyFacility.facility_id == link.facility_id).first()
    return {
        "cubbyTaskId": link.task_id, "facilityId": link.facility_id,
        "facilityName": (fac.name if fac else "") or link.facility_id,
        "unitName": link.unit_name or "", "status": link.status or "OPEN",
        "assignedNames": list(link.assigned_names or []), "groupNames": list(link.group_names or []),
        "createdBy": link.created_by_name or "", "automated": bool(link.workflow_generated),
        "dueDate": link.due_date or "", "pushStatus": link.push_status or "", "pushError": link.push_error or "",
        "pushedAt": link.pushed_at or "", "lastSeenAt": link.last_seen_at or "",
    }


def overview(db) -> dict:
    """Settings: the switches, the map, the facilities and projects to map
    between, the last run and the push queue."""
    import models
    import ops_cubby_push
    cfg = settings(db)
    facilities = [{"id": f.facility_id, "name": f.name or f.facility_id,
                   "internalName": ((f.data or {}).get("internalName") or "").strip()}
                  for f in db.query(models.CubbyFacility).filter(models.CubbyFacility.enabled.is_(True))
                  .order_by(models.CubbyFacility.name).all()]
    projects = [{"id": p.id, "name": p.name, "ownerEmail": p.owner_email or ""}
                for p in db.query(models.TaskProject).filter(models.TaskProject.archived.is_(False))
                .order_by(models.TaskProject.name).all()]
    links = db.query(models.CubbyTaskLink).all()
    pending = [l for l in links if l.push_status]
    import cubby_warehouse
    return {
        "on": cfg["on"], "closeInCubby": cfg["closeInCubby"], "projects": cfg["projects"],
        "updatedBy": cfg["updatedBy"], "updatedAt": cfg["updatedAt"],
        "facilities": facilities, "projectOptions": projects,
        "warehouseConfigured": cubby_warehouse.configured(),
        "writeConfigured": ops_cubby_push.write_configured(), "writeKeyEnv": ops_cubby_push.WRITE_KEY_ENV,
        "linked": len(links), "linkedOpen": sum(1 for l in links if l.status == "OPEN"),
        "pending": len(pending),
        "pendingErrors": [{"title": l.title, "error": l.push_error, "attempts": l.push_attempts}
                          for l in pending if l.push_error][:20],
        "stuck": sum(1 for l in pending if int(l.push_attempts or 0) >= PUSH_MAX_ATTEMPTS),
        "lastRun": last_run(db),
    }
