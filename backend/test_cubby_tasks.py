"""Cubby tasks <-> Nexus Tasks (cubby_tasks.py, Neil, Oct 30 2026). Cubby's
API, its warehouse and the Manager-key write are all faked - nothing here
calls out. Runs on the throwaway SQLite conftest gives the run. Run alone:
python -m pytest test_cubby_tasks.py"""
import json

import pytest
from fastapi import BackgroundTasks

import cubby
import cubby_tasks
import cubby_warehouse
import job_switch
import models
import ops_cubby_push
import task_notify
from database import SessionLocal
from routers.task_util import gen_id, now_iso, task_assignees
from routers.tasks import TaskUpdate, update_task

# The real warehouse readers, kept before the World fixture swaps in fakes.
REAL_TASK_ROWS, REAL_MANAGER_ROWS, REAL_NOTE_ROWS = (cubby_warehouse.task_rows, cubby_warehouse.manager_rows,
                                                    cubby_warehouse.note_rows)
OWNER = "valinda@greensstorage.com"      # the facility project's owner - tasks are created as them
AMY = "amy@greensstorage.com"
SAGAR = "sagar@greensglobal.com"
ADMIN = {"email": "admin@greensglobal.com", "level": 4, "role": "administrator"}
OWNER_USER = {"email": OWNER, "level": 3, "role": "manager"}
FAC = "fac_a"
STAFF = [{"manager_id": "m1", "manager_name": "Amy Bolanos", "manager_email": AMY},
         {"manager_id": "m2", "manager_name": "Sagar Shoundik", "manager_email": SAGAR},
         {"manager_id": "m3", "manager_name": "Greens Storage - API", "manager_email": "neil@greensglobal.com"}]

TABLES = (models.Task, models.TaskProject, models.TaskActivity, models.CubbyTaskLink, models.CubbyTask,
          models.CubbyFacility, models.CubbyUnit, models.NexusEmployee, models.NexusRole, models.NexusSetting,
          models.NexusNotification, models.TaskComment, models.TaskNotification)


def _note(nid, tid, message, who="Sagar Shoundik", at="2026-11-01T08:00:00"):
    return {"id": nid, "manager_note_id_int": int(nid), "task_id": tid, "message": message,
            "manager_name": who, "manager_id": "m2", "created_at": at}


def _comments(task_id):
    db = SessionLocal()
    try:
        return [(c.author_email, c.body) for c in db.query(models.TaskComment)
                .filter(models.TaskComment.task_id == task_id).order_by(models.TaskComment.created_at).all()]
    finally:
        db.close()


def _bells(email):
    db = SessionLocal()
    try:
        return [n.title for n in db.query(models.TaskNotification)
                .filter(models.TaskNotification.for_email == email).all()]
    finally:
        db.close()


def _api_task(tid, title, due="2026-11-07", unit="u1", updated="2026-10-30T08:54:16Z", desc=""):
    return {"id": tid, "title": title, "description": desc, "dueDate": due, "status": "OPEN", "facilityId": FAC,
            "customerId": "cust_1", "unitId": unit, "createdAt": "2026-10-30T08:54:16Z", "updatedAt": updated}


def _wh_task(tid, title, people=(), groups=(), auto=False, status="OPEN", created_by="Ashley Vizcarra"):
    return {"task_id": tid, "facility_id": FAC, "status": status, "task_title": title, "due_date": "2026-11-07",
            "schedule": None, "assigned_managers": list(people), "assigned_manager_groups": list(groups),
            "created_by": None if auto else created_by, "contact_id": None, "unit_id": "u1",
            "is_workflow_generated": auto, "created_at": "2026-10-30T08:54:16", "updated_at": "2026-10-30T08:54:16"}


class World:
    def __init__(self, monkeypatch):
        self.api_open = {}        # Cubby's open list, as cubby_sync saved it: tid -> API row
        self.api_status = {}      # what tasks/search answers for a task no longer open
        self.wh = {}              # warehouse rows by tid
        self.notes = []           # warehouse manager_notes rows on tasks
        self.writes = []          # tasks/update bodies sent to Cubby
        self.write_ok = True
        monkeypatch.setattr(cubby_warehouse, "configured", lambda: True)
        monkeypatch.setattr(cubby_warehouse, "task_rows", lambda since: list(self.wh.values()))
        monkeypatch.setattr(cubby_warehouse, "manager_rows", lambda: list(STAFF))
        monkeypatch.setattr(cubby_warehouse, "note_rows", lambda since: list(self.notes))
        monkeypatch.setattr(cubby, "_post", self._post)
        monkeypatch.setattr(job_switch, "off", lambda key: False)
        monkeypatch.setattr(task_notify, "notify_task_event", lambda *a, **k: None)
        monkeypatch.setenv(ops_cubby_push.WRITE_KEY_ENV, "manager-key")
        monkeypatch.setattr(ops_cubby_push.httpx, "post", self._http_post)

    def _post(self, path, where):
        assert path == "tasks/search" and "taskId" in where
        st = self.api_status.get(where["taskId"])
        return {"tasks": [{"id": where["taskId"], "status": st}]} if st else {"tasks": []}

    def _http_post(self, url, json=None, headers=None, timeout=None):
        assert url.endswith("/tasks/update") and headers["Authorization"] == "Bearer manager-key"
        self.writes.append(dict(json))

        class R:
            status_code = 200 if self.write_ok else 500

            def json(_):
                return {"data": {"taskId": json["taskId"]}} if self.write_ok else {"errors": ["boom"]}
        return R()

    def save_open(self):
        """Replace the cubby_tasks rows the way cubby_sync does."""
        db = SessionLocal()
        try:
            db.query(models.CubbyTask).filter(models.CubbyTask.facility_id == FAC).delete()
            for tid, row in self.api_open.items():
                db.add(models.CubbyTask(id=f"{FAC}:{tid}", facility_id=FAC, task_id=tid, unit_id=row["unitId"],
                                        due_date=row["dueDate"], data=row))
            db.commit()
        finally:
            db.close()

    def sync(self):
        self.save_open()
        return cubby_tasks.after_sync([FAC])


