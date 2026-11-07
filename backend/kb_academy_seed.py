"""Greens Storage Academy: import the content package (kb_seed/academy) into
the Knowledge Base ONCE, as drafts (Neil, 11/04/2026).

Runs on every boot from main.py `_tier_seeds`, guarded by MARK in
nexus_settings. Refuses while kb_academy.problems() finds anything, so a
half-built academy never lands. Everything it writes is a draft - pages
`draft`, courses `draft` with their content in `draft`, the plan inactive
with no rules - for the Operations Manager to review and publish. A
collection, course or plan whose title already exists (a page: inside the
Academy collection) is left untouched, so a second worker adds nothing.
Fields mirror routers/kb.py create_page and routers/kb_training.py
create_course.
"""
import json

from sqlalchemy import func
from sqlalchemy.orm import Session

MARK = "kb.storage_academy_seeded_2026_11"
PATHS_MARK = "kb.learning_paths_seeded_2026_11"
CONTENT_MARK = "kb.academy_content_2026_11_07"
# The Academy plan as the onboarding path (Neil, 11/07/2026): four stages, the
# six courses in order. Index = the course's position in kb_academy.ORDER.
ACADEMY_STAGES = ["Week 1: Nexus and the Business", "Week 2: Storage and Cubby", "Weeks 3 and 4: Serving and Selling", "Sign-Off"]
ACADEMY_STAGE_OF = [0, 0, 1, 1, 2, 3]
COLLECTION = "Greens Storage Academy"
DEPT = "Operations"
FALLBACK_OWNER = "neil@greensglobal.com"


def owner_email(db: Session) -> str:
    """The first active Operations Manager in People, else Neil."""
    from models import NexusEmployee
    emp = (db.query(NexusEmployee)
           .filter(func.lower(func.trim(NexusEmployee.job_title)) == "operations manager",
                   NexusEmployee.status == "active", func.coalesce(NexusEmployee.deleted_at, "") == "",
                   func.coalesce(NexusEmployee.work_email, "") != "")
           .order_by(NexusEmployee.id).first())
    return emp.work_email.lower() if emp else FALLBACK_OWNER


def _collection(db: Session, owner: str, owner_name: str):
    from models import KbCollection
    import kb_core
    found = db.query(KbCollection).filter(KbCollection.name == COLLECTION).first()
    if found:
        return found
    ops = db.query(KbCollection).filter(KbCollection.parent_id == "", KbCollection.department == DEPT).first()
    if ops is None:
        ops = KbCollection(id=kb_core.new_id("col"), name=DEPT, parent_id="", department=DEPT, description="", owner_email="",
                           owner_name="", review_every_months=12, reading_order="[]", sort_order=0, active=True,
                           created_by=owner, created_at=kb_core.now(), updated_at=kb_core.now())
        db.add(ops)
    col = KbCollection(id=kb_core.new_id("col"), name=COLLECTION, parent_id=ops.id, department="",
                       description="Training for new facility hires: Nexus, self-storage, RV and boat storage, Cubby, customer service and sales.",
                       owner_email=owner, owner_name=owner_name, review_every_months=12, reading_order="[]", sort_order=0,
                       active=True, created_by=owner, created_at=kb_core.now(), updated_at=kb_core.now())
    db.add(col)
    return col


