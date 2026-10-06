"""Google Business Profile in Nexus (Marketing, Neil call of 10/01).

"Google Business Profile management in Nexus, so Neil isn't a single point of
failure": edit the listing, see reviews split into replied and unreplied, and
reply / edit / delete replies - from Nexus, by whoever has the Marketing grant.

How it hangs together:
  - ONE dedicated Google account (an Owner / Manager on every location, e.g.
    nexus@kadakia.com - not Neil's own) is connected once by an admin. Google
    has no API key for Business Profile; OAuth with an offline refresh token is
    the only way in. The refresh token is encrypted (secret_box) and never
    leaves the server.
  - Who replies (Neil's question 12): Google shows EVERY reply publicly as
    "Response from the owner" under the business name, whichever manager
    account posted it - so one connection loses nothing. Which PERSON answered
    is recorded here instead (MarketingReview.replied_by + a MarketingReviewAction row per
    reply / edit / delete).
  - Locations and reviews are mirrored into marketing_gbp_locations / marketing_reviews by a
    sync (every 30 minutes on the deployed API, or Sync Now), so lists are
    fast and work while Google is slow. Writes go to Google first and are only
    recorded once Google accepts them.
  - A review replied to in Google directly still shows as replied, with no
    Nexus name on it.

gbp_client.py does the HTTP; this module owns the database.
"""
from __future__ import annotations

import asyncio
import json
import re
import threading
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import gbp_client
import models
import secret_box
from gbp_client import GbpError
from routers.task_util import gen_id, now_iso

CONN_ID = "gbp"
STATE_TTL = 10 * 60
SYNC_EVERY_SEC = 30 * 60
STARS = {"ONE": 1, "TWO": 2, "THREE": 3, "FOUR": 4, "FIVE": 5}
REPLY_MAX = 4096          # Google's limit on a reply
SYNC_MIN_GAP_SEC = 60     # Sync Now right after a sync finished is a no-op
PERF_EVERY_SEC = 6 * 3600 # performance, keywords and photo counts change slowly
PERF_FIRST_DAYS = 540     # first fill: Google keeps about 18 months of daily figures
PERF_REFRESH_DAYS = 14    # later: Google reports days late, so re-read two weeks
KEYWORD_MONTHS = 6
LOW_STAR = 2              # a new review at or below this many stars rings the bell
LOW_STAR_FRESH_DAYS = 14  # ...if Google dates it recently (not an old one surfacing)
STALE_PHOTO_DAYS = 60
POST_MAX = 1500           # Google's limit on a post's text
PHOTO_MIN_BYTES, PHOTO_MAX_BYTES = 10 * 1024, 5 * 1024 * 1024
PHOTO_TYPES = ("image/jpeg", "image/png")
PHOTO_CATEGORIES = ("EXTERIOR", "INTERIOR", "AT_WORK", "TEAMS", "COMMON_AREA", "ADDITIONAL", "COVER", "LOGO")
CTA_TYPES = ("LEARN_MORE", "BOOK", "ORDER", "SHOP", "SIGN_UP", "CALL")
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]+$")

# One sync at a time in this process (the 30-minute loop and a Sync Now
# click). Other gunicorn workers are covered by SYNC_MIN_GAP_SEC and by the
# unique external_id - a collision there is reported, never half-written.
_sync_lock = threading.Lock()


def review_link(place_id: str) -> str:
    """Google's own "write a review" link for a location - what goes on a QR
    code, an NFC tag or the thank-you email (Neil, item 14)."""
    return f"https://search.google.com/local/writereview?placeid={place_id}" if place_id else ""


# ── OAuth state (stateless: encrypted, expiring) ───────────────────────────────

def issue_state(email: str) -> str:
    """The OAuth `state`: who started the connection and until when, sealed
    with secret_box - the callback is a bare browser redirect with no bearer
    token, so this is both the CSRF check and the identity."""
    return secret_box.encrypt(json.dumps({"e": (email or "").lower(), "x": int(time.time()) + STATE_TTL}))


def consume_state(state: str) -> str:
    try:
        d = json.loads(secret_box.decrypt(state or ""))
    except (ValueError, TypeError):
        return ""
    return d.get("e", "") if int(d.get("x") or 0) >= time.time() else ""


# ── The connection ─────────────────────────────────────────────────────────────

def get_connection(db: Session):
    return db.get(models.MarketingIntegrationToken, CONN_ID)


def _refresh_token(conn) -> str:
    if not conn or not conn.refresh_token_enc:
        raise GbpError("No Google account is connected yet.", 409)
    try:
        return secret_box.decrypt(conn.refresh_token_enc)
    except ValueError:
        raise GbpError("The stored Google connection cannot be read - reconnect the Google account.", 409)


def _token(db: Session) -> tuple:
    conn = get_connection(db)
    try:
        return conn, gbp_client.access_token(_refresh_token(conn))
    except GbpError as e:
        # A dead grant is a state of the connection, not of one request -
        # record it so every screen asks for a reconnect.
        if conn and e.status == 401:
            conn.last_error = str(e)[:500]
            db.commit()
        raise


