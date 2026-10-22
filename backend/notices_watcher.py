"""Workplace Notices - the nightly watcher, the yearly calendar and the
December Annual Notice Review (Neil, Oct 21 2026: "these things need to get
updated automatically ... but we want to make sure there's an internal check").

Watcher. Government agencies publish PDFs and pages with no change feed, so
each notice's official source is fingerprinted once a night (sha256 of a
PDF's bytes, or of a page's visible text). When a PDF changes, the new file
becomes a version WAITING FOR APPROVAL - prepared by the watcher, approved by
a person. A changed page (no file to take) tells the approvers to look. Three
failed checks in a row tell them the link is broken. From September a source
whose link names this year (MW-2026.pdf) is also tried with next year's
(MW-2027.pdf), because agencies publish next year's poster under a new name.
Nothing is ever published by the watcher.

Calendar. The dates the law sets (01/01 posters, the 02/01 Know Your Rights
round, the 300A window, Time Off to Vote before each election) plus each
notice's own review date; the approvers hear 30 and 7 days ahead.

Annual Review. On 12/01 a review of every notice for the coming year opens;
an approver signs it (typed name), which freezes what it covered.
"""
from __future__ import annotations

import hashlib
import html as _html
import json
import re
import time
import uuid
from datetime import date, datetime, timedelta, timezone

import httpx

import models
import notices as core
from database import SessionLocal

UA = "Mozilla/5.0 (compatible; GreensNexus-NoticeWatcher/1.0; +https://nexus.greensglobal.com)"
PACE_S = 1.5
FAILS_TO_ALERT = 3
HR_TYPE = "workplace_notice_hr"
HR_ACTION = {"view": "hr", "sub": "hr-notices"}


def _us(iso: str) -> str:
    try:
        d = date.fromisoformat(str(iso)[:10])
        return f"{d.month:02d}/{d.day:02d}/{d.year}"
    except (TypeError, ValueError):
        return iso or ""


def _tell_approvers(db, title: str, body: str, ref_id: str, key: str = "", days: int = 6) -> int:
    """One bell per approver per `key` within `days` (no repeats each night)."""
    from routers.notices import approvers
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    ref = f"{ref_id}:{key}" if key else ref_id
    n = 0
    for a in approvers(db):
        if db.query(models.NexusNotification.id).filter(
                models.NexusNotification.recipient == a, models.NexusNotification.type == HR_TYPE,
                models.NexusNotification.ref_id == ref, models.NexusNotification.created_at >= since).first():
            continue
        db.add(models.NexusNotification(
            id=str(uuid.uuid4()), type=HR_TYPE, recipient=a, title=title, body=body, ref_id=ref,
            item_name=title[:120], requested_by="Workplace Notices", action=json.dumps(HR_ACTION),
            actioned=False, read_by="", company="", created_at=core.now_iso(), priority=1))
        n += 1
    return n


# ── Fingerprints ─────────────────────────────────────────────────────────────

def is_pdf(url: str, ctype: str, data: bytes) -> bool:
    return "pdf" in (ctype or "").lower() or data[:5] == b"%PDF-" or url.lower().split("?")[0].endswith(".pdf")


def page_text(raw: bytes) -> str:
    """The visible words of a page - scripts, styles, tags and whitespace out,
    so a rotating ad or a session token does not count as a change."""
    s = raw.decode("utf-8", "ignore")
    s = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?s)<!--.*?-->", " ", s)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", _html.unescape(s)).strip()


def fingerprint(url: str, ctype: str, data: bytes) -> tuple[str, bool]:
    pdf = is_pdf(url, ctype, data)
    body = data if pdf else page_text(data).encode("utf-8")
    return hashlib.sha256(body).hexdigest(), pdf


def fetch(url: str) -> tuple[int, str, bytes]:
    r = httpx.get(url, headers={"User-Agent": UA}, timeout=30, follow_redirects=True)
    return r.status_code, r.headers.get("content-type", ""), r.content


