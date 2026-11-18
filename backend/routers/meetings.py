"""Meeting Notes (Neil, 11/12/2026): a Notes note for a Teams meeting.

Teams records and transcribes the call (nothing Nexus pays for); Nexus is the
notebook around it. Phase 1:

  GET  /meetings/day           the caller's Teams meetings between two times
                               (their own Outlook calendar, read with the app
                               token - Calendars.ReadWrite, already granted for
                               shift_calendar / hr_interviews), each with the
                               note the caller already has for it.
  POST /meetings/notes         the caller's note for one of those meetings:
                               made once (title, the invite's agenda folded in
                               a toggle), the same note every time after.
  GET  /meetings/notes/{id}    the meeting behind a note: when, who, the join
                               link (only to the people invited).
  GET  /meetings/notes/{id}/transcript
                               the Teams transcript as cues with wall-clock
                               times, so a line typed at 10:04 finds what was
                               said at 10:04.

LINKS, NEVER COPIES (Neil, 11/12/2026): the transcript and the recording stay
in Teams. Nothing of them is written to the database or to storage; the
transcript is read through Graph when someone opens it (kept in this worker's
memory for TRANSCRIPT_TTL so reopening a panel does not call Graph again), and
the recording is reached in Teams through the meeting chat. When Teams lets
them go, they are gone from the note too.

Who reads what: the note follows the Notes rules (routers/notes.py - owner and
the people it is shared with, 404 to anyone else). The meeting's join link and
transcript are only for the people on the invite (organizer + attendees,
copied from the calendar event when the note was made) - sharing the note with
someone who was not invited shares the notes, never the call. Externals and
Act As are refused: a calendar and a call are a person's own.

TESTERS FIRST (Neil, 11/12/2026: "turn this feature on for Neil Kadakia on
production as a tester"): Meeting Notes is off for everyone except the people
in the `meeting_notes.access` nexus_settings row - JSON {"everyone": false,
"emails": [...]} - per database, so dev and production each keep their own
list. Every route answers 403 to anyone else and GET /meetings/access tells
the screen whether to show the Meetings button. No row = nobody. Widen it by
editing the row (or "everyone": true), never by a code default.

The Graph lookups reuse routers/meeting_files.py (Visesh, Oct 24 2026: the
organizer's id from the join link, the Teams application access policy, the
transcript list and its "switched off for the tenant" answer) - never a second
copy of them. An AI summary is Phase 4, behind ai_switch, off. Nothing here
calls a model.

Phase 2 (Neil, 11/12/2026):

  Highlights   - the transcript answer carries `highlights` (possible action
                 items, decisions, open questions) read by RULES from the cues
                 (meeting_highlights.py); computed per read, never stored.
  Last time    - a meeting in a recurring series (Graph's seriesMasterId, kept
                 as `series_id`) shows the reader's note from the series'
                 previous meeting and the tasks made from it that are still
                 open, through record_links' own task walls.
  Ready bell   - OPT-IN per person (`meeting_notes.alerts:<email>` in
                 nexus_settings, PUT /meetings/alerts): after a meeting with a
                 note ends, ready_pass (meeting_ready_loop, every 5 minutes, off
                 the event loop) asks Teams whether a transcript exists - the
                 list only, never its words - and bells the note's owner once
                 ("Transcript Ready", opens the note). It looks for 8 hours
                 after the end, at most every 10 minutes per meeting. Opening
                 the transcript yourself marks it ready, so nobody is belled
                 about one they already read.
"""
from __future__ import annotations

import json
import re
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from html import escape
from typing import List, Optional
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import meeting_highlights
import models
from auth import get_current_user
from database import get_db
from routers import meeting_files, notes

router = APIRouter(prefix="/meetings", tags=["Meeting Notes"])

_GRAPH = "https://graph.microsoft.com/v1.0"
DAY_SPAN_MAX = timedelta(hours=48)
AGENDA_MAX = 2000
CUES_MAX = 6000
MERGE_GAP_S = 3.0          # one speaker's cues closer than this read as one paragraph
MERGE_CHARS = 700
TRANSCRIPT_TTL = 15 * 60   # seconds a read transcript is kept in this worker's memory
_CACHE_MAX = 32
SOURCE_KIND = "meeting"    # the note's source: {kind: 'meeting', id: <row id>, label: subject}
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CAL_HINT = ("Nexus cannot read Outlook calendars yet - the GreensNexus app needs the Calendars.ReadWrite "
             "application permission with admin consent")


def _me(user: dict) -> str:
    return meeting_files._canon(user.get("email", ""))


ACCESS_KEY = "meeting_notes.access"


def _access_rule(db: Session) -> dict:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == ACCESS_KEY).first()
    try:
        rule = json.loads(row.value) if row and row.value else {}
    except ValueError:
        rule = {}
    return rule if isinstance(rule, dict) else {}


def may_use(db: Session, email: str) -> bool:
    """Whether Meeting Notes is turned on for this person (testers first)."""
    rule = _access_rule(db)
    if rule.get("everyone") is True:
        return True
    emails = rule.get("emails") if isinstance(rule.get("emails"), list) else []
    return meeting_files._canon(email) in {meeting_files._canon(str(e)) for e in emails}