@pytest.fixture
def world(monkeypatch):
    db = SessionLocal()
    try:
        for t in TABLES:
            db.query(t).delete()
        for who in (OWNER, AMY, SAGAR, ADMIN["email"]):
            db.add(models.NexusEmployee(id=gen_id(), work_email=who, first_name=who.split("@")[0], status="active"))
        db.add(models.NexusRole(email=OWNER, role="manager"))
        db.add(models.NexusRole(email=ADMIN["email"], role="administrator"))
        db.add(models.CubbyFacility(facility_id=FAC, name="Greens Storage Temecula", enabled=True,
                                    data={"internalName": "01 - GS Temecula"}))
        db.add(models.CubbyFacility(facility_id="fac_b", name="Greens Storage Valley Center", enabled=True))
        db.add(models.CubbyUnit(id=f"{FAC}:u1", facility_id=FAC, unit_id="u1", unit_name="A014"))
        p = models.TaskProject(id="proj_temecula", name="GS Temecula Operations", access_level="org",
                               owner_email=OWNER, member_emails=[], created_at=now_iso(), modified_at=now_iso())
        db.add(p)
        db.commit()
        cubby_tasks.save(db, {"on": True, "projects": {FAC: p.id}}, ADMIN)
    finally:
        db.close()
    import auth
    auth.invalidate_role_cache()
    return World(monkeypatch)


def _tasks():
    db = SessionLocal()
    try:
        return {t.cubby_task_id: t for t in db.query(models.Task).all()}
    finally:
        db.close()


def _link(tid):
    db = SessionLocal()
    try:
        return db.query(models.CubbyTaskLink).filter(models.CubbyTaskLink.task_id == tid).first()
    finally:
        db.close()


def _history(task_id):
    db = SessionLocal()
    try:
        t = db.query(models.Task).filter(models.Task.id == task_id).first()
        rows = db.query(models.TaskActivity).filter(models.TaskActivity.id.in_(t.activity_ids or [])).all()
        return [r.detail for r in rows]
    finally:
        db.close()


# ── Cubby -> Nexus ───────────────────────────────────────────────────────────

def test_open_cubby_tasks_become_nexus_tasks_in_the_facility_project(world):
    world.api_open = {"task_1": _api_task("task_1", "Sample Task for Nexus Test", desc="Check unit A014"),
                      "task_2": _api_task("task_2", "30th - Final Collection Call")}
    world.wh = {"task_1": _wh_task("task_1", "Sample Task for Nexus Test", people=["Amy Bolanos"]),
                "task_2": _wh_task("task_2", "30th - Final Collection Call", groups=["Operations"], auto=True)}
    s = world.sync()
    assert s["status"] == "ok" and s["created"] == 2 and s["errors"] == []
    tasks = _tasks()
    manual, auto = tasks["task_1"], tasks["task_2"]
    assert manual.project_id == "proj_temecula" and task_assignees(manual) == [AMY]
    assert manual.due_on == "2026-11-07" and manual.description == "Check unit A014"
    assert manual.created_by == OWNER and "Cubby" in manual.tags
    assert auto.project_id == "proj_temecula" and task_assignees(auto) == []       # the group's: the project's
    assert "Automated" in auto.tags
    link = _link("task_1")
    assert link.nexus_task_id == manual.id and link.unit_name == "A014" and link.assigned_names == ["Amy Bolanos"]
    assert _link("task_2").group_names == ["Operations"] and _link("task_2").workflow_generated is True
    hist = _history(manual.id)
    assert any("Imported from Cubby (Greens Storage Temecula, unit A014) - created in Cubby by Ashley Vizcarra" in h
               for h in hist)
    # Running again imports nothing twice.
    s2 = world.sync()
    assert s2["created"] == 0 and len(_tasks()) == 2


def test_a_facility_with_no_project_is_skipped_and_counted(world):
    row = _api_task("task_b", "Move-out")
    row["facilityId"] = "fac_b"
    db = SessionLocal()
    try:
        db.add(models.CubbyTask(id="fac_b:task_b", facility_id="fac_b", task_id="task_b", data=row))
        db.commit()
    finally:
        db.close()
    s = cubby_tasks.after_sync([FAC, "fac_b"])
    assert s["unmapped"] == {"fac_b": 1} and _tasks() == {}


