"""Knowledge Base migration (Oct 2026 rebuild): every existing record carries
over, nothing is deleted, nothing is overwritten.

  plan(db)   -> the dry-run report: one row per document, course and
                collection saying what WOULD happen. Changes nothing.
  apply(db)  -> does it, idempotently (a row already migrated is skipped), and
                returns the same report with what happened.

What carries over (the plan page's "Nothing Is Lost" table):
  departments + services  -> collections (department, then service under it)
  SOP / Guide / Manual    -> sop / how_to / reference pages; the old `body` is
                             converted by kb_blocks.from_guided (fixed rules,
                             never AI) into `blocks`; `body` stays untouched
  Full Editor docs        -> the linked Document Builder content copied in;
                             the Document row stays where it is
  version string          -> major.minor; snapshots -> kb_page_versions (order fixed)
  revision_history        -> kb_events
  acknowledgements        -> kb_signatures (typed name unknown: "")
  courses                 -> version 1 of each, lessons pinned to the page
                             version current now; quiz answers as lists
  completions             -> certificates with the original date, legacy=True
  runs, comments, votes, pins, originals, translations -> kept, read as-is
Manual-input needed is reported, never guessed: every row has `action` and
`notes`.

CLI:  python -m kb_migrate            (dry run, prints the report)
      python -m kb_migrate --apply
"""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict

from sqlalchemy.orm import Session

import kb_blocks
import kb_core
import kb_media
import models

TYPE_MAP = {"SOP": "sop", "Guide": "how_to", "Manual": "reference", "Policy": "policy", "How-To": "how_to", "Reference": "reference"}


def _j(raw, default):
    try:
        v = json.loads(raw) if raw else default
    except (ValueError, TypeError):
        return default
    return v if isinstance(v, type(default)) else default


def _collections_plan(db: Session) -> tuple[dict, dict, list[dict]]:
    """(dept_name -> collection id or None, service_id -> collection id or None, report rows)."""
    existing = db.query(models.KbCollection).all()
    by_dept = {c.department.lower(): c for c in existing if c.department and not c.parent_id}
    by_service = {c.legacy_service_id: c for c in existing if c.legacy_service_id}
    rows = []
    dept_map: dict[str, str | None] = {}
    depts: Counter = Counter()
    owners: dict[str, Counter] = defaultdict(Counter)
    for d in db.query(models.KbDocument).all():
        for p in (d.departments or "").split(","):
            p = p.strip()
            if p:
                depts[p] += 1
                if d.owner_email:
                    owners[p][d.owner_email.lower()] += 1
    for s in db.query(models.KbService).all():
        depts[s.department] += 0
    for name in sorted(depts):
        c = by_dept.get(name.lower())
        owner = owners[name].most_common(1)[0][0] if owners[name] else ""
        rows.append({"kind": "collection", "name": name, "parent": "", "pages": depts[name],
                     "owner": c.owner_email if c else owner,
                     "action": "exists" if c else "create", "notes": [] if (c or owner) else ["no owner found: assign one in Manage"]})
        dept_map[name] = c.id if c else None
    svc_map: dict[str, str | None] = {}
    for s in db.query(models.KbService).order_by(models.KbService.department, models.KbService.sort_order).all():
        c = by_service.get(s.id)
        n = db.query(models.KbDocument).filter(models.KbDocument.service == s.name, models.KbDocument.departments.like(f"%{s.department}%")).count()
        rows.append({"kind": "collection", "name": s.name, "parent": s.department, "pages": n,
                     "owner": c.owner_email if c else "", "action": "exists" if c else "create",
                     "notes": [] if s.active else ["service was inactive: collection is created inactive"]})
        svc_map[s.id] = c.id if c else None
    return dept_map, svc_map, rows


