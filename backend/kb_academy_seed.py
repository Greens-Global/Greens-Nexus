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
import hashlib
from functools import lru_cache
from pathlib import Path
import json

from sqlalchemy import func
from sqlalchemy.orm import Session

MARK = "kb.storage_academy_seeded_2026_11"
PATHS_MARK = "kb.learning_paths_seeded_2026_11"
CONTENT_MARK = "kb.academy_content"   # value = the package digest
FP_PREFIX = "kb.academy_fp:"          # + course id; value = _fp of the draft the importer last wrote
PREV_LESSONS = Path(__file__).parent / "kb_seed" / "academy_prev_lessons.json"
PREV_PREFIX = "kb.academy_prev:"      # + course id; the draft an unfingerprinted course had before the importer replaced it
# The Academy plan as the onboarding path (Neil, 11/07/2026): four stages, the
# six courses in order. Index = the course's position in kb_academy.ORDER.
ACADEMY_STAGES = ["Week 1: Nexus and the Business", "Week 2: Storage and Cubby", "Weeks 3 and 4: Serving and Selling", "Sign-Off"]
ACADEMY_STAGE_OF = [0, 0, 1, 1, 2, 3]
# The package's path order before Cubby moved third (11/08/2026). A path still
# exactly in this order was never reordered by a person, so it may follow the new one.
PREV_PLAN_ORDER = ["nexus-fundamentals", "self-storage-fundamentals", "rv-boat-storage-fundamentals", "cubby-fundamentals",
                   "customer-service-sales-fundamentals", "hands-on-check"]
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


def _page(db: Session, col, p, owner: str, owner_name: str):
    """The Academy page for a package page: found by title inside the
    collection, else created as a draft. Returns (row, 1 if created)."""
    from models import KbDocument
    import kb_blocks
    import kb_core
    import kb_media
    d = db.query(KbDocument).filter(KbDocument.collection_id == col.id, KbDocument.title == p.title[:300]).first()
    if d is not None:
        return d, 0
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
    return d, 1


def _course(db: Session, s, owner: str, owner_name: str, page_ids: dict):
    """The course for a package course: found by title, else created as a
    draft with the package's lessons and quiz. Returns (row, 1 if created)."""
    from models import KbCourse
    import kb_core
    from routers.kb_training import _draft_of, _norm_lessons, _norm_quiz
    c = db.query(KbCourse).filter(KbCourse.title == s.title[:200]).first()
    if c is not None:
        return c, 0
    c = KbCourse(id=kb_core.new_id("crs"), course_code="", title=s.title[:200], description=(s.description or "")[:400],
                 overview=json.dumps(s.overview or []), recert_months=0, default_due_days=0, departments=(s.departments or DEPT)[:200],
                 status="draft", owner_email=owner, owner_name=owner_name, est_minutes=int(s.est_minutes or 15),
                 lessons="[]", quiz=json.dumps({"passPct": 80, "drawCount": 0, "maxTries": 3, "shuffle": True, "questions": []}),
                 created_at=kb_core.now(), updated_at=kb_core.now(), major=0, draft="", published_at="", published_by="")
    kb_core.assign_course_code(db, c)
    if s.delivery in ("online", "in_person"):
        c.delivery = s.delivery
    c.level, c.tags, c.teaches = s.level or "", s.tags or "", s.teaches or ""
    draft = _draft_of(c)
    lessons = [{**L, "docId": page_ids[L["page"]]} if L["type"] == "page" else L for L in s.lessons]
    draft["lessons"] = _norm_lessons(db, lessons)
    draft["quiz"] = _norm_quiz(s.quiz)
    draft["teaches"] = s.teaches or ""
    c.draft = json.dumps(draft)
    db.add(c)
    _stamp(db, c.id, draft)
    kb_core.event(db, kind="course_created", actor=owner, course_id=c.id, actor_name=owner_name)
    return c, 1


