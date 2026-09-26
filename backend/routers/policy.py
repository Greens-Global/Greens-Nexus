"""Company-policy & monitoring acknowledgment shown at sign-in.

A standing, portal-wide gate (distinct from the per-day clock-in MonitoringConsent):
the first time a person signs in - and again whenever the policy VERSION changes -
they must accept the company policies + employee-monitoring disclosure before the
app loads. The acceptance is recorded (who/when/version/ip/ua) so it's provable.

Editable since Sep 26, 2026 (Settings > Global Settings > Branding & Policies >
Sign-In Policy). The title, text and version live in NexusSetting key
"signin_policy_config":

    {"published": {"title", "body", "version", "publishedAt", "publishedBy"},
     "draft":     {"title", "body", "savedAt", "savedBy"} | null}

With no row saved, the published policy is DEFAULT_POLICY below - word for
word the text PolicyGate.jsx used to hardcode, at the version everyone already
accepted (2026-07-21), so this change re-prompts nobody. Saving a draft never
touches the version; only Publish New Version does, and that re-prompts
everyone at their next sign-in.

The body is plain text with a tiny markdown subset ("## " headings, "- "
bullets, blank-line paragraphs). The frontend renders it as React text nodes,
never as HTML, so nothing typed here can inject markup.
"""
import csv
import io
import json
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from auth import get_current_user, require_administrator
import models
from models import PolicyAcknowledgment

router = APIRouter(prefix="/policy", tags=["policy"],
                   dependencies=[Depends(get_current_user)])

SETTINGS_KEY = "signin_policy_config"
TITLE_MAX = 200
BODY_MAX = 20_000

# The version everyone accepted before the policy became editable. Kept as the
# default so deploying this re-prompts nobody.
POLICY_VERSION = "2026-07-21"

DEFAULT_POLICY = {
    "title": "Company Policies & Monitoring",
    "body": (
        "## Acceptable use\n"
        "Nexus and the devices you use to access it are company property, provided for work. "
        "Use them in line with your organization’s policies. Do not share your access or use "
        "the portal for anything unlawful.\n\n"
        "## Employee monitoring (please read)\n"
        "On company-managed devices, while you are clocked in, Nexus may capture periodic "
        "screenshots of your work screen(s), record which applications and window titles are "
        "active, and measure your overall activity level. This is to verify worked time and "
        "support performance review. It does NOT capture your keystrokes, and it stops when you "
        "clock out. Capture never runs on a personal device unless you explicitly share your screen.\n\n"
        "## How the data is used\n"
        "Monitoring data is visible to your manager and HR for time-verification, performance, and "
        "payroll purposes, and is retained per company policy. It is not sold or shared outside the "
        "company.\n\n"
        "## Your acknowledgment\n"
        "By accepting, you confirm you have read and understood these policies and the monitoring "
        "described above, and you agree to comply while using Nexus on company devices. You can "
        "review the policies you have accepted at any time from your profile."
    ),
    "version": POLICY_VERSION,
    "publishedAt": "",
    "publishedBy": "",
}


# ── config ────────────────────────────────────────────────────────────────

def _load(db: Session) -> dict:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTINGS_KEY).first()
    raw = {}
    if row and row.value:
        try:
            raw = json.loads(row.value)
        except (TypeError, ValueError):
            raw = {}
    if not isinstance(raw, dict):
        raw = {}
    pub = raw.get("published") if isinstance(raw.get("published"), dict) else {}
    published = {**DEFAULT_POLICY, **{k: v for k, v in pub.items() if k in DEFAULT_POLICY and v}}
    draft = raw.get("draft") if isinstance(raw.get("draft"), dict) else None
    return {"published": published, "draft": draft}


def get_config(db: Session) -> dict:
    """Cached like every other NexusSetting-backed config: /policy/status is
    called on every app load by every person."""
    import cache
    return cache.settings_config.get_or_load(SETTINGS_KEY, lambda: _load(db))