def next_year_url(url: str, on: date) -> str:
    """MW-2026.pdf -> MW-2027.pdf (from September, when next year's posters
    appear). '' when the link names no year."""
    if on.month < 9 or str(on.year) not in url:
        return ""
    return url.replace(str(on.year), str(on.year + 1))


# ── The watcher ──────────────────────────────────────────────────────────────

def _draft_from(db, notice, data: bytes, url: str, digest: str, why: str) -> object | None:
    """A version waiting for approval, prepared by the watcher - unless the
    live (or a pending) version already carries this exact file."""
    from routers.notices import new_version, store_file
    file_sha = hashlib.sha256(data).hexdigest()
    for v in core.versions_of(db, notice.id):
        if v.status in ("approved", "in_review", "draft") and any(f.get("sha256") == file_sha for f in (v.files or [])):
            return None
    name = url.split("?")[0].rstrip("/").split("/")[-1] or f"{notice.id}.pdf"
    v = new_version(db, notice.id, "watcher", origin="watcher", label=f"Official {_us(core.today().isoformat())}",
                    effective_date=core.today().isoformat(), major=True,
                    summary=f"{why} Check it against the live version; set the date it takes effect when you approve.")
    v.source_hash = digest
    store_file(db, v, data, name, "application/pdf", "en", "watcher")
    v.status, v.submitted_at = "in_review", core.now_iso()
    core.log_event(db, "watcher", "watcher_draft", notice.id, v.id, url=url)
    return v


def check_source(db, src, notice, on: date | None = None, fetcher=fetch) -> str:
    """Check one source. Returns what happened: baseline | same | changed |
    drafted | failed | moved."""
    d = on or core.today()
    src.last_checked_at = core.now_iso()
    try:
        status, ctype, data = fetcher(src.url)
        if status >= 400 or not data:
            raise RuntimeError(f"HTTP {status}")
    except Exception as e:  # noqa: BLE001 - a dead link is an alert, never a failed pass
        src.fail_count = (src.fail_count or 0) + 1
        src.last_error = str(e)[:300]
        if src.fail_count == FAILS_TO_ALERT:
            _tell_approvers(db, f"Source Not Reachable: {notice.title}",
                            f"The official link has failed {FAILS_TO_ALERT} nights in a row ({src.last_error}). "
                            "Check it in People > Notices.", notice.id, "fail", days=30)
        return "failed"
    src.fail_count, src.last_error = 0, ""
    digest, pdf = fingerprint(src.url, ctype, data)
    has_versions = bool(core.versions_of(db, notice.id))
    result = "same"
    if not src.last_hash:
        src.last_hash = digest
        result = "baseline"
        if pdf and not has_versions:
            # first sight of a notice with nothing yet: put the official file in front of HR
            if _draft_from(db, notice, data, src.url, digest, "The official file, downloaded by Nexus."):
                result = "drafted"
                _tell_approvers(db, f"Notice To Approve: {notice.title}",
                                "Nexus downloaded the official file. Review and approve it in People > Notices.",
                                notice.id, "first", days=30)
    elif digest != src.last_hash:
        src.last_hash, src.last_changed_at = digest, core.now_iso()
        core.log_event(db, "watcher", "watcher_changed", notice.id, url=src.url, pdf=pdf)
        result = "changed"
        if pdf:
            if _draft_from(db, notice, data, src.url, digest, "The official file changed."):
                result = "drafted"
            _tell_approvers(db, f"Official Notice Changed: {notice.title}",
                            "The agency changed this notice. The new file is waiting for your approval in People > Notices.",
                            notice.id, f"chg-{digest[:12]}", days=60)
        else:
            _tell_approvers(db, f"Official Page Changed: {notice.title}",
                            "The agency page for this notice changed. Check whether the notice itself changed, "
                            "and prepare a new version if it did.", notice.id, f"chg-{digest[:12]}", days=60)
    # next year's file under a new name (MW-2027.pdf)
    nxt = next_year_url(src.url, d)
    if nxt and nxt != src.url:
        try:
            s2, c2, d2 = fetcher(nxt)
        except Exception:  # noqa: BLE001
            s2, c2, d2 = 0, "", b""
        if s2 < 400 and d2 and is_pdf(nxt, c2, d2):
            dg2, _ = fingerprint(nxt, c2, d2)
            core.log_event(db, "watcher", "watcher_moved", notice.id, frm=src.url, to=nxt)
            src.url, src.last_hash, src.last_changed_at = nxt, dg2, core.now_iso()
            if notice.source_url != nxt:
                notice.source_url = nxt
            _draft_from(db, notice, d2, nxt, dg2, f"Next year's official file ({d.year + 1}).")
            _tell_approvers(db, f"Next Year's Notice Published: {notice.title}",
                            f"The agency published the {d.year + 1} version. Approve it with the date it takes effect "
                            "(usually 01/01).", notice.id, f"next-{d.year + 1}", days=90)
            result = "moved"
    return result