def status(db: Session) -> dict:
    conn = get_connection(db)
    connected = bool(conn and conn.refresh_token_enc)
    return {
        "configured": not gbp_client.not_configured_reason(),
        "notConfiguredReason": gbp_client.not_configured_reason(),
        "redirectUri": gbp_client.redirect_uri(),
        "connected": connected,
        "accountEmail": (conn.account_email if connected else ""),
        "accountLabel": (conn.account_label if connected else ""),
        "connectedBy": (conn.connected_by if connected else ""),
        "connectedAt": (conn.connected_at if connected else ""),
        "lastSyncAt": (conn.last_sync_at if connected else ""),
        "lastError": (conn.last_error if connected else ""),
        "needsReconnect": bool(connected and gbp_client.RECONNECT in (conn.last_error or "")),
        "perfSyncedAt": (conn.perf_synced_at if connected else ""),
        "perfError": (conn.perf_error if connected else ""),
        "locationCount": db.query(models.MarketingGbpLocation).count() if connected else 0,
    }


def connect(db: Session, code: str, admin_email: str) -> dict:
    """Finish the OAuth flow: keep the refresh token, note which Google account
    it is and which business account it manages the locations through, then
    pull the locations and reviews once."""
    tok = gbp_client.exchange_code(code)
    refresh = tok.get("refresh_token") or ""
    if not refresh:
        raise GbpError("Google did not grant offline access. Remove Nexus from the Google account's "
                       "third-party access and connect again.", 400)
    access = tok.get("access_token") or gbp_client.access_token(refresh)
    email = gbp_client.account_email(access)
    accounts = gbp_client.list_accounts(access)
    # A business group ("LOCATION_GROUP" / organization) over the personal
    # account when there are several - it is where shared locations live.
    accounts.sort(key=lambda a: 0 if (a.get("type") or "") != "PERSONAL" else 1)
    if not accounts:
        raise GbpError(f"{email} does not manage any Business Profile. Add it as a Manager on the "
                       "locations first, then connect again.", 400)
    conn = get_connection(db) or models.MarketingIntegrationToken(id=CONN_ID)
    old = conn.refresh_token_enc
    conn.account_email, conn.account_name = email, accounts[0].get("name") or ""
    conn.account_label = accounts[0].get("accountName") or ""
    conn.refresh_token_enc, conn.scope = secret_box.encrypt(refresh), tok.get("scope") or ""
    conn.connected_by, conn.connected_at, conn.last_error = (admin_email or "").lower(), now_iso(), ""
    db.merge(conn)
    db.commit()
    if old:
        try:
            gbp_client.forget(secret_box.decrypt(old))
        except ValueError:
            pass
    return sync(db, force=True)


def disconnect(db: Session) -> None:
    """Revoke at Google and forget the token. The mirrored locations and
    reviews stay (they are a record), and so does the reply history."""
    conn = get_connection(db)
    if not conn:
        return
    try:
        gbp_client.revoke(_refresh_token(conn))
    except GbpError:
        pass
    conn.refresh_token_enc, conn.last_error = "", ""
    db.commit()


# ── Sync ──────────────────────────────────────────────────────────────────────

def _address(loc: dict) -> str:
    a = loc.get("storefrontAddress") or {}
    parts = [*(a.get("addressLines") or []), a.get("locality") or "",
             " ".join(x for x in (a.get("administrativeArea"), a.get("postalCode")) if x)]
    return ", ".join(p for p in parts if p)


def _upsert_location(db: Session, account: str, loc: dict) -> models.MarketingGbpLocation:
    row = db.get(models.MarketingGbpLocation, loc["name"]) or models.MarketingGbpLocation(id=loc["name"])
    row.account_name, row.title, row.address = account, loc.get("title") or "", _address(loc)
    row.place_id = (loc.get("metadata") or {}).get("placeId") or ""
    row.phone = (loc.get("phoneNumbers") or {}).get("primaryPhone") or ""
    row.website, row.listing, row.synced_at = loc.get("websiteUri") or "", loc, now_iso()
    return db.merge(row)   # the session's own copy - later changes must land on it


def _upsert_review(db: Session, location_id: str, rv: dict):
    """Returns the row when the review is new to Nexus, else None."""
    existing = db.query(models.MarketingReview).filter(models.MarketingReview.external_id == rv["name"]).first()
    row = existing or models.MarketingReview(id=gen_id(), external_id=rv["name"])
    reviewer = rv.get("reviewer") or {}
    reply = rv.get("reviewReply") or {}
    row.location_id = location_id
    row.reviewer_name = reviewer.get("displayName") or ("Anonymous" if reviewer.get("isAnonymous") else "")
    row.reviewer_photo = reviewer.get("profilePhotoUrl") or ""
    row.rating = STARS.get(rv.get("starRating") or "", 0)
    row.text, row.reviewed_at, row.updated_at = rv.get("comment") or "", rv.get("createTime") or "", rv.get("updateTime") or ""
    new_reply, new_time = reply.get("comment") or "", reply.get("updateTime") or ""
    # Still the reply Nexus posted -> keep who posted it. Changed or removed in
    # Google itself -> nobody in Nexus can be named for it.
    if new_reply != (row.reply_text or "") or new_time != (row.reply_updated_at or ""):
        row.replied_by, row.replied_at = "", ""
    row.reply_text, row.reply_updated_at, row.synced_at = new_reply, new_time, now_iso()
    db.add(row)
    return None if existing else row


def sync(db: Session, *, force: bool = False) -> dict:
    """Mirror every location and its reviews, one sync at a time. A sync
    asked for within a minute of the last one returns {"skipped": True}
    unless forced (connecting and the 30-minute loop force one). Errors are
    recorded on the connection (last_error) - the screens show them - and
    re-raised."""
    if not _sync_lock.acquire(timeout=120):
        raise GbpError("A sync is already running - try again in a minute.", 409)
    try:
        return _sync(db, force)
    finally:
        _sync_lock.release()