def test_an_assignee_without_a_nexus_account_is_noted_never_dropped(world):
    world.api_open = {"task_3": _api_task("task_3", "Add Senior Discount")}
    world.wh = {"task_3": _wh_task("task_3", "Add Senior Discount", people=["Vicki Hale", "Amy Bolanos"])}
    s = world.sync()
    assert s["unmatchedPeople"] == {"Vicki Hale": 1}
    t = _tasks()["task_3"]
    assert task_assignees(t) == [AMY]
    assert any("assigned in Cubby to Vicki Hale, who has no Nexus account" in h for h in _history(t.id))


def test_completed_or_archived_in_cubby_closes_the_nexus_task(world):
    world.api_open = {"task_4": _api_task("task_4", "Enroll Tenant in Protection Plan"),
                      "task_5": _api_task("task_5", "Remind Tenant of POI Obligation")}
    world.wh = {"task_4": _wh_task("task_4", "Enroll Tenant in Protection Plan", groups=["Operations"], auto=True),
                "task_5": _wh_task("task_5", "Remind Tenant of POI Obligation", groups=["Operations"], auto=True)}
    world.sync()
    # Both leave Cubby's open list: one completed (the warehouse says so), one
    # archived (the warehouse is behind, so Cubby's API is asked).
    world.api_open = {}
    world.wh["task_4"]["status"] = "COMPLETED"
    world.api_status["task_5"] = "ARCHIVED"
    s = world.sync()
    assert s["completedFromCubby"] == 2 and s["errors"] == []
    tasks = _tasks()
    assert tasks["task_4"].completed is True and tasks["task_4"].status == "completed"
    assert tasks["task_5"].completed is True
    assert _link("task_4").status == "COMPLETED" and _link("task_5").status == "ARCHIVED"
    assert any("Completed - completed in Cubby" in h for h in _history(tasks["task_4"].id))
    assert any("archived in Cubby (dismissed, not done)" in h for h in _history(tasks["task_5"].id))
    # Nothing was sent to Cubby: Cubby did this.
    assert world.writes == [] and _link("task_4").push_status == ""


def test_reopened_in_cubby_reopens_the_nexus_task(world):
    world.api_open = {"task_6": _api_task("task_6", "No lock on unit yet")}
    world.wh = {"task_6": _wh_task("task_6", "No lock on unit yet", people=["Amy Bolanos"])}
    world.sync()
    world.api_open = {}
    world.wh["task_6"]["status"] = "COMPLETED"
    world.sync()
    assert _tasks()["task_6"].completed is True
    world.api_open = {"task_6": _api_task("task_6", "No lock on unit yet")}
    world.wh["task_6"]["status"] = "OPEN"
    s = world.sync()
    assert s["reopenedFromCubby"] == 1
    assert _tasks()["task_6"].completed is False and _link("task_6").status == "OPEN"


def test_cubbys_own_fields_follow_cubby_and_nexus_edits_stand(world):
    world.api_open = {"task_7": _api_task("task_7", "Move TNT out")}
    world.wh = {"task_7": _wh_task("task_7", "Move TNT out", people=["Amy Bolanos"])}
    world.sync()
    t = _tasks()["task_7"]
    # Edited in Nexus; Cubby unchanged (same updatedAt): the Nexus title stands.
    db = SessionLocal()
    try:
        update_task(t.id, TaskUpdate(title="Move tenant out - call first"), BackgroundTasks(), OWNER_USER, db)
    finally:
        db.close()
    world.sync()
    assert _tasks()["task_7"].title == "Move tenant out - call first"
    # Cubby changed it: Cubby's title and date win.
    world.api_open["task_7"] = _api_task("task_7", "Move TNT out TODAY", due="2026-11-01", updated="2026-10-31T10:00:00Z")
    s = world.sync()
    assert s["updated"] == 1
    t = _tasks()["task_7"]
    assert t.title == "Move TNT out TODAY" and t.due_on == "2026-11-01"
    assert any("Updated from Cubby: title, due date" in h for h in _history(t.id))


def test_assignment_follows_cubby_while_people_added_in_nexus_stay(world):
    world.api_open = {"task_8": _api_task("task_8", "Make sure Auto pay goes through")}
    world.wh = {"task_8": _wh_task("task_8", "Make sure Auto pay goes through", people=["Amy Bolanos"])}
    world.sync()
    t = _tasks()["task_8"]
    db = SessionLocal()
    try:   # a manager adds themselves in Nexus
        update_task(t.id, TaskUpdate(assignee_emails=[AMY, OWNER]), BackgroundTasks(), OWNER_USER, db)
    finally:
        db.close()
    world.wh["task_8"]["assigned_managers"] = ["Sagar Shoundik"]        # Cubby: Amy off, Sagar on
    s = world.sync()
    assert s["reassigned"] == 1
    assert sorted(task_assignees(_tasks()["task_8"])) == sorted([OWNER, SAGAR])
    assert _link("task_8").assignee_snapshot == [SAGAR]


def test_switch_off_syncs_nothing(world):
    db = SessionLocal()
    try:
        cubby_tasks.save(db, {"on": False}, ADMIN)
    finally:
        db.close()
    world.api_open = {"task_9": _api_task("task_9", "Sweep aisle B")}
    assert world.sync() == {"status": "off"} and _tasks() == {}