def current_version(db: Session) -> str:
    return get_config(db)["published"]["version"]


def _save(db: Session, cfg: dict, user: dict) -> None:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTINGS_KEY).first()
    if not row:
        row = models.NexusSetting(key=SETTINGS_KEY)
        db.add(row)
    row.value = json.dumps(cfg)
    row.updated_by = user["email"]
    row.updated_at = datetime.now(timezone.utc).isoformat()


def _next_version(current: str, today: str) -> str:
    """Date-based: '2026-09-26', then '2026-09-26.2', '.3' for further
    publishes the same day, so every publish is a new version."""
    if current == today or current.startswith(today + "."):
        n = 1
        if "." in current:
            try:
                n = int(current.rsplit(".", 1)[1])
            except ValueError:
                n = 1
        return f"{today}.{n + 1}"
    return today


class PolicyTextIn(BaseModel):
    title: str = ""
    body: str = ""


def _clean_text(body: PolicyTextIn) -> tuple[str, str]:
    title = (body.title or "").strip()
    text = (body.body or "").replace("\r\n", "\n").strip()
    if not title:
        raise HTTPException(400, "The policy needs a title")
    if not text:
        raise HTTPException(400, "The policy text cannot be empty")
    if len(title) > TITLE_MAX:
        raise HTTPException(400, f"Title must be {TITLE_MAX} characters or fewer")
    if len(text) > BODY_MAX:
        raise HTTPException(400, f"Policy text must be {BODY_MAX} characters or fewer")
    return title, text


def _audit(db: Session, user: dict, action: str, details: dict) -> None:
    db.add(models.AuditLog(timestamp=datetime.now(timezone.utc).isoformat(), user_email=user["email"],
                           user_role=user.get("role", ""), action=action, resource_type="policy",
                           resource_id=SETTINGS_KEY, details=json.dumps(details)))


# ── everyone ──────────────────────────────────────────────────────────────