def _recent(iso: str, seconds: int = SYNC_MIN_GAP_SEC) -> bool:
    try:
        then = datetime.fromisoformat((iso or "").replace("Z", "+00:00"))
    except ValueError:
        return False
    if then.tzinfo is None:
        then = then.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - then).total_seconds() < seconds


def _sync(db: Session, force: bool) -> dict:
    db.expire_all()   # a sync that waited on the lock must see the one before it
    conn = get_connection(db)
    if not force and conn and not conn.last_error and _recent(conn.last_sync_at):
        return {"skipped": True, "locations": db.query(models.MarketingGbpLocation).count(),
                "reviews": db.query(models.MarketingReview).count()}
    try:
        conn, token = _token(db)
        locs = gbp_client.list_locations(token, conn.account_name)
        reviews, low = 0, []
        for loc in locs:
            # A location's first sync imports its whole history - none of
            # that is news, so only later syncs ring the bell.
            known = bool(getattr(db.get(models.MarketingGbpLocation, loc["name"]), "synced_at", ""))
            row = _upsert_location(db, conn.account_name, loc)
            for rv in gbp_client.list_reviews(token, conn.account_name, row.id):
                new = _upsert_review(db, row.id, rv)
                reviews += 1
                if new is not None and known and _is_fresh_low(new):
                    low.append((new, row.facility_name or row.title))
            db.flush()
            stats = (db.query(func.count(models.MarketingReview.id), func.avg(models.MarketingReview.rating))
                     .filter(models.MarketingReview.location_id == row.id, models.MarketingReview.rating > 0).one())
            row.review_count, row.avg_rating = int(stats[0] or 0), round(float(stats[1] or 0), 2)
        conn.last_sync_at, conn.last_error = now_iso(), ""
        db.commit()
        _notify_low_reviews(db, low)
        _sync_content(db, conn, token)
        return {"locations": len(locs), "reviews": reviews}
    except IntegrityError:
        # Another worker inserted the same new review a moment ago.
        db.rollback()
        raise GbpError("Another sync was running at the same time - try again in a minute.", 409)
    except GbpError as e:
        db.rollback()
        conn = get_connection(db)
        if conn:
            conn.last_error = str(e)[:500]
            db.commit()
        raise


def sync_once() -> None:
    from database import SessionLocal
    db = SessionLocal()
    try:
        conn = get_connection(db)
        if conn and conn.refresh_token_enc:
            sync(db, force=True)
    except GbpError as e:
        print(f"[gbp] sync failed: {e}")
    finally:
        db.close()


async def gbp_sync_loop():
    """Started from main.py on the deployed API only. The sync is blocking
    HTTP + DB, so it runs in a thread (CLAUDE.md: never on the event loop)."""
    await asyncio.sleep(120)
    while True:
        try:
            await asyncio.to_thread(sync_once)
        except Exception as e:
            print(f"[gbp] loop error: {e}")
        await asyncio.sleep(SYNC_EVERY_SEC)


# ── Reviews ───────────────────────────────────────────────────────────────────

def _names(db: Session, emails: set) -> dict:
    emails = {e for e in emails if e}
    if not emails:
        return {}
    return {(e.work_email or "").lower(): f"{e.first_name or ''} {e.last_name or ''}".strip() or e.work_email
            for e in db.query(models.NexusEmployee).filter(func.lower(models.NexusEmployee.work_email).in_(emails))}


def review_dict(r: models.MarketingReview, loc_titles: dict, names: dict) -> dict:
    return {
        "id": r.id, "locationId": r.location_id, "location": loc_titles.get(r.location_id, ""),
        "reviewer": r.reviewer_name, "reviewerPhoto": r.reviewer_photo, "rating": r.rating,
        "comment": r.text, "createdAt": r.reviewed_at, "updatedAt": r.updated_at,
        "replied": bool(r.reply_text), "reply": r.reply_text, "replyUpdatedAt": r.reply_updated_at,
        # Who answered, from Nexus. Blank on a reply made in Google directly.
        "repliedBy": r.replied_by, "repliedByName": names.get(r.replied_by, r.replied_by),
        "repliedAt": r.replied_at,
    }


def list_reviews(db: Session, *, replied: str = "", location_id: str = "", limit: int = 200, offset: int = 0) -> dict:
    """Newest first. replied = "yes" | "no" | "" (all) - the Replied /
    Unreplied split Neil asked for."""
    q = db.query(models.MarketingReview)
    if location_id:
        q = q.filter(models.MarketingReview.location_id == location_id)
    if replied == "yes":
        q = q.filter(models.MarketingReview.reply_text != "")
    elif replied == "no":
        q = q.filter((models.MarketingReview.reply_text == "") | (models.MarketingReview.reply_text.is_(None)))
    total = q.count()
    rows = q.order_by(models.MarketingReview.reviewed_at.desc()).offset(max(0, offset)).limit(min(max(1, limit), 500)).all()
    titles = {loc.id: loc.title for loc in db.query(models.MarketingGbpLocation).all()}
    names = _names(db, {r.replied_by for r in rows})
    counts = {
        "all": db.query(models.MarketingReview).count(),
        "unreplied": db.query(models.MarketingReview).filter((models.MarketingReview.reply_text == "")
                                                       | (models.MarketingReview.reply_text.is_(None))).count(),
    }
    counts["replied"] = counts["all"] - counts["unreplied"]
    return {"total": total, "counts": counts, "reviews": [review_dict(r, titles, names) for r in rows]}