def apply_once(db: Session) -> dict | None:
    """Import the academy as drafts and write the mark, in one commit.
    Returns {collection, pages, courses, plan, owner} (pages / courses =
    rows created), or None when already marked or the package has problems."""
    from models import KbTrainingPlan, NexusSetting
    import kb_academy
    import kb_access
    import kb_core

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
        d, made = _page(db, col, p, owner, owner_name)
        pages_made += made
        page_ids[p.slug] = d.id
    db.flush()   # _norm_lessons looks the pages up by id

    by_slug, courses_made = {}, 0
    for s in a.courses:
        c, made = _course(db, s, owner, owner_name, page_ids)
        courses_made += made
        by_slug[s.slug] = c.id
    course_ids = [by_slug[slug] for slug in a.plan.get("courses") or [] if slug in by_slug]   # the plan's courses, in its order

    plan = db.query(KbTrainingPlan).filter(KbTrainingPlan.name == a.plan["name"][:200]).first()
    if plan is None:
        plan = KbTrainingPlan(id=kb_core.new_id("plan"), name=a.plan["name"][:200], description=(a.plan.get("description") or "")[:500],
                              items=json.dumps([{"kind": "course", "id": i, "stage": ACADEMY_STAGE_OF[n] if n < len(ACADEMY_STAGE_OF) else -1} for n, i in enumerate(course_ids)]),
                              due_days=30, due_date="", audience=_plan_audience(a.plan), active=False, created_by=owner, created_at=kb_core.now(), updated_at=kb_core.now(),
                              kind="onboarding", stages=json.dumps(ACADEMY_STAGES), open_enrollment=True)
        db.add(plan)
    now = kb_core.now()
    db.add(NexusSetting(key=MARK, value=now, updated_by="startup", updated_at=now))
    db.commit()
    return {"collection": col.id, "pages": pages_made, "courses": courses_made, "plan": plan.id, "owner": owner}


def _plan_audience(plan: dict) -> str:
    """The Academy path is for Operations (Neil, 11/09/2026: Cubby and site
    work are not for everyone on the team); '' when the package names none."""
    import kb_audience
    a = plan.get("audience") or {}
    return kb_audience.dumps(a) if a else ""


def _sync_plan(db: Session, a, by_slug: dict) -> bool:
    """Move the Academy path to the package's new order ONLY while nobody
    reordered it: its courses are exactly the previous package order
    (PREV_PLAN_ORDER) and its stages are still ACADEMY_STAGES. Never touches
    the audience - kb_daily assigns a path to its whole audience, so the
    package's audience is set only when apply_once creates the (inactive)
    plan. Returns whether it changed."""
    from models import KbTrainingPlan
    import kb_core
    plan = db.query(KbTrainingPlan).filter(KbTrainingPlan.name == (a.plan.get("name") or "")[:200]).first() if a.plan else None
    if plan is None:
        return False
    ids = [by_slug[s] for s in a.plan.get("courses") or [] if s in by_slug]
    prev = [by_slug[s] for s in PREV_PLAN_ORDER if s in by_slug]
    try:
        items = json.loads(plan.items or "[]")
        stages = json.loads(plan.stages or "[]")
    except ValueError:
        return False
    have = [it.get("id") if isinstance(it, dict) and it.get("kind") == "course" else None for it in items]
    if have != prev or stages != ACADEMY_STAGES or prev == ids or sorted(prev) != sorted(ids):
        return False
    plan.items = json.dumps([{"kind": "course", "id": i, "stage": ACADEMY_STAGE_OF[n] if n < len(ACADEMY_STAGE_OF) else -1}
                             for n, i in enumerate(ids)])
    plan.updated_at = kb_core.now()
    return True


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
        ids = [by_title[slug].id for slug in (a.plan.get("courses") or []) if slug in by_title]
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


def _fp(draft: dict) -> str:
    """What the importer writes into a draft: lessons, quiz (drawCount
    included), teaches, description, overview and est_minutes - an author's
    edit to any of them reads as edited. Question ids are left out - they
    are minted per normalize."""
    quiz = dict(draft.get("quiz") or {})
    quiz["questions"] = [{k: v for k, v in q.items() if k != "_id"} for q in quiz.get("questions") or []]
    body = {"lessons": _no_qids(draft.get("lessons") or []), "quiz": quiz, "teaches": draft.get("teaches") or "",
            "description": draft.get("description") or "", "overview": draft.get("overview") or [],
            "est_minutes": int(draft.get("est_minutes") or 0)}
    return hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()


def _stamp(db: Session, course_id: str, draft: dict):
    """Remember what the importer wrote, so the next pass can tell it was not changed since."""
    from models import NexusSetting
    import kb_core
    row = db.get(NexusSetting, FP_PREFIX + course_id)
    if row is None:
        db.add(NexusSetting(key=FP_PREFIX + course_id, value=_fp(draft), updated_by="startup", updated_at=kb_core.now()))
    else:
        row.value, row.updated_at = _fp(draft), kb_core.now()


