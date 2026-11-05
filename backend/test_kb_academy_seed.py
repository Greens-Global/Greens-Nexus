"""Storage Academy importer: drafts only, once. ONE FILE PER PROCESS."""
import json
import os
import tempfile

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_RATE_LIMIT", "off")

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

import database  # noqa: E402
import kb_academy  # noqa: E402
import kb_academy_seed  # noqa: E402
import kb_access  # noqa: E402
import models  # noqa: E402
from kb_academy_testpkg import _pkg  # noqa: E402  the same minimal package the content test validates

ROWS = (models.KbCollection, models.KbDocument, models.KbCourse, models.KbTrainingPlan, models.NexusSetting, models.NexusEmployee)


@pytest.fixture(autouse=True)
def _package(tmp_path, monkeypatch):
    assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
    models.Base.metadata.create_all(bind=database.engine)
    db = database.SessionLocal()
    for m in ROWS:
        db.query(m).delete()
    db.commit()
    monkeypatch.setattr(kb_academy, "MIN_READING", dict.fromkeys(kb_academy.ORDER, 0))
    root = _pkg(tmp_path)
    for f in root.glob("courses/*/course.json"):  # distinct titles: the importer finds courses by title
        c = json.loads(f.read_text())
        f.write_text(json.dumps(dict(c, title=c["slug"].replace("-", " ").title())))
    monkeypatch.setattr(kb_academy, "ROOT", root)
    yield db
    db.close()


def _counts(db):
    return {m.__tablename__: db.query(m).count() for m in ROWS}


def test_first_run_creates_drafts(_package):
    db = _package
    a = kb_academy.load(kb_academy.ROOT)
    res = kb_academy_seed.apply_once(db)
    assert res and res["pages"] == len(a.pages) and res["courses"] == len(a.courses)
    col = db.get(models.KbCollection, res["collection"])
    assert col.name == "Greens Storage Academy"
    parent = db.get(models.KbCollection, col.parent_id)
    assert parent.department == "Operations" and parent.parent_id == ""
    pages = db.query(models.KbDocument).all()
    assert len(pages) == len(a.pages)
    for p in pages:
        assert (p.status, p.collection_id, p.departments, p.major, p.minor) == ("draft", col.id, "Operations", 0, 1)
        assert p.require_ack == (p.page_type == "policy") and p.doc_code
    courses = {c.title: c for c in db.query(models.KbCourse).all()}
    assert len(courses) == len(a.courses)
    for spec in a.courses:
        c = courses[spec.title]
        assert c.status == "draft" and c.recert_months == 0 and c.departments == "Operations" and c.course_code
        assert len(json.loads(c.draft)["lessons"]) == len(spec.lessons)
    plan = db.get(models.KbTrainingPlan, res["plan"])
    assert plan.active is False and plan.due_days == 30
    ids = {c.id: t for t, c in courses.items()}
    assert [(i["kind"], ids[i["id"]]) for i in json.loads(plan.items)] == [("course", s.title) for s in a.courses]
    assert db.get(models.NexusSetting, kb_academy_seed.MARK)


def test_page_lesson_points_at_the_created_page(_package):
    db = _package
    kb_academy_seed.apply_once(db)
    page = db.query(models.KbDocument).one()
    lesson = json.loads(db.query(models.KbCourse).filter(models.KbCourse.title == "Cubby Fundamentals").one().draft)["lessons"][1]
    assert lesson["type"] == "page" and lesson["docId"] == page.id


def test_second_run_is_a_no_op(_package):
    db = _package
    assert kb_academy_seed.apply_once(db)
    before = _counts(db)
    assert kb_academy_seed.apply_once(db) is None
    assert _counts(db) == before


def test_existing_title_is_not_overwritten(_package):
    db = _package
    db.add(models.KbCourse(id="crs_mine", title="Nexus Fundamentals", description="MARKER", status="published"))
    db.commit()
    kb_academy_seed.apply_once(db)
    rows = db.query(models.KbCourse).filter(models.KbCourse.title == "Nexus Fundamentals").all()
    assert [(r.id, r.description) for r in rows] == [("crs_mine", "MARKER")]


def test_owner_falls_back_to_neil(_package):
    assert kb_academy_seed.owner_email(_package) == "neil@greensglobal.com"


def test_owner_is_operations_manager(_package):
    db = _package
    db.add(models.NexusEmployee(id="e1", first_name="O", last_name="M", work_email="ops.gone@example.com",
                                job_title="Operations Manager", status="offboarded"))
    db.add(models.NexusEmployee(id="e2", first_name="O", last_name="M", work_email="ops@example.com",
                                job_title="  operations manager ", status="active"))
    db.commit()
    assert kb_academy_seed.owner_email(db) == "ops@example.com"
    assert kb_academy_seed.apply_once(db)["owner"] == "ops@example.com"


def test_staff_cannot_see_drafts(_package):
    db = _package
    kb_academy_seed.apply_once(db)
    staff = {"email": "staff@example.com", "level": 1}
    with pytest.raises(HTTPException) as e:
        kb_access.get_page(db, db.query(models.KbDocument).first().id, staff)
    assert e.value.status_code in (403, 404)
    with pytest.raises(HTTPException) as e:
        kb_access.get_course(db, db.query(models.KbCourse).first().id, staff)
    assert e.value.status_code in (403, 404)


def test_refuses_invalid_package(_package, monkeypatch):
    db = _package
    monkeypatch.setattr(kb_academy, "problems", lambda a: ["x"])
    assert kb_academy_seed.apply_once(db) is None
    assert all(n == 0 for n in _counts(db).values())


def test_unrelated_page_with_same_title_is_not_reused(_package):
    db = _package
    db.add(models.KbCollection(id="col_other", name="Other", parent_id="", department="HR"))
    db.add(models.KbDocument(id="kb_other", title="Gate Codes", status="approved", collection_id="col_other"))
    db.commit()
    kb_academy_seed.apply_once(db)
    page = db.query(models.KbDocument).filter(models.KbDocument.id != "kb_other").one()
    assert page.title == "Gate Codes" and page.status == "draft"
    lesson = json.loads(db.query(models.KbCourse).filter(models.KbCourse.title == "Cubby Fundamentals").one().draft)["lessons"][1]
    assert lesson["docId"] == page.id


def test_question_lesson_id_survives_import(_package, tmp_path, monkeypatch):
    db = _package
    (tmp_path / "tagged").mkdir()
    root = _pkg(tmp_path / "tagged", lambda c: c["quiz"]["questions"][0].update(lesson="01.md"))
    for f in root.glob("courses/*/course.json"):
        c = json.loads(f.read_text())
        f.write_text(json.dumps(dict(c, title=c["slug"].replace("-", " ").title())))
    monkeypatch.setattr(kb_academy, "ROOT", root)
    kb_academy_seed.apply_once(db)
    draft = json.loads(db.query(models.KbCourse).filter(models.KbCourse.title == "Nexus Fundamentals").one().draft)
    assert draft["quiz"]["questions"][0]["lessonId"] == draft["lessons"][0]["_id"] == "l_nexus-fundamentals_01"
