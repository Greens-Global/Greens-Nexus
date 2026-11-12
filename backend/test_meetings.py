"""Meeting Notes (routers/meetings.py, Neil 11/12/2026).

The day's Teams meetings come from the caller's own calendar; a meeting's
note is made once and found again; the transcript is read from Teams (never
stored) and only the people on the invite get it; a note line's stamp
survives the sanitizer. Graph is mocked - nothing leaves the machine.

    python -m unittest test_meetings -v
"""
import json
import os
import tempfile
import unittest
from unittest import mock
from urllib.parse import quote

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import meeting_files, meetings, notes  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

OID = "11111111-2222-3333-4444-555555555555"
JOIN = ("https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context="
        + quote(json.dumps({"Tid": "t", "Oid": OID})))
UID = "040000008200E00074C5B7101A82E008-occurrence-1"
EVENT = {
    "id": "AAMk/evt1=", "iCalUId": UID, "subject": "Weekly Ops", "isCancelled": False,
    "start": {"dateTime": "2026-11-12T15:00:00.0000000", "timeZone": "UTC"},
    "end": {"dateTime": "2026-11-12T15:30:00.0000000", "timeZone": "UTC"},
    "isOnlineMeeting": True, "onlineMeeting": {"joinUrl": JOIN},
    "organizer": {"emailAddress": {"name": "Neil", "address": "neil@greensglobal.com"}},
    "attendees": [
        {"type": "required", "emailAddress": {"name": "Visesh", "address": "visesh.lodha@greensg.onmicrosoft.com"}},
        {"type": "resource", "emailAddress": {"name": "Board Room", "address": "boardroom@greensglobal.com"}},
    ],
    "body": {"contentType": "text", "content": "1. Rent roll\n2. Gate codes\n\n"
             "________________________________________________________________________________\n"
             "Microsoft Teams meeting\nJoin on your computer\n"},
}
NOT_TEAMS = {**EVENT, "id": "evt2", "iCalUId": "uid-2", "subject": "Lunch", "isOnlineMeeting": False, "onlineMeeting": None}
VTT = ("WEBVTT\n\n"
       "abc/1-0\n00:00:01.000 --> 00:00:03.000\n<v Neil>Okay, rent roll first.</v>\n\n"
       "abc/2-0\n00:00:03.500 --> 00:00:05.000\n<v Neil>It closed at 16,200.</v>\n\n"
       "abc/3-0\n00:01:00.000 --> 00:01:04.000\n<v Visesh>I will fix the gate codes by Friday.</v>\n")
CALLS = []


class _R:
    def __init__(self, status=200, body=None, text=""):
        self.status_code = status
        self._body = body
        self.text = text or (json.dumps(body) if body is not None else "")
        self.is_success = 200 <= status < 300

    def json(self):
        return self._body


def fake_graph(calendar_ok=True, transcripts=True):
    def get(url, params=None, headers=None, timeout=None):
        assert headers and headers["Authorization"] == "Bearer app-token"
        CALLS.append(url)
        if url.endswith("/calendarView"):
            if not calendar_ok:
                return _R(403, {"error": {"code": "ErrorAccessDenied"}})
            return _R(200, {"value": [EVENT, NOT_TEAMS]})
        if "/events/" in url:
            assert url.endswith("/events/" + quote(EVENT["id"], safe="")), url
            return _R(200, EVENT)
        if url.endswith(f"/users/{OID}/onlineMeetings"):
            return _R(200, {"value": [{"id": "MSo1", "chatInfo": {"threadId": "19:meeting_abc@thread.v2"}}]})
        if url.endswith("/transcripts"):
            return _R(200, {"value": [{"id": "T1", "createdDateTime": "2026-11-12T15:01:00Z"}] if transcripts else []})
        if url.endswith("/recordings"):
            return _R(200, {"value": [{"id": "R1"}]})
        if url.endswith("/transcripts/T1/content"):
            return _R(200, text=VTT)
        raise AssertionError("unexpected Graph call " + url)
    return get


class MeetingNotesTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self.tok = mock.patch.object(meeting_files.graph_mail, "access_token", return_value="app-token")
        self.tok.start()
        meetings._cache.clear()
        CALLS.clear()
        db = database.SessionLocal()
        db.query(models.NexusMeetingNote).delete()
        db.query(models.NexusNote).delete()
        db.commit()
        db.close()

    def tearDown(self):
        self.tok.stop()
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    def as_(self, who):
        os.environ["NEXUS_DEV_EMAIL"] = who

    def day(self, **kw):
        with mock.patch.object(meetings.httpx, "get", side_effect=fake_graph(**kw)):
            return self.client.get("/meetings/day", params={"start": "2026-11-12T05:00:00Z", "end": "2026-11-13T05:00:00Z"})

    def open_note(self):
        with mock.patch.object(meetings.httpx, "get", side_effect=fake_graph()):
            return self.client.post("/meetings/notes", json={"eventId": EVENT["id"], "day": "2026-11-12"})

    def test_the_day_lists_only_teams_meetings_with_people_but_no_rooms(self):
        self.as_("neil@greensglobal.com")
        r = self.day()
        self.assertEqual(r.status_code, 200, r.text)
        got = r.json()
        self.assertTrue(got["enabled"])
        self.assertEqual([m["subject"] for m in got["meetings"]], ["Weekly Ops"])
        m = got["meetings"][0]
        self.assertEqual(m["start"], "2026-11-12T15:00:00Z")
        self.assertTrue(m["isOrganizer"])
        self.assertEqual([a["email"] for a in m["attendees"]], ["visesh.lodha@greensglobal.com"])
        self.assertEqual(m["noteId"], "")
        self.assertTrue(CALLS[0].endswith("/users/neil@greensglobal.com/calendarView"))

    def test_no_calendar_permission_is_said_quietly(self):
        self.as_("neil@greensglobal.com")
        r = self.day(calendar_ok=False)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["enabled"])
        self.assertIn("Calendars.ReadWrite", r.json()["reason"])

    def test_a_meeting_note_is_made_once_with_the_agenda_and_found_again(self):
        self.as_("neil@greensglobal.com")
        r = self.open_note()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["created"])
        nid = r.json()["noteId"]
        note = self.client.get(f"/notes/{nid}").json()
        self.assertEqual(note["title"], "Weekly Ops")
        self.assertEqual(note["day"], "2026-11-12")
        self.assertEqual(note["source"]["kind"], "meeting")
        self.assertIn('data-summary="Agenda"', note["body"])
        self.assertIn("Gate codes", note["body"])
        self.assertNotIn("Join on your computer", note["body"])
        again = self.open_note()
        self.assertEqual(again.json(), {"noteId": nid, "created": False})
        self.assertEqual(self.day().json()["meetings"][0]["noteId"], nid)

    def test_meeting_details_and_transcript_only_for_the_invited(self):
        self.as_("neil@greensglobal.com")
        nid = self.open_note().json()["noteId"]
        info = self.client.get(f"/meetings/notes/{nid}").json()
        self.assertTrue(info["invited"])
        self.assertEqual(info["joinUrl"], JOIN)
        # Shared with someone who was not on the invite: the notes, never the call.
        with mock.patch.object(notes, "_directory_person", return_value={"email": "sam.staff@greensglobal.com"}):
            self.assertEqual(self.client.put(f"/notes/{nid}/share", json={"email": "sam.staff@greensglobal.com"}).status_code, 200)
        self.as_("sam.staff@greensglobal.com")
        info = self.client.get(f"/meetings/notes/{nid}").json()
        self.assertFalse(info["invited"])
        self.assertEqual(info["joinUrl"], "")
        with mock.patch.object(meetings.httpx, "get", side_effect=fake_graph()):
            self.assertEqual(self.client.get(f"/meetings/notes/{nid}/transcript").status_code, 403)
        # Someone with neither the note nor the invite: no such note.
        self.as_("other.person@greensglobal.com")
        self.assertEqual(self.client.get(f"/meetings/notes/{nid}").status_code, 404)

    def test_the_transcript_is_read_from_teams_with_wall_clock_times(self):
        self.as_("neil@greensglobal.com")
        nid = self.open_note().json()["noteId"]
        with mock.patch.object(meetings.httpx, "get", side_effect=fake_graph()):
            r = self.client.get(f"/meetings/notes/{nid}/transcript")
        self.assertEqual(r.status_code, 200, r.text)
        t = r.json()
        base = 1794495660   # 11/12/2026 3:01:00 PM UTC - the transcript's createdDateTime
        self.assertEqual([c["speaker"] for c in t["cues"]], ["Neil", "Visesh"])   # Neil's two cues read as one
        self.assertEqual(t["cues"][0]["at"], base + 1)
        self.assertEqual(t["cues"][0]["text"], "Okay, rent roll first. It closed at 16,200.")
        self.assertEqual(t["cues"][1]["at"], base + 60)
        self.assertEqual(t["recordings"], 1)
        self.assertEqual(t["chatThreadId"], "19:meeting_abc@thread.v2")
        # Nothing of it is kept: no transcript text anywhere in the database.
        db = database.SessionLocal()
        try:
            row = db.query(models.NexusMeetingNote).first()
            self.assertNotIn("16,200", json.dumps({c.name: getattr(row, c.name) for c in row.__table__.columns}))
            self.assertNotIn("16,200", db.query(models.NexusNote).first().body)
        finally:
            db.close()

    def test_no_transcript_yet_is_a_plain_404(self):
        self.as_("neil@greensglobal.com")
        nid = self.open_note().json()["noteId"]
        with mock.patch.object(meetings.httpx, "get", side_effect=fake_graph(transcripts=False)):
            r = self.client.get(f"/meetings/notes/{nid}/transcript")
        self.assertEqual(r.status_code, 404)
        self.assertIn("transcription", r.json()["detail"])

    def test_act_as_is_refused(self):
        with self.assertRaises(Exception) as e:
            meetings._guard({"email": "neil@greensglobal.com", "acting_as": "visesh.lodha@greensglobal.com"})
        self.assertEqual(e.exception.status_code, 403)
        with self.assertRaises(Exception) as e:
            meetings._guard({"email": "guest@vendor.com", "external": True})
        self.assertEqual(e.exception.status_code, 403)

    def test_a_line_stamp_survives_the_sanitizer_and_junk_does_not(self):
        out = notes.sanitize_note('<p data-at="1794495720">Gate codes</p><h2 data-at="12ab">X</h2><p data-at="17934589201">Y</p>')
        self.assertIn('<p data-at="1794495720">', out)
        self.assertNotIn('data-at="12ab"', out)
        self.assertNotIn("17934589201", out)

    def test_vtt_without_voices_or_hours(self):
        cues = meetings.parse_vtt("WEBVTT\n\n01:02.500 --> 01:04.000\nPlain words\n")
        self.assertEqual(cues, [{"start": 62.5, "end": 64.0, "speaker": "", "text": "Plain words"}])


if __name__ == "__main__":
    unittest.main()