def _near(a: str, b: str, within: float = 60) -> bool:
    from datetime import datetime, timezone

    def _t(v: str):
        d = datetime.fromisoformat(v)
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    try:
        return abs((_t(a) - _t(b)).total_seconds()) < within
    except (TypeError, ValueError):
        return False


def _untouched(db: Session, c, draft: dict, mark) -> bool:
    """Nobody changed the course since the importer last wrote it. With a
    fingerprint (every course the importer wrote from 11/08/2026 on): the
    draft - or, once published with no draft pending, the live version -
    still equals what it wrote; a publish of that same content keeps it
    untouched. Without one (older rows), the last write was the importer's:
    updated_at within a minute of created_at (the first run) or within two
    seconds of the last content pass (the mark: the pass stamps both in one
    transaction, so a person's save a few seconds later is a person's), and
    never published."""
    from models import NexusSetting
    row = db.get(NexusSetting, FP_PREFIX + c.id)
    if row is not None:
        return _fp(draft) == row.value
    if _matches_previous_package(c.title, draft):   # e.g. published as imported: its text is still the package's
        return True
    if c.major or not c.updated_at:
        return False
    return _near(c.updated_at, c.created_at or "") or (mark is not None and _near(c.updated_at, mark.updated_at or "", within=2))


def _h(v) -> str:
    return hashlib.sha256(json.dumps(v, sort_keys=True).encode()).hexdigest()[:24]


def _qtexts(qs) -> list:
    return [str(q.get("q") or "").strip()[:600] for q in qs or [] if isinstance(q, dict)]


def lesson_sequence(lessons: list) -> list:
    """[type, title, hash] per lesson, in order, of what survives the
    normalizer: text = its blocks with the figures out, checkpoint = its
    questions' words, page = its title (the draft keeps no slug)."""
    out = []
    for L in lessons or []:
        t, title = L.get("type"), str(L.get("title") or "Lesson")[:200]
        body = _without_figures(L.get("blocks") or {}) if t == "text" else _qtexts(L.get("questions")) if t == "checkpoint" else title
        out.append([t, title, _h(body)])
    return out


def quiz_hash(quiz: dict) -> str:
    return _h(_qtexts((quiz or {}).get("questions")))


@lru_cache(maxsize=4)
def _prev_courses(path: str) -> dict:
    """The previous package's courses, read once (keyed by path, so a test's file is its own)."""
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))["courses"]
    except (OSError, ValueError, KeyError):
        return {}


def _matches_previous_package(title: str, draft: dict) -> bool:
    """A course with no fingerprint whose lessons (type, title, content -
    figures left out) and final quiz questions are exactly those of the
    package shipped before 11/08/2026 (kb_seed/academy_prev_lessons.json) -
    nobody rewrote it, even if it was published. Its draft is replaced and
    the old one kept (PREV_PREFIX); the live version is never touched."""
    want = _prev_courses(str(PREV_LESSONS)).get(title)
    if not want or not draft.get("lessons"):
        return False
    return lesson_sequence(draft["lessons"]) == want.get("lessons") and quiz_hash(draft.get("quiz")) == want.get("quiz")


