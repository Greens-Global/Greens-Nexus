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
          models.NexusNotification)


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
        self.writes = []          # tasks/update bodies sent to Cubby
        self.write_ok = True
        monkeypatch.setattr(cubby_warehouse, "configured", lambda: True)
        monkeypatch.setattr(cubby_warehouse, "task_rows", lambda since: list(self.wh.values()))
        monkeypatch.setattr(cubby_warehouse, "manager_rows", lambda: list(STAFF))
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