def test_settings_refuse_a_project_that_does_not_exist(world):
    db = SessionLocal()
    try:
        with pytest.raises(ValueError):
            cubby_tasks.save(db, {"projects": {FAC: "proj_nope"}}, ADMIN)
        cfg = cubby_tasks.settings(db)
        assert cfg["projects"] == {FAC: "proj_temecula"} and cfg["updatedBy"] == ADMIN["email"]
        audit = db.query(models.AuditLog).filter(models.AuditLog.action == cubby_tasks.AUDIT_ACTION).all()
        assert audit and json.loads(audit[-1].details)["on"] == {"from": False, "to": True}
    finally:
        db.close()


# ── Nexus -> Cubby ───────────────────────────────────────────────────────────

def test_completed_in_nexus_is_queued_and_sent_only_behind_the_switch(world):
    world.api_open = {"task_10": _api_task("task_10", "Merch fulfillment needed for unit B157")}
    world.wh = {"task_10": _wh_task("task_10", "Merch fulfillment needed for unit B157", people=["Amy Bolanos"])}
    world.sync()
    t = _tasks()["task_10"]
    db = SessionLocal()
    try:
        update_task(t.id, TaskUpdate(completed=True), BackgroundTasks(), OWNER_USER, db)
    finally:
        db.close()
    link = _link("task_10")
    assert link.push_status == "COMPLETED" and link.status == "OPEN"
    # The switch is off (the default): it waits, nothing leaves the server.
    assert cubby_tasks.push_pending() == {"status": "waiting", "sent": 0} and world.writes == []
    db = SessionLocal()
    try:
        cubby_tasks.save(db, {"closeInCubby": True}, ADMIN)
    finally:
        db.close()
    assert cubby_tasks.push_pending()["sent"] == 1
    assert world.writes == [{"taskId": "task_10", "status": "COMPLETED"}]
    link = _link("task_10")
    assert link.status == "COMPLETED" and link.push_status == "" and link.pushed_at
    assert any("Completed in Cubby" in h for h in _history(t.id))
    # Cubby then drops it from the open list: that is our own completion, not news.
    world.api_open = {}
    world.wh["task_10"]["status"] = "COMPLETED"
    s = world.sync()
    assert s["completedFromCubby"] == 0 and s["errors"] == []
    # Reopened in Nexus -> reopened in Cubby.
    db = SessionLocal()
    try:
        update_task(t.id, TaskUpdate(completed=False), BackgroundTasks(), OWNER_USER, db)
    finally:
        db.close()
    assert _link("task_10").push_status == "OPEN"
    cubby_tasks.push_pending()
    assert world.writes[-1] == {"taskId": "task_10", "status": "OPEN"} and _link("task_10").status == "OPEN"


def test_a_refused_push_is_retried_and_its_error_shown(world):
    world.api_open = {"task_11": _api_task("task_11", "B306 mislocked")}
    world.wh = {"task_11": _wh_task("task_11", "B306 mislocked", people=["Amy Bolanos"])}
    world.sync()
    t = _tasks()["task_11"]
    db = SessionLocal()
    try:
        cubby_tasks.save(db, {"closeInCubby": True}, ADMIN)
        update_task(t.id, TaskUpdate(completed=True), BackgroundTasks(), OWNER_USER, db)
    finally:
        db.close()
    world.write_ok = False
    r = cubby_tasks.push_pending()
    assert r["failed"] == 1 and r["sent"] == 0
    link = _link("task_11")
    assert link.push_status == "COMPLETED" and link.push_attempts == 1 and "boom" in link.push_error
    world.write_ok = True
    assert cubby_tasks.push_pending()["sent"] == 1 and _link("task_11").push_error == ""


def test_a_completion_that_came_from_cubby_is_never_sent_back(world):
    world.api_open = {"task_12": _api_task("task_12", "D013 mislocked")}
    world.wh = {"task_12": _wh_task("task_12", "D013 mislocked", people=["Amy Bolanos"])}
    world.sync()
    db = SessionLocal()
    try:
        cubby_tasks.save(db, {"closeInCubby": True}, ADMIN)
    finally:
        db.close()
    world.api_open = {}
    world.wh["task_12"]["status"] = "COMPLETED"
    world.sync()
    assert _link("task_12").push_status == ""
    assert cubby_tasks.push_pending()["sent"] == 0 and world.writes == []


def test_overview_lists_what_settings_shows(world):
    world.api_open = {"task_13": _api_task("task_13", "Protection Plan Enrollment")}
    world.wh = {"task_13": _wh_task("task_13", "Protection Plan Enrollment", people=["Amy Bolanos"])}
    world.sync()
    db = SessionLocal()
    try:
        o = cubby_tasks.overview(db)
    finally:
        db.close()
    assert o["on"] is True and o["closeInCubby"] is False and o["projects"] == {FAC: "proj_temecula"}
    assert [f["id"] for f in o["facilities"]] == [FAC, "fac_b"]
    assert o["projectOptions"][0]["name"] == "GS Temecula Operations"
    assert o["linked"] == 1 and o["linkedOpen"] == 1 and o["pending"] == 0
    assert o["lastRun"]["created"] == 1 and o["warehouseConfigured"] is True
    db = SessionLocal()
    try:
        info = cubby_tasks.link_for_task(db, _tasks()["task_13"].id)
    finally:
        db.close()
    assert info["facilityName"] == "Greens Storage Temecula" and info["unitName"] == "A014"
    assert info["assignedNames"] == ["Amy Bolanos"] and info["automated"] is False
    assert info["url"] == "https://app.cubbystorage.com/tasks/all"   # Find in Cubby: no deep link exists


