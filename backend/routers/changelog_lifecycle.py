"""What's New after release (Oct 18 2026): what happens to an update once it
is out, and to the requests people raise.

  - Feature requests have a status (New, Under Review, Planned, In Progress,
    Shipped, Declined) set from Manage. The requester's bell rings once per
    status, one row per request updated in place. Shipped names the update
    that delivered it, and that bell waits until the update is released
    (on_released calls notify_shipped). Anyone can also raise a request on
    its own, not tied to an update (entry_id '').
  - Known issues and rollbacks: an admin marks a released update Known Issue
    or Rolled Back (payload.issue), then Resolved, optionally naming the fix.
    The people who read the update and the people who follow its module or
    category get a bell, one row per person and update, updated in place.
    An active issue shows on the screen it names (the hints) whatever its age.
  - Deprecations: payload.deprecation = {removeOn: YYYY-MM-DD, what,
    replacement}. A countdown shows on the update and on its screen; the
    bell reminds the people it concerns 7 days and 1 day before
    (deprecation_tick, every poll of changelog_auto).
  - Guided tours: payload.tour = steps {title, body, image, selector}. The
    hint on the screen and the update offer Take the Tour; finishing it
    stamps changelog_entry_views.tour_done_at (the insights count them).
  - Live in production: on the DEV deployment a merged update is Dev Only
    until its merge commit is on main; sync_production asks GitHub and
    stamps payload.prodAt. Prod's own updates are written when they reach
    main, so they are live by definition.

issue, prodAt and mergeSha are written ONLY here: clean_payload keeps the
stored values whatever an edit form sends back.
"""
import json
import os
from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import changelog_reach as reach
import models
from auth import get_current_user, require_level
from database import get_db
from routers.task_util import gen_id, now_iso

router = APIRouter(tags=["What's New"])

REQUEST_STATUSES = ("New", "Under Review", "Planned", "In Progress", "Shipped", "Declined")
ISSUE_KINDS = ("known", "rolledBack")
REQUEST_REF = "whats-new-request:"          # + feedback id
ISSUE_REF = "whats-new-issue:"              # + entry id
DEPRECATION_REF = "whats-new-deprecation:"  # + entry id
SERVER_OWNED = ("issue", "prodAt", "mergeSha")
TOUR_MAX_STEPS = 8
MAX_IMAGES = 12
MAX_ATTACHMENTS = 10
INLINE_IMAGE_MAX = 2_800_000                # a data: URL (no storage configured, local dev)
PROD_SCAN_DAYS = 90
PROD_SCAN_MAX = 30
PROD_STATE_KEY = "changelog_prod_state"
PROD_EVERY_MINUTES = 10
_PACIFIC = ZoneInfo("America/Los_Angeles")


def _entry(db: Session, entry_id: str):
    return db.query(models.TaskChangelogEntry).filter(models.TaskChangelogEntry.id == entry_id).first()


def _entry_or_404(db: Session, entry_id: str):
    e = _entry(db, entry_id)
    if not e:
        raise HTTPException(404, "Changelog entry not found")
    return e


def _released(p: dict) -> bool:
    return reach.status_of(p) == "Released"


# ── Payload: server-owned fields, media and tours ──────────────────────────

def _check_url(url: str, field: str, allow_inline: bool) -> str:
    from routers.items import _validate_photo_url
    u = str(url or "").strip()
    if not u:
        return ""
    if u.startswith("data:"):
        if not allow_inline or not u.startswith("data:image/") or len(u) > INLINE_IMAGE_MAX:
            raise HTTPException(400, f"{field} must be uploaded to Nexus storage")
        return u
    _validate_photo_url(u, field)
    return u


def _clean_tour(steps) -> list:
    out = []
    for s in (steps or [])[:TOUR_MAX_STEPS]:
        if not isinstance(s, dict):
            continue
        title, body = str(s.get("title") or "").strip()[:120], str(s.get("body") or "").strip()[:1000]
        if not (title or body):
            continue
        out.append({"title": title, "body": body,
                    "image": _check_url(s.get("image"), "Tour image", True),
                    "selector": str(s.get("selector") or "").strip()[:200]})
    return out


