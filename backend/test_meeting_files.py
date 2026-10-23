"""Meeting files (routers/meeting_files.py, Oct 2026).

Only the organizer or an invited attendee gets a meeting's transcript or
recording; anyone else is told the meeting does not exist; externals are
refused; Microsoft's own refusals come back as a clear setup message.
Graph is mocked - nothing leaves the machine.

    python -m unittest test_meeting_files -v
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
from routers import meeting_files  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

OID = "11111111-2222-3333-4444-555555555555"
JOIN = ("https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context="
        + quote(json.dumps({"Tid": "t", "Oid": OID})))
MID = "MSo1"
MEETING = {"id": MID, "subject": "Accounting Meeting", "startDateTime": "2026-10-23T20:00:00Z", "endDateTime": "2026-10-23T21:00:00Z",
           "participants": {"organizer": {"upn": "charmi@greensglobal.com"},
                            "attendees": [{"upn": "visesh.lodha@greensg.onmicrosoft.com"}, {"upn": "neil@greensglobal.com"}]}}


class _R:
    def __init__(self, status=200, body=None, text=""):
        self.status_code = status
        self._body = body
        self.text = text or (json.dumps(body) if body is not None else "")
        self.is_success = 200 <= status < 300

    def json(self):
        return self._body


def fake_graph(policy_ok=True, transcripts=True, transcripts_off=False):
    def get(url, params=None, headers=None, timeout=None):
        assert headers and headers["Authorization"] == "Bearer app-token"
        if not policy_ok:
            return _R(403, {"error": {"code": "Forbidden"}})
        if url.endswith(f"/users/{OID}/onlineMeetings"):
            return _R(200, {"value": [MEETING]})
        if url.endswith("/transcripts") and transcripts_off:
            return _R(403, text='{"error":{"code":"Forbidden","message":"Graph API access to transcripts is disabled for this tenant."}}')
        if url.endswith("/transcripts"):
            return _R(200, {"value": [{"id": "T1", "createdDateTime": "2026-10-23T21:01:00Z"}] if transcripts else []})
        if url.endswith("/recordings"):
            return _R(200, {"value": [{"id": "R1", "createdDateTime": "2026-10-23T21:02:00Z"}]})
        if url.endswith("/transcripts/T1/content"):
            assert params == {"$format": "text/vtt"}
            return _R(200, text="WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Charmi Desai>January rent should be 16,200.</v>\n")
        if "/users/charmi@greensglobal.com" in url:
            return _R(200, {"id": OID})
        raise AssertionError("unexpected Graph call " + url)
    return get


class MeetingFilesTests(unittest.TestCase):
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

    def tearDown(self):
        self.tok.stop()
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    def as_(self, who):
        os.environ["NEXUS_DEV_EMAIL"] = who

    def test_invited_attendee_sees_what_teams_has(self):
        self.as_("visesh.lodha@greensglobal.com")  # invited under the tenant alias - same person
        with mock.patch.object(meeting_files.httpx, "get", side_effect=fake_graph()):
            r = self.client.get("/meeting-files", params={"join_url": JOIN})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["subject"], "Accounting Meeting")
        self.assertEqual([t["id"] for t in r.json()["transcripts"]], ["T1"])
        self.assertEqual([t["id"] for t in r.json()["recordings"]], ["R1"])

    def test_organizer_gets_the_transcript_as_vtt(self):
        self.as_("charmi@greensglobal.com")
        with mock.patch.object(meeting_files.httpx, "get", side_effect=fake_graph()):
            r = self.client.get("/meeting-files/transcript", params={"join_url": JOIN})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.text.startswith("WEBVTT"))
        self.assertIn("Charmi Desai", r.text)

    def test_someone_not_invited_is_told_there_is_no_such_meeting(self):
        self.as_("sam.staff@greensglobal.com")
        with mock.patch.object(meeting_files.httpx, "get", side_effect=fake_graph()):
            for path in ("/meeting-files", "/meeting-files/transcript", "/meeting-files/recording"):
                r = self.client.get(path, params={"join_url": JOIN})
                self.assertEqual(r.status_code, 404, path)
                self.assertNotIn("Accounting", r.text)

    def test_an_external_is_refused(self):
        main.app.dependency_overrides[meeting_files.get_current_user] = lambda: {"email": "guest@partner.example", "external": True}
        try:
            r = self.client.get("/meeting-files", params={"join_url": JOIN})
        finally:
            main.app.dependency_overrides.pop(meeting_files.get_current_user, None)
        self.assertEqual(r.status_code, 403)

    def test_only_teams_links(self):
        self.as_("visesh.lodha@greensglobal.com")
        r = self.client.get("/meeting-files", params={"join_url": "https://evil.example.com/x"})
        self.assertEqual(r.status_code, 400)

    def test_microsoft_refusal_says_what_to_fix(self):
        self.as_("visesh.lodha@greensglobal.com")
        with mock.patch.object(meeting_files.httpx, "get", side_effect=fake_graph(policy_ok=False)):
            r = self.client.get("/meeting-files", params={"join_url": "https://teams.microsoft.com/meet/123", "organizer": "charmi@greensglobal.com"})
        self.assertEqual(r.status_code, 502)

    def test_short_link_uses_the_organizer_email(self):
        self.as_("neil@greensglobal.com")
        short = "https://teams.microsoft.com/meet/2468?p=abc"
        with mock.patch.object(meeting_files.httpx, "get", side_effect=fake_graph()):
            r = self.client.get("/meeting-files", params={"join_url": short, "organizer": "charmi@greensglobal.com"})
            self.assertEqual(r.status_code, 200, r.text)
            r2 = self.client.get("/meeting-files", params={"join_url": short})
            self.assertEqual(r2.status_code, 400)

    def test_transcripts_off_for_the_tenant_still_gives_the_recording(self):
        self.as_("visesh.lodha@greensglobal.com")
        with mock.patch.object(meeting_files.httpx, "get", side_effect=fake_graph(transcripts_off=True)):
            r = self.client.get("/meeting-files", params={"join_url": JOIN})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["transcripts"], [])
            self.assertIn("switched off", r.json()["transcriptsNote"])
            self.assertEqual([x["id"] for x in r.json()["recordings"]], ["R1"])
            t = self.client.get("/meeting-files/transcript", params={"join_url": JOIN})
            self.assertEqual(t.status_code, 409)

    def test_no_transcript_yet_is_a_plain_404(self):
        self.as_("neil@greensglobal.com")
        with mock.patch.object(meeting_files.httpx, "get", side_effect=fake_graph(transcripts=False)):
            r = self.client.get("/meeting-files/transcript", params={"join_url": JOIN})
        self.assertEqual(r.status_code, 404)
        self.assertIn("no transcript", r.text.lower())


if __name__ == "__main__":
    unittest.main()