# ── Notes, and what Cubby did is Cubby's (Sagar, 11/03/2026) ─────────────────

def test_a_note_typed_in_cubby_becomes_a_comment_once(world):
    world.api_open = {"task_20": _api_task("task_20", "Sample Task for Nexus Test")}
    world.wh = {"task_20": _wh_task("task_20", "Sample Task for Nexus Test", people=["Amy Bolanos"])}
    world.notes = [_note("501", "task_20", "Adding a note from Cubby", at="2026-11-01T08:00:00"),
                   _note("502", "task_other", "On some other task")]
    s = world.sync()
    t = _tasks()["task_20"]
    assert s["notes"] == 1
    assert _comments(t.id) == [(cubby_tasks.CUBBY_ACTOR, "[Cubby · Sagar Shoundik · 2026-11-01]\nAdding a note from Cubby")]
    assert _link("task_20").note_ids == ["501"]
    # The backfill (older than the link) told nobody; a note typed after the
    # link exists bells the task's people like any comment.
    assert "New Comment on a Task" not in _bells(AMY)
    world.notes.append(_note("503", "task_20", "Tenant called back", at="2099-01-01T00:00:00"))
    s = world.sync()
    assert s["notes"] == 1 and len(_comments(t.id)) == 2
    assert "New Comment on a Task" in _bells(AMY)
    # Again: nothing twice.
    assert world.sync()["notes"] == 0 and len(_comments(t.id)) == 2 and _link("task_20").note_ids == ["501", "503"]


def test_a_notes_problem_costs_nothing_else(world, monkeypatch):
    def boom(since):
        raise cubby_warehouse.WarehouseError("BigQuery did not answer (NotFound): manager_notes")
    monkeypatch.setattr(cubby_warehouse, "note_rows", boom)
    world.api_open = {"task_21": _api_task("task_21", "Sweep aisle B")}
    world.wh = {"task_21": _wh_task("task_21", "Sweep aisle B", people=["Amy Bolanos"])}
    s = world.sync()
    assert s["status"] == "ok" and s["created"] == 1 and s["notes"] == 0
    assert s["warehouse"] == "ok" and "manager_notes" in s["notesWarehouse"]
    assert task_assignees(_tasks()["task_21"]) == [AMY]


def test_the_owner_is_not_a_collaborator_and_the_date_is_cubbys(world):
    world.api_open = {"task_22": _api_task("task_22", "Test task from Cubby", due="2026-11-07")}
    world.wh = {"task_22": _wh_task("task_22", "Test task from Cubby", people=["Amy Bolanos"])}
    world.sync()
    t = _tasks()["task_22"]
    assert OWNER not in [e.lower() for e in (t.follower_emails or [])]
    assert t.due_history[-1]["by"] == cubby_tasks.CUBBY_ACTOR and t.due_history[-1]["source"] == "cubby"
    # Cubby moves the date: still Cubby's move, never the owner's.
    world.api_open["task_22"] = _api_task("task_22", "Test task from Cubby", due="2026-11-06", updated="2026-11-03T13:54:00Z")
    world.sync()
    t = _tasks()["task_22"]
    assert t.due_on == "2026-11-06" and len(t.due_history) == 2
    assert t.due_history[-1] == {**t.due_history[-1], "from": "2026-11-07", "to": "2026-11-06",
                                 "by": cubby_tasks.CUBBY_ACTOR, "source": "cubby"} and "undo" not in t.due_history[-1]
    # Cubby reassigns: the owner is still not subscribed by it...
    world.wh["task_22"]["assigned_managers"] = ["Sagar Shoundik"]
    world.sync()
    assert OWNER not in [e.lower() for e in (_tasks()["task_22"].follower_emails or [])]
    # ...but an owner who chose to follow in Nexus stays.
    db = SessionLocal()
    try:
        update_task(t.id, TaskUpdate(follower_emails=[OWNER]), BackgroundTasks(), OWNER_USER, db)
    finally:
        db.close()
    world.wh["task_22"]["assigned_managers"] = ["Amy Bolanos"]
    world.sync()
    assert OWNER in [e.lower() for e in (_tasks()["task_22"].follower_emails or [])]


# ── The warehouse query (prod, 11/03-11/05/2026) ─────────────────────────────
# BigQuery's tables differ from the Postgres mirror, and each guessed column
# only uncovered the next gap. The queries are built from the table's REAL
# columns and types (cubby_warehouse._columns).

def _warehouse_with(monkeypatch, tables: dict, rows: dict):
    """A configured warehouse whose tables have `tables[name] = {col: type}`;
    `_run` answers rows[name] and records each SQL."""
    monkeypatch.setenv("CUBBY_BQ_CREDENTIALS_JSON", '{"type": "service_account"}')
    monkeypatch.setattr(cubby_warehouse, "_columns_cache", {})
    monkeypatch.setattr(cubby_warehouse, "_missing", {})
    monkeypatch.setattr(cubby_warehouse, "_columns", lambda table: tables[table.rsplit(".", 1)[-1]])
    asked = []

    def run(sql, params):
        asked.append(sql)
        table = sql.split("FROM `", 1)[1].split("`", 1)[0].rsplit(".", 1)[-1]
        return rows.get(table, [])
    monkeypatch.setattr(cubby_warehouse, "_run", run)
    return asked