def _log(db: Session, review_id: str, action: str, actor: str, text: str, ok: bool, error: str = "") -> None:
    db.add(models.MarketingReviewAction(id=gen_id(), review_id=review_id, action=action, actor_email=(actor or "").lower(),
                                  text=text, ok=ok, error=error[:500], at=now_iso()))


def reply(db: Session, review_id: str, text: str, actor: str) -> dict:
    """Post the reply, or replace the existing one (Google keeps one reply
    per review). Recorded only once Google accepts it; a refusal is logged
    with Google's reason and re-raised."""
    text = (text or "").strip()
    if not text:
        raise GbpError("Write a reply first.", 422)
    if len(text) > REPLY_MAX:
        raise GbpError(f"Google allows up to {REPLY_MAX} characters in a reply.", 422)
    r = db.get(models.MarketingReview, review_id)
    if not r:
        raise GbpError("That review is no longer here - sync and try again.", 404)
    action = "edit" if r.reply_text else "reply"
    _, token = _token(db)
    try:
        out = gbp_client.put_reply(token, r.external_id, text)
    except GbpError as e:
        rv = _settle(token, r.external_id, e,
                     lambda rv: ((rv.get("reviewReply") or {}).get("comment") or "").strip() == text)
        if rv is None:
            _log(db, r.id, action, actor, text, False, str(e))
            db.commit()
            raise
        out = rv.get("reviewReply") or {}
    r.reply_text, r.reply_updated_at = out.get("comment") or text, out.get("updateTime") or now_iso()
    r.replied_by, r.replied_at = (actor or "").lower(), now_iso()
    _log(db, r.id, action, actor, text, True)
    db.commit()
    loc = db.get(models.MarketingGbpLocation, r.location_id)
    return review_dict(r, {r.location_id: loc.title if loc else ""}, _names(db, {r.replied_by}))


def _settle(token: str, review_name: str, err: GbpError, landed):
    """A write whose answer never arrived (timeout, dropped connection) may
    still have landed at Google. Read the review back: if `landed(review)`
    holds, the write succeeded and the review is returned; otherwise None
    (a real failure). Google's own refusals are never second-guessed."""
    if not err.transport:
        return None
    try:
        rv = gbp_client.get_review(token, review_name)
    except GbpError:
        return None
    return rv if landed(rv) else None


def delete_reply(db: Session, review_id: str, actor: str) -> None:
    r = db.get(models.MarketingReview, review_id)
    if not r:
        raise GbpError("That review is no longer here - sync and try again.", 404)
    if not r.reply_text:
        return
    _, token = _token(db)
    old = r.reply_text
    try:
        gbp_client.delete_reply(token, r.external_id)
    except GbpError as e:
        if _settle(token, r.external_id, e, lambda rv: not (rv.get("reviewReply") or {}).get("comment")) is None:
            _log(db, r.id, "delete", actor, old, False, str(e))
            db.commit()
            raise
    r.reply_text = r.reply_updated_at = r.replied_by = r.replied_at = ""
    _log(db, r.id, "delete", actor, old, True)
    db.commit()


def history(db: Session, review_id: str) -> list:
    rows = (db.query(models.MarketingReviewAction).filter(models.MarketingReviewAction.review_id == review_id)
            .order_by(models.MarketingReviewAction.at.desc()).all())
    names = _names(db, {a.actor_email for a in rows})
    return [{"action": a.action, "by": a.actor_email, "byName": names.get(a.actor_email, a.actor_email),
             "text": a.text, "ok": bool(a.ok), "error": a.error, "at": a.at} for a in rows]


# ── Locations and the listing ────────────────────────────────────────────────

def location_dict(loc: models.MarketingGbpLocation) -> dict:
    listing = loc.listing or {}
    return {
        "id": loc.id, "key": loc.id.split("/")[-1], "title": loc.title, "address": loc.address, "phone": loc.phone, "website": loc.website,
        "placeId": loc.place_id, "reviewLink": review_link(loc.place_id), "facility": loc.facility_name,
        "reviewCount": loc.review_count, "avgRating": loc.avg_rating, "syncedAt": loc.synced_at,
        "description": (listing.get("profile") or {}).get("description") or "",
        "regularHours": listing.get("regularHours") or {}, "specialHours": listing.get("specialHours") or {},
        # Google holds some edits for its own review before they go live.
        "pendingGoogleReview": bool((listing.get("metadata") or {}).get("hasPendingEdits")),
        "photoCount": loc.photo_count or 0, "lastPhotoAt": loc.last_photo_at or "",
    }


def list_locations(db: Session) -> list:
    return [location_dict(x) for x in db.query(models.MarketingGbpLocation).order_by(models.MarketingGbpLocation.title).all()]


def map_facility(db: Session, location_id: str, facility: str) -> dict:
    loc = db.get(models.MarketingGbpLocation, location_id)
    if not loc:
        raise GbpError("That location is no longer here - sync and try again.", 404)
    loc.facility_name = (facility or "").strip()
    db.commit()
    return location_dict(loc)


