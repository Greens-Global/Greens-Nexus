"""Who sees a What's New update, and who hears about it (Oct 16 2026).

  - Audience: an update can be aimed at some modules (the people with a grant
    to any of them) and/or some companies (NexusEmployee.company). No audience
    = everyone. Hidden updates and anything not Released are for admins (and
    the update's own author) only. visible() is the one rule - the list, the
    weekly bar, the feed, the digest and the screen hints all call it.
  - Scheduled: an update with status Scheduled and a `scheduledFor` instant
    goes out by itself once that time passes (promote_scheduled, run on read
    and every minute in the changelog loop).
  - Following: a person follows modules and categories
    (ChangelogSubscription); a released update that matches lands in their
    bell - ONE "Updates You Follow" row per person, updated in place.
  - Comments: a reply, an @mention or a comment on your update rings your
    bell - one row per person and update, updated in place.
  - Digest: the Monday email of last week's updates for people who opted in,
    sent from the deployed API only (changelog_auto's loop).
"""
import json
import uuid
from datetime import datetime, timedelta, timezone
from html import escape
from zoneinfo import ZoneInfo

import models

ADMIN_LEVEL = 3
FOLLOW_REF = "whats-new-follow"
COMMENT_REF = "whats-new-comment:"          # + entry id
DIGEST_STATE_KEY = "changelog_digest_state"
HISTORY_FIELDS = ("title", "description", "type", "module", "version", "environment", "status",
                  "businessImpact", "userImpact", "whatsChanged", "tags", "audience", "hidden",
                  "pinned", "breaking", "actionRequired", "scheduledFor", "videoUrl", "relatedIds",
                  "screen", "links")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _instant(value):
    s = str(value or "").strip()
    if not s:
        return None
    try:
        at = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if at.tzinfo is None:
        at = at.replace(tzinfo=ZoneInfo("America/Los_Angeles"))
    return at.astimezone(timezone.utc)


def payload_of(e) -> dict:
    return e.payload if isinstance(e.payload, dict) else {}


def status_of(p: dict) -> str:
    return p.get("status") or ("Pending Review" if p.get("origin") == "pr" else "Released")


# ── Who sees what ──────────────────────────────────────────────────────────

def viewer(db, user: dict) -> dict:
    """What visible() needs to know about the person reading."""
    from auth import _grants_for
    email = (user.get("email") or "").lower()
    emp = db.query(models.NexusEmployee.company).filter(models.NexusEmployee.work_email == email).first()
    return {
        "email": email,
        "admin": int(user.get("level") or 0) >= ADMIN_LEVEL,
        "modules": set(_grants_for(email, db).keys()) if email else set(),
        "company": (emp[0] if emp else "") or "",
    }


def in_audience(p: dict, ctx: dict) -> bool:
    aud = p.get("audience") if isinstance(p.get("audience"), dict) else {}
    mods = [m for m in (aud.get("modules") or []) if m]
    comps = [c for c in (aud.get("companies") or []) if c]
    if mods and not (set(mods) & ctx["modules"]):
        return False
    if comps and ctx["company"] not in comps:
        return False
    return True


def visible(p: dict, ctx: dict) -> bool:
    if ctx["admin"]:
        return True
    if (p.get("authorId") or "").lower() == ctx["email"] and ctx["email"]:
        return True                       # your own submission, whatever its status
    if status_of(p) != "Released" or p.get("hidden"):
        return False
    return in_audience(p, ctx)


# ── Scheduled releases ─────────────────────────────────────────────────────

def promote_scheduled(db) -> list:
    """Release every Scheduled update whose time has come. Returns them."""
    now = datetime.now(timezone.utc)
    due = []
    for e in db.query(models.TaskChangelogEntry).all():
        p = payload_of(e)
        if p.get("status") != "Scheduled":
            continue
        at = _instant(p.get("scheduledFor"))
        if not at or at > now:
            continue
        p = dict(p)
        p.update(status="Released", releasedAt=at.isoformat(), publishedAt=now.isoformat(), publishedBy="schedule")
        e.payload = p
        e.updated_at = now.isoformat()
        record_history(db, e.id, "schedule", "published", {})
        due.append(e)
    if due:
        db.commit()
        on_released(db, due)
    return due


# ── Edit history ───────────────────────────────────────────────────────────

def _short(v):
    if isinstance(v, str):
        return v[:500]
    try:
        s = json.dumps(v, default=str)
    except (TypeError, ValueError):
        s = str(v)
    return v if len(s) <= 500 else s[:500]


def diff(old: dict, new: dict) -> dict:
    out = {}
    for f in HISTORY_FIELDS:
        a, b = old.get(f), new.get(f)
        if (a in (None, "", [], {}) and b in (None, "", [], {})) or a == b:
            continue
        out[f] = [_short(a), _short(b)]
    return out