PROD_LIKE_TASKS = {"task_id": "STRING", "facility_id": "STRING", "status": "STRING", "title": "STRING",
                   "assignee": "STRING", "created_at": "DATETIME", "completed_at": "DATETIME"}   # no archived_at, no schedule


def test_tasks_are_read_with_only_the_columns_the_table_has(monkeypatch):
    asked = _warehouse_with(monkeypatch, {"tasks": PROD_LIKE_TASKS}, {"tasks": [
        {"task_id": "task_x", "status": "OPEN", "title": "Lock check", "assignee": ["user_TZnGWYd2Ndm"],
         "created_at": "2026-11-06T05:21:00", "completed_at": None}]})
    rows = cubby_warehouse.task_rows(None)
    sql = asked[0]
    assert "archived_at" not in sql and "schedule" not in sql
    assert "created_at >= DATETIME(@since)" in sql and "completed_at >= DATETIME(@since)" in sql
    assert rows[0]["assignee_ids"] == ["user_TZnGWYd2Ndm"] and rows[0]["task_title"] == "Lock check"
    assert rows[0]["updated_at"] == "2026-11-06T05:21:00"
    assert "tasks has no" in cubby_warehouse.missing_note() and "archived_at" in cubby_warehouse.missing_note()


def test_a_tasks_table_without_an_assignee_column_says_so(monkeypatch):
    _warehouse_with(monkeypatch, {"tasks": {"task_id": "STRING", "status": "STRING", "created_at": "DATETIME"}}, {})
    with pytest.raises(cubby_warehouse.WarehouseError) as e:
        cubby_warehouse.task_rows(None)
    assert "no assignee column" in str(e.value) and "task_id" in str(e.value)


def test_the_window_compares_in_the_columns_own_type():
    w = cubby_warehouse._window
    assert w("updated_at", "TIMESTAMP") == "updated_at >= @since"
    assert w("created_at", "DATETIME") == "created_at >= DATETIME(@since)"
    assert w("due", "DATE") == "due >= DATE(@since)"
    assert w("created_at", "STRING") == "SAFE_CAST(created_at AS TIMESTAMP) >= @since"


def test_staff_are_read_whatever_the_name_and_email_columns_are_called(monkeypatch):
    asked = _warehouse_with(monkeypatch, {"managers": {"manager_id": "STRING", "name": "STRING", "email": "STRING"}},
                            {"managers": [{"manager_name": "Sagar Shoundik", "manager_email": "sagar@x.com"}]})
    assert cubby_warehouse.manager_rows() == [{"manager_name": "Sagar Shoundik", "manager_email": "sagar@x.com"}]
    assert "name AS manager_name" in asked[0] and "email AS manager_email" in asked[0]


def test_a_staff_table_with_no_email_says_so(monkeypatch):
    _warehouse_with(monkeypatch, {"managers": {"manager_id": "STRING", "manager_name": "STRING"}}, {})
    with pytest.raises(cubby_warehouse.WarehouseError) as e:
        cubby_warehouse.manager_rows()
    assert "no email column" in str(e.value)


def test_notes_window_uses_the_real_type(monkeypatch):
    asked = _warehouse_with(monkeypatch, {"manager_notes": {"manager_note_id_int": "INTEGER", "task_id": "STRING",
                                                            "message": "STRING", "manager_name": "STRING",
                                                            "created_at": "TIMESTAMP"}}, {})
    cubby_warehouse.note_rows(None)
    assert "created_at >= @since" in asked[0] and "manager_id" not in asked[0]


def test_any_other_warehouse_error_still_raises(monkeypatch):
    _warehouse_with(monkeypatch, {"tasks": PROD_LIKE_TASKS}, {})

    def run(sql, params):
        raise cubby_warehouse.WarehouseError("BigQuery did not answer (Forbidden)")

    monkeypatch.setattr(cubby_warehouse, "_run", run)
    with pytest.raises(cubby_warehouse.WarehouseError):
        cubby_warehouse.task_rows(None)


def test_the_sync_key_writes_when_no_manager_key_is_set(monkeypatch):
    """Sagar, 11/05/2026: our CUBBY_API_KEY carries every role, so Close Tasks
    in Cubby uses it when CUBBY_MANAGER_API_KEY is not set; a Manager key wins."""
    monkeypatch.delenv(ops_cubby_push.WRITE_KEY_ENV, raising=False)
    monkeypatch.delenv("CUBBY_API_KEY", raising=False)
    assert ops_cubby_push.write_configured() is False
    monkeypatch.setenv("CUBBY_API_KEY", "sync-key")
    assert ops_cubby_push.write_configured() is True and ops_cubby_push._write_key() == "sync-key"
    monkeypatch.setenv(ops_cubby_push.WRITE_KEY_ENV, "manager-key")
    assert ops_cubby_push._write_key() == "manager-key"