def _collections_apply(db: Session, actor: str) -> tuple[dict, dict]:
    dept_map, svc_map, _rows = _collections_plan(db)
    order = 0
    for name, cid in list(dept_map.items()):
        if cid:
            continue
        owners: Counter = Counter()
        for d in db.query(models.KbDocument).filter(models.KbDocument.departments.like(f"%{name}%")).all():
            if d.owner_email:
                owners[d.owner_email.lower()] += 1
        owner = owners.most_common(1)[0][0] if owners else ""
        c = models.KbCollection(id=kb_core.new_id("col"), name=name, department=name, owner_email=owner,
                                owner_name=kb_core.person_name(db, owner) if owner else "", review_every_months=12,
                                sort_order=order, active=True, created_by=actor, created_at=kb_core.now(), updated_at=kb_core.now())
        db.add(c)
        db.flush()
        dept_map[name] = c.id
        order += 1
    for s in db.query(models.KbService).all():
        if svc_map.get(s.id):
            continue
        parent = dept_map.get(s.department) or ""
        c = models.KbCollection(id=kb_core.new_id("col"), name=s.name, parent_id=parent, department="",
                                owner_email="", owner_name="", review_every_months=12, sort_order=s.sort_order or 0,
                                active=bool(s.active), created_by=actor, created_at=kb_core.now(), updated_at=kb_core.now(),
                                legacy_service_id=s.id)
        db.add(c)
        db.flush()
        svc_map[s.id] = c.id
    return dept_map, svc_map


def _service_lookup(db: Session) -> dict[tuple[str, str], str]:
    return {(s.department, (s.name or "").lower()): s.id for s in db.query(models.KbService).all()}


def _doc_target(d: models.KbDocument, dept_map: dict, svc_map: dict, svc_lookup: dict) -> tuple[str | None, list[str]]:
    notes = []
    depts = [p.strip() for p in (d.departments or "").split(",") if p.strip()]
    if not depts:
        notes.append("no department: page lands with no collection (file it in Manage)")
        return None, notes
    if len(depts) > 1:
        notes.append(f"{len(depts)} departments: filed under {depts[0]}, the rest kept as tags")
    dept = depts[0]
    if d.service:
        sid = svc_lookup.get((dept, d.service.lower()))
        if sid and svc_map.get(sid):
            return svc_map[sid], notes
        if sid:
            return "(new service collection)", notes
        notes.append(f"service '{d.service}' is not in the service list: filed under the department")
    return dept_map.get(dept) or "(new department collection)", notes


def _linked_document(db: Session, body: dict):
    lid = body.get("linkedDocumentId")
    if not lid:
        return None
    return db.query(models.Document).filter(models.Document.id == lid).first()


def _convert(db: Session, d: models.KbDocument, *, store_images: bool) -> tuple[dict, list[str], str]:
    """-> (blocks, notes, mode)"""
    body = _j(d.body, {})
    mode = "freeform" if body.get("authoringMode") == "freeform" else "guided"
    notes: list[str] = []
    if mode == "freeform":
        doc_row = _linked_document(db, body)
        if not doc_row:
            notes.append("full editor page: linked document is missing; falling back to the form fields")
            mode = "guided"
        else:
            blocks, n = kb_blocks.from_tiptap_document(doc_row.content, image_ok=lambda u: not u.startswith("data:"))
            notes.extend(n)
            if kb_blocks.is_blank(blocks) and (d.content_text or "").strip():
                blocks = kb_blocks.from_plain_text(d.content_text)
                notes.append("linked document was empty: used the indexed text")
            return blocks, notes, "freeform"
    resolver = (lambda ref: kb_media.resolve_legacy(ref)) if store_images else (lambda ref: "" if ref.startswith("data:") else kb_media.resolve_legacy(ref) if kb_media.configured() else ref)
    blocks, n = kb_blocks.from_guided(body, resolve_image=resolver, title=d.title)
    notes.extend(n)
    if kb_blocks.is_blank(blocks) and (d.original_content or "").strip():
        blocks = kb_blocks.from_plain_text(d.original_content)
        notes.append("form fields were empty: used the original import text")
    return blocks, notes, mode