def update_listing(db: Session, location_id: str, changes: dict, actor: str) -> dict:
    """Description, phone, website and hours - only what was sent changes
    (updateMask), so a field nobody touched is never overwritten. Google may
    publish it at once or hold it for review; the reply tells which."""
    loc = db.get(models.MarketingGbpLocation, location_id)
    if not loc:
        raise GbpError("That location is no longer here - sync and try again.", 404)
    patch, mask = {}, []
    if "description" in changes:
        desc = (changes.get("description") or "").strip()
        if len(desc) > 750:
            raise GbpError("Google allows up to 750 characters in the description.", 422)
        patch["profile"] = {"description": desc}
        mask.append("profile.description")
    if "phone" in changes:
        patch["phoneNumbers"] = {"primaryPhone": (changes.get("phone") or "").strip()}
        mask.append("phoneNumbers.primaryPhone")
    if "website" in changes:
        patch["websiteUri"] = (changes.get("website") or "").strip()
        mask.append("websiteUri")
    for key in ("regularHours", "specialHours"):
        if key in changes:
            patch[key] = changes.get(key) or {}
            mask.append(key)
    if not mask:
        raise GbpError("Nothing to change.", 422)
    _, token = _token(db)
    try:
        gbp_client.update_location(token, loc.id, patch, mask)
    except GbpError as e:
        _log_listing(db, loc.id, actor, mask, patch, False, str(e))
        db.commit()
        raise
    _log_listing(db, loc.id, actor, mask, patch, True)
    db.commit()
    # Read it back rather than trusting the patch: Google normalizes values
    # and reports whether the edit is waiting on its review. If the read-back
    # fails the edit still stands; the next sync brings the fresh copy.
    try:
        fresh = gbp_client.get_location(token, loc.id)
        _upsert_location(db, loc.account_name, fresh)
        db.commit()
    except GbpError as e:
        print(f"[gbp] listing {loc.id} read-back failed: {e}")
    return location_dict(db.get(models.MarketingGbpLocation, loc.id))


def _log_listing(db: Session, location_id: str, actor: str, mask: list, patch: dict, ok: bool, error: str = "") -> None:
    db.add(models.MarketingListingAction(id=gen_id(), location_id=location_id, actor_email=(actor or "").lower(),
                                         fields=",".join(mask), changes=patch, ok=ok, error=error[:500], at=now_iso()))


def listing_history(db: Session, location_id: str) -> list:
    """Every listing edit made from Nexus, newest first - who changed which
    fields, and whether Google accepted it (Google keeps no such record)."""
    rows = (db.query(models.MarketingListingAction).filter(models.MarketingListingAction.location_id == location_id)
            .order_by(models.MarketingListingAction.at.desc()).limit(200).all())
    names = _names(db, {a.actor_email for a in rows})
    return [{"fields": [f for f in (a.fields or "").split(",") if f], "changes": a.changes or {},
             "by": a.actor_email, "byName": names.get(a.actor_email, a.actor_email),
             "ok": bool(a.ok), "error": a.error, "at": a.at} for a in rows]


# ── New low-star reviews -> the bell ─────────────────────────────────────────

def _is_fresh_low(r: models.MarketingReview) -> bool:
    if not r.rating or r.rating > LOW_STAR:
        return False
    try:
        when = datetime.fromisoformat((r.reviewed_at or "").replace("Z", "+00:00"))
    except ValueError:
        return False
    return datetime.now(timezone.utc) - when < timedelta(days=LOW_STAR_FRESH_DAYS)


def marketing_responders(db: Session) -> list:
    """Everyone who can reply to a review: an Access Group grants them
    Marketing at editor level or above. Never a broadcast - nobody holding
    the grant means nobody is told."""
    from auth import _MODULE_LEVEL_RANK
    need = _MODULE_LEVEL_RANK["editor"]
    out = set()
    rows = (db.query(models.NexusGroup.allowed_modules, models.NexusGroupMember.email)
            .join(models.NexusGroupMember, models.NexusGroupMember.group_id == models.NexusGroup.id).all())
    for modules, email in rows:
        for part in (modules or "").split(","):
            mid, _, level = part.strip().partition(":")
            if mid == "marketing" and _MODULE_LEVEL_RANK.get(level, 1) >= need and email:
                out.add(email.lower())
    return sorted(out)


def _notify_low_reviews(db: Session, low: list) -> None:
    """One bell per new low-star review per responder, opening Marketing >
    Reputation. Best effort: a failure here never fails the sync."""
    if not low:
        return
    try:
        from auth import company_of
        people = marketing_responders(db)
        action = json.dumps({"view": "marketing", "sub": "marketing-reputation"})
        for r, where in low:
            snippet = (r.text or "").strip()
            snippet = (snippet[:140] + "...") if len(snippet) > 140 else snippet
            body = f'{r.reviewer_name or "A customer"}: "{snippet}"' if snippet else f"{r.reviewer_name or 'A customer'} left a rating with no text."
            for email in people:
                db.add(models.NexusNotification(
                    id=str(uuid.uuid4()), type="gbp_low_review", recipient=email,
                    title=f"{r.rating}-star Google review for {where} - awaiting a reply",
                    body=body, ref_id=r.id, item_name=where, requested_by="", action=action,
                    actioned=False, read_by="", company=company_of(email, db), created_at=now_iso()))
        db.commit()
    except Exception as e:   # noqa: BLE001 - the reviews are already saved
        db.rollback()
        print(f"[gbp] low-star notification failed: {e}")


# ── Performance, keywords and photo counts (every 6 hours) ───────────────────