def record_history(db, entry_id: str, by: str, action: str, changes: dict) -> None:
    if action == "edit" and not changes:
        return
    db.add(models.ChangelogEntryHistory(id=str(uuid.uuid4()), entry_id=entry_id, at=now_iso(),
                                        by_email=(by or "").lower(), action=action, changes=changes or {}))


# ── Bell notices ───────────────────────────────────────────────────────────

def _bell(db, email: str, ref: str, title: str, body: str, entry_id: str = "") -> None:
    """One row per person and ref, updated in place (CLAUDE.md)."""
    from notify_company import notification_company
    row = (db.query(models.NexusNotification)
           .filter(models.NexusNotification.recipient == email, models.NexusNotification.ref_id == ref)
           .order_by(models.NexusNotification.created_at.desc()).first())
    action = json.dumps({"view": "whats-new", **({"sub": entry_id} if entry_id else {})})   # /whats-new/<id> opens it
    if row is not None:
        row.title, row.body, row.created_at, row.read_by, row.actioned, row.closed_by = title, body, now_iso(), "", False, ""
        row.action = action
        return
    db.add(models.NexusNotification(
        id=str(uuid.uuid4()), type="whats_new", recipient=email, title=title, body=body, ref_id=ref,
        item_name="", requested_by="", action=action, actioned=False, read_by="",
        company=notification_company(db, email), created_at=now_iso()))


def _matches(sub, p: dict) -> bool:
    mods = {str(m).lower() for m in (sub.modules or [])}
    cats = {str(c).lower() for c in (sub.categories or [])}
    return ((p.get("module") or "").lower() in mods) or ((p.get("type") or "").lower() in cats)


def on_released(db, entries: list) -> int:
    """Bell the followers of each newly released update. Returns how many
    people were told. Never raises - a release must not fail on a notice."""
    try:
        subs = db.query(models.ChangelogSubscription).all() if entries else []
        told = 0
        for sub in subs:
            if not (sub.modules or sub.categories):
                continue
            ctx = None
            mine = []
            for e in entries:
                p = payload_of(e)
                if p.get("hidden") or not _matches(sub, p):
                    continue
                if ctx is None:
                    ctx = viewer(db, {"email": sub.email, "level": _level(db, sub.email)})
                if visible(p, ctx):
                    mine.append(p.get("title") or "Update")
            if mine:
                body = (f"{len(mine)} new: " if len(mine) > 1 else "") + ", ".join(mine)[:280]
                _bell(db, sub.email, FOLLOW_REF, "Updates You Follow", body,
                      entry_id=entries[0].id if len(entries) == 1 else "")
                told += 1
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        print(f"[changelog] follower notices failed: {e}")
        told = 0
    try:
        # Requests this release shipped (changelog_lifecycle, Oct 18 2026).
        from routers.changelog_lifecycle import notify_shipped
        notify_shipped(db, entries or [])
    except Exception as e:  # noqa: BLE001
        db.rollback()
        print(f"[changelog] shipped-request notices failed: {e}")
    return told


def _level(db, email: str) -> int:
    from auth import level_for
    try:
        return level_for(email, db)
    except Exception:  # noqa: BLE001
        return 1


def on_comment(db, entry, comment, actor: str) -> int:
    """Bell the people a comment is for: anyone it @mentions, the author of
    the comment it answers, and the update's author and developers."""
    try:
        p = payload_of(entry)
        actor = (actor or "").lower()
        to = {}
        for m in (comment.mentions or []):
            to[str(m).lower()] = "mentioned you"
        if comment.parent_id:
            parent = db.query(models.TaskChangelogComment).filter(models.TaskChangelogComment.id == comment.parent_id).first()
            if parent and parent.author_email:
                to.setdefault(parent.author_email.lower(), "replied to you")
        owners = [p.get("authorId") or ""] + [d.get("email") or "" for d in (p.get("developers") or []) if isinstance(d, dict)]
        for o in owners:
            if o:
                to.setdefault(o.lower(), "commented on your update")
        to.pop(actor, None)
        if not to:
            return 0
        name = _display_name(db, actor)
        title = (p.get("title") or "an update")[:120]
        for email, why in to.items():
            ctx = viewer(db, {"email": email, "level": _level(db, email)})
            if not visible(p, ctx):
                continue
            _bell(db, email, COMMENT_REF + entry.id, f"{name} {why}",
                  f"On \"{title}\": {(comment.body or '')[:200]}", entry_id=entry.id)
        db.commit()
        return len(to)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        print(f"[changelog] comment notices failed: {e}")
        return 0


def _display_name(db, email: str) -> str:
    emp = (db.query(models.NexusEmployee.first_name, models.NexusEmployee.last_name)
           .filter(models.NexusEmployee.work_email == email).first())
    if emp and (emp[0] or emp[1]):
        return f"{emp[0] or ''} {emp[1] or ''}".strip()
    return email.split("@")[0] if email else "Someone"


# ── Reach: who an update is FOR, for the read rate ─────────────────────────

