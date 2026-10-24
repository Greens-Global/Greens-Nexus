"""Shared Knowledge Base rules (Oct 2026 rebuild): ids, versions, codes,
bells, the activity log, review dates, sign-off and training status. Both
routers, the daily scan and the migration use these so there is one rule
for each thing.
"""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session
from types import SimpleNamespace

import code_sequence
import kb_audience
import kb_blocks
import models
from notify_company import notification_company

PAGE_TYPES = ("how_to", "sop", "policy", "reference")
PAGE_TYPE_LABEL = {"how_to": "How-To", "sop": "SOP", "policy": "Policy", "reference": "Reference"}
DEPT_ABBR = {
    "Operations": "OPS", "Revenue Management": "RM", "Real Estate Development": "RED",
    "People (HR)": "HR", "People": "HR", "Accounting": "ACC", "IT": "IT",
    "Marketing": "MKT", "Administration": "ADM", "Learning": "LRN",
}
DEFAULT_MAX_TRIES = 3
DEFAULT_PASS_PCT = 80


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def today() -> str:
    return now()[:10]


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def add_days(iso: str, days: int) -> str:
    try:
        d = datetime.fromisoformat(iso[:10])
    except ValueError:
        return ""
    return (d + timedelta(days=days)).date().isoformat()


def add_months(iso: str, months: int) -> str:
    if not iso:
        return ""
    try:
        y, m, da = (int(x) for x in iso[:10].split("-"))
    except (ValueError, IndexError):
        return ""
    m0 = (m - 1) + (months or 0)
    y += m0 // 12
    m = m0 % 12 + 1
    return f"{y:04d}-{m:02d}-{min(da, 28):02d}"


def days_between(a: str, b: str) -> int:
    """b - a in days (both ISO dates); 0 when either is blank."""
    try:
        return (datetime.fromisoformat(b[:10]) - datetime.fromisoformat(a[:10])).days
    except ValueError:
        return 0


# ----------------------------------------------------------------- versions

def version_str(major: int, minor: int) -> str:
    return f"{int(major or 0)}.{int(minor or 0)}"


def parse_version(s: str) -> tuple[int, int]:
    m = re.match(r"^\s*v?(\d+)(?:\.(\d+))?", s or "")
    if not m:
        return 0, 0
    return int(m.group(1)), int(m.group(2) or 0)


def bump(major: int, minor: int, kind: str) -> tuple[int, int]:
    if kind == "major" or major == 0:
        return (max(major, 0) + 1, 0)
    return (major, minor + 1)


# ----------------------------------------------------------------- codes

def _dept_prefix(db: Session, d: models.KbDocument) -> str:
    dept = ""
    if d.collection_id:
        c = db.query(models.KbCollection).filter(models.KbCollection.id == d.collection_id).first()
        while c and not c.department and c.parent_id:
            c = db.query(models.KbCollection).filter(models.KbCollection.id == c.parent_id).first()
        dept = (c.department or "") if c else ""
    if not dept and d.departments:
        parts = [p for p in d.departments.split(",") if p.strip()]
        dept = parts[0].strip() if len(parts) == 1 else ""
    return DEPT_ABBR.get(dept, "COR") if dept else "COR"


def _seed_code(prefix: str):
    def seed(db: Session) -> int:
        best = 0
        for (code,) in db.query(models.KbDocument.doc_code).all():
            if code and code.startswith(prefix + "-"):
                try:
                    best = max(best, int(code.split("-")[1]))
                except (ValueError, IndexError):
                    pass
        return best
    return seed


def assign_code(db: Session, d: models.KbDocument) -> str:
    """OPS-014 style, handed out under the shared counter lock, once."""
    if d.doc_code:
        return d.doc_code
    prefix = _dept_prefix(db, d)
    n = code_sequence.next_number(db, f"kb_code_{prefix}", _seed_code(prefix))
    taken = {c for (c,) in db.query(models.KbDocument.doc_code).filter(models.KbDocument.doc_code != "").all()}
    while f"{prefix}-{n:03d}" in taken:
        n = code_sequence.next_number(db, f"kb_code_{prefix}", _seed_code(prefix))
    d.doc_code = f"{prefix}-{n:03d}"
    return d.doc_code