_METRIC_FIELD = {
    "BUSINESS_IMPRESSIONS_DESKTOP_MAPS": "maps_views", "BUSINESS_IMPRESSIONS_MOBILE_MAPS": "maps_views",
    "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH": "search_views", "BUSINESS_IMPRESSIONS_MOBILE_SEARCH": "search_views",
    "WEBSITE_CLICKS": "website_clicks", "CALL_CLICKS": "call_clicks",
    "BUSINESS_DIRECTION_REQUESTS": "direction_requests",
}
_DAILY_FIELDS = ("maps_views", "search_views", "website_clicks", "call_clicks", "direction_requests")


def _months_back(n: int) -> list:
    """The last n COMPLETE months, newest first, as (year, month)."""
    y, m = date.today().year, date.today().month
    out = []
    for _ in range(n):
        m -= 1
        if m == 0:
            y, m = y - 1, 12
        out.append((y, m))
    return out


def _sync_content(db: Session, conn, token: str) -> None:
    """The slower half of a sync, on its own 6-hour clock (retried every
    sync while it is failing). Kept apart from reviews: Performance is a
    separate Google API that can be refused on its own, and that must never
    stop reviews syncing - its error is recorded as perf_error instead."""
    if conn.perf_synced_at and not conn.perf_error and _recent(conn.perf_synced_at, PERF_EVERY_SEC):
        return
    try:
        today = date.today()
        for loc in db.query(models.MarketingGbpLocation).all():
            _sync_daily(db, token, loc, today)
            _sync_keywords(db, token, loc)
            _sync_photo_stats(db, token, conn.account_name, loc)
            db.commit()
        conn.perf_synced_at, conn.perf_error = now_iso(), ""
        db.commit()
    except GbpError as e:
        db.rollback()
        conn = get_connection(db)
        if conn:
            conn.perf_error = str(e)[:500]
            db.commit()
        print(f"[gbp] performance sync failed: {e}")


def _sync_daily(db: Session, token: str, loc, today: date) -> None:
    has = db.query(models.MarketingGbpDaily.id).filter(models.MarketingGbpDaily.location_id == loc.id).first()
    start = today - timedelta(days=PERF_REFRESH_DAYS if has else PERF_FIRST_DAYS)
    series = gbp_client.daily_metrics(token, loc.id, start, today - timedelta(days=1))
    by_day: dict = {}
    for metric, points in series.items():
        field = _METRIC_FIELD.get(metric)
        if not field:
            continue
        for day, value in points:
            by_day.setdefault(day, dict.fromkeys(_DAILY_FIELDS, 0))[field] += value
    for day, vals in by_day.items():
        db.merge(models.MarketingGbpDaily(id=f"{loc.id}|{day}", location_id=loc.id, date=day, **vals))


def _sync_keywords(db: Session, token: str, loc) -> None:
    have = {m for (m,) in db.query(models.MarketingGbpKeyword.month)
            .filter(models.MarketingGbpKeyword.location_id == loc.id).distinct()}
    for i, (y, m) in enumerate(_months_back(KEYWORD_MONTHS)):
        month = f"{y:04d}-{m:02d}"
        if month in have and i > 0:      # older months never change; the newest may still fill in
            continue
        rows = gbp_client.search_keywords(token, loc.id, y, m)
        db.query(models.MarketingGbpKeyword).filter(models.MarketingGbpKeyword.location_id == loc.id,
                                                    models.MarketingGbpKeyword.month == month).delete()
        for kw, n, floor in rows:
            db.add(models.MarketingGbpKeyword(id=gen_id(), location_id=loc.id, month=month, keyword=kw[:300],
                                              impressions=n, below_threshold=floor))


def _sync_photo_stats(db: Session, token: str, account: str, loc) -> None:
    items = gbp_client.list_media(token, account, loc.id)
    loc.photo_count = len(items)
    loc.last_photo_at = max((m.get("createTime") or "" for m in items), default="")


def performance(db: Session, location_id: str, start: str, end: str) -> dict:
    """Daily figures for start..end (YYYY-MM-DD) and the same-length period
    just before it, summed across locations unless one is given, plus the
    top search terms for the months the range touches."""
    try:
        d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
    except ValueError:
        raise GbpError("Pick a valid date range.", 422)
    if d1 < d0 or (d1 - d0).days > 731:
        raise GbpError("Pick a range of up to two years.", 422)
    span = (d1 - d0).days + 1
    p0, p1 = d0 - timedelta(days=span), d0 - timedelta(days=1)
    q = db.query(models.MarketingGbpDaily).filter(models.MarketingGbpDaily.date >= p0.isoformat(),
                                                  models.MarketingGbpDaily.date <= d1.isoformat())
    if location_id:
        q = q.filter(models.MarketingGbpDaily.location_id == location_id)
    by_day: dict = {}
    for r in q.all():
        acc = by_day.setdefault(r.date, dict.fromkeys(_DAILY_FIELDS, 0))
        for f in _DAILY_FIELDS:
            acc[f] += getattr(r, f) or 0

    def rows(a: date, b: date) -> list:
        out, d = [], a
        while d <= b:
            v = by_day.get(d.isoformat(), dict.fromkeys(_DAILY_FIELDS, 0))
            out.append({"date": d.isoformat(), "mapsViews": v["maps_views"], "searchViews": v["search_views"],
                        "websiteClicks": v["website_clicks"], "callClicks": v["call_clicks"],
                        "directionRequests": v["direction_requests"]})
            d += timedelta(days=1)
        return out

    months = sorted({f"{d.year:04d}-{d.month:02d}" for d in (d0 + timedelta(days=i) for i in range(span))})
    kq = db.query(models.MarketingGbpKeyword).filter(models.MarketingGbpKeyword.month.in_(months))
    if location_id:
        kq = kq.filter(models.MarketingGbpKeyword.location_id == location_id)
    words: dict = {}
    for k in kq.all():
        w = words.setdefault(k.keyword.lower(), {"keyword": k.keyword, "impressions": 0, "belowThreshold": False})
        w["impressions"] += k.impressions or 0
        w["belowThreshold"] = w["belowThreshold"] or bool(k.below_threshold)
    conn = get_connection(db)
    first = db.query(func.min(models.MarketingGbpDaily.date)).scalar() or ""
    return {
        "rows": rows(d0, d1), "prevRows": rows(p0, p1),
        "keywords": sorted(words.values(), key=lambda w: -w["impressions"])[:15],
        "keywordMonths": months, "firstDate": first,
        "syncedAt": conn.perf_synced_at if conn else "", "error": conn.perf_error if conn else "",
    }