def population(db) -> dict:
    """Active people, {email: company}, and module -> emails with a grant."""
    people = {}
    for email, company, status in db.query(models.NexusEmployee.work_email, models.NexusEmployee.company,
                                            models.NexusEmployee.status).all():
        if email and (status or "active") == "active":
            people[email.lower()] = company or ""
    by_module: dict = {}
    for modules, email in (db.query(models.NexusGroup.allowed_modules, models.NexusGroupMember.email)
                           .join(models.NexusGroupMember, models.NexusGroupMember.group_id == models.NexusGroup.id).all()):
        for part in (modules or "").split(","):
            mid = part.strip().partition(":")[0]
            if mid and email:
                by_module.setdefault(mid, set()).add(email.lower())
    return {"people": people, "by_module": by_module}


def audience_of(p: dict, pop: dict) -> set:
    aud = p.get("audience") if isinstance(p.get("audience"), dict) else {}
    mods = [m for m in (aud.get("modules") or []) if m]
    comps = [c for c in (aud.get("companies") or []) if c]
    out = set(pop["people"])
    if mods:
        allowed = set()
        for m in mods:
            allowed |= pop["by_module"].get(m, set())
        out &= allowed
    if comps:
        out = {e for e in out if pop["people"].get(e) in comps}
    return out


# ── Weekly digest email ────────────────────────────────────────────────────

def _read_state(db) -> dict:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == DIGEST_STATE_KEY).first()
    try:
        return json.loads(row.value) if row and row.value else {}
    except (TypeError, ValueError):
        return {}


def _write_state(db, state: dict) -> None:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == DIGEST_STATE_KEY).first()
    if not row:
        row = models.NexusSetting(key=DIGEST_STATE_KEY)
        db.add(row)
    row.value = json.dumps(state)
    row.updated_by = "system"
    row.updated_at = now_iso()
    db.commit()


def digest_html(entries: list, base_url: str) -> str:
    items = []
    for p in entries:
        module = f" - {escape(p['module'])}" if p.get("module") else ""
        action = (f"<br><span style='color:#b45309'>Action required: {escape(p['actionRequired'])}</span>"
                  if p.get("actionRequired") else "")
        items.append(f"<li style='margin:0 0 10px'><strong>{escape(p.get('title') or 'Update')}</strong>"
                     f" <span style='color:#5b6472'>({escape(p.get('type') or 'Update')}{module})</span>{action}"
                     f"<br><span>{escape((p.get('description') or '')[:240])}</span></li>")
    return (f"<div style='font-family:Inter,Arial,sans-serif;font-size:14px;color:#111827'>"
            f"<h2 style='margin:0 0 12px'>What's New in Nexus this week</h2><ul style='padding-left:18px'>{''.join(items)}</ul>"
            f"<p><a href='{escape(base_url)}/whats-new'>See everything in What's New</a></p>"
            f"<p style='color:#5b6472;font-size:12px'>You get this because you turned on the weekly digest in "
            f"What's New &gt; Follow.</p></div>")


def send_digests_if_due(db, now: datetime = None) -> int:
    """Monday from 9 AM Pacific, once per week: email each opted-in person the
    updates released in the 7 days before, the ones they can see. Returns how
    many emails went out."""
    import graph_mail
    from app_url import app_url
    now = now or datetime.now(timezone.utc)
    local = now.astimezone(ZoneInfo("America/Los_Angeles"))
    if local.weekday() != 0 or local.hour < 9:
        return 0
    week = local.strftime("%G-W%V")
    state = _read_state(db)
    if state.get("week") == week:
        return 0
    _write_state(db, {**state, "week": week, "started_at": now.isoformat()})   # once, even if a send fails
    since = now - timedelta(days=7)
    released = []
    for e in db.query(models.TaskChangelogEntry).all():
        p = payload_of(e)
        at = _instant(p.get("releasedAt") or e.created_at)
        if status_of(p) == "Released" and at and at > since and not p.get("hidden"):
            released.append((at, p))
    released.sort(key=lambda x: x[0], reverse=True)
    sent = 0
    for sub in db.query(models.ChangelogSubscription).filter(models.ChangelogSubscription.digest.is_(True)).all():
        ctx = viewer(db, {"email": sub.email, "level": _level(db, sub.email)})
        mine = [p for _, p in released if visible(p, ctx)]
        if not mine:
            continue
        try:
            graph_mail.send_mail(from_email=graph_mail.DEFAULT_FROM_EMAIL, to=[sub.email], cc=None,
                                 subject=f"What's New in Nexus - {len(mine)} update{'' if len(mine) == 1 else 's'} this week",
                                 html=digest_html(mine, app_url()))
            sent += 1
        except Exception as e:  # noqa: BLE001 - one bad address never stops the rest
            print(f"[changelog] digest to {sub.email} failed: {e}")
    _write_state(db, {**_read_state(db), "week": week, "sent": sent, "finished_at": now_iso()})
    return sent