def run_watcher(on: date | None = None, fetcher=fetch, pace: float = PACE_S, fresh_hours: int = 20) -> dict:
    """Check every source not checked in the last `fresh_hours` (the daily
    loop also runs after each deploy), one at a time, paced. Each source
    commits alone."""
    db = SessionLocal()
    out: dict = {}
    try:
        cfg = core.settings(db)
        if not cfg.get("watcherOn"):
            return {"skipped": True}
        stale = (datetime.now(timezone.utc) - timedelta(hours=fresh_hours)).isoformat()
        ids = [r[0] for r in db.query(models.WorkplaceNoticeSource.notice_id)
               .filter(models.WorkplaceNoticeSource.url != "",
                       (models.WorkplaceNoticeSource.last_checked_at == "")
                       | (models.WorkplaceNoticeSource.last_checked_at < stale)).all()]
        for i, nid in enumerate(ids):
            notice = db.get(models.WorkplaceNotice, nid)
            src = db.get(models.WorkplaceNoticeSource, nid)
            if notice is None or src is None or notice.status != "active" or not src.url:
                continue
            try:
                res = check_source(db, src, notice, on=on, fetcher=fetcher)
                db.commit()
            except Exception as e:  # noqa: BLE001
                db.rollback()
                res = f"error: {e}"
            out[res.split(":")[0]] = out.get(res.split(":")[0], 0) + 1
            if pace and i < len(ids) - 1:
                time.sleep(pace)
        return out
    finally:
        db.close()


# ── Calendar ─────────────────────────────────────────────────────────────────

def calendar(db, year: int | None = None) -> list:
    """The year's deadlines, sorted: [{date, key, title, detail, noticeId}]."""
    y = year or core.today().year
    cfg = core.settings(db)
    rows = {n.id: n for n in db.query(models.WorkplaceNotice).filter(models.WorkplaceNotice.status == "active").all()}
    items = []

    def add(d, key, title, detail, nid=""):
        items.append({"date": d.isoformat(), "key": key, "title": title, "detail": detail, "noticeId": nid})

    add(date(y, 1, 1), f"jan1-{y}", "New Minimum Wage Posters Take Effect",
        "California and City of San Diego wage posters for the year go live - approve them in December.")
    for nid, n in rows.items():
        if n.annual_due and n.trigger in ("annual", "hire_annual"):
            try:
                add(date(y, int(n.annual_due[:2]), int(n.annual_due[3:])), f"due-{nid}-{y}", f"{n.title} Due",
                    "Every employee must have this year's copy - Nexus sends it once the version is approved.", nid)
            except ValueError:
                pass
        if n.trigger == "window" and n.window:
            try:
                lo = date(y, int(n.window[0][:2]), int(n.window[0][3:]))
                add(lo, f"window-{nid}-{y}", f"Post {n.title}", f"Posted {_us(lo.isoformat())} through {n.window[1].replace('-', '/')}.", nid)
            except ValueError:
                pass
    for e in cfg.get("elections") or []:
        try:
            ed = date.fromisoformat(e)
        except ValueError:
            continue
        if ed.year == y:
            add(ed - timedelta(days=10), f"vote-{e}", "Post Time Off to Vote",
                f"At every California site 10 days before the {_us(e)} election.", "ca-vote")
    add(date(y, 12, 1), f"review-{y + 1}", f"Annual Notice Review for {y + 1}",
        "Approve next year's posters and sign the review of every notice.")
    # each notice's own review date
    from routers.notices import ser_notice
    by: dict = {}
    for v in db.query(models.WorkplaceNoticeVersion).all():
        by.setdefault(v.notice_id, []).append(v)
    for nid, n in rows.items():
        s = ser_notice(db, n, by.get(nid, []), {})
        if s["reviewDue"] and s["reviewDue"][:4] == str(y):
            add(date.fromisoformat(s["reviewDue"]), f"rev-{nid}-{s['reviewDue']}", f"Review {n.title}",
                "A year since this version went live - check the official source.", nid)
    return sorted(items, key=lambda x: x["date"])