# ── The summary the alerts bell and AI Analyst read ──────────────────────────

def summary(db: Session) -> dict:
    """Real review figures for Marketing's alerts and insight rules, in the
    shape shared/alerts.js and buildAccountWideInsightInput.js already use."""
    conn = get_connection(db)
    if not (conn and conn.refresh_token_enc):
        return {"connected": False}
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
    overdue_before = (now - timedelta(hours=48)).isoformat()
    rows = db.query(models.MarketingReview.rating, models.MarketingReview.reviewed_at,
                    models.MarketingReview.reply_text, models.MarketingReview.text).all()

    def stats(rs):
        rated = [r for r in rs if r.rating]
        return {"rating": round(sum(r.rating for r in rated) / len(rated), 2) if rated else 0,
                "positivePct": round(100 * sum(1 for r in rated if r.rating >= 4) / len(rated), 1) if rated else 0,
                "count": len(rated)}

    # ISO-8601 UTC strings compare correctly as text.
    before = [r for r in rows if (r.reviewed_at or "") < month_start]
    cur, prev = stats(rows), stats(before)
    unreplied = [r for r in rows if not r.reply_text]
    this_month = [r for r in rows if (r.reviewed_at or "") >= month_start and r.text]
    stale = []
    if conn.perf_synced_at:
        cutoff = (now - timedelta(days=STALE_PHOTO_DAYS)).isoformat()
        stale = [(loc.facility_name or loc.title) for loc in db.query(models.MarketingGbpLocation).all()
                 if (loc.last_photo_at or "") < cutoff]
    return {
        "connected": True,
        "reviewCount": cur["count"],
        "unreplied": len(unreplied),
        "lowStarUnreplied": sum(1 for r in unreplied if r.rating and r.rating <= LOW_STAR),
        "overdueUnreplied": sum(1 for r in unreplied if (r.reviewed_at or "") < overdue_before),
        "rating": {"current": cur["rating"], "previous": prev["rating"] or cur["rating"]},
        "positivePct": {"current": cur["positivePct"], "previous": prev["positivePct"] or cur["positivePct"]},
        "recentPositiveTexts": [r.text for r in this_month if r.rating >= 4][:50],
        "recentNegativeTexts": [r.text for r in this_month if r.rating and r.rating <= 2][:50],
        "platformRatings": [{"platform": "Google", "rating": cur["rating"], "reviews": cur["count"]}],
        "stalePhotoLocations": stale,
    }


# ── Posts ─────────────────────────────────────────────────────────────────────

def _location(db: Session, location_id: str):
    loc = db.get(models.MarketingGbpLocation, location_id)
    if not loc:
        raise GbpError("That location is no longer here - sync and try again.", 404)
    return loc


def _child(loc, kind: str, child_id: str) -> str:
    if not _SAFE_ID.match(child_id or ""):
        raise GbpError("Not found.", 404)
    return f"{loc.account_name}/{loc.id}/{kind}/{child_id}"


def post_dict(p: dict) -> dict:
    cta = p.get("callToAction") or {}
    media = p.get("media") or []
    return {
        "id": (p.get("name") or "").split("/")[-1], "summary": p.get("summary") or "",
        "topicType": p.get("topicType") or "STANDARD", "state": p.get("state") or "",
        "ctaType": cta.get("actionType") or "", "ctaUrl": cta.get("url") or "",
        "imageUrl": (media[0].get("googleUrl") or media[0].get("sourceUrl") or "") if media else "",
        "createdAt": p.get("createTime") or "", "updatedAt": p.get("updateTime") or "",
        "searchUrl": p.get("searchUrl") or "", "eventTitle": (p.get("event") or {}).get("title") or "",
    }


def list_posts(db: Session, location_id: str) -> list:
    loc = _location(db, location_id)
    _, token = _token(db)
    posts = gbp_client.list_posts(token, loc.account_name, loc.id)
    return sorted((post_dict(p) for p in posts), key=lambda x: x["createdAt"], reverse=True)