def _docs_plan(db: Session, dept_map: dict, svc_map: dict, store_images: bool) -> list[dict]:
    rows = []
    lookup = _service_lookup(db)
    for d in db.query(models.KbDocument).order_by(models.KbDocument.created_at).all():
        notes: list[str] = []
        if d.migrated_at:
            rows.append({"kind": "page", "id": d.id, "code": d.doc_code, "title": d.title, "old_type": d.doc_type,
                         "new_type": d.page_type, "status": d.status, "version": d.version, "collection": d.collection_id,
                         "action": "already migrated", "notes": []})
            continue
        new_type = TYPE_MAP.get(d.doc_type or "SOP", "sop")
        if d.require_ack and new_type != "policy":
            notes.append("sign-off required: stays a " + kb_core.PAGE_TYPE_LABEL[new_type] + " with signatures on; change the type to Policy if it is rules people agree to")
        target, n = _doc_target(d, dept_map, svc_map, lookup)
        notes.extend(n)
        try:
            blocks, n2, mode = _convert(db, d, store_images=store_images)
            notes.extend(n2)
        except Exception as e:  # noqa: BLE001
            blocks, mode = kb_blocks.from_plain_text(d.content_text or d.original_content or ""), "error"
            notes.append(f"conversion failed ({e.__class__.__name__}); kept as plain text")
        major, minor = kb_core.parse_version(d.version)
        if d.status == "approved" and major == 0:
            major, minor = 1, 0
            notes.append(f"published page with version '{d.version}': becomes 1.0")
        snaps = db.query(models.KbSnapshot).filter(models.KbSnapshot.doc_id == d.id).count()
        acks = db.query(models.KbAcknowledgement).filter(models.KbAcknowledgement.doc_id == d.id).count()
        if any(u.startswith("data:") for u in kb_blocks.image_urls(blocks)):
            notes.append("has inline images that will be uploaded to storage on apply")
        action = "convert"
        if mode == "error" or kb_blocks.is_blank(blocks):
            action = "needs a look"
        rows.append({"kind": "page", "id": d.id, "code": d.doc_code, "title": d.title, "old_type": d.doc_type,
                     "new_type": new_type, "status": d.status, "version": f"{major}.{minor}", "collection": target or "",
                     "mode": mode, "blocks": len(blocks.get("content") or []), "words": kb_blocks.word_count(blocks),
                     "snapshots": snaps, "signatures": acks, "action": action, "notes": notes})
    return rows


