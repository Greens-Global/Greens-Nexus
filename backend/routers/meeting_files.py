"""Meeting files: the Teams transcript and recording of a meeting the caller
was invited to, whoever pressed Record (Visesh, Oct 24 2026).

Why this exists: a Teams recording lands in the organizer's OneDrive and every
other attendee gets view-only access - no download, not even through Graph
with their own sign-in. Nexus Bots (the desktop bot team) signs in as the
person, so it was refused ("Access denied") on any call it did not record.
The GreensNexus Entra app holds the tenant permissions to read meetings
(OnlineMeetings.Read.All, OnlineMeetingTranscript.Read.All,
OnlineMeetingRecording.Read.All) and is in the Teams application access
policy "Nexus-Meeting-Reader" (granted -Global), so the server can fetch the
files and hand them to the right person.

Who gets what: the caller must be the meeting's organizer or one of its
invited attendees (Graph's own participant list) - nobody can pull a meeting
they were not in. Externals are refused outright. Read-only: nothing is
stored, every file is passed straight through.

Same Graph patterns as routers/hr_interviews.py (organizer object id from the
join link, then the onlineMeeting by JoinWebUrl), with the app token from
graph_mail.access_token() - not another copy of the token fetch.
"""
from __future__ import annotations

import json
import re
from urllib.parse import parse_qs, unquote, urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse, StreamingResponse

import graph_mail
from auth import get_current_user

router = APIRouter(prefix="/meeting-files", tags=["meeting-files"])

_GRAPH = "https://graph.microsoft.com/v1.0"
_GUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_POLICY_HINT = ("Microsoft refused - the GreensNexus app needs the meeting read permissions with admin consent "
                "and must be in the Teams application access policy (it can take 30 minutes after a change).")


def _canon(email: str) -> str:
    """Same address rewrite as auth.email_from_claims: the tenant alias is the same person."""
    e = (email or "").strip().lower()
    if e.endswith("@greensg.onmicrosoft.com"):
        e = e.split("@")[0] + "@greensglobal.com"
    return e


def _headers() -> dict:
    try:
        return {"Authorization": f"Bearer {graph_mail.access_token()}"}
    except Exception as e:  # noqa: BLE001 - surfaced as a setup problem
        raise HTTPException(503, f"Nexus is not signed in to Microsoft ({type(e).__name__}) - check the API's Azure settings")


def _organizer_oid(join_url: str, organizer: str, h: dict) -> str:
    """The organizer's directory object id: from the join link's context when it
    carries one (classic meetup-join links do), else looked up by email."""
    try:
        ctx = parse_qs(urlparse(join_url).query).get("context", [""])[0]
        oid = (json.loads(unquote(ctx)) if ctx else {}).get("Oid", "")
        if _GUID.match(oid or ""):
            return oid
    except (ValueError, TypeError):
        pass
    if not organizer:
        raise HTTPException(400, "This join link does not name its organizer - pass organizer=<their email> too")
    r = httpx.get(f"{_GRAPH}/users/{organizer}", params={"$select": "id"}, headers=h, timeout=20)
    if r.status_code == 404:
        raise HTTPException(404, "That organizer is not in the Greens directory")
    if not r.is_success:
        raise HTTPException(502, f"Could not look up the organizer ({r.status_code})")
    return r.json().get("id", "")


def _meeting(join_url: str, organizer: str, user: dict) -> tuple[dict, str, dict]:
    """(meeting, organizer oid, graph headers) - only for a meeting the caller was in."""
    if user.get("external"):
        raise HTTPException(403, "Meeting files are for Greens staff only")
    join_url = (join_url or "").strip()
    if not join_url.startswith("https://teams.microsoft.com/"):
        raise HTTPException(400, "Pass the meeting's Teams join link (https://teams.microsoft.com/...)")
    h = _headers()
    oid = _organizer_oid(join_url, organizer, h)
    r = httpx.get(f"{_GRAPH}/users/{oid}/onlineMeetings",
                  params={"$filter": f"JoinWebUrl eq '{join_url.replace(chr(39), chr(39) * 2)}'"}, headers=h, timeout=30)
    if r.status_code in (401, 403):
        raise HTTPException(502, _POLICY_HINT)
    if not r.is_success:
        raise HTTPException(502, f"Meeting lookup failed ({r.status_code})")
    found = r.json().get("value") or []
    if not found:
        raise HTTPException(404, "No Teams meeting with that join link")
    m = found[0]
    parts = m.get("participants") or {}
    people = {_canon((parts.get("organizer") or {}).get("upn", ""))}
    people |= {_canon(a.get("upn", "")) for a in parts.get("attendees") or []}
    if _canon(user.get("email", "")) not in people:
        # Same answer as a missing meeting: never confirm a meeting exists to someone who was not in it.
        raise HTTPException(404, "No Teams meeting with that join link that you were invited to")
    return m, oid, h


