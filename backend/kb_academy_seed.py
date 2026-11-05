"""Greens Storage Academy: import the content package (kb_seed/academy) into
the Knowledge Base ONCE, as drafts (Neil, 11/04/2026).

Runs on every boot from main.py `_tier_seeds`, guarded by MARK in
nexus_settings. Refuses while kb_academy.problems() finds anything, so a
half-built academy never lands. Everything it writes is a draft - pages
`draft`, courses `draft` with their content in `draft`, the plan inactive
with no rules - for the Operations Manager to review and publish. A
collection, page, course or plan whose title already exists is left
untouched (find-or-create by title), so a second worker adds nothing.
Fields mirror routers/kb.py create_page and routers/kb_training.py
create_course.
"""
import json

from sqlalchemy import func
from sqlalchemy.orm import Session

MARK = "kb.storage_academy_seeded_2026_11"
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
    import kb_core
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
        d = db.query(KbDocument).filter(KbDocument.title == p.title[:300]).first()
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
            kb_core.set_content(d, p.blocks)
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
                              items=json.dumps([{"kind": "course", "id": i} for i in course_ids]), due_days=30, due_date="",
                              audience="", active=False, created_by=owner, created_at=kb_core.now(), updated_at=kb_core.now())
        db.add(plan)
    now = kb_core.now()
    db.add(NexusSetting(key=MARK, value=now, updated_by="startup", updated_at=now))
    db.commit()
    return {"collection": col.id, "pages": pages_made, "courses": courses_made, "plan": plan.id, "owner": owner}