def assign_course_code(db: Session, c: models.KbCourse) -> str:
    if c.course_code:
        return c.course_code

    def seed(db_: Session) -> int:
        best = 0
        for (code,) in db_.query(models.KbCourse.course_code).all():
            if code and code.startswith("LRN-"):
                try:
                    best = max(best, int(code.split("-")[1]))
                except (ValueError, IndexError):
                    pass
        return best
    n = code_sequence.next_number(db, "kb_code_LRN", seed)
    c.course_code = f"LRN-{n:03d}"
    return c.course_code


def cert_serial(db: Session) -> str:
    year = today()[:4]

    def seed(db_: Session) -> int:
        best = 0
        for (s,) in db_.query(models.KbCertificate.serial).all():
            m = re.match(rf"^CERT-{year}-(\d+)$", s or "")
            if m:
                best = max(best, int(m.group(1)))
        return best
    n = code_sequence.next_number(db, f"kb_cert_{year}", seed)
    return f"CERT-{year}-{n:05d}"


# ----------------------------------------------------------------- bells and log

def notify(db: Session, *, recipient: str, ntype: str, title: str, body: str,
           ref_id: str = "", item_name: str = "", sub: str = "", requested_by: str = "",
           dedupe_today: bool = False, priority: int = 0) -> bool:
    """A bell that opens the page / course it is about. Never one per item
    when `dedupe_today` is on: same type + ref + recipient once a day."""
    email = (recipient or "").lower().strip()
    if not email or email == (requested_by or "").lower():
        return False
    if dedupe_today:
        day = today()
        dup = db.query(models.NexusNotification).filter(
            models.NexusNotification.type == ntype, models.NexusNotification.recipient == email,
            models.NexusNotification.ref_id == ref_id, models.NexusNotification.created_at >= day).first()
        if dup:
            return False
    action = json.dumps({"view": "sop", "sub": sub, "label": "Open"}) if sub else ""
    db.add(models.NexusNotification(
        id=str(uuid.uuid4()), type=ntype, recipient=email, title=title[:200], body=body[:1000],
        ref_id=ref_id, item_name=(item_name or "")[:200], requested_by=requested_by or "", action=action,
        actioned=False, read_by="", company=notification_company(db, requested_by or email, email),
        created_at=now(), priority=priority))
    return True


def event(db: Session, *, kind: str, actor: str, doc_id: str = "", course_id: str = "",
          note: str = "", version: str = "", actor_name: str = "") -> models.KbEvent:
    e = models.KbEvent(id=new_id("evt"), doc_id=doc_id, course_id=course_id, kind=kind, version=version,
                       actor_email=(actor or "").lower(), actor_name=actor_name or "", note=(note or "")[:1000], created_at=now())
    db.add(e)
    return e


# ----------------------------------------------------------------- review dates

def review_months(db: Session, d: models.KbDocument) -> int:
    if d.review_every_months:
        return int(d.review_every_months)
    if d.collection_id:
        c = db.query(models.KbCollection).filter(models.KbCollection.id == d.collection_id).first()
        if c and c.review_every_months:
            return int(c.review_every_months)
    return 12


def next_review(db: Session, d: models.KbDocument) -> str:
    base = d.verified_at or d.published_at or d.effective_date or ""
    return add_months(base[:10], review_months(db, d)) if base else ""


def review_state(db: Session, d: models.KbDocument) -> dict:
    """{next_review, days_overdue, stale, banner} - stale = past the review
    date; banner = 30+ days past (readers see it)."""
    if d.status != "approved":
        return {"next_review": "", "days_overdue": 0, "stale": False, "banner": False}
    nr = next_review(db, d)
    if not nr:
        return {"next_review": "", "days_overdue": 0, "stale": True, "banner": False}
    over = days_between(nr, today())
    return {"next_review": nr, "days_overdue": max(0, over), "stale": over > 0, "banner": over >= 30}


# ----------------------------------------------------------------- content

def set_content(d: models.KbDocument, blocks: dict) -> None:
    d.blocks = kb_blocks.dumps(blocks)
    d.content_text = kb_blocks.plain_text(blocks)