def test_columns_fall_back_to_a_dry_run_without_metadata_permission(monkeypatch):
    """No bigquery.tables.get: the column list comes from a free dry run."""
    import sys
    import types
    monkeypatch.setattr(cubby_warehouse, "_columns_cache", {})
    seen = {}

    class Field:
        def __init__(self, name, kind):
            self.name, self.field_type = name, kind

    class Client:
        def get_table(self, table):
            raise PermissionError("Forbidden: bigquery.tables.get")

        def query(self, sql, job_config=None):
            seen["sql"], seen["dry"] = sql, job_config.dry_run
            return types.SimpleNamespace(schema=[Field("task_id", "STRING"), Field("created_at", "DATETIME")])

    fake_bq = types.SimpleNamespace(QueryJobConfig=lambda **kw: types.SimpleNamespace(**kw))
    monkeypatch.setitem(sys.modules, "google.cloud.bigquery", fake_bq)
    monkeypatch.setattr(cubby_warehouse, "_client", lambda: Client())
    cols = cubby_warehouse._columns(cubby_warehouse.TASKS_TABLE)
    assert cols == {"task_id": "STRING", "created_at": "DATETIME"}
    assert seen["dry"] is True and seen["sql"].startswith("SELECT * FROM `cubby-partner-data.analytics.tasks`")



# ── End to end against a prod-shaped BigQuery (11/05/2026) ───────────────────
# Prod answered, one guess at a time: no updated_at; a DATETIME compared with
# a TIMESTAMP; no task_title. This fake BigQuery refuses exactly those things
# the way BigQuery does, and the REAL readers (cubby_warehouse) run against it.
import re  # noqa: E402

PROD_SCHEMA = {
    # Cubby's published BigQuery schema, column for column
    # (https://cubbystorage.github.io/docs/data-dictionary/schema.csv, read
    # 11/06/2026). ARRAY<STRING> is written STRING here; the fake treats both
    # alike. Earlier versions of this test were built from guesses and passed
    # while prod failed - this one is Cubby's own description.
    "tasks": {"archived_at": "DATETIME", "assignee": "STRING", "completed_at": "DATETIME", "contact_id": "STRING", "created_at": "DATETIME", "description": "STRING", "due_date": "DATETIME", "facility_id": "STRING", "manager_created_by": "STRING", "org_id": "STRING", "schedule": "STRING", "status": "STRING", "task_id": "STRING", "title": "STRING", "unit_id": "STRING", "workflow_name": "STRING", "workflow_run_id": "INT64"},
    "managers": {"manager_email": "STRING", "manager_id": "STRING", "manager_name": "STRING", "manager_permissions": "INT64", "manager_persona": "STRING", "manager_phone": "STRING", "manager_status": "STRING", "manager_username": "STRING", "org_id": "STRING"},
    "manager_notes": {"contact_name": "STRING", "created_at": "DATETIME", "facility_name": "STRING", "manager_name": "STRING", "note": "STRING", "org_id": "STRING", "unit_name": "STRING", "updated_at": "DATETIME"},
}
_SQL_WORDS = {"select", "from", "where", "or", "and", "is", "not", "null", "true", "as", "order", "by", "desc",
              "limit", "open", "datetime", "date", "safe_cast", "timestamp", "since"}


class StrictBigQuery:
    """Refuses an unknown column ("Unrecognized name") and a DATETIME/DATE
    column compared with the TIMESTAMP parameter ("No matching signature"),
    as prod's BigQuery did."""

    def __init__(self, rows):
        self.rows, self.asked = rows, []

    def get_table(self, table):
        name = table.rsplit(".", 1)[-1]
        Field = type("Field", (), {})
        out = []
        for col, kind in PROD_SCHEMA[name].items():
            f = Field()
            f.name, f.field_type = col, kind
            out.append(f)
        return type("Table", (), {"schema": out})()

    def query(self, sql, job_config=None):
        self.asked.append(sql)
        table = sql.split("FROM `", 1)[1].split("`", 1)[0].rsplit(".", 1)[-1]
        schema = PROD_SCHEMA[table]
        body = sql.split("`", 2)[2]                       # after the table name
        select = sql[len("SELECT "):sql.index(" FROM ")]
        aliases = {}
        for part in select.split(","):
            bits = part.split()
            aliases[bits[-1]] = bits[0]
        idents = set(aliases.values()) | {w for w in re.findall(r"[a-z_]+", re.sub(r"'[^']*'", "", body))
                                         if w not in _SQL_WORDS}
        for w in sorted(idents):
            if w not in schema:
                raise RuntimeError(f"Unrecognized name: {w}")
        for col in re.findall(r"(?<![(\w])([a-z_]+) >= @since", body):
            if schema[col] != "TIMESTAMP":
                raise RuntimeError(f"No matching signature for operator >= for argument types: {schema[col]}, TIMESTAMP")
        rows = [{alias: r.get(src) for alias, src in aliases.items()} for r in self.rows.get(table, [])]
        return type("Job", (), {"result": lambda _self, timeout=None: rows})()