_TRANSCRIPTS_OFF = ("Microsoft has Graph access to Teams transcripts switched off for Greens (a tenant setting), "
                    "so only the recording can be fetched - transcribe it instead")


def _list(oid: str, mid: str, kind: str, h: dict) -> list[dict]:
    r = httpx.get(f"{_GRAPH}/users/{oid}/onlineMeetings/{mid}/{kind}", headers=h, timeout=30)
    if r.status_code in (401, 403):
        # Graph says this in plain words when the tenant has transcript access off
        # (Oct 24: recordings worked, transcripts did not) - not a permission problem.
        if kind == "transcripts" and "disabled for this tenant" in r.text:
            raise HTTPException(409, _TRANSCRIPTS_OFF)
        raise HTTPException(502, _POLICY_HINT)
    if r.status_code == 404:
        return []
    if not r.is_success:
        raise HTTPException(502, f"Could not list the {kind} ({r.status_code})")
    return sorted(r.json().get("value") or [], key=lambda x: x.get("createdDateTime") or "")


@router.get("")
def meeting_info(join_url: str = Query(...), organizer: str = Query(""), user: dict = Depends(get_current_user)):
    """What Teams has for this meeting: subject, times, and the transcripts and
    recordings published so far (newest last)."""
    m, oid, h = _meeting(join_url, organizer, user)
    pick = lambda xs: [{"id": x.get("id"), "created": x.get("createdDateTime"), "ended": x.get("endDateTime")} for x in xs]  # noqa: E731
    # A blocked transcript must never hide the recording.
    try:
        transcripts, transcripts_note = pick(_list(oid, m["id"], "transcripts", h)), ""
    except HTTPException as e:
        if e.status_code != 409:
            raise
        transcripts, transcripts_note = [], e.detail
    return {
        "subject": m.get("subject") or "",
        "start": m.get("startDateTime"), "end": m.get("endDateTime"),
        "organizer": _canon(((m.get("participants") or {}).get("organizer") or {}).get("upn", "")),
        "transcripts": transcripts,
        "transcriptsNote": transcripts_note,
        "recordings": pick(_list(oid, m["id"], "recordings", h)),
    }


@router.get("/transcript", response_class=PlainTextResponse)
def meeting_transcript(join_url: str = Query(...), organizer: str = Query(""), id: str = Query(""),
                       user: dict = Depends(get_current_user)):
    """The Teams transcript as WebVTT (speaker names and times). The newest one
    unless an id from GET /meeting-files is given."""
    m, oid, h = _meeting(join_url, organizer, user)
    items = _list(oid, m["id"], "transcripts", h)
    if not items:
        raise HTTPException(404, "Teams has no transcript for this meeting - transcription was not turned on, "
                                 "or it is still being published (a few minutes after the call)")
    tid = id or items[-1]["id"]
    if tid not in {x["id"] for x in items}:
        raise HTTPException(404, "No transcript with that id on this meeting")
    r = httpx.get(f"{_GRAPH}/users/{oid}/onlineMeetings/{m['id']}/transcripts/{tid}/content",
                  params={"$format": "text/vtt"}, headers=h, timeout=60)
    if not r.is_success:
        raise HTTPException(502, f"Could not download the transcript ({r.status_code})")
    return PlainTextResponse(r.text, media_type="text/vtt; charset=utf-8",
                             headers={"Content-Disposition": 'attachment; filename="transcript.vtt"', "Cache-Control": "no-store"})


@router.get("/recording")
def meeting_recording(join_url: str = Query(...), organizer: str = Query(""), id: str = Query(""),
                      user: dict = Depends(get_current_user)):
    """The Teams recording (mp4), streamed straight through - hundreds of MB,
    never held in memory or stored. The newest one unless an id is given."""
    m, oid, h = _meeting(join_url, organizer, user)
    items = _list(oid, m["id"], "recordings", h)
    if not items:
        raise HTTPException(404, "Teams has no recording for this meeting yet")
    rid = id or items[-1]["id"]
    if rid not in {x["id"] for x in items}:
        raise HTTPException(404, "No recording with that id on this meeting")
    client = httpx.Client(timeout=httpx.Timeout(30, read=300), follow_redirects=True)
    resp = client.send(client.build_request("GET", f"{_GRAPH}/users/{oid}/onlineMeetings/{m['id']}/recordings/{rid}/content",
                                            headers=h), stream=True)
    if not resp.is_success:
        resp.close(); client.close()
        raise HTTPException(502, _POLICY_HINT if resp.status_code in (401, 403) else f"Could not download the recording ({resp.status_code})")

    def body():
        try:
            yield from resp.iter_bytes(1024 * 1024)
        finally:
            resp.close(); client.close()

    headers = {"Content-Disposition": 'attachment; filename="recording.mp4"', "Cache-Control": "no-store"}
    if resp.headers.get("content-length"):
        headers["Content-Length"] = resp.headers["content-length"]
    return StreamingResponse(body(), media_type="video/mp4", headers=headers)