def apply_content_once(db: Session) -> dict | None:
    """The package's content, once per package version (Neil, 11/07/2026:
    figures, drawings, screens, the facility lesson, a seventh course). The
    mark's value is the package digest (kb_academy.digest), so the pass runs
    again whenever the repository's package changes:
    - a page or a course the package has and the database does not is
      created as a draft, the way a first run makes it (a new course named
      in the Academy plan is added to the plan's items at its stage);
    - a course a first run imported and NOBODY saved since (`_untouched`)
      takes the package's lessons and quiz whole, new lessons included;
    - in a course somebody did save, a lesson is replaced only when its
      blocks equal the package's blocks with the figures taken out (figures
      into an untouched lesson); an edited lesson is left exactly as it is.
    Everything lands in drafts - never in a live version. Returns
    {pages, courses, lessons} made or touched, or None when the package is
    unchanged since the last run."""
    from models import KbCollection, KbTrainingPlan, NexusSetting
    import kb_academy
    import kb_access
    import kb_core
    from routers.kb_training import _draft_of, _norm_lessons, _norm_quiz

    digest = kb_academy.digest(kb_academy.ROOT)
    mark = db.get(NexusSetting, CONTENT_MARK)
    if mark is not None and mark.value == digest:
        return None
    a = kb_academy.load(kb_academy.ROOT)
    if kb_academy.problems(a):
        return None
    col = db.query(KbCollection).filter(KbCollection.name == COLLECTION).first()
    if col is None:
        return None   # no first run yet: apply_once will import everything
    owner = owner_email(db)
    owner_name = kb_access.display_name(db, owner)
    pages_made, courses_made, courses_touched, lessons_touched = 0, 0, 0, 0
    page_ids = {}
    for p in a.pages.values():
        d, made = _page(db, col, p, owner, owner_name)
        pages_made += made
        page_ids[p.slug] = d.id
    db.flush()
    plan = db.query(KbTrainingPlan).filter(KbTrainingPlan.name == (a.plan.get("name") or "")[:200]).first() if a.plan else None
    plan_courses = a.plan.get("courses") or []
    slug_ids = {}
    for spec in a.courses:
        c, made = _course(db, spec, owner, owner_name, page_ids)
        slug_ids[spec.slug] = c.id
        if made:
            courses_made += 1
            if plan is not None and spec.slug in plan_courses:
                try:
                    items = json.loads(plan.items or "[]")
                except ValueError:
                    items = []
                if not any(isinstance(it, dict) and it.get("id") == c.id for it in items):
                    n = plan_courses.index(spec.slug)
                    items.append({"kind": "course", "id": c.id, "stage": ACADEMY_STAGE_OF[n] if n < len(ACADEMY_STAGE_OF) else -1})
                    plan.items = json.dumps(items)
                    plan.updated_at = kb_core.now()
            continue
        draft = _draft_of(c)
        changed = False
        if _untouched(db, c, draft, mark) and all(L["type"] != "page" or L["page"] in page_ids for L in spec.lessons):
            lessons = [{**L, "docId": page_ids[L["page"]]} if L["type"] == "page" else L for L in spec.lessons]
            new = dict(draft, lessons=_norm_lessons(db, lessons), quiz=_norm_quiz(spec.quiz), teaches=spec.teaches or draft.get("teaches") or "",
                       description=(spec.description or "")[:400], overview=spec.overview or [],
                       est_minutes=int(spec.est_minutes or draft.get("est_minutes") or 15))
            if _fp(new) != _fp(draft):
                if db.get(NexusSetting, FP_PREFIX + c.id) is None and c.draft:   # no fingerprint: keep what it had, recoverable
                    db.merge(NexusSetting(key=PREV_PREFIX + c.id, value=c.draft, updated_by="startup", updated_at=kb_core.now()))
                draft = new
                lessons_touched += sum(1 for L in new["lessons"] if L["type"] == "text")
                changed = True
            _stamp(db, c.id, draft)
        else:
            if db.get(NexusSetting, FP_PREFIX + c.id) is None:   # a person's course: never read as untouched again, whatever its updated_at
                db.add(NexusSetting(key=FP_PREFIX + c.id, value="edited", updated_by="startup", updated_at=kb_core.now()))
            if spec.teaches and not (draft.get("teaches") or "").strip():   # metadata: fills a blank, never replaces a person's value
                draft["teaches"] = spec.teaches
                changed = True
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
        if spec.teaches and not (c.teaches or "").strip():   # the Help panel's Learn This Screen reads the live column
            c.teaches = spec.teaches
            changed = True
        if changed:
            c.draft = json.dumps(draft)   # drafts only: a published course's live lessons and quiz wait for an author's Publish
            if c.status == "draft":
                c.est_minutes = int(draft.get("est_minutes") or c.est_minutes or 15)
            c.updated_at = kb_core.now()
            courses_touched += 1
    _sync_plan(db, a, slug_ids)
    now = kb_core.now()
    if mark is None:
        db.add(NexusSetting(key=CONTENT_MARK, value=digest, updated_by="startup", updated_at=now))
    else:
        mark.value, mark.updated_by, mark.updated_at = digest, "startup", now
    db.commit()
    return {"pages": pages_made, "courses": courses_made + courses_touched, "lessons": lessons_touched}