def apply_once(db: Session) -> dict | None:
    """Import the academy as drafts and write the mark, in one commit.
    Returns {collection, pages, courses, plan, owner} (pages / courses =
    rows created), or None when already marked or the package has problems."""
    from models import KbCourse, KbDocument, KbTrainingPlan, NexusSetting
    import kb_academy
    import kb_access
    import kb_blocks
    import kb_core
    import kb_media
    from routers.kb_training import _draft_of, _norm_lessons, _norm_quiz

    if db.get(NexusSetting, MARK):
        return None
    a = kb_academy.load(kb_academy.ROOT)
    probs = kb_academy.problems(a)
    if probs:
        print(f"[startup] storage academy not imported: {len(probs)} content problem(s), first: {probs[0]}")
        return None
    owner = owner_email(db)
    owner_name = kb_access.display_name(db, owner)
    col = _collection(db, owner, owner_name)
    db.flush()   # autoflush is off: assign_code reads the collection's department

    page_ids, pages_made = {}, 0
    for p in a.pages.values():
        # pages are matched inside the Academy only, so an unrelated page elsewhere is never linked
        d = db.query(KbDocument).filter(KbDocument.collection_id == col.id, KbDocument.title == p.title[:300]).first()
        if d is None:
            pt = p.page_type if p.page_type in kb_core.PAGE_TYPES else "how_to"
            d = KbDocument(id=kb_core.new_id("kb"), doc_code="", title=p.title[:300],
                           doc_type={"sop": "SOP", "policy": "SOP", "reference": "Guide", "how_to": "Guide"}[pt],
                           departments="", service="", status="draft", owner_email=owner, owner_name=owner_name,
                           reviewer_email="", reviewer_name="", version="0.1", effective_date="", body="{}", review_note="",
                           revision_history="[]", require_ack=(pt == "policy"), views=0, review_every_months=0, verified_at="",
                           verified_by="", stale_notified_at="", retention_months=84,
                           tags=",".join(str(t).strip().lower() for t in p.tags if str(t).strip())[:500], related_ids="",
                           content_text="", created_by=owner, created_at=kb_core.now(), updated_at=kb_core.now(),
                           original_title="", original_content="", page_type=pt, collection_id=col.id,
                           summary=(p.summary or "")[:300], major=0, minor=1, published_at="", audience="",
                           signing="in_page", translations="", migrated_at=kb_core.now())
            kb_core.set_content(d, kb_blocks.sanitize(p.blocks, image_ok=kb_media.is_storage_url))
            kb_core.set_departments(d, [DEPT])
            kb_core.assign_code(db, d)
            db.add(d)
            kb_core.event(db, kind="created", actor=owner, doc_id=d.id, version="0.1", actor_name=owner_name)
            pages_made += 1
        page_ids[p.slug] = d.id
    db.flush()   # _norm_lessons looks the pages up by id

    course_ids, courses_made = [], 0
    for s in a.courses:
        c = db.query(KbCourse).filter(KbCourse.title == s.title[:200]).first()
        if c is None:
            c = KbCourse(id=kb_core.new_id("crs"), course_code="", title=s.title[:200], description=(s.description or "")[:400],
                         overview=json.dumps(s.overview or []), recert_months=0, default_due_days=0, departments=DEPT,
                         status="draft", owner_email=owner, owner_name=owner_name, est_minutes=int(s.est_minutes or 15),
                         lessons="[]", quiz=json.dumps({"passPct": 80, "drawCount": 0, "maxTries": 3, "shuffle": True, "questions": []}),
                         created_at=kb_core.now(), updated_at=kb_core.now(), major=0, draft="", published_at="", published_by="")
            kb_core.assign_course_code(db, c)
            if s.delivery in ("online", "in_person"):
                c.delivery = s.delivery
            c.level, c.tags = s.level or "", s.tags or ""
            draft = _draft_of(c)
            lessons = [{**L, "docId": page_ids[L["page"]]} if L["type"] == "page" else L for L in s.lessons]
            draft["lessons"] = _norm_lessons(db, lessons)
            draft["quiz"] = _norm_quiz(s.quiz)
            c.draft = json.dumps(draft)
            db.add(c)
            kb_core.event(db, kind="course_created", actor=owner, course_id=c.id, actor_name=owner_name)
            courses_made += 1
        course_ids.append(c.id)

    plan = db.query(KbTrainingPlan).filter(KbTrainingPlan.name == a.plan["name"][:200]).first()
    if plan is None:
        plan = KbTrainingPlan(id=kb_core.new_id("plan"), name=a.plan["name"][:200], description=(a.plan.get("description") or "")[:500],
                              items=json.dumps([{"kind": "course", "id": i, "stage": ACADEMY_STAGE_OF[n] if n < len(ACADEMY_STAGE_OF) else -1} for n, i in enumerate(course_ids)]),
                              due_days=30, due_date="", audience="", active=False, created_by=owner, created_at=kb_core.now(), updated_at=kb_core.now(),
                              kind="onboarding", stages=json.dumps(ACADEMY_STAGES), open_enrollment=True)
        db.add(plan)
    now = kb_core.now()
    db.add(NexusSetting(key=MARK, value=now, updated_by="startup", updated_at=now))
    db.commit()
    return {"collection": col.id, "pages": pages_made, "courses": courses_made, "plan": plan.id, "owner": owner}


def apply_paths_once(db: Session) -> dict | None:
    """Learning paths (Neil, 11/07/2026), once: the Academy plan a first run
    already made becomes the onboarding path (kind, four stages, each course
    in its stage) and each Academy course gets its level and tags from the
    package - only where nothing was set by hand. Returns {plan, courses}
    (the plan id touched or '', courses stamped), or None once marked."""
    from models import KbCourse, KbTrainingPlan, NexusSetting
    import kb_academy
    import kb_core

    if db.get(NexusSetting, PATHS_MARK):
        return None
    a = kb_academy.load(kb_academy.ROOT)
    stamped, plan_id = 0, ""
    by_title = {}
    for s in a.courses:
        c = db.query(KbCourse).filter(KbCourse.title == s.title[:200]).first()
        if c is None:
            continue
        by_title[s.slug] = c
        if not (c.level or "") and not (c.tags or ""):
            c.level, c.tags = s.level or "", s.tags or ""
            stamped += 1
    plan = db.query(KbTrainingPlan).filter(KbTrainingPlan.name == (a.plan.get("name") or "")[:200]).first() if a.plan else None
    if plan is not None and (plan.kind or "custom") == "custom" and not (plan.stages or ""):
        plan.kind = "onboarding"
        plan.stages = json.dumps(ACADEMY_STAGES)
        ids = [by_title[slug].id for slug in kb_academy.ORDER if slug in by_title]
        try:
            items = json.loads(plan.items or "[]")
        except ValueError:
            items = []
        for it in items:
            if isinstance(it, dict) and it.get("id") in ids:
                it["stage"] = ACADEMY_STAGE_OF[ids.index(it["id"])]
        plan.items = json.dumps(items)
        plan.updated_at = kb_core.now()
        plan_id = plan.id
    now = kb_core.now()
    db.add(NexusSetting(key=PATHS_MARK, value=now, updated_by="startup", updated_at=now))
    db.commit()
    return {"plan": plan_id, "courses": stamped}