@router.get("/status")
def policy_status(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Has the current user accepted the CURRENT policy version? Also carries
    the text itself, so the sign-in gate needs one request, not two."""
    pub = get_config(db)["published"]
    row = (db.query(PolicyAcknowledgment)
           .filter(PolicyAcknowledgment.email == user["email"].lower(),
                   PolicyAcknowledgment.version == pub["version"])
           .first())
    return {"version": pub["version"],
            "title": pub["title"],
            "body": pub["body"],
            "accepted": row is not None,
            "acceptedAt": row.accepted_at if row else ""}


class AcceptIn(BaseModel):
    version: Optional[str] = None


@router.post("/accept")
def policy_accept(request: Request, body: Optional[AcceptIn] = None,
                  user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Record acceptance of the current policy version (idempotent per
    person+version). The gate sends the version it showed; if a new one was
    published in between, 409 so the person reads the new text first - an
    acceptance must always be of the words that were on screen."""
    version = current_version(db)
    if body is not None and body.version and body.version != version:
        raise HTTPException(409, "The policy was just updated. Please review the new version.")
    email = user["email"].lower()
    existing = (db.query(PolicyAcknowledgment)
                .filter(PolicyAcknowledgment.email == email,
                        PolicyAcknowledgment.version == version)
                .first())
    if existing:
        return {"ok": True, "acceptedAt": existing.accepted_at}
    now = datetime.now(timezone.utc).isoformat()
    db.add(PolicyAcknowledgment(
        id=str(uuid.uuid4()), email=email, version=version, accepted_at=now,
        ip=(request.client.host if request.client else "")[:64],
        user_agent=request.headers.get("user-agent", "")[:300]))
    db.commit()
    return {"ok": True, "acceptedAt": now}


@router.get("/acknowledgments")
def my_acknowledgments(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The caller's own acceptance history - lets them keep a copy of what they signed."""
    rows = (db.query(PolicyAcknowledgment)
            .filter(PolicyAcknowledgment.email == user["email"].lower())
            .order_by(PolicyAcknowledgment.accepted_at.desc()).all())
    return [{"version": r.version, "acceptedAt": r.accepted_at} for r in rows]


# ── administrators (Settings > Branding & Policies > Sign-In Policy) ─────

@router.get("/config")
def admin_get_config(user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    cfg = get_config(db)
    return {"published": cfg["published"], "draft": cfg["draft"]}


@router.put("/draft")
def admin_save_draft(body: PolicyTextIn, user: dict = Depends(require_administrator),
                     db: Session = Depends(get_db)):
    """Save work in progress. The published text and version do not change,
    so nobody is re-prompted."""
    import cache
    title, text = _clean_text(body)
    cfg = _load(db)
    cfg["draft"] = {"title": title, "body": text,
                    "savedAt": datetime.now(timezone.utc).isoformat(), "savedBy": user["email"]}
    _save(db, cfg, user)
    db.commit()
    cache.settings_config.invalidate()
    return {"published": cfg["published"], "draft": cfg["draft"]}


@router.delete("/draft")
def admin_discard_draft(user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    import cache
    cfg = _load(db)
    cfg["draft"] = None
    _save(db, cfg, user)
    db.commit()
    cache.settings_config.invalidate()
    return {"published": cfg["published"], "draft": None}


@router.post("/publish")
def admin_publish(body: PolicyTextIn, user: dict = Depends(require_administrator),
                  db: Session = Depends(get_db)):
    """Make this text the policy everyone must accept. Sets a new version, so
    everyone (including people who accepted the old one) is asked again at
    their next sign-in. Clears the draft."""
    import cache
    title, text = _clean_text(body)
    cfg = _load(db)
    old = cfg["published"]["version"]
    now = datetime.now(timezone.utc)
    version = _next_version(old, now.date().isoformat())
    cfg["published"] = {"title": title, "body": text, "version": version,
                        "publishedAt": now.isoformat(), "publishedBy": user["email"]}
    cfg["draft"] = None
    _save(db, cfg, user)
    _audit(db, user, f"Published sign-in policy version {version}",
           {"previousVersion": old, "version": version, "title": title})
    db.commit()
    cache.settings_config.invalidate()
    return {"published": cfg["published"], "draft": None}


def _report(db: Session) -> dict:
    """Active internal employees vs acceptances of the CURRENT version."""
    version = current_version(db)
    emps = (db.query(models.NexusEmployee)
            .filter(models.NexusEmployee.status == "active",
                    models.NexusEmployee.work_email != "")
            .all())
    people = {}
    for e in emps:
        if (e.identity_type or "internal") != "internal" or (e.deleted_at or ""):
            continue
        email = (e.work_email or "").strip().lower()
        if email:
            people[email] = e
    accepted = {}
    if people:
        for r in (db.query(PolicyAcknowledgment)
                  .filter(PolicyAcknowledgment.version == version).all()):
            if r.email in people:
                accepted[r.email] = r.accepted_at
    entity_names = {h.id: h.name for h in db.query(models.HrEntity).all()}

    def person(email, e):
        name = (e.display_name or f"{e.first_name or ''} {e.last_name or ''}").strip() or email
        return {"name": name, "email": email, "department": e.department or "",
                "company": entity_names.get(e.company or "", "")}

    pending = sorted((person(em, e) for em, e in people.items() if em not in accepted),
                     key=lambda p: p["name"].lower())
    return {"version": version, "total": len(people), "accepted": len(accepted),
            "pending": pending}


@router.get("/report")
def admin_report(user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    return _report(db)


@router.get("/report.csv")
def admin_report_csv(user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    """Everyone who has not accepted the current version, for follow-up."""
    rep = _report(db)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Name", "Email", "Department", "Company", "Policy Version"])
    for p in rep["pending"]:
        w.writerow([p["name"], p["email"], p["department"], p["company"], rep["version"]])
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="policy-not-accepted.csv"'})