def _docs_apply(db: Session, dept_map: dict, svc_map: dict, actor: str) -> list[dict]:
    rows = []
    lookup = _service_lookup(db)
    for d in db.query(models.KbDocument).order_by(models.KbDocument.created_at).all():
        if d.migrated_at:
            rows.append({"kind": "page", "id": d.id, "title": d.title, "action": "already migrated", "notes": []})
            continue
        notes: list[str] = []
        new_type = TYPE_MAP.get(d.doc_type or "SOP", "sop")
        target, n = _doc_target(d, dept_map, svc_map, lookup)
        notes.extend(n)
        if target and target.startswith("("):
            target = None
        try:
            blocks, n2, mode = _convert(db, d, store_images=True)
            notes.extend(n2)
        except Exception as e:  # noqa: BLE001
            blocks, mode = kb_blocks.from_plain_text(d.content_text or d.original_content or ""), "error"
            notes.append(f"conversion failed ({e.__class__.__name__}); kept as plain text")
        blocks = kb_blocks.sanitize(blocks, image_ok=lambda u: not u.startswith("data:"))
        major, minor = kb_core.parse_version(d.version)
        if d.status == "approved" and major == 0:
            major, minor = 1, 0
        d.page_type = new_type
        d.collection_id = target or ""
        d.major, d.minor = major, minor
        d.version = kb_core.version_str(major, minor)
        d.blocks = kb_blocks.dumps(blocks)
        d.content_text = kb_blocks.plain_text(blocks) or d.content_text
        if not d.summary:
            first = next((kb_blocks.node_text(n_) for n_ in blocks.get("content") or [] if n_.get("type") == "paragraph" and kb_blocks.node_text(n_).strip()), "")
            d.summary = first.strip()[:200]
        if d.status == "approved" and not d.published_at:
            d.published_at = (d.effective_date or d.updated_at or d.created_at or kb_core.now())
        depts = [p.strip() for p in (d.departments or "").split(",") if p.strip()]
        if len(depts) > 1:
            tags = [t.strip() for t in (d.tags or "").split(",") if t.strip()]
            for extra in depts[1:]:
                if extra not in tags:
                    tags.append(extra)
            d.tags = ",".join(tags)
        # versions: snapshots, oldest first, one row per distinct version string
        snaps = db.query(models.KbSnapshot).filter(models.KbSnapshot.doc_id == d.id).all()
        snaps.sort(key=lambda s: ((s.date or ""), s.id))
        seen: dict[str, models.KbPageVersion] = {}
        for s in snaps:
            ma, mi = kb_core.parse_version(s.version)
            key = kb_core.version_str(ma, mi)
            sb, _n = kb_blocks.from_guided(_j(s.body, {}), resolve_image=lambda ref: kb_media.resolve_legacy(ref), title=s.title or d.title)
            sb = kb_blocks.sanitize(sb, image_ok=lambda u: not u.startswith("data:"))
            if key in seen:   # the same version saved twice: keep the latest body
                v = seen[key]
                v.blocks, v.content_text, v.published_at = kb_blocks.dumps(sb), kb_blocks.plain_text(sb), s.date or v.published_at
                continue
            v = models.KbPageVersion(id=kb_core.new_id("ver"), doc_id=d.id, major=ma, minor=mi, version=key, title=s.title or d.title,
                                     summary="", blocks=kb_blocks.dumps(sb), content_text=kb_blocks.plain_text(sb), change_kind="migrated",
                                     change_note="From the old version history", author_email=(s.author or "").lower(), approved_by="",
                                     published_at=s.date or "", legacy_snapshot_id=s.id)
            db.add(v)
            seen[key] = v
        if d.status == "approved" and d.version not in seen:
            db.add(models.KbPageVersion(id=kb_core.new_id("ver"), doc_id=d.id, major=major, minor=minor, version=d.version, title=d.title,
                                        summary=d.summary or "", blocks=d.blocks, content_text=d.content_text, change_kind="migrated",
                                        change_note="The page as it read at migration", author_email=(d.owner_email or "").lower(),
                                        approved_by=(d.verified_by or "").lower(), published_at=d.published_at or ""))
        elif d.status == "approved" and d.version in seen:
            v = seen[d.version]
            v.blocks, v.content_text, v.title = d.blocks, d.content_text, d.title
        # signatures
        for a in db.query(models.KbAcknowledgement).filter(models.KbAcknowledgement.doc_id == d.id).all():
            if db.query(models.KbSignature).filter(models.KbSignature.legacy_ack_id == a.id).first():
                continue
            ma, mi = kb_core.parse_version(a.version)
            if ma == 0 and d.status == "approved":
                ma = 1
            db.add(models.KbSignature(id=kb_core.new_id("sig"), doc_id=d.id, version=a.version or kb_core.version_str(ma, mi), major=ma,
                                      user_email=(a.user_email or "").lower(), user_name=a.user_name or "", typed_name="",
                                      signed_at=a.signed_at or "", content_text="", content_hash="", method="legacy", legacy_ack_id=a.id))
        # history -> events
        for h in reversed(_j(d.revision_history, [])):
            if not isinstance(h, dict):
                continue
            note = str(h.get("notes") or "")
            kind = "created" if note.startswith("Created") else "published" if note.startswith("Approved") else \
                "archived" if note.startswith("Archived") else "verified" if note.startswith("Verified") else "edited"
            db.add(models.KbEvent(id=kb_core.new_id("evt"), doc_id=d.id, kind=kind, version=str(h.get("version") or ""),
                                  actor_email=str(h.get("author") or "").lower(), note=note[:1000], created_at=str(h.get("date") or "")))
        d.migrated_at = kb_core.now()
        rows.append({"kind": "page", "id": d.id, "code": d.doc_code, "title": d.title, "new_type": new_type, "version": d.version,
                     "collection": d.collection_id, "mode": mode, "action": "converted" if mode != "error" else "needs a look", "notes": notes})
    return rows


