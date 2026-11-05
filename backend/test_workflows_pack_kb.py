"""Workflows - the Knowledge Base pack (11/05/2026): Assign A Training Course.

  * only a course author (a manager, or the Knowledge Base editor grant) may
    use it; a draft course is refused;
  * it assigns the published course with the step's due days (else the
    course's own), bells the person, never assigns twice, never moves an
    existing assignment's date, and skips people outside the owner's wall.

    cd backend && python -m pytest test_workflows_pack_kb.py -q
"""
import os
import tempfile
from datetime import date

import pytest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ["NEXUS_APP_URL"] = "https://nexus.test"

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import kb_access  # noqa: E402
import models  # noqa: E402
from workflows import catalog  # noqa: E402
from workflows.context import RunContext  # noqa: E402

ENTITY = "ent-kbwf"
PRIYA, MAX, OLGA, EVE = ("priya.kbwf@greensglobal.com", "max.kbwf@greensglobal.com",
                         "olga.kbwf@greensglobal.com", "eve.kbwf@greensglobal.com")


@pytest.fixture(scope="module", autouse=True)
def _setup():
    assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
    models.Base.metadata.create_all(bind=database.engine)
    catalog.load_packs()
    s = database.SessionLocal()
    s.add(models.HrEntity(id=ENTITY, name="Greens KB"))
    s.add(models.HrEntity(id="ent-kb-other", name="Other Co"))
    s.add(models.NexusEmployee(id="k-priya", work_email=PRIYA, first_name="Priya", last_name="Shah",
                               manager_email=MAX, company=ENTITY, status="active"))
    s.add(models.NexusEmployee(id="k-max", work_email=MAX, first_name="Max", last_name="Miller",
                               company=ENTITY, status="active"))
    s.add(models.NexusEmployee(id="k-olga", work_email=OLGA, first_name="Olga", last_name="Other",
                               company="ent-kb-other", status="active"))
    s.add(models.NexusEmployee(id="k-eve", work_email=EVE, first_name="Eve", last_name="Staff",
                               company=ENTITY, status="active"))
    s.add(models.NexusRole(email=MAX, role="manager"))
    s.add(models.KbCourse(id="c-safety", title="Site Safety", status="published", default_due_days=14))
    s.add(models.KbCourse(id="c-draft", title="Draft Course", status="draft"))
    s.commit()
    s.close()
    auth._role_cache.clear()
    cache.module_grants.invalidate()
    yield
    database.engine.dispose()
    try:
        os.remove(_tmp_db.name)
    except (FileNotFoundError, PermissionError):
        pass


@pytest.fixture
def db():
    s = database.SessionLocal()
    for m in (models.KbCourseAssignment, models.NexusNotification):
        s.query(m).delete()
    s.commit()
    yield s
    s.rollback()
    s.close()


def _ctx(db, *, run_as=MAX, level=3):
    priya = db.get(models.NexusEmployee, "k-priya")
    wf = models.Workflow(id="wf-kb", name="New Hire Training", owner_email=run_as or "", company_id=ENTITY)
    user = {"email": run_as, "role": "manager" if level >= 3 else "employee", "level": level} if run_as else None
    return RunContext(db=db, workflow=wf, definition={"v": 1, "settings": {}},
                      entity=catalog.ENTITIES["employee"], subject=priya,
                      payload={"subject": {}, "changes": {}, "extra": {}, "actor": MAX},
                      actor=MAX, run_as=user, today=date(2026, 11, 5), company_id=ENTITY)


ACTION = "kb.assign_course"


def test_only_an_author_may_assign_and_only_a_published_course(db):
    act = catalog.ACTIONS[ACTION]
    assert act.allowed(_ctx(db, run_as=EVE, level=1), {"course": "c-safety"}).startswith("The owner needs")
    assert act.allowed(_ctx(db, run_as=None), {"course": "c-safety"}) == "Assigning training needs a person's identity"
    assert act.allowed(_ctx(db), {"course": "c-draft"}) == "Draft Course is not published"
    assert act.allowed(_ctx(db), {"course": "nope"}) == "The course is gone or the owner can no longer see it"
    assert act.allowed(_ctx(db), {"course": "c-safety"}) == ""
    with pytest.raises(PermissionError):
        act.run(_ctx(db, run_as=EVE, level=1), {"course": "c-safety", "to": [{"kind": "self"}]})


def test_plan_says_who_and_when(db):
    line = catalog.ACTIONS[ACTION].plan(_ctx(db), {"course": "c-safety", "to": [{"kind": "self"}]})
    assert line == "Would assign Site Safety to Priya Shah, due in 14 days"


def test_assigns_once_with_due_date_and_a_bell(db):
    act = catalog.ACTIONS[ACTION]
    out = act.run(_ctx(db), {"course": "c-safety", "to": [{"kind": "self"}], "due_days": 7})
    db.commit()
    rows = db.query(models.KbCourseAssignment).all()
    assert len(rows) == 1 and rows[0].user_email == PRIYA and rows[0].source == "workflow"
    assert rows[0].assigned_by == MAX and rows[0].due_date > "2026-01-01"
    assert out["line"] == "Assigned Site Safety to Priya Shah" and out["sent"] == [PRIYA]
    bell = db.query(models.NexusNotification).filter(models.NexusNotification.recipient == PRIYA).one()
    assert bell.title == "Training Assigned"
    kept = rows[0].due_date
    out = act.run(_ctx(db), {"course": "c-safety", "to": [{"kind": "self"}], "due_days": 1})
    db.commit()
    assert db.query(models.KbCourseAssignment).count() == 1
    assert db.query(models.KbCourseAssignment).one().due_date == kept      # never moved
    assert out["line"] == "Nobody new was assigned Site Safety (1 already had it)"


def test_people_outside_the_owners_wall_are_skipped(db, monkeypatch):
    monkeypatch.setattr(kb_access, "scope", lambda user, db: {ENTITY})
    out = catalog.ACTIONS[ACTION].run(_ctx(db), {"course": "c-safety",
                                                 "to": [{"kind": "person", "value": OLGA}, {"kind": "self"}]})
    db.commit()
    assert {r.user_email for r in db.query(models.KbCourseAssignment).all()} <= {PRIYA}
    assert OLGA not in out["sent"]


def test_courses_option_source_lists_published_only(db):
    from workflows.packs import kb
    assert kb._courses(db) == [{"value": "c-safety", "label": "Site Safety"}]