def _guard(user: dict, db: Session) -> str:
    if user.get("external"):
        raise HTTPException(403, "Meeting notes are for Greens staff only")
    if user.get("acting_as"):
        raise HTTPException(403, "Meeting notes are not available while acting as someone - a calendar is a person's own")
    me = _me(user)
    if not may_use(db, me):
        raise HTTPException(403, "Meeting Notes is not turned on for you yet")
    return me


@router.get("/access")
def meetings_access(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Whether the screen shows Meetings to this person."""
    try:
        me = _guard(user, db)
    except HTTPException:
        return {"enabled": False, "alerts": False}
    return {"enabled": True, "alerts": alerts_on(db, me)}


def _iso(value: str) -> datetime:
    try:
        d = datetime.fromisoformat((value or "").strip().replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(400, "Times must be ISO 8601")
    if d.tzinfo is None:
        raise HTTPException(400, "Times need a UTC offset")
    return d.astimezone(timezone.utc)


def _graph_time(t: dict) -> str:
    """Graph's {dateTime, timeZone: 'UTC'} (asked for with Prefer) as ISO UTC."""
    raw = ((t or {}).get("dateTime") or "")[:19]
    return f"{raw}Z" if raw else ""


def _join_url(ev: dict) -> str:
    url = ((ev.get("onlineMeeting") or {}).get("joinUrl") or "").strip()
    return url if ev.get("isOnlineMeeting") and url.startswith("https://teams.microsoft.com/") else ""


def _person(p: dict) -> dict:
    a = (p or {}).get("emailAddress") or {}
    return {"email": meeting_files._canon(a.get("address", "")), "name": (a.get("name") or "").strip()}


def _attendees(ev: dict) -> list[dict]:
    """The invite's people (rooms and equipment left out), one row each."""
    out, seen = [], set()
    for a in ev.get("attendees") or []:
        if (a.get("type") or "").lower() == "resource":
            continue
        p = _person(a)
        if p["email"] and p["email"] not in seen:
            seen.add(p["email"])
            out.append(p)
    return out


def _calendar_headers() -> dict:
    h = meeting_files._headers()
    return {**h, "Prefer": 'outlook.timezone="UTC", outlook.body-content-type="text"'}


_EVENT_FIELDS = ("subject,start,end,isOnlineMeeting,onlineMeeting,organizer,attendees,iCalUId,isCancelled,"
                 "seriesMasterId,type,isAllDay,location,onlineMeetingUrl")
# Phase 3: a meeting on another service is still a meeting - its link, when the
# invite carries one, opens it (Zoom, Google Meet, Webex, GoTo).
_OTHER_LINK = re.compile(r"https://[A-Za-z0-9.-]*(zoom\.us|meet\.google\.com|webex\.com|gotomeeting\.com|goto\.com)/[^\s<>\"']{1,500}", re.I)


def _other_link(ev: dict) -> str:
    loc = ev.get("location") or {}
    for text in (ev.get("onlineMeetingUrl") or "", loc.get("locationUri") or "", loc.get("displayName") or "",
                 ((ev.get("body") or {}).get("content") or "")):
        m = _OTHER_LINK.search(text or "")
        if m:
            return m.group(0)
    return ""


def _meeting_out(ev: dict, me: str) -> dict:
    org = _person(ev.get("organizer") or {})
    join = _join_url(ev)
    return {
        "eventId": ev.get("id") or "", "icalUid": ev.get("iCalUId") or "",
        "subject": (ev.get("subject") or "").strip() or ("Teams Meeting" if join else "Meeting"),
        "start": _graph_time(ev.get("start")), "end": _graph_time(ev.get("end")),
        "organizer": org, "isOrganizer": org["email"] == me,
        "attendees": _attendees(ev), "joinUrl": join,
        "seriesId": (ev.get("seriesMasterId") or "")[:500],
        "kind": "teams" if join else "other",
        "onlineUrl": "" if join else _other_link(ev),
        "location": ((ev.get("location") or {}).get("displayName") or "").strip()[:200],
    }


# ── the day's meetings ─────────────────────────────────────────────────────
@router.get("/day")
def meetings_day(start: str = Query(...), end: str = Query(...),
                 user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The caller's meetings from `start` to `end` (the browser's own day,
    ISO with an offset), earliest first, each with `noteId` - the caller's note
    for it, else one shared with them, else ''. `enabled: false` with a reason
    when Graph cannot read calendars yet (the screen says so, never an error)."""
    me = _guard(user, db)
    s, e = _iso(start), _iso(end)
    if e <= s or e - s > DAY_SPAN_MAX:
        raise HTTPException(400, "Pick a span of up to two days")
    try:
        h = _calendar_headers()
    except HTTPException as err:
        return {"enabled": False, "reason": err.detail, "meetings": []}
    r = httpx.get(f"{_GRAPH}/users/{me}/calendarView", headers=h, timeout=20, params={
        "startDateTime": s.strftime("%Y-%m-%dT%H:%M:%SZ"), "endDateTime": e.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "$select": _EVENT_FIELDS, "$orderby": "start/dateTime", "$top": "100"})
    if r.status_code in (401, 403):
        return {"enabled": False, "reason": _CAL_HINT, "meetings": []}
    if r.status_code == 404:
        return {"enabled": False, "reason": "There is no Outlook calendar for your account", "meetings": []}
    if not r.is_success:
        raise HTTPException(502, f"Could not read your calendar ({r.status_code})")
    # Every meeting on the calendar (Phase 3): Teams ones get the Teams
    # transcript, the rest are transcribed on the device. All-day items are
    # not meetings.
    meetings = [_meeting_out(ev, me) for ev in r.json().get("value") or []
                if not ev.get("isCancelled") and not ev.get("isAllDay") and ev.get("iCalUId")]
    found = _readable_notes(db, me, [m["icalUid"] for m in meetings])
    for m in meetings:
        m["noteId"] = found.get(m["icalUid"], "")
    return {"enabled": True, "meetings": meetings}


def _readable_notes(db: Session, me: str, uids: list[str]) -> dict:
    """iCalUId -> the note the caller has for it: their own first, else one shared with them."""
    if not uids:
        return {}
    rows = db.query(models.NexusMeetingNote).filter(models.NexusMeetingNote.ical_uid.in_(uids)).all()
    by_note = {n.id: n for n in db.query(models.NexusNote)
               .filter(models.NexusNote.id.in_([r.note_id for r in rows if r.note_id])).all()} if rows else {}
    out: dict[str, str] = {}
    for r in sorted(rows, key=lambda x: x.owner_email != me):     # the caller's own rows first
        n = by_note.get(r.note_id)
        if r.ical_uid in out or n is None or not notes._access(n, me):
            continue
        out[r.ical_uid] = n.id
    return out


# ── the note for a meeting ─────────────────────────────────────────────────
class OpenIn(BaseModel):
    eventId: str
    day: Optional[str] = ""     # the meeting's day where the caller is (YYYY-MM-DD)


def _agenda(body_text: str) -> str:
    """The invite's own words, without the Teams join block Outlook adds."""
    t = (body_text or "").replace("\r\n", "\n")
    cut = re.search(r"^_{10,}\s*$|^\s*Microsoft Teams (meeting|Need help)", t, re.M | re.I)
    if cut:
        t = t[:cut.start()]
    t = re.sub(r"\n\s*\n+", "\n\n", t).strip()
    return t[:AGENDA_MAX]


def _starting_body(agenda: str) -> str:
    """A new meeting note: the agenda folded away (when the invite has one), then room to write."""
    if not agenda:
        return "<p></p>"
    paras = "".join(f"<p>{escape(line)}</p>" for line in agenda.split("\n") if line.strip())
    return f'<div data-type="toggle" data-summary="Agenda" data-open="false">{paras}</div><p></p>'


@router.post("/notes")
def open_meeting_note(body: OpenIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The caller's note for a meeting on their own calendar: made the first
    time, the same one after ({noteId, created}). The event is read from the
    caller's calendar, never taken from the request, so nobody can make a
    meeting note for a call they were not invited to."""
    me = _guard(user, db)
    day = (body.day or "").strip()
    if day and not _DAY.match(day):
        raise HTTPException(400, "Day must be YYYY-MM-DD")
    event_id = (body.eventId or "").strip()
    if not event_id or len(event_id) > 500:
        raise HTTPException(400, "Pick a meeting from your calendar")
    r = httpx.get(f"{_GRAPH}/users/{me}/events/{quote(event_id, safe='')}", headers=_calendar_headers(), timeout=20,
                  params={"$select": _EVENT_FIELDS + ",body"})
    if r.status_code in (401, 403):
        raise HTTPException(502, _CAL_HINT)
    if r.status_code in (400, 404):
        raise HTTPException(404, "That meeting is not on your calendar")
    if not r.is_success:
        raise HTTPException(502, f"Could not read the meeting ({r.status_code})")
    ev = r.json()
    m = _meeting_out(ev, me)
    if not m["icalUid"]:
        raise HTTPException(400, "That calendar item is not a meeting")

    row = (db.query(models.NexusMeetingNote)
           .filter(models.NexusMeetingNote.owner_email == me, models.NexusMeetingNote.ical_uid == m["icalUid"]).first())
    if row is not None:
        n = db.query(models.NexusNote).filter(models.NexusNote.id == row.note_id).first()
        if n is not None:
            return {"noteId": n.id, "created": False}
    n = notes._new_note(me, kind="note", title=m["subject"][:notes.TITLE_MAX],
                        day=day or (m["start"][:10] if m["start"] else datetime.now(timezone.utc).strftime("%Y-%m-%d")),
                        color="", pinned=False)
    notes._set_body(n, _starting_body(_agenda(((ev.get("body") or {}).get("content")) or "")))
    if row is None:
        row = models.NexusMeetingNote(id="mtg_" + uuid.uuid4().hex, owner_email=me, ical_uid=m["icalUid"],
                                      created_at=datetime.now(timezone.utc).isoformat())
        db.add(row)
    row.note_id = n.id
    row.event_id = m["eventId"]
    row.join_url = m["joinUrl"]
    row.organizer = m["organizer"]["email"]
    row.subject = m["subject"][:300]
    row.start_at, row.end_at = m["start"], m["end"]
    row.attendees = json.dumps([m["organizer"], *m["attendees"]] if m["organizer"]["email"] else m["attendees"])
    row.series_id = m["seriesId"]
    row.kind = m["kind"]
    row.online_url = m["onlineUrl"]
    n.source = json.dumps({"kind": SOURCE_KIND, "id": row.id, "label": m["subject"][:notes.SOURCE_LABEL_MAX], "url": ""})
    notes._content_changed(n, me)
    db.add(n)
    try:
        db.commit()
    except IntegrityError:
        # A second click raced this one: theirs made the row, so this note goes and theirs answers.
        db.rollback()
        row = (db.query(models.NexusMeetingNote)
               .filter(models.NexusMeetingNote.owner_email == me, models.NexusMeetingNote.ical_uid == m["icalUid"]).first())
        if row is None:
            raise HTTPException(409, "Try again")
        return {"noteId": row.note_id, "created": False}
    return {"noteId": n.id, "created": True}


def _row_for_note(db: Session, note_id: str, me: str) -> tuple:
    """(note, access, meeting row) for a meeting note the caller may read; 404 otherwise."""
    n, can = notes._get_or_404(db, note_id, me)
    src = notes._loads(n.source, {})
    row = None
    if src.get("kind") == SOURCE_KIND and src.get("id"):
        row = db.query(models.NexusMeetingNote).filter(models.NexusMeetingNote.id == str(src["id"])).first()
    if row is None or row.note_id != n.id:
        raise HTTPException(404, "This note is not linked to a meeting")
    return n, can, row


def _invited(row: models.NexusMeetingNote, me: str) -> bool:
    if (row.kind or "teams") == "adhoc":
        return meeting_files._canon(row.owner_email) == me     # a meeting with no invite is its owner's
    people = {meeting_files._canon(p.get("email", "")) for p in notes._loads(row.attendees, []) if isinstance(p, dict)}
    return me in people or me == meeting_files._canon(row.organizer)


@router.get("/notes/{note_id}")
def meeting_of_note(note_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The meeting a note was taken for. `invited` says whether the caller was
    on the invite - only then are the join link and the transcript theirs."""
    me = _guard(user, db)
    _, can, row = _row_for_note(db, note_id, me)
    invited = _invited(row, me)
    return {
        "subject": row.subject or "", "start": row.start_at or "", "end": row.end_at or "",
        "organizer": row.organizer or "",
        "attendees": [p for p in notes._loads(row.attendees, []) if isinstance(p, dict) and p.get("email")],
        "invited": invited, "joinUrl": row.join_url if invited else "", "mine": can == "owner",
        "transcriptReady": bool(row.transcript_ready_at) and invited,
        "previous": _previous_in_series(db, user, me, row),
        # Phase 3: what kind of meeting, its link elsewhere, and the transcript
        # made in Nexus (who may record one: the note's owner and Can Edit).
        "kind": row.kind or "teams",
        "onlineUrl": row.online_url if invited else "",
        "mayRecord": can in ("owner", "edit"),
        "recorded": _recorded_summary(db, row.note_id),
    }


OPEN_TASKS_MAX = 10


def _previous_in_series(db: Session, user: dict, me: str, row: models.NexusMeetingNote) -> Optional[dict]:
    """The reader's note from this series' previous meeting (their own first,
    else one shared with them) and the tasks made from it that are still open -
    each task only if the reader may open it (record_links' task walls)."""
    if not row.series_id or not row.start_at:
        return None
    earlier = (db.query(models.NexusMeetingNote)
               .filter(models.NexusMeetingNote.series_id == row.series_id,
                       models.NexusMeetingNote.start_at < row.start_at,
                       models.NexusMeetingNote.note_id != row.note_id)
               .order_by(models.NexusMeetingNote.start_at.desc()).limit(40).all())
    if not earlier:
        return None
    by_note = {n.id: n for n in db.query(models.NexusNote)
               .filter(models.NexusNote.id.in_([r.note_id for r in earlier if r.note_id])).all()}
    newest = earlier[0].start_at
    # The most recent earlier meeting that has a note this reader may open - their own first on the same day.
    pick = None
    for r in sorted(earlier, key=lambda x: (x.start_at, x.owner_email == me), reverse=True):
        n = by_note.get(r.note_id)
        if n is not None and not n.trashed_at and notes._access(n, me):
            pick = (r, n)
            break
    if pick is None:
        return None
    r, n = pick
    import record_links
    tasks = []
    for ref in record_links.refs_in(n.body or ""):
        kind, _, tid = ref.partition(":")
        if kind != "task":
            continue
        item = record_links._task_item(db, user, tid)
        if item and not item["done"]:
            tasks.append({"id": item["id"], "title": item["title"], "code": item["code"]})
        if len(tasks) >= OPEN_TASKS_MAX:
            break
    return {"noteId": n.id, "title": n.title or r.subject or "", "start": r.start_at,
            "latest": r.start_at == newest, "openTasks": tasks}


# ── the ready bell (opt-in per person) ─────────────────────────────────────
ALERTS_KEY = "meeting_notes.alerts:"
READY_LOOK_FOR = timedelta(hours=8)     # after the meeting's end
READY_RECHECK = timedelta(minutes=10)   # per meeting
READY_GRACE = timedelta(minutes=2)      # Teams publishes a few minutes after the end
READY_BATCH = 40


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def alerts_on(db: Session, email: str) -> bool:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == ALERTS_KEY + meeting_files._canon(email)).first()
    return bool(row and row.value == "on")


class AlertsIn(BaseModel):
    on: bool


@router.get("/alerts")
def get_alerts(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Whether this person is belled when a meeting's transcript is ready."""
    me = _guard(user, db)
    return {"on": alerts_on(db, me)}


@router.put("/alerts")
def set_alerts(body: AlertsIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _guard(user, db)
    key = ALERTS_KEY + me
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == key).first()
    if row is None:
        row = models.NexusSetting(key=key)
        db.add(row)
    row.value = "on" if body.on else ""
    row.updated_by = me
    row.updated_at = _now_iso()
    db.commit()
    return {"on": bool(body.on)}


def _transcript_exists(row: models.NexusMeetingNote, h: dict) -> bool:
    """Whether Teams has published a transcript - the list only, never its words."""
    m, oid = _online_meeting(row, h)
    return bool(meeting_files._list(oid, m["id"], "transcripts", h))


def ready_pass(db: Session, now: Optional[datetime] = None) -> int:
    """Bell each opted-in owner once their meeting's transcript is published.
    Returns how many were belled. Graph trouble on one meeting never stops the
    others; Graph saying transcripts are off for the whole tenant stops the pass."""
    now = now or datetime.now(timezone.utc)
    lo, hi = (now - READY_LOOK_FOR).strftime("%Y-%m-%dT%H:%M:%SZ"), (now - READY_GRACE).strftime("%Y-%m-%dT%H:%M:%SZ")
    stale = (now - READY_RECHECK).isoformat()
    rows = (db.query(models.NexusMeetingNote)
            .filter(models.NexusMeetingNote.transcript_ready_at == "",
                    models.NexusMeetingNote.join_url != "",
                    models.NexusMeetingNote.end_at >= lo, models.NexusMeetingNote.end_at <= hi,
                    models.NexusMeetingNote.ready_checked_at < stale)
            .order_by(models.NexusMeetingNote.end_at).limit(READY_BATCH).all())
    rows = [r for r in rows if may_use(db, r.owner_email) and alerts_on(db, r.owner_email)]
    if not rows:
        return 0
    try:
        h = meeting_files._headers()
    except HTTPException:
        return 0
    import notify_rollup
    from auth import company_of
    belled = 0
    for r in rows:
        n = db.query(models.NexusNote).filter(models.NexusNote.id == r.note_id).first()
        r.ready_checked_at = now.isoformat()
        if n is None or n.trashed_at:
            db.commit()
            continue
        try:
            ready = _transcript_exists(r, h)
        except HTTPException as e:
            db.commit()
            if e.status_code == 409:
                break       # transcripts are off for the tenant: nothing to look for
            continue
        except httpx.HTTPError:
            db.commit()
            continue
        if ready:
            r.transcript_ready_at = now.isoformat()
            title = (r.subject or n.title or "your meeting").strip()
            notify_rollup.upsert_rollup(
                db, recipient=r.owner_email, key=f"meeting-ready:{n.id}", title="Meeting Transcript Ready",
                line=f'The Teams transcript of "{title[:80]}" is ready beside your notes.',
                action={"view": "dashboard", "sub": f"notes:{n.id}"},
                company=company_of(r.owner_email, db) or "", requested_by=r.owner_email, replace=True)
            belled += 1
        db.commit()
    return belled


def run_ready_pass() -> int:
    from database import SessionLocal
    db = SessionLocal()
    try:
        return ready_pass(db)
    finally:
        db.close()


async def meeting_ready_loop():
    """The ready bell, every 5 minutes on the leader - Graph and the database in a thread (CLAUDE.md)."""
    import asyncio
    await asyncio.sleep(120)
    while True:
        try:
            await asyncio.to_thread(run_ready_pass)
        except Exception as e:  # noqa: BLE001 - one bad pass never stops the loop
            print(f"[meeting notes] ready pass failed: {e}")
        await asyncio.sleep(300)


# ── the transcript (read from Teams, never kept) ───────────────────────────
_TS = re.compile(r"^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$")
_VOICE = re.compile(r"<v(?:\.[^\s>]*)?\s+([^>]*)>", re.I)
_TAG = re.compile(r"<[^>]+>")


def _seconds(ts: str) -> Optional[float]:
    m = _TS.match((ts or "").strip())
    if not m:
        return None
    h, mi, s, ms = m.groups()
    return int(h or 0) * 3600 + int(mi) * 60 + int(s) + (int((ms or "0").ljust(3, "0")) / 1000)


def parse_vtt(vtt: str) -> list[dict]:
    """WebVTT -> [{start, end, speaker, text}] in seconds from the transcript's
    start, one speaker's back-to-back cues joined into one paragraph."""
    out: list[dict] = []
    for block in re.split(r"\n\s*\n", (vtt or "").replace("\r\n", "\n")):
        lines = [x for x in block.split("\n") if x.strip()]
        at = next((k for k, x in enumerate(lines) if "-->" in x), -1)
        if at < 0:
            continue
        a, _, b = lines[at].partition("-->")
        start, end = _seconds(a), _seconds(b.strip().split(" ")[0])
        if start is None:
            continue
        raw = " ".join(lines[at + 1:])
        voice = _VOICE.search(raw)
        speaker = voice.group(1).strip() if voice else ""
        text = re.sub(r"\s+", " ", _TAG.sub("", raw)).strip()
        if not text:
            continue
        prev = out[-1] if out else None
        if (prev and prev["speaker"] == speaker and start - prev["end"] <= MERGE_GAP_S
                and len(prev["text"]) + len(text) < MERGE_CHARS):
            prev["text"] += " " + text
            prev["end"] = max(prev["end"], end or start)
            continue
        out.append({"start": start, "end": end if end is not None else start, "speaker": speaker, "text": text})
    return out


_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()


def _cached(key: str) -> Optional[dict]:
    with _cache_lock:
        hit = _cache.get(key)
        if hit and hit[0] > time.time():
            return hit[1]
        _cache.pop(key, None)
        return None


def _remember(key: str, value: dict) -> None:
    with _cache_lock:
        if len(_cache) >= _CACHE_MAX:
            _cache.pop(min(_cache, key=lambda k: _cache[k][0]), None)
        _cache[key] = (time.time() + TRANSCRIPT_TTL, value)


def _online_meeting(row: models.NexusMeetingNote, h: dict) -> tuple[dict, str]:
    oid = meeting_files._organizer_oid(row.join_url, row.organizer, h)
    url = row.join_url.replace("'", "''")
    r = httpx.get(f"{_GRAPH}/users/{oid}/onlineMeetings", params={"$filter": f"JoinWebUrl eq '{url}'"},
                  headers=h, timeout=30)
    if r.status_code in (401, 403):
        raise HTTPException(502, meeting_files._POLICY_HINT)
    if not r.is_success:
        raise HTTPException(502, f"Meeting lookup failed ({r.status_code})")
    found = r.json().get("value") or []
    if not found:
        raise HTTPException(404, "Teams no longer has this meeting")
    return found[0], oid


def _stamp(iso: str) -> Optional[float]:
    try:
        return datetime.fromisoformat((iso or "").replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


@router.get("/notes/{note_id}/transcript")
def meeting_transcript(note_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The meeting's Teams transcript, read now: `cues` [{at, speaker, text}]
    with `at` in Unix seconds (the transcript's start + the cue's offset, so it
    lines up with a note line's stamp), every transcript of the call in order
    (transcription stopped and started again), plus how many recordings Teams
    has and the meeting chat's thread (Open in Teams - the recording lives
    there). 404 with a plain reason while there is none yet."""
    me = _guard(user, db)
    _, _, row = _row_for_note(db, note_id, me)
    if (row.kind or "teams") != "teams" or not row.join_url:
        raise HTTPException(404, "This meeting is not on Teams - its transcript is the one recorded in Nexus")
    if not _invited(row, me):
        raise HTTPException(403, "The transcript is only for the people invited to the meeting")
    key = row.join_url
    hit = _cached(key)
    if hit is not None:
        return hit
    h = meeting_files._headers()
    m, oid = _online_meeting(row, h)
    items = meeting_files._list(oid, m["id"], "transcripts", h)     # 409: switched off for the tenant
    if not items:
        raise HTTPException(404, "No transcript yet - someone has to start transcription in the meeting, "
                                 "and Teams publishes it a few minutes after the call ends")
    cues: list[dict] = []
    for t in items:
        r = httpx.get(f"{_GRAPH}/users/{oid}/onlineMeetings/{m['id']}/transcripts/{t['id']}/content",
                      params={"$format": "text/vtt"}, headers=h, timeout=60)
        if not r.is_success:
            raise HTTPException(502, f"Could not read the transcript ({r.status_code})")
        base = _stamp(t.get("createdDateTime") or "") or _stamp(row.start_at) or 0.0
        cues += [{"at": round(base + c["start"]), "speaker": c["speaker"], "text": c["text"]} for c in parse_vtt(r.text)]
    try:
        recordings = len(meeting_files._list(oid, m["id"], "recordings", h))
    except HTTPException:
        recordings = 0      # a recording it cannot see never hides the transcript
    cues = cues[:CUES_MAX]
    out = {"cues": cues, "truncated": len(cues) >= CUES_MAX, "recordings": recordings,
           "chatThreadId": ((m.get("chatInfo") or {}).get("threadId") or ""), "transcripts": len(items),
           "highlights": meeting_highlights.extract(cues)}
    if not row.transcript_ready_at:
        # Read it yourself = it is ready: the ready bell never tells you about one you already opened.
        row.transcript_ready_at = _now_iso()
        db.commit()
    _remember(key, out)
    return out


# ── Phase 3: meetings outside Teams, transcribed on the device ─────────────
# (Neil, 11/12/2026: "Text lives in Nexus"; consent asked every time; Whisper
# on the device with the browser's own speech service as the fallback; testers
# first.) The audio never reaches the server - the browser turns speech into
# text (frontend/src/notes/meetings/capture/) and sends only the words, a few
# lines at a time, so a closed tab loses at most the last few seconds. The
# words live in nexus_meeting_transcripts, one row per note: whoever may read
# the note reads them (the note is where they were written), its owner and Can
# Edit add to them, only its owner deletes them. Every recording starts with a
# session that records who confirmed everyone agreed to be transcribed, and
# when - a session without that is refused.

SEGMENTS_MAX = 20000
TEXT_MAX = 2000
CHARS_MAX = 2_000_000
SPEAKER_MAX = 60
ENGINES = ("whisper", "browser")
SOURCES = ("mic", "mic+tab", "file")
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class AdhocIn(BaseModel):
    title: Optional[str] = ""
    day: Optional[str] = ""


@router.post("/adhoc")
def new_adhoc_meeting(body: AdhocIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """A meeting note for something not on the calendar (a site walk, a
    hallway decision): the caller's own, starting now."""
    me = _guard(user, db)
    day = (body.day or "").strip()
    if day and not _DAY.match(day):
        raise HTTPException(400, "Day must be YYYY-MM-DD")
    title = re.sub(r"\s+", " ", body.title or "").strip()[:notes.TITLE_MAX] or "Meeting"
    now = datetime.now(timezone.utc)
    n = notes._new_note(me, kind="note", title=title, day=day or now.strftime("%Y-%m-%d"), color="", pinned=False)
    notes._set_body(n, "<p></p>")
    row = models.NexusMeetingNote(
        id="mtg_" + uuid.uuid4().hex, owner_email=me, ical_uid="adhoc-" + uuid.uuid4().hex, note_id=n.id,
        kind="adhoc", subject=title[:300], organizer=me, start_at=now.strftime("%Y-%m-%dT%H:%M:%SZ"), end_at="",
        attendees=json.dumps([{"email": me, "name": user.get("name") or ""}]), created_at=now.isoformat())
    n.source = json.dumps({"kind": SOURCE_KIND, "id": row.id, "label": title[:notes.SOURCE_LABEL_MAX], "url": ""})
    notes._content_changed(n, me)
    db.add(row)
    db.add(n)
    db.commit()
    return {"noteId": n.id, "created": True}


def _recorded(db: Session, note_id: str, lock: bool = False) -> Optional[models.NexusMeetingTranscript]:
    q = db.query(models.NexusMeetingTranscript).filter(models.NexusMeetingTranscript.note_id == note_id)
    return (q.with_for_update() if lock else q).first()


def _recorded_summary(db: Session, note_id: str) -> dict:
    t = _recorded(db, note_id)
    if t is None:
        return {"exists": False, "segments": 0, "live": False}
    sessions = notes._loads(t.sessions, [])
    segs = notes._loads(t.segments, [])
    return {"exists": bool(segs or sessions), "segments": len(segs),
            "live": any(isinstance(x, dict) and not x.get("endedAt") for x in sessions)}


def _note_for_recording(db: Session, note_id: str, me: str, write: bool, lock: bool = False):
    """(note, access) for a meeting note; a write needs owner or Can Edit and a live note."""
    n, can = notes._get_or_404(db, note_id, me, lock=lock)
    src = notes._loads(n.source, {})
    if src.get("kind") != SOURCE_KIND:
        raise HTTPException(404, "This note is not linked to a meeting")
    if write and (can not in ("owner", "edit") or n.trashed_at):
        raise HTTPException(403, "Only the note's owner and the people who can edit it record its meeting")
    return n, can


def _recorded_out(t: Optional[models.NexusMeetingTranscript], can: str) -> dict:
    segs = notes._loads(t.segments, []) if t else []
    speakers = notes._loads(t.speakers, {}) if t else {}
    named = lambda label: speakers.get(label) or label   # noqa: E731
    cues = [{"id": s.get("id"), "at": s.get("at"), "end": s.get("end"), "speaker": named(s.get("speaker") or ""),
             "label": s.get("speaker") or "", "text": s.get("text") or "", "session": s.get("session") or ""}
            for s in segs if isinstance(s, dict)]
    return {
        "cues": cues,
        "sessions": notes._loads(t.sessions, []) if t else [],
        "speakers": speakers,
        "highlights": meeting_highlights.extract(cues),
        "mayRecord": can in ("owner", "edit"), "mayDelete": can == "owner",
        "rev": (t.rev or 1) if t else 0,
    }


@router.get("/notes/{note_id}/recorded")
def get_recorded(note_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The transcript recorded in Nexus for this meeting note (words only)."""
    me = _guard(user, db)
    _, can = _note_for_recording(db, note_id, me, write=False)
    return _recorded_out(_recorded(db, note_id), can)


class SessionIn(BaseModel):
    id: str
    engine: str
    source: str
    consent: bool = False


@router.post("/notes/{note_id}/recorded/sessions")
def start_recording(note_id: str, body: SessionIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Start a recording session. Refused unless the person confirmed that
    everyone present agreed to be transcribed - kept with who and when."""
    me = _guard(user, db)
    if not body.consent:
        raise HTTPException(400, "Confirm that everyone in the meeting agreed to be transcribed")
    if not _ID.match(body.id or "") or body.engine not in ENGINES or body.source not in SOURCES:
        raise HTTPException(400, "Not a recording session")
    _note_for_recording(db, note_id, me, write=True)
    t = _recorded(db, note_id, lock=True)
    now = datetime.now(timezone.utc).isoformat()
    if t is None:
        t = models.NexusMeetingTranscript(id="mtr_" + uuid.uuid4().hex, note_id=note_id, owner_email=me,
                                          segments="[]", sessions="[]", speakers="{}", rev=1, created_at=now, updated_at=now)
        db.add(t)
    sessions = notes._loads(t.sessions, [])
    if not any(isinstance(x, dict) and x.get("id") == body.id for x in sessions):
        sessions.append({"id": body.id, "by": me, "startedAt": now, "consentAt": now, "endedAt": "",
                         "engine": body.engine, "source": body.source})
    t.sessions = json.dumps(sessions[-200:])
    t.rev = (t.rev or 1) + 1
    t.updated_at = now
    try:
        db.commit()
    except IntegrityError:
        db.rollback()        # two first sessions at once: the other made the row - add to it
        return start_recording(note_id, body, user, db)
    return {"ok": True, "startedAt": now}


class SegmentIn(BaseModel):
    id: str
    at: float
    end: Optional[float] = None
    speaker: Optional[str] = ""
    text: str


class SegmentsIn(BaseModel):
    sessionId: str
    segments: List[SegmentIn]


@router.post("/notes/{note_id}/recorded/segments")
def add_segments(note_id: str, body: SegmentsIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Add words to a session (the same segment id twice is kept once, so a
    resend after a dropped connection never doubles a line)."""
    me = _guard(user, db)
    _note_for_recording(db, note_id, me, write=True)
    t = _recorded(db, note_id, lock=True)
    if t is None or not any(isinstance(x, dict) and x.get("id") == body.sessionId for x in notes._loads(t.sessions, [])):
        raise HTTPException(409, "Start the recording first")
    segs = notes._loads(t.segments, [])
    have = {s.get("id") for s in segs if isinstance(s, dict)}
    added = 0
    for s in body.segments[:200]:
        text = re.sub(r"\s+", " ", s.text or "").strip()[:TEXT_MAX]
        if not text or not _ID.match(s.id or "") or s.id in have or not (1e9 < s.at < 1e10):
            continue
        segs.append({"id": s.id, "at": round(s.at, 2), "end": round(s.end, 2) if s.end and s.end >= s.at else round(s.at, 2),
                     "speaker": re.sub(r"\s+", " ", s.speaker or "").strip()[:SPEAKER_MAX], "text": text,
                     "session": body.sessionId})
        have.add(s.id)
        added += 1
    if len(segs) > SEGMENTS_MAX:
        raise HTTPException(413, "This transcript is full - start a new meeting note for the rest")
    raw = json.dumps(sorted(segs, key=lambda x: x.get("at") or 0), separators=(",", ":"))
    if len(raw) > CHARS_MAX:
        raise HTTPException(413, "This transcript is full - start a new meeting note for the rest")
    if added:
        t.segments = raw
        t.rev = (t.rev or 1) + 1
        t.updated_at = datetime.now(timezone.utc).isoformat()
        db.commit()
    return {"added": added, "total": len(segs)}


@router.post("/notes/{note_id}/recorded/sessions/{session_id}/end")
def end_recording(note_id: str, session_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _guard(user, db)
    _note_for_recording(db, note_id, me, write=True)
    t = _recorded(db, note_id, lock=True)
    if t is None:
        raise HTTPException(404, "No recording on this note")
    sessions = notes._loads(t.sessions, [])
    for x in sessions:
        if isinstance(x, dict) and x.get("id") == session_id and not x.get("endedAt"):
            x["endedAt"] = datetime.now(timezone.utc).isoformat()
    t.sessions = json.dumps(sessions)
    t.rev = (t.rev or 1) + 1
    db.commit()
    return {"ok": True}


class SpeakersIn(BaseModel):
    speakers: dict


@router.put("/notes/{note_id}/recorded/speakers")
def name_speakers(note_id: str, body: SpeakersIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Put names on the transcript's voices ("Others" -> "Visesh")."""
    me = _guard(user, db)
    _, can = _note_for_recording(db, note_id, me, write=True)
    t = _recorded(db, note_id, lock=True)
    if t is None:
        raise HTTPException(404, "No recording on this note")
    clean = {}
    for k, v in list((body.speakers or {}).items())[:50]:
        k = re.sub(r"\s+", " ", str(k)).strip()[:SPEAKER_MAX]
        v = re.sub(r"\s+", " ", str(v or "")).strip()[:SPEAKER_MAX]
        if k and v and v != k:
            clean[k] = v
    t.speakers = json.dumps(clean)
    t.rev = (t.rev or 1) + 1
    db.commit()
    return _recorded_out(t, can)


@router.delete("/notes/{note_id}/recorded")
def delete_recorded(note_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Delete the recorded transcript - the note's owner only, the words gone for good."""
    me = _guard(user, db)
    _, can = _note_for_recording(db, note_id, me, write=False)
    if can != "owner":
        raise HTTPException(403, "Only the note's owner deletes its transcript")
    db.query(models.NexusMeetingTranscript).filter(models.NexusMeetingTranscript.note_id == note_id).delete()
    db.commit()
    return {"ok": True}