def calendar_reminders(db, on: date | None = None) -> int:
    d = on or core.today()
    sent = 0
    for it in calendar(db, d.year) + calendar(db, d.year + 1):
        left = (date.fromisoformat(it["date"]) - d).days
        if left in (30, 7):
            sent += _tell_approvers(db, f"In {left} Days: {it['title']}", f"{_us(it['date'])} - {it['detail']}",
                                    it["noticeId"] or "calendar", f"{it['key']}-{left}", days=40)
    db.commit()
    return sent


# ── Annual review ────────────────────────────────────────────────────────────

def review_items(db, year: str) -> list:
    """Every active notice and what it will be on 01/01 of `year`."""
    from routers.notices import ser_notice
    jan1 = date(int(year), 1, 1)
    by: dict = {}
    for v in db.query(models.WorkplaceNoticeVersion).all():
        by.setdefault(v.notice_id, []).append(v)
    out = []
    for n in (db.query(models.WorkplaceNotice).filter(models.WorkplaceNotice.status == "active")
              .order_by(models.WorkplaceNotice.sort).all()):
        s = ser_notice(db, n, by.get(n.id, []), {})
        on_jan1 = core.live_version(db, n.id, on=jan1, rows=by.get(n.id, []))
        out.append({"id": n.id, "title": n.title, "area": n.area, "state": s["state"],
                    "versionOnJan1": (on_jan1.label or f"Version {on_jan1.number}") if on_jan1 else "",
                    "effectiveDate": on_jan1.effective_date if on_jan1 else "",
                    "lastChecked": (s["source"] or {}).get("lastCheckedAt", "")})
    return out


def open_review(db, year: str) -> object:
    r = db.get(models.WorkplaceNoticeReview, year)
    if r is None:
        r = models.WorkplaceNoticeReview(id=year, status="open", opened_at=core.now_iso(), items=[])
        db.add(r)
        core.log_event(db, "system", "review_opened", year=year)
    return r


def review_pass(db, on: date | None = None) -> int:
    """From 12/01 the next year's review is open; approvers hear weekly until
    it is signed."""
    d = on or core.today()
    if d.month != 12:
        return 0
    year = str(d.year + 1)
    r = open_review(db, year)
    sent = 0
    if r.status != "signed":
        sent = _tell_approvers(db, f"Annual Notice Review for {year}",
                               f"Check every notice for {year} and sign the review in People > Notices.",
                               "review", year, days=6)
    db.commit()
    return sent


def run_daily() -> None:
    for step in (calendar_reminders, review_pass):
        db = SessionLocal()
        try:
            step(db)
        except Exception as e:  # noqa: BLE001
            db.rollback()
            print(f"[notices] {step.__name__} failed: {e}")
        finally:
            db.close()
    try:
        print(f"[notices] watcher: {run_watcher()}")
    except Exception as e:  # noqa: BLE001
        print(f"[notices] watcher failed: {e}")