def test_prod_shaped_warehouse_assigns_the_task_end_to_end(world, monkeypatch):
    """Prod, 11/06/2026: "Assignee Test Task" on 04 - GS Escondido, assigned in
    Cubby to Sagar Shoundik, came in unassigned. Cubby's BigQuery keeps the
    assignee as manager IDs in `tasks.assignee`; the run must read it, match
    the ID to Sagar's work email and assign him."""
    # 1. Linked while the warehouse could not be read: nobody assigned.
    world.api_open = {"task_aTest": _api_task("task_aTest", "Assignee Test Task")}
    monkeypatch.setattr(cubby_warehouse, "task_rows",
                        lambda since: (_ for _ in ()).throw(cubby_warehouse.WarehouseError("Unrecognized name: task_title")))
    world.sync()
    assert task_assignees(_tasks()["task_aTest"]) == []
    # 2. The REAL readers against a BigQuery with Cubby's published columns.
    bq = StrictBigQuery({
        "tasks": [{"task_id": "task_aTest", "facility_id": FAC, "status": "OPEN", "title": "Assignee Test Task",
                   "assignee": ["m2"], "manager_created_by": "m2", "unit_id": "u1",
                   "created_at": "2026-11-06 05:21:00", "due_date": "2026-11-10 00:00:00"}],
        "managers": [{"manager_id": "m1", "manager_name": "Amy Bolanos", "manager_email": AMY},
                     {"manager_id": "m2", "manager_name": "Sagar Shoundik", "manager_email": SAGAR},
                     # a second "Sagar Shoundik" with another email must not be the one matched
                     {"manager_id": "m9", "manager_name": "Sagar Shoundik", "manager_email": "other@x.com"}],
        "manager_notes": [],
    })
    monkeypatch.setattr(cubby_warehouse, "_client", lambda: bq)
    monkeypatch.setattr(cubby_warehouse, "_columns_cache", {})
    monkeypatch.setattr(cubby_warehouse, "_missing", {})
    monkeypatch.setattr(cubby_warehouse, "task_rows", REAL_TASK_ROWS)
    monkeypatch.setattr(cubby_warehouse, "manager_rows", REAL_MANAGER_ROWS)
    monkeypatch.setattr(cubby_warehouse, "note_rows", REAL_NOTE_ROWS)
    s = world.sync()
    assert s["warehouse"] == "ok" and s["errors"] == [], s
    assert s["reassigned"] == 1 and s["unmatchedPeople"] == {}
    t = _tasks()["task_aTest"]
    assert task_assignees(t) == [SAGAR]
    assert OWNER not in (t.follower_emails or [])          # the project owner is not made a collaborator
    assert s["warehouseGaps"] == ""                          # every column the reader asks for exists
    # Task notes: Cubby's warehouse links notes to tenants only - said plainly.
    assert "tenants only" in s["notesWarehouse"]
    # Every query BigQuery saw was one it accepts (the fake raises otherwise).
    assert any("assignee" in q for q in bq.asked)
    # 3. The next run changes nothing.
    assert world.sync()["reassigned"] == 0


def test_an_assignee_with_no_nexus_account_is_named(world, monkeypatch):
    bq = StrictBigQuery({
        "tasks": [{"task_id": "task_b", "facility_id": FAC, "status": "OPEN", "title": "Lock check",
                   "assignee": ["m7"], "created_at": "2026-11-06 05:00:00"}],
        "managers": [{"manager_id": "m7", "manager_name": "Pat Lee", "manager_email": "pat@nowhere.com"}],
        "manager_notes": [],
    })
    monkeypatch.setattr(cubby_warehouse, "_client", lambda: bq)
    monkeypatch.setattr(cubby_warehouse, "_columns_cache", {})
    monkeypatch.setattr(cubby_warehouse, "_missing", {})
    monkeypatch.setattr(cubby_warehouse, "task_rows", REAL_TASK_ROWS)
    monkeypatch.setattr(cubby_warehouse, "manager_rows", REAL_MANAGER_ROWS)
    world.api_open = {"task_b": _api_task("task_b", "Lock check")}
    s = world.sync()
    assert s["unmatchedPeople"] == {"Pat Lee": 1}             # by name, not "m7"
    assert task_assignees(_tasks()["task_b"]) == []


def test_close_in_cubby_works_with_only_the_sync_key(world, monkeypatch):
    """Sagar, 11/05/2026: no CUBBY_MANAGER_API_KEY on prod - the sync's
    CUBBY_API_KEY (every role) sends the completion."""
    monkeypatch.delenv(ops_cubby_push.WRITE_KEY_ENV, raising=False)
    monkeypatch.setenv("CUBBY_API_KEY", "sync-key")
    sent = []

    def post(url, json=None, headers=None, timeout=None):
        sent.append((url, headers["Authorization"], dict(json)))
        return type("R", (), {"status_code": 200, "json": lambda _s: {"data": {"taskId": json["taskId"]}}})()

    monkeypatch.setattr(ops_cubby_push.httpx, "post", post)
    world.api_open = {"task_20": _api_task("task_20", "Lock check")}
    world.wh = {"task_20": _wh_task("task_20", "Lock check", people=["Amy Bolanos"])}
    world.sync()
    t = _tasks()["task_20"]
    db = SessionLocal()
    try:
        update_task(t.id, TaskUpdate(completed=True), BackgroundTasks(), OWNER_USER, db)
        cubby_tasks.save(db, {"closeInCubby": True}, ADMIN)
    finally:
        db.close()
    assert cubby_tasks.push_pending()["sent"] == 1
    url, auth_header, body = sent[-1]
    assert url.endswith("/tasks/update") and auth_header == "Bearer sync-key"
    assert body == {"taskId": "task_20", "status": "COMPLETED"} and _link("task_20").status == "COMPLETED"