def _norm_lessons(db: Session, lessons: list) -> list[dict]:
    out = []
    for L in lessons:
        if not isinstance(L, dict):
            continue
        lid = L.get("_id") or kb_core.new_id("l")
        if L.get("type") == "sop" and L.get("docId"):
            d = db.query(models.KbDocument).filter(models.KbDocument.id == L["docId"]).first()
            out.append({"_id": lid, "type": "page", "title": L.get("title") or (d.title if d else "Lesson"),
                        "docId": L["docId"], "docVersion": d.version if d else "", "blocks": None, "summary": L.get("body") or ""})
        else:
            body = L.get("body") or ""
            out.append({"_id": lid, "type": "text", "title": L.get("title") or "Lesson", "docId": "", "docVersion": "",
                        "blocks": kb_blocks.from_plain_text(body), "summary": ""})
    return out


def _norm_quiz(quiz: dict) -> dict:
    qs = []
    for q in quiz.get("questions") or []:
        if not isinstance(q, dict):
            continue
        opts = [str(o) for o in (q.get("options") or [])]
        ans = q.get("answer")
        if isinstance(ans, int):
            ans = [ans]
        ans = [int(a) for a in (ans or []) if isinstance(a, int) and 0 <= a < len(opts)]
        t = q.get("type") if q.get("type") in ("single", "multi", "tf") else ("multi" if len(ans) > 1 else "single")
        qs.append({"_id": q.get("_id") or kb_core.new_id("q"), "type": t, "q": str(q.get("q") or ""), "options": opts,
                   "answer": ans, "explanation": str(q.get("explanation") or ""), "lessonId": str(q.get("lessonId") or "")})
    return {"passPct": int(quiz.get("passPct") or kb_core.DEFAULT_PASS_PCT), "drawCount": int(quiz.get("drawCount") or 0),
            "maxTries": int(quiz.get("maxTries") or kb_core.DEFAULT_MAX_TRIES), "shuffle": quiz.get("shuffle", True) is not False, "questions": qs}


def _courses_plan(db: Session) -> list[dict]:
    rows = []
    for c in db.query(models.KbCourse).all():
        lessons = _j(c.lessons, [])
        quiz = _j(c.quiz, {})
        completions = db.query(models.KbCourseProgress).filter(models.KbCourseProgress.course_id == c.id, models.KbCourseProgress.completed_at != "").count()
        notes = []
        if c.major:
            action = "already migrated"
        else:
            action = "convert"
            missing = [L.get("docId") for L in lessons if isinstance(L, dict) and L.get("type") == "sop" and L.get("docId")
                       and not db.query(models.KbDocument).filter(models.KbDocument.id == L["docId"]).first()]
            if missing:
                notes.append(f"{len(missing)} SOP lesson(s) point at pages that no longer exist")
            bad = [q for q in (quiz.get("questions") or []) if not isinstance(q, dict) or not isinstance(q.get("answer"), (int, list))]
            if bad:
                notes.append(f"{len(bad)} question(s) have no answer and will be kept but need a look")
        rows.append({"kind": "course", "id": c.id, "code": c.course_code, "title": c.title, "status": c.status,
                     "lessons": len(lessons), "questions": len(quiz.get("questions") or []), "completions": completions,
                     "action": action, "notes": notes})
    return rows