def clean_payload(payload: dict, before: Optional[dict]) -> dict:
    """The payload an add or edit form sent, made safe to store: server-owned
    fields come from what is stored (never from the form), gallery images,
    attachments and tour images must live in Nexus storage, and a
    deprecation keeps its sent reminders unless its date moved."""
    p = dict(payload or {})
    before = before or {}
    for k in SERVER_OWNED:
        p.pop(k, None)
        if k in before:
            p[k] = before[k]
    if "images" in p:
        p["images"] = [u for u in (_check_url(x, "Screenshot", True) for x in (p.get("images") or [])[:MAX_IMAGES]) if u]
    if "attachments" in p:
        files = []
        for a in (p.get("attachments") or [])[:MAX_ATTACHMENTS]:
            if not isinstance(a, dict):
                continue
            url = _check_url(a.get("url"), "Attachment", False)
            if url:
                files.append({"name": str(a.get("name") or "File")[:200], "url": url,
                              "size": int(a.get("size") or 0), "type": str(a.get("type") or "")[:100]})
        p["attachments"] = files
    if "tour" in p:
        p["tour"] = _clean_tour(p.get("tour"))
    dep = p.get("deprecation")
    if isinstance(dep, dict) and dep.get("removeOn"):
        try:
            day = datetime.strptime(str(dep["removeOn"])[:10], "%Y-%m-%d").date().isoformat()
        except ValueError:
            raise HTTPException(400, "The removal date is not a date")
        old = before.get("deprecation") if isinstance(before.get("deprecation"), dict) else {}
        p["deprecation"] = {"removeOn": day, "what": str(dep.get("what") or "").strip()[:200],
                            "replacement": str(dep.get("replacement") or "").strip()[:200],
                            "reminded": list(old.get("reminded") or []) if old.get("removeOn") == day else []}
    else:
        p.pop("deprecation", None)
    return p


# ── Feature requests ───────────────────────────────────────────────────────

def _status(r) -> str:
    return r.status if r.status in REQUEST_STATUSES else "New"


def _titles(db: Session, ids) -> dict:
    ids = [i for i in set(ids) if i]
    if not ids:
        return {}
    return {e.id: (reach.payload_of(e).get("title") or "Update", _released(reach.payload_of(e)))
            for e in db.query(models.TaskChangelogEntry).filter(models.TaskChangelogEntry.id.in_(ids)).all()}


def request_dict(r, titles: dict) -> dict:
    origin, shipped = titles.get(r.entry_id), titles.get(r.shipped_entry_id)
    return {"id": r.id, "entryId": r.entry_id or "", "entryTitle": origin[0] if origin else "",
            "module": r.module or "", "email": r.email, "note": r.note or "", "at": r.created_at or "",
            "status": _status(r), "statusNote": r.status_note or "", "statusBy": r.status_by or "",
            "statusAt": r.status_at or "", "shippedEntryId": r.shipped_entry_id or "",
            "shippedTitle": shipped[0] if shipped else "", "shippedReleased": bool(shipped and shipped[1])}


_REQUEST_WORDS = {
    "Under Review": "Your Request Is Under Review", "Planned": "Your Request Is Planned",
    "In Progress": "Your Request Is In Progress", "Shipped": "Your Request Shipped",
    "Declined": "Update on Your Request",
}


def notify_request(db: Session, r) -> bool:
    """Ring the requester's bell for the request's current status, once per
    status. Shipped waits for its update's release. Caller commits."""
    st = _status(r)
    if st == "New" or (r.notified_status or "") == st:
        return False
    link = r.shipped_entry_id if st == "Shipped" and r.shipped_entry_id else r.entry_id
    if st == "Shipped" and r.shipped_entry_id:
        shipped = _entry(db, r.shipped_entry_id)
        if shipped is None or not _released(reach.payload_of(shipped)):
            return False
    if link:
        e = _entry(db, link)
        if e is None or not reach.visible(reach.payload_of(e), reach.viewer(db, {"email": r.email, "level": reach._level(db, r.email)})):
            link = ""
    body = f"\"{(r.note or '').strip()[:140]}\""
    if st == "Shipped" and r.shipped_entry_id and link:
        body += f" - it is in \"{reach.payload_of(_entry(db, link)).get('title') or 'an update'}\"."
    if (r.status_note or "").strip():
        body += f" {r.status_note.strip()[:200]}"
    reach._bell(db, r.email, REQUEST_REF + r.id, _REQUEST_WORDS[st], body[:400], entry_id=link)
    r.notified_status = st
    return True


def notify_shipped(db: Session, entries: list) -> int:
    """An update just released: tell the people whose request it shipped."""
    ids = [e.id for e in entries]
    if not ids:
        return 0
    F = models.ChangelogFeedback
    rows = db.query(F).filter(F.kind == "request", F.shipped_entry_id.in_(ids), F.status == "Shipped").all()
    told = sum(1 for r in rows if notify_request(db, r))
    if told:
        db.commit()
    return told