def content_hash(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def publish(db: Session, d: models.KbDocument, *, blocks: dict, title: str, summary: str,
            change_kind: str, change_note: str, author: str, approved_by: str) -> models.KbPageVersion:
    """Make `blocks` the live page: bump the version, write the version row,
    stamp verified, hand out the code on first publish. The caller commits."""
    major, minor = bump(d.major or 0, d.minor or 0, change_kind)
    d.major, d.minor = major, minor
    d.version = version_str(major, minor)
    d.title = title or d.title
    d.summary = summary if summary is not None else d.summary
    set_content(d, blocks)
    d.status = "approved"
    d.published_at = now()
    d.verified_at = today()
    d.verified_by = approved_by or author
    if not d.effective_date:
        d.effective_date = today()
    d.updated_at = now()
    assign_code(db, d)
    v = models.KbPageVersion(id=new_id("ver"), doc_id=d.id, major=major, minor=minor, version=d.version,
                             title=d.title, summary=d.summary or "", blocks=d.blocks, content_text=d.content_text,
                             change_kind=change_kind, change_note=change_note or "", author_email=(author or "").lower(),
                             approved_by=(approved_by or "").lower(), published_at=d.published_at)
    db.add(v)
    # keep the OLD history list growing too - the old screens' readers of
    # revision_history (nothing is dropped, nothing is reset)
    try:
        hist = json.loads(d.revision_history or "[]")
    except ValueError:
        hist = []
    hist.insert(0, {"version": d.version, "date": today(), "author": author, "notes": f"Published ({change_kind}). {change_note or ''}".strip()})
    d.revision_history = json.dumps(hist)
    return v


# ----------------------------------------------------------------- sign-offs

def policy_audience_emails(db: Session, d: models.KbDocument) -> set[str]:
    """Who must sign: the page's audience, plus everyone on a training plan
    that lists it."""
    emails = kb_audience.member_emails(db, kb_audience.loads(d.audience))
    for plan in db.query(models.KbTrainingPlan).filter(models.KbTrainingPlan.active.is_(True)).all():
        try:
            items = json.loads(plan.items or "[]")
        except ValueError:
            items = []
        if any(i.get("kind") == "policy" and i.get("id") == d.id for i in items if isinstance(i, dict)):
            for pa in db.query(models.KbPlanAssignment).filter(models.KbPlanAssignment.plan_id == plan.id).all():
                emails.add((pa.user_email or "").lower())
    return emails


def signature_for(db: Session, d: models.KbDocument, email: str):
    """The signature that counts for the CURRENT major version. Until the
    migration has run, an old acknowledgement of the same version string
    counts too, so nobody is asked to sign twice."""
    email = (email or "").lower()
    sig = db.query(models.KbSignature).filter(
        models.KbSignature.doc_id == d.id, models.KbSignature.user_email == email,
        models.KbSignature.major == (d.major or 0)).order_by(models.KbSignature.signed_at.desc()).first()
    if sig:
        return sig
    ack = db.query(models.KbAcknowledgement).filter(
        models.KbAcknowledgement.doc_id == d.id, func.lower(models.KbAcknowledgement.user_email) == email,
        models.KbAcknowledgement.version == (d.version or "")).first()
    if ack:
        return SimpleNamespace(id=ack.id, signed_at=ack.signed_at or "", version=ack.version or "", major=d.major or 0,
                               user_name=ack.user_name or "", typed_name="", method="legacy")
    return None


def signature_due(db: Session, d: models.KbDocument, emp: models.NexusEmployee | None) -> str:
    """Due = (published date, or the person's start date if later) + the
    audience's due window (default 14 days)."""
    a = kb_audience.loads(d.audience)
    due_days = 14
    try:
        raw = json.loads(d.audience) if d.audience else {}
        due_days = int(raw.get("due_days") or 14)
    except (ValueError, TypeError):
        pass
    base = (d.published_at or d.effective_date or today())[:10]
    if emp and emp.start_date and emp.start_date[:10] > base:
        base = emp.start_date[:10]
    _ = a
    return add_days(base, due_days)


def signoff_state(db: Session, d: models.KbDocument, email: str) -> dict:
    """{required, signed, signed_at, due, overdue_days, version_signed}"""
    email = (email or "").lower()
    if d.status != "approved" or not d.require_ack:
        return {"required": False, "signed": False, "signed_at": "", "due": "", "overdue_days": 0, "version_signed": ""}
    required = (kb_audience.is_everyone(kb_audience.loads(d.audience)) and bool(email)) or email in policy_audience_emails(db, d)
    sig = signature_for(db, d, email) if email else None
    older = None
    if not sig and email:
        older = db.query(models.KbSignature).filter(models.KbSignature.doc_id == d.id, models.KbSignature.user_email == email).order_by(models.KbSignature.signed_at.desc()).first()
    emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == email).first() if email else None
    due = signature_due(db, d, emp) if required else ""
    return {
        "required": required, "signed": bool(sig), "signed_at": sig.signed_at if sig else "",
        "due": due, "overdue_days": max(0, days_between(due, today())) if required and not sig and due else 0,
        "version_signed": (sig.version if sig else (older.version if older else "")),
    }