def _courses_apply(db: Session, actor: str) -> list[dict]:
    rows = []
    for c in db.query(models.KbCourse).all():
        if c.major:
            rows.append({"kind": "course", "id": c.id, "title": c.title, "action": "already migrated", "notes": []})
            continue
        lessons = _norm_lessons(db, _j(c.lessons, []))
        quiz = _norm_quiz(_j(c.quiz, {}))
        c.lessons = json.dumps(lessons)
        c.quiz = json.dumps(quiz)
        c.major = 1
        c.published_at = c.updated_at or c.created_at or kb_core.now() if c.status == "published" else ""
        if c.status == "published":
            db.add(models.KbCourseVersion(id=kb_core.new_id("cv"), course_id=c.id, major=1, title=c.title, description=c.description or "",
                                          overview=c.overview or "[]", est_minutes=c.est_minutes or 15, lessons=c.lessons, quiz=c.quiz,
                                          published_at=c.published_at, published_by=(c.owner_email or "").lower(), change_note="Migrated"))
        else:
            c.major = 0
            c.draft = json.dumps({"title": c.title, "description": c.description or "", "overview": _j(c.overview, []),
                                  "est_minutes": c.est_minutes or 15, "lessons": lessons, "quiz": quiz,
                                  "recert_months": c.recert_months or 0, "departments": c.departments or ""})
        certs = 0
        for p in db.query(models.KbCourseProgress).filter(models.KbCourseProgress.course_id == c.id).all():
            p.course_major = c.major
            if p.completed_at and not p.certificate_id and (p.passed or not quiz["questions"]):
                kb_core.issue_certificate(db, c, p, score=p.quiz_score or 0, user_name=kb_core.person_name(db, p.user_email),
                                          legacy=True, issued_at=p.completed_at)
                certs += 1
        for a in db.query(models.KbQuizAttempt).filter(models.KbQuizAttempt.course_id == c.id).all():
            if not a.course_major:
                a.course_major = c.major
        rows.append({"kind": "course", "id": c.id, "code": c.course_code, "title": c.title, "status": c.status,
                     "certificates": certs, "action": "converted", "notes": []})
    return rows


def _summary(rows: list[dict]) -> dict:
    out: dict = {"pages": Counter(), "courses": Counter(), "collections": Counter()}
    for r in rows:
        key = {"page": "pages", "course": "courses", "collection": "collections"}[r["kind"]]
        out[key][r["action"]] += 1
    return {k: dict(v) for k, v in out.items()}


def plan(db: Session) -> dict:
    dept_map, svc_map, col_rows = _collections_plan(db)
    rows = col_rows + _docs_plan(db, dept_map, svc_map, store_images=False) + _courses_plan(db)
    return {"dry_run": True, "at": kb_core.now(), "summary": _summary(rows), "rows": rows,
            "storage": kb_media.configured(), "ai": False}


def apply(db: Session, actor: str = "migration") -> dict:
    dept_map, svc_map = _collections_apply(db, actor)
    rows = []
    for name, cid in dept_map.items():
        rows.append({"kind": "collection", "name": name, "parent": "", "id": cid, "action": "ready", "notes": []})
    rows += _docs_apply(db, dept_map, svc_map, actor)
    rows += _courses_apply(db, actor)
    db.commit()
    return {"dry_run": False, "at": kb_core.now(), "summary": _summary(rows), "rows": rows, "storage": kb_media.configured()}


if __name__ == "__main__":   # pragma: no cover
    import database
    models.Base.metadata.create_all(bind=database.engine)
    session = database.SessionLocal()
    try:
        rep = apply(session, actor="cli") if "--apply" in sys.argv else plan(session)
    finally:
        session.close()
    print(json.dumps(rep["summary"], indent=2))
    for r in rep["rows"]:
        if r.get("notes") or r.get("action") == "needs a look":
            print(f"- [{r['kind']}] {r.get('title') or r.get('name')}: {r['action']}; " + "; ".join(r.get("notes") or []))