def _without_figures(blocks: dict) -> dict:
    return {"type": "doc", "content": [b for b in (blocks or {}).get("content") or [] if b.get("type") != "figure"]}


def _no_qids(lessons: list) -> list:
    return [{**L, "questions": [{k: v for k, v in q.items() if k != "_id"} for q in L.get("questions") or []]} if L.get("type") == "checkpoint" else L
            for L in lessons]


def _untouched(c) -> bool:
    """A course nobody has saved since a first run imported it: every save,
    publish and import stamps updated_at; the first run stamps it in the
    same transaction as created_at (two now() calls, microseconds apart),
    so a gap under a minute means nobody has touched it since."""
    from datetime import datetime, timezone
    if c.major or not c.created_at or not c.updated_at:
        return False

    def _t(v: str):
        d = datetime.fromisoformat(v)
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    try:
        gap = _t(c.updated_at) - _t(c.created_at)
    except (TypeError, ValueError):
        return False
    return abs(gap.total_seconds()) < 60


def apply_content_once(db: Session) -> dict | None:
    """The package's lessons (Neil, 11/07/2026: figures, drawings, the
    facility lesson, the deeper lock and space sections), once. A course a
    first run imported and NOBODY saved since (`_untouched`) takes the
    package's lessons and quiz whole - new lessons included - the way a
    first run would import them today. In a course somebody did save, a
    lesson is replaced only when its blocks equal the package's blocks with
    the figures taken out (figures into an untouched lesson); an edited
    lesson is left exactly as it is. Everything lands in the course's DRAFT
    - a never-published course edits its draft, a published one gets a
    draft it did not have (the author sees "unpublished edits" and
    publishes) - never in a live version. Returns {courses, lessons}
    touched, or None once marked."""
    from models import KbCollection, KbCourse, KbDocument, NexusSetting
    import kb_academy
    import kb_core
    from routers.kb_training import _draft_of, _norm_lessons, _norm_quiz

    if db.get(NexusSetting, CONTENT_MARK):
        return None
    a = kb_academy.load(kb_academy.ROOT)
    if kb_academy.problems(a):
        return None
    courses_touched, lessons_touched = 0, 0
    col = db.query(KbCollection).filter(KbCollection.name == COLLECTION).first()
    page_ids = {}
    if col is not None:
        for p in a.pages.values():
            d = db.query(KbDocument).filter(KbDocument.collection_id == col.id, KbDocument.title == p.title[:300]).first()
            if d is not None:
                page_ids[p.slug] = d.id
    for spec in a.courses:
        c = db.query(KbCourse).filter(KbCourse.title == spec.title[:200]).first()
        if c is None:
            continue
        draft = _draft_of(c)
        changed = False
        if _untouched(c) and all(L["type"] != "page" or L["page"] in page_ids for L in spec.lessons):
            lessons = [{**L, "docId": page_ids[L["page"]]} if L["type"] == "page" else L for L in spec.lessons]
            new_lessons = _norm_lessons(db, lessons)
            if _no_qids(new_lessons) != _no_qids(draft.get("lessons") or []):   # question ids are minted per normalize
                draft["lessons"] = new_lessons
                draft["quiz"] = _norm_quiz(spec.quiz)
                draft["description"], draft["overview"] = (spec.description or "")[:400], spec.overview or []
                draft["est_minutes"] = int(spec.est_minutes or draft.get("est_minutes") or 15)
                lessons_touched += sum(1 for L in new_lessons if L["type"] == "text")
                changed = True
        else:
            pkg = {L["title"]: L["blocks"] for L in spec.lessons if L["type"] == "text"}
            for L in draft.get("lessons") or []:
                if L.get("type") != "text" or L.get("title") not in pkg:
                    continue
                new = pkg[L["title"]]
                if not any(b.get("type") == "figure" for b in new.get("content") or []):
                    continue
                if _without_figures(L.get("blocks") or {}) == _without_figures(new):
                    L["blocks"] = new
                    lessons_touched += 1
                    changed = True
        if changed:
            c.draft = json.dumps(draft)
            c.est_minutes = int(draft.get("est_minutes") or c.est_minutes or 15)
            c.updated_at = kb_core.now()
            courses_touched += 1
    now = kb_core.now()
    db.add(NexusSetting(key=CONTENT_MARK, value=now, updated_by="startup", updated_at=now))
    db.commit()
    return {"courses": courses_touched, "lessons": lessons_touched}
