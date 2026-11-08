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
from kb_academy_testpkg import _pkg, _q  # noqa: E402  the same minimal package the content test validates

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
    assert [(i["kind"], ids[i["id"]]) for i in json.loads(plan.items)] == [("course", s.title) for s in a.courses if s.slug in a.plan["courses"]]   # the plan's six, not the manager course
    assert db.get(models.NexusSetting, kb_academy_seed.MARK)
    # Learning paths (11/07/2026): the plan is the onboarding path with its
    # stages, each course in one; courses carry the package's level and tags.
    assert plan.kind == "onboarding" and json.loads(plan.stages) == kb_academy_seed.ACADEMY_STAGES
    assert [i["stage"] for i in json.loads(plan.items)] == kb_academy_seed.ACADEMY_STAGE_OF
    assert all(c.level == "foundations" and c.tags == "storage, new hire" for c in courses.values())


def test_paths_pass_upgrades_a_plan_a_first_run_made_before_paths(_package):
    db = _package
    res = kb_academy_seed.apply_once(db)
    plan = db.get(models.KbTrainingPlan, res["plan"])
    # as the plan and the courses stood before 11/07/2026
    plan.kind, plan.stages = "custom", ""
    plan.items = json.dumps([{"kind": i["kind"], "id": i["id"]} for i in json.loads(plan.items)])
    for c in db.query(models.KbCourse).all():
        c.level, c.tags = "", ""
    db.commit()
    out = kb_academy_seed.apply_paths_once(db)
    assert out == {"plan": plan.id, "courses": len(kb_academy.ORDER)}
    db.expire_all()
    plan = db.get(models.KbTrainingPlan, plan.id)
    assert plan.kind == "onboarding" and json.loads(plan.stages) == kb_academy_seed.ACADEMY_STAGES
    assert [i["stage"] for i in json.loads(plan.items)] == kb_academy_seed.ACADEMY_STAGE_OF
    assert all(c.level == "foundations" for c in db.query(models.KbCourse).all())
    assert kb_academy_seed.apply_paths_once(db) is None   # marked: never again


def test_paths_pass_leaves_hand_set_values_alone(_package):
    db = _package
    res = kb_academy_seed.apply_once(db)
    plan = db.get(models.KbTrainingPlan, res["plan"])
    plan.kind, plan.stages = "role", json.dumps(["Mine"])
    for c in db.query(models.KbCourse).all():
        c.level, c.tags = "", ""
    c = db.query(models.KbCourse).first()
    c.level, c.tags = "advanced", "mine"
    db.commit()
    out = kb_academy_seed.apply_paths_once(db)
    assert out["plan"] == "" and out["courses"] == len(kb_academy.ORDER) - 1
    db.expire_all()
    assert db.get(models.KbTrainingPlan, plan.id).kind == "role"
    assert db.get(models.KbCourse, c.id).level == "advanced"


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


def test_content_pass_refreshes_untouched_courses_and_figures_in_touched_ones(_package, tmp_path):
    db = _package
    kb_academy_seed.apply_once(db)   # the package as imported: no figures, one text lesson per course
    import kb_academy
    # the package grows: a figure in every first lesson, and a brand-new lesson in the first course
    for f in kb_academy.ROOT.glob("courses/*/lessons/01.md"):
        f.write_text(f.read_text() + '\n```figure\n{"kind": "steps", "title": "Flow", "items": [{"label": "One"}]}\n```\n', encoding="utf-8")
    first = sorted(kb_academy.ROOT.glob("courses/*"))[0]
    (first / "lessons" / "01a.md").write_text("---\ntitle: The Facility\nsummary: What a site is made of.\n---\n\nA fence, a gate, an office.\n", encoding="utf-8")
    cfg = json.loads((first / "course.json").read_text())
    cfg["lessons"].insert(1, {"file": "01a.md"})
    cfg["teaches"] = "Workday, Time Clock"   # Keeps Up: the tag reaches the imported course too
    (first / "course.json").write_text(json.dumps(cfg), encoding="utf-8")
    courses = {c.title: c for c in db.query(models.KbCourse).all()}
    # one course's lesson was saved by hand since the import (updated_at moves, like every save route)
    edited = db.get(models.KbCourse, courses["Hands On Check"].id)
    d = json.loads(edited.draft)
    d["lessons"][0]["blocks"]["content"].append({"type": "paragraph", "content": [{"type": "text", "text": "Edited by hand."}]})
    edited.draft, edited.updated_at = json.dumps(d), "2026-11-07T10:00:00"
    # another course was saved by hand without changing the seeded lesson: it keeps its lessons but still gets the figure
    saved = db.get(models.KbCourse, courses["Cubby Fundamentals"].id)
    saved.updated_at = "2026-11-07T10:00:00"
    db.commit()
    out = kb_academy_seed.apply_content_once(db)
    n = len(kb_academy.ORDER)
    assert out == {"pages": 0, "courses": n - 1, "lessons": n}   # every untouched course whole (one of them now two lessons), one figure into the saved course
    db.expire_all()
    for title, c in courses.items():
        d = json.loads(db.get(models.KbCourse, c.id).draft)
        has = any(b.get("type") == "figure" for b in d["lessons"][0]["blocks"]["content"])
        assert has == (title != "Hands On Check"), title
    d = json.loads(db.get(models.KbCourse, courses["Nexus Fundamentals"].id).draft)
    assert [L["title"] for L in d["lessons"]][:2] == [d["lessons"][0]["title"], "The Facility"]   # the new lesson landed, in place
    assert d["lessons"][1]["_id"] == "l_nexus-fundamentals_02"
    assert db.get(models.KbCourse, courses["Nexus Fundamentals"].id).teaches == "Workday, Time Clock"
    assert kb_academy_seed.apply_content_once(db) is None   # the package did not change
    # the package grows a course (the code's ORDER grows with it): the pass imports it as a draft
    import kb_academy as ka
    extra = kb_academy.ROOT / "courses" / "99-extra-course"   # sorts after every package course, so the slugs stay in ORDER
    (extra / "lessons").mkdir(parents=True)
    (extra / "lessons" / "01.md").write_text("---\ntitle: Extra Lesson\nsummary: s\n---\n\n## Hi\n\nMore words here.\n", encoding="utf-8")
    (extra / "course.json").write_text(json.dumps({"slug": "extra-course", "title": "Extra Course", "description": "d", "overview": ["o"], "est_minutes": 30,
                                                   "delivery": "online", "level": "core", "tags": "x", "min_reading_minutes": 0,
                                                   "lessons": [{"file": "01.md"}], "quiz": {"passPct": 80, "drawCount": 25, "maxTries": 3, "questions": [_q(i) for i in range(45)]}}), encoding="utf-8")
    monkeypatch_order = list(ka.ORDER) + ["extra-course"]
    ka.ORDER, saved = monkeypatch_order, ka.ORDER
    ka.MIN_READING["extra-course"] = 0
    try:
        out = kb_academy_seed.apply_content_once(db)
    finally:
        ka.ORDER = saved
    assert out == {"pages": 0, "courses": 1, "lessons": 0}
    made = db.query(models.KbCourse).filter(models.KbCourse.title == "Extra Course").one()
    assert made.status == "draft" and json.loads(made.draft)["lessons"][0]["title"] == "Extra Lesson"
    assert made.id not in [i["id"] for i in json.loads(db.query(models.KbTrainingPlan).one().items)]   # not in the plan: not added to it