def _post_body(body: dict) -> tuple:
    summary_ = (body.get("summary") or "").strip()
    if not summary_:
        raise GbpError("Write the post first.", 422)
    if len(summary_) > POST_MAX:
        raise GbpError(f"Google allows up to {POST_MAX} characters in a post.", 422)
    out, mask = {"summary": summary_}, ["summary"]
    cta, url = (body.get("ctaType") or "").strip(), (body.get("ctaUrl") or "").strip()
    if cta:
        if cta not in CTA_TYPES:
            raise GbpError("Pick a button from the list.", 422)
        if cta != "CALL" and not url.startswith(("https://", "http://")):
            raise GbpError("The button needs a web address starting with https://.", 422)
        out["callToAction"] = {"actionType": cta, **({"url": url} if cta != "CALL" else {})}
    mask.append("callToAction")
    photo = (body.get("photoUrl") or "").strip()
    if photo:
        # A photo already on the location's Google profile - Google needs a
        # public address for a post's picture, and its own is one.
        if not re.match(r"^https://[a-z0-9.-]+\.(googleusercontent|ggpht)\.com/", photo):
            raise GbpError("Pick one of the location's Google photos for the post.", 422)
        out["media"] = [{"mediaFormat": "PHOTO", "sourceUrl": photo}]
    return out, mask


def create_post(db: Session, location_id: str, body: dict, actor: str) -> dict:
    loc = _location(db, location_id)
    payload, _ = _post_body(body)
    payload = {"languageCode": "en-US", "topicType": "STANDARD", **payload}
    _, token = _token(db)
    try:
        out = gbp_client.create_post(token, loc.account_name, loc.id, payload)
    except GbpError as e:
        _log_listing(db, loc.id, actor, ["post:create"], payload, False, str(e))
        db.commit()
        raise
    _log_listing(db, loc.id, actor, ["post:create"], payload, True)
    db.commit()
    return post_dict(out)


def update_post(db: Session, location_id: str, post_id: str, body: dict, actor: str) -> dict:
    loc = _location(db, location_id)
    name = _child(loc, "localPosts", post_id)
    payload, mask = _post_body(body)
    payload.pop("media", None)           # the picture is chosen when the post is made
    _, token = _token(db)
    try:
        out = gbp_client.update_post(token, name, payload, mask)
    except GbpError as e:
        _log_listing(db, loc.id, actor, ["post:edit"], payload, False, str(e))
        db.commit()
        raise
    _log_listing(db, loc.id, actor, ["post:edit"], payload, True)
    db.commit()
    return post_dict(out)


def delete_post(db: Session, location_id: str, post_id: str, actor: str) -> None:
    loc = _location(db, location_id)
    name = _child(loc, "localPosts", post_id)
    _, token = _token(db)
    try:
        gbp_client.delete_post(token, name)
    except GbpError as e:
        _log_listing(db, loc.id, actor, ["post:delete"], {"post": post_id}, False, str(e))
        db.commit()
        raise
    _log_listing(db, loc.id, actor, ["post:delete"], {"post": post_id}, True)
    db.commit()


# ── Photos ────────────────────────────────────────────────────────────────────

def photo_dict(m: dict) -> dict:
    return {
        "id": (m.get("name") or "").split("/")[-1], "url": m.get("googleUrl") or "",
        "thumbnailUrl": m.get("thumbnailUrl") or m.get("googleUrl") or "",
        "category": (m.get("locationAssociation") or {}).get("category") or "",
        "createdAt": m.get("createTime") or "", "views": int((m.get("insights") or {}).get("viewCount") or 0),
    }


def list_photos(db: Session, location_id: str) -> list:
    loc = _location(db, location_id)
    _, token = _token(db)
    items = gbp_client.list_media(token, loc.account_name, loc.id)
    photos = [photo_dict(m) for m in items if (m.get("mediaFormat") or "PHOTO") == "PHOTO"]
    loc.photo_count = len(items)
    loc.last_photo_at = max((m.get("createTime") or "" for m in items), default="")
    db.commit()
    return sorted(photos, key=lambda x: x["createdAt"], reverse=True)


def add_photo(db: Session, location_id: str, data: bytes, content_type: str, category: str, actor: str) -> dict:
    loc = _location(db, location_id)
    content_type = (content_type or "").split(";")[0].strip().lower()
    if content_type not in PHOTO_TYPES:
        raise GbpError("Google takes JPG or PNG photos.", 422)
    if not PHOTO_MIN_BYTES <= len(data or b"") <= PHOTO_MAX_BYTES:
        raise GbpError("Google takes photos between 10 KB and 5 MB.", 422)
    category = (category or "ADDITIONAL").upper()
    if category not in PHOTO_CATEGORIES:
        raise GbpError("Pick a photo category from the list.", 422)
    _, token = _token(db)
    note = {"category": category, "bytes": len(data)}
    try:
        out = gbp_client.upload_photo(token, loc.account_name, loc.id, data, content_type, category)
    except GbpError as e:
        _log_listing(db, loc.id, actor, ["photo:add"], note, False, str(e))
        db.commit()
        raise
    loc.photo_count = (loc.photo_count or 0) + 1
    loc.last_photo_at = out.get("createTime") or now_iso()
    _log_listing(db, loc.id, actor, ["photo:add"], note, True)
    db.commit()
    return photo_dict(out)


def delete_photo(db: Session, location_id: str, photo_id: str, actor: str) -> None:
    loc = _location(db, location_id)
    name = _child(loc, "media", photo_id)
    _, token = _token(db)
    try:
        gbp_client.delete_media(token, name)
    except GbpError as e:
        _log_listing(db, loc.id, actor, ["photo:delete"], {"photo": photo_id}, False, str(e))
        db.commit()
        raise
    loc.photo_count = max(0, (loc.photo_count or 0) - 1)
    _log_listing(db, loc.id, actor, ["photo:delete"], {"photo": photo_id}, True)
    db.commit()