@router.get("/task-changelog/my-requests")
def my_requests(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = (user["email"] or "").lower()
    F = models.ChangelogFeedback
    rows = db.query(F).filter(F.kind == "request", F.email == email).order_by(F.created_at.desc()).all()
    titles = _titles(db, [r.entry_id for r in rows] + [r.shipped_entry_id for r in rows])
    return [request_dict(r, titles) for r in rows]


class NewRequestBody(BaseModel):
    note: str
    module: str = ""


@router.post("/task-changelog/requests", status_code=201)
def raise_request(body: NewRequestBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """A request of its own, not raised from an update."""
    note = (body.note or "").strip()
    if not note:
        raise HTTPException(400, "Say what you would like")
    r = models.ChangelogFeedback(id=gen_id(), entry_id="", email=(user["email"] or "").lower(), kind="request",
                                 helpful=1, note=note[:2000], created_at=now_iso(), status="",
                                 module=(body.module or "").strip()[:80])
    db.add(r)
    db.commit()
    return request_dict(r, {})


class RequestStatusBody(BaseModel):
    status: str
    note: str = ""
    shippedEntryId: str = ""


@router.patch("/task-changelog-admin/requests/{request_id}")
def set_request_status(request_id: str, body: RequestStatusBody, user: dict = Depends(require_level(3)),
                       db: Session = Depends(get_db)):
    F = models.ChangelogFeedback
    r = db.query(F).filter(F.id == request_id, F.kind == "request").with_for_update().first()
    if r is None:
        raise HTTPException(404, "Request not found")
    if body.status not in REQUEST_STATUSES:
        raise HTTPException(400, "Unknown status")
    shipped = (body.shippedEntryId or "").strip() if body.status == "Shipped" else ""
    if shipped and _entry(db, shipped) is None:
        raise HTTPException(400, "That update no longer exists")
    changed = body.status != _status(r) or shipped != (r.shipped_entry_id or "")
    r.status = "" if body.status == "New" else body.status
    r.status_note = (body.note or "").strip()[:1000]
    r.shipped_entry_id = shipped
    if changed:
        r.status_by, r.status_at = (user["email"] or "").lower(), now_iso()
        if r.notified_status == body.status:
            r.notified_status = ""          # a new shipped-in update is news again
    notify_request(db, r)
    db.commit()
    return request_dict(r, _titles(db, [r.entry_id, r.shipped_entry_id]))


# ── Known issues and rollbacks ─────────────────────────────────────────────

def issue_active(p: dict) -> bool:
    i = p.get("issue")
    return isinstance(i, dict) and i.get("kind") in ISSUE_KINDS and not i.get("resolvedAt")


def _issue_people(db: Session, e, p: dict) -> set:
    """Who hears about an issue: everyone who read the update, and the
    people following its module or category."""
    people = {v.email for v in db.query(models.ChangelogEntryView.email)
              .filter(models.ChangelogEntryView.entry_id == e.id).all() if v.email}
    for sub in db.query(models.ChangelogSubscription).all():
        if reach._matches(sub, p):
            people.add(sub.email)
    return people


def _ring(db: Session, emails, ref: str, title: str, body: str, entry_id: str, p: dict, skip: str = "") -> int:
    told = 0
    for email in sorted(emails):
        email = (email or "").lower()
        if not email or email == skip:
            continue
        if not reach.visible(p, reach.viewer(db, {"email": email, "level": reach._level(db, email)})):
            continue
        reach._bell(db, email, ref, title, body, entry_id=entry_id)
        told += 1
    return told


def notify_issue(db: Session, e, actor: str) -> int:
    try:
        p = reach.payload_of(e)
        i = p.get("issue") or {}
        name = (p.get("title") or "An update")[:120]
        if i.get("resolvedAt"):
            title = f"Fixed: {name}"
            body = (i.get("resolvedNote") or "It works as described again.")[:300]
        else:
            title = f"{'Rolled Back' if i.get('kind') == 'rolledBack' else 'Known Issue'}: {name}"
            body = (i.get("note") or "")[:240] + (f" Workaround: {i['workaround'][:150]}" if i.get("workaround") else "")
        told = _ring(db, _issue_people(db, e, p), ISSUE_REF + e.id, title, body.strip(), e.id, p, skip=(actor or "").lower())
        db.commit()
        return told
    except Exception as ex:  # noqa: BLE001 - the issue is saved; a notice must not undo it
        db.rollback()
        print(f"[changelog] issue notices failed: {ex}")
        return 0


class IssueBody(BaseModel):
    kind: str = "known"
    note: str
    workaround: str = ""


@router.post("/task-changelog-admin/{entry_id}/issue")
def raise_issue(entry_id: str, body: IssueBody, user: dict = Depends(require_level(3)), db: Session = Depends(get_db)):
    if body.kind not in ISSUE_KINDS:
        raise HTTPException(400, "Unknown issue kind")
    note = (body.note or "").strip()
    if not note:
        raise HTTPException(400, "Say what is wrong")
    e = db.query(models.TaskChangelogEntry).filter(models.TaskChangelogEntry.id == entry_id).with_for_update().first()
    if e is None:
        raise HTTPException(404, "Changelog entry not found")
    p = dict(reach.payload_of(e))
    if not _released(p):
        raise HTTPException(400, "Only a released update can have an issue")
    me = (user["email"] or "").lower()
    old = p.get("issue") if isinstance(p.get("issue"), dict) else {}
    keep_at = issue_active(p)
    p["issue"] = {"kind": body.kind, "note": note[:1000], "workaround": (body.workaround or "").strip()[:500],
                  "at": old.get("at") if keep_at else now_iso(), "by": old.get("by") if keep_at else me}
    e.payload, e.updated_at = p, now_iso()
    reach.record_history(db, e.id, me, "issue", {"issue": [old or None, p["issue"]]})
    db.commit()
    notify_issue(db, e, me)
    from routers.task_config import changelog_entry_to_dict
    return changelog_entry_to_dict(e)


class ResolveBody(BaseModel):
    note: str = ""
    fixEntryId: str = ""


@router.post("/task-changelog-admin/{entry_id}/issue/resolve")
def resolve_issue(entry_id: str, body: ResolveBody, user: dict = Depends(require_level(3)), db: Session = Depends(get_db)):
    e = db.query(models.TaskChangelogEntry).filter(models.TaskChangelogEntry.id == entry_id).with_for_update().first()
    if e is None:
        raise HTTPException(404, "Changelog entry not found")
    p = dict(reach.payload_of(e))
    if not issue_active(p):
        raise HTTPException(400, "This update has no open issue")
    fix = (body.fixEntryId or "").strip()
    if fix and (fix == entry_id or _entry(db, fix) is None):
        raise HTTPException(400, "Pick another update as the fix")
    me = (user["email"] or "").lower()
    old = dict(p["issue"])
    p["issue"] = {**old, "resolvedAt": now_iso(), "resolvedBy": me, "resolvedNote": (body.note or "").strip()[:500],
                  "fixId": fix}
    e.payload, e.updated_at = p, now_iso()
    reach.record_history(db, e.id, me, "resolved", {"issue": [old, p["issue"]]})
    db.commit()
    notify_issue(db, e, me)
    from routers.task_config import changelog_entry_to_dict
    return changelog_entry_to_dict(e)


@router.delete("/task-changelog-admin/{entry_id}/issue")
def clear_issue(entry_id: str, user: dict = Depends(require_level(3)), db: Session = Depends(get_db)):
    """Raised by mistake: take it off, and its bell rows with it."""
    e = db.query(models.TaskChangelogEntry).filter(models.TaskChangelogEntry.id == entry_id).with_for_update().first()
    if e is None:
        raise HTTPException(404, "Changelog entry not found")
    p = dict(reach.payload_of(e))
    old = p.pop("issue", None)
    e.payload, e.updated_at = p, now_iso()
    reach.record_history(db, e.id, (user["email"] or "").lower(), "issue cleared", {"issue": [old, None]})
    db.query(models.NexusNotification).filter(models.NexusNotification.ref_id == ISSUE_REF + entry_id).delete()
    db.commit()
    from routers.task_config import changelog_entry_to_dict
    return changelog_entry_to_dict(e)


# ── Deprecations ───────────────────────────────────────────────────────────

def _today() -> datetime:
    return datetime.now(_PACIFIC)


def days_left(p: dict, today=None):
    dep = p.get("deprecation") if isinstance(p.get("deprecation"), dict) else {}
    try:
        day = datetime.strptime(str(dep.get("removeOn") or "")[:10], "%Y-%m-%d").date()
    except ValueError:
        return None
    return (day - (today or _today().date())).days


def _deprecation_people(db: Session, e, p: dict, pop: dict) -> set:
    aud = p.get("audience") if isinstance(p.get("audience"), dict) else {}
    if aud.get("modules") or aud.get("companies"):
        people = reach.audience_of(p, pop)
    elif p.get("screen"):
        people = set(pop["by_module"].get(p["screen"], set())) & set(pop["people"])
    else:
        people = set()
    return people | _issue_people(db, e, p)


def deprecation_tick(db: Session, now: Optional[datetime] = None) -> int:
    """Remind the people a deprecation concerns, 7 days and 1 day before.
    Each stage once (payload.deprecation.reminded, under a row lock: several
    workers may tick). Returns how many bells rang."""
    today = (now or datetime.now(timezone.utc)).astimezone(_PACIFIC).date()
    due = []
    for e in db.query(models.TaskChangelogEntry).all():
        p = reach.payload_of(e)
        left = days_left(p, today)
        if left is None or left < 0 or left > 7 or not _released(p) or p.get("hidden"):
            continue
        stage = "1d" if left <= 1 else "7d"
        if stage not in ((p.get("deprecation") or {}).get("reminded") or []):
            due.append(e.id)
    if not due:
        return 0
    pop = reach.population(db)
    told = 0
    for eid in due:
        e = db.query(models.TaskChangelogEntry).filter(models.TaskChangelogEntry.id == eid).with_for_update().first()
        p = dict(reach.payload_of(e)) if e else {}
        left = days_left(p, today)
        if e is None or left is None or left < 0:
            db.rollback()
            continue
        dep = dict(p["deprecation"])
        stage = "1d" if left <= 1 else "7d"
        if stage in (dep.get("reminded") or []):
            db.rollback()
            continue
        dep["reminded"] = sorted(set((dep.get("reminded") or []) + (["7d", "1d"] if stage == "1d" else ["7d"])))
        p["deprecation"] = dep
        e.payload = p
        what = dep.get("what") or p.get("title") or "A feature"
        when = datetime.strptime(dep["removeOn"], "%Y-%m-%d").strftime("%m/%d/%Y")
        title = "Going Away Today" if left == 0 else "Going Away Tomorrow" if left == 1 else f"Going Away in {left} Days"
        body = f"{what} goes away on {when}." + (f" Use {dep['replacement']} instead." if dep.get("replacement") else "")
        told += _ring(db, _deprecation_people(db, e, p, pop), DEPRECATION_REF + e.id, title, body[:400], e.id, p)
        db.commit()
    return told


# ── What the screen you are on should say ──────────────────────────────────

def screen_notices(db: Session, view: str, ctx: dict) -> list:
    """Active issues and coming removals for this screen, whatever their age
    (changelog_extras.changelog_hints adds them before the new updates)."""
    out = []
    today = _today().date()
    for e in db.query(models.TaskChangelogEntry).all():
        p = reach.payload_of(e)
        if p.get("screen") != view or p.get("hidden") or not reach.visible(p, ctx):
            continue
        base = {"id": e.id, "title": p.get("title") or "Update", "type": p.get("type") or "Update"}
        if issue_active(p):
            i = p["issue"]
            out.append({**base, "kind": "issue", "issueKind": i.get("kind"), "note": i.get("note") or "",
                        "workaround": i.get("workaround") or "", "stamp": i.get("at") or ""})
        left = days_left(p, today)
        if left is not None and 0 <= left <= 60:
            dep = p["deprecation"]
            out.append({**base, "kind": "deprecation", "removeOn": dep["removeOn"], "daysLeft": left,
                        "what": dep.get("what") or "", "replacement": dep.get("replacement") or "",
                        "stamp": dep["removeOn"]})
    out.sort(key=lambda r: (r["kind"] != "issue", r.get("daysLeft", 0)))
    return out


# ── Guided tours ───────────────────────────────────────────────────────────

@router.get("/task-changelog/{entry_id}/tour")
def get_tour(entry_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    e = _entry_or_404(db, entry_id)
    p = reach.payload_of(e)
    if not reach.visible(p, reach.viewer(db, user)) or not p.get("tour"):
        raise HTTPException(404, "No tour for this update")
    V = models.ChangelogEntryView
    mine = db.query(V).filter(V.entry_id == entry_id, V.email == (user["email"] or "").lower()).first()
    return {"id": e.id, "title": p.get("title") or "Update", "screen": p.get("screen") or "",
            "steps": p.get("tour") or [], "doneAt": (mine.tour_done_at if mine else "") or ""}


@router.post("/task-changelog/{entry_id}/tour-done")
def tour_done(entry_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _entry_or_404(db, entry_id)
    email = (user["email"] or "").lower()
    V = models.ChangelogEntryView
    row = db.query(V).filter(V.entry_id == entry_id, V.email == email).first()
    now = now_iso()
    if row is None:
        row = V(id=gen_id(), entry_id=entry_id, email=email, views=1, first_at=now, last_at=now)
        db.add(row)
    row.tour_done_at = now
    db.commit()
    return {"ok": True, "doneAt": now}


# ── Live in production ─────────────────────────────────────────────────────

def _read_state(db: Session) -> dict:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == PROD_STATE_KEY).first()
    try:
        return json.loads(row.value) if row and row.value else {}
    except (TypeError, ValueError):
        return {}


def _write_state(db: Session, state: dict) -> None:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == PROD_STATE_KEY).first()
    if not row:
        row = models.NexusSetting(key=PROD_STATE_KEY)
        db.add(row)
    row.value, row.updated_by, row.updated_at = json.dumps(state), "system", now_iso()
    db.commit()


def _candidates(db: Session) -> list:
    floor = datetime.now(timezone.utc) - timedelta(days=PROD_SCAN_DAYS)
    rows = []
    for e in db.query(models.TaskChangelogEntry).all():
        p = reach.payload_of(e)
        if p.get("origin") != "pr" or p.get("prodAt") or not _released(p):
            continue
        at = reach._instant(p.get("mergedAt") or p.get("releasedAt") or e.created_at)
        if at and at > floor:
            rows.append((at, e))
    rows.sort(key=lambda r: r[0])
    return [e for _, e in rows[:PROD_SCAN_MAX]]


def sync_production(db: Session) -> dict:
    """Stamp prodAt on the dev site's merged updates whose commit is on main."""
    import changelog_prs
    from routers.task_config import deployment_branch
    if deployment_branch() == "main":
        return {"production": True, "checked": 0, "live": 0,
                "message": "This is the production site - every update here is live."}
    if not changelog_prs._token():
        return {"checked": 0, "live": 0, "message": "GITHUB_TOKEN is not set on this server."}
    todo = _candidates(db)
    live = checked = 0
    try:
        with changelog_prs._client() as client:
            for e in todo:
                p = dict(reach.payload_of(e))
                sha = p.get("mergeSha") or ""
                try:
                    if not sha and p.get("prNumber"):
                        sha = changelog_prs._get(client, f"/pulls/{p['prNumber']}").get("merge_commit_sha") or ""
                    if not sha and p.get("commitShas"):
                        sha = str(p["commitShas"][-1])
                    if not sha:
                        continue
                    cmp = changelog_prs._get(client, f"/compare/main...{sha}", per_page=1)
                except changelog_prs.GitHubError as ex:
                    print(f"[changelog] production check of {e.id} failed: {ex}")
                    continue
                checked += 1
                p["mergeSha"] = sha
                if cmp.get("status") in ("behind", "identical"):
                    p["prodAt"] = now_iso()
                    live += 1
                e.payload = p
            db.commit()
    except Exception as ex:  # noqa: BLE001 - httpx errors and the like: try again next tick
        db.rollback()
        return {"checked": checked, "live": live, "message": f"Could not reach GitHub ({type(ex).__name__})."}
    msg =(f"{live} more update{'' if live == 1 else 's'} reached production." if live
           else "Nothing new has reached production." if todo else "Every merged update is already in production.")
    return {"checked": checked, "live": live, "message": msg}


def sync_production_if_due(db: Session) -> None:
    """The changelog loop's tick: on the dev site, at most every 10 minutes."""
    from routers.task_config import deployment_branch
    if deployment_branch() != "dev" or os.getenv("NEXUS_CHANGELOG_PROD_SYNC", "true").lower() == "false":
        return
    state = _read_state(db)
    last = reach._instant(state.get("at"))
    if last and datetime.now(timezone.utc) - last < timedelta(minutes=PROD_EVERY_MINUTES):
        return
    _write_state(db, {"at": now_iso()})
    result = sync_production(db)
    _write_state(db, {"at": now_iso(), **result})


@router.post("/task-changelog-admin/check-production")
def check_production(user: dict = Depends(require_level(3)), db: Session = Depends(get_db)):
    result = sync_production(db)
    if not result.get("production"):
        _write_state(db, {"at": now_iso(), **result})
    return result