# ----------------------------------------------------------------- training

def course_settings(c: models.KbCourse) -> dict:
    try:
        q = json.loads(c.quiz or "{}")
    except ValueError:
        q = {}
    return {
        "pass_pct": int(q.get("passPct") or DEFAULT_PASS_PCT),
        "draw": int(q.get("drawCount") or 0),
        "max_tries": int(q.get("maxTries") or DEFAULT_MAX_TRIES),
        "shuffle": q.get("shuffle", True) is not False,
        "questions": [x for x in (q.get("questions") or []) if isinstance(x, dict)],
    }


def lessons_of(c: models.KbCourse) -> list[dict]:
    try:
        return [x for x in json.loads(c.lessons or "[]") if isinstance(x, dict)]
    except ValueError:
        return []


def progress_of(db: Session, c: models.KbCourse, email: str) -> models.KbCourseProgress | None:
    return db.query(models.KbCourseProgress).filter(models.KbCourseProgress.course_id == c.id,
                                                    models.KbCourseProgress.user_email == (email or "").lower()).first()


def expiry_of(db: Session, c: models.KbCourse, prog: models.KbCourseProgress | None) -> str:
    """When a completion stops counting ("" = never)."""
    if not prog or not prog.completed_at or not c.recert_months:
        return ""
    return add_months(prog.completed_at[:10], int(c.recert_months))


def training_status(db: Session, c: models.KbCourse, prog: models.KbCourseProgress | None, due_date: str = "") -> dict:
    """One rule for every screen: {status: Completed|In Progress|Not Started|Expired|Overdue,
    pct, expires, days_overdue}."""
    lessons = lessons_of(c)
    done = set()
    if prog:
        try:
            done = set(json.loads(prog.lessons_done or "[]"))
        except ValueError:
            done = set()
    total = len(lessons) + (1 if course_settings(c)["questions"] else 0)
    did = len([L for L in lessons if L.get("_id") in done]) + (1 if (prog and prog.passed) else 0)
    pct = int(round(100 * did / total)) if total else (100 if prog and prog.completed_at else 0)
    expires = expiry_of(db, c, prog)
    if prog and prog.completed_at and (prog.passed or not course_settings(c)["questions"]):
        if expires and expires < today():
            return {"status": "Expired", "pct": 100, "expires": expires, "days_overdue": days_between(expires, today())}
        return {"status": "Completed", "pct": 100, "expires": expires, "days_overdue": 0}
    overdue = days_between(due_date, today()) if due_date else 0
    if overdue > 0:
        return {"status": "Overdue", "pct": pct, "expires": "", "days_overdue": overdue}
    return {"status": "In Progress" if (prog and (done or prog.started_at)) else "Not Started", "pct": pct, "expires": "", "days_overdue": 0}


def tries_allowed(c: models.KbCourse, prog: models.KbCourseProgress | None) -> int:
    base = course_settings(c)["max_tries"]
    return base * (1 + (prog.unlock_rounds if prog else 0))


def attempts_used(db: Session, c: models.KbCourse, email: str) -> int:
    return db.query(models.KbQuizAttempt).filter(
        models.KbQuizAttempt.course_id == c.id, models.KbQuizAttempt.user_email == (email or "").lower(),
        models.KbQuizAttempt.status == "graded", models.KbQuizAttempt.course_major == (c.major or 0)).count()


def issue_certificate(db: Session, c: models.KbCourse, prog: models.KbCourseProgress, *, score: int,
                      user_name: str, assignment_id: str = "", legacy: bool = False, issued_at: str = "") -> models.KbCertificate:
    cert = models.KbCertificate(
        id=new_id("cert"), serial=cert_serial(db), course_id=c.id, course_code=c.course_code or "",
        course_title=c.title, course_major=c.major or 0, user_email=prog.user_email.lower(), user_name=user_name or "",
        score=int(score or 0), issued_at=issued_at or now(), expires_at=expiry_of(db, c, prog) or "",
        assignment_id=assignment_id or "", legacy=legacy)
    db.add(cert)
    prog.certificate_id = cert.id
    return cert


def person_name(db: Session, email: str) -> str:
    from kb_access import display_name
    return display_name(db, email)
