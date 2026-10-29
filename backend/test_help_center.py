"""Help Center (Oct 2026): Ask Nexus (docs only, KB walls, rate limit), the
failed-search record, Was This Helpful?, Help Signals and Known Issues.
ONE FILE PER PROCESS."""
import os
import tempfile
import unittest
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_RATE_LIMIT", "off")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import kb_ai  # noqa: E402
import kb_blocks  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import help_center  # noqa: E402

ADM = "hc.admin@example.com"
EMP = "hc.employee@example.com"


def _page(pid, title, status="approved", text="Open the gate with the keypad code, then check the lock."):
    return models.KbDocument(
        id=pid, title=title, status=status, page_type="sop", collection_id="", version="1.0",
        blocks=kb_blocks.dumps(kb_blocks.doc([kb_blocks.paragraph(text)])), content_text=text, doc_code="")


class HelpCenterCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)
        db = database.SessionLocal()
        try:
            for e, role, first in ((ADM, "administrator", "Ada"), (EMP, "employee", "Eve")):
                db.add(models.NexusRole(email=e, role=role, display_name=f"{first} Test"))
                db.add(models.NexusEmployee(id=f"e-{e}", first_name=first, last_name="Test", work_email=e, status="active",
                                            deleted_at="", department="Operations", job_title="Site Manager"))
            db.add(_page("kb-live", "Gate Keypad Codes"))
            db.add(_page("kb-draft", "Gate Keypad Secret Draft", status="draft", text="DRAFT-SECRET gate keypad notes"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._prev = os.environ.get("NEXUS_DEV_EMAIL")
        help_center.reset_rate_limit()

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache()

    # ── Ask Nexus ──────────────────────────────────────────────────────────
    def test_ask_sends_capped_guide_and_only_published_kb_pages(self):
        self._as(EMP)
        seen = {}

        def fake(q, sources):
            seen["q"], seen["sources"] = q, sources
            return {"answer": "Use the keypad code [1].", "sources": [0, len(sources) - 1], "grounded": True}

        guide = [{"id": f"g{i}", "title": f"Guide {i}", "text": "x" * 9000, "secret": "drop me"} for i in range(9)]
        with mock.patch.object(kb_ai, "available", return_value=True), mock.patch.object(kb_ai, "answer_help", side_effect=fake):
            r = self.client.post("/help-center/ask", json={"question": "How do I open the gate keypad?", "guide": guide})
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertTrue(out["grounded"])
        kinds = [s["kind"] for s in seen["sources"]]
        self.assertEqual(kinds.count("guide"), help_center.GUIDE_SECTIONS_MAX)
        self.assertTrue(all(len(s["text"]) <= help_center.GUIDE_TEXT_MAX for s in seen["sources"]))
        self.assertTrue(all("secret" not in s for s in seen["sources"]))
        kb_ids = [s["id"] for s in seen["sources"] if s["kind"] == "kb"]
        self.assertIn("kb-live", kb_ids)
        self.assertNotIn("kb-draft", kb_ids)
        self.assertNotIn("DRAFT-SECRET", " ".join(s["text"] for s in seen["sources"]))
        # The answer's sources carry no page text back to the browser.
        self.assertTrue(all("text" not in s for s in out["sources"]))
        self.assertEqual(out["sources"][0]["id"], "g0")

    def test_ask_offline_returns_sources_without_a_model_call(self):
        self._as(EMP)
        with mock.patch.object(kb_ai, "available", return_value=False), mock.patch.object(kb_ai, "answer_help") as called:
            r = self.client.post("/help-center/ask", json={"question": "gate keypad", "guide": []})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["offline"])
        called.assert_not_called()

    def test_ask_is_rate_limited_per_person(self):
        self._as(EMP)
        ok = {"answer": "Yes [1].", "sources": [0], "grounded": True}
        with mock.patch.object(kb_ai, "available", return_value=True), mock.patch.object(kb_ai, "answer_help", return_value=ok):
            for _ in range(help_center.ASKS_PER_HOUR):
                self.assertEqual(self.client.post("/help-center/ask", json={"question": "gate keypad"}).status_code, 200)
            r = self.client.post("/help-center/ask", json={"question": "gate keypad"})
            self.assertEqual(r.status_code, 429)
            self._as(ADM)   # someone else still has theirs
            self.assertEqual(self.client.post("/help-center/ask", json={"question": "gate keypad"}).status_code, 200)

    def test_an_answer_the_sources_did_not_cover_is_recorded(self):
        self._as(EMP)
        miss = {"answer": "The guides do not cover that.", "sources": [], "grounded": False}
        with mock.patch.object(kb_ai, "available", return_value=True), mock.patch.object(kb_ai, "answer_help", return_value=miss):
            self.client.post("/help-center/ask", json={"question": "gate keypad battery brand"})
        db = database.SessionLocal()
        try:
            row = db.query(models.KbSearchLog).filter(models.KbSearchLog.query == "gate keypad battery brand").first()
            self.assertIsNotNone(row)
            self.assertEqual(row.source, "ask")
        finally:
            db.close()

    def test_empty_question_is_refused(self):
        self._as(EMP)
        self.assertEqual(self.client.post("/help-center/ask", json={"question": "   "}).status_code, 422)

    # ── Failed searches ────────────────────────────────────────────────────
    def test_search_log_records_misses_by_source(self):
        self._as(EMP)
        self.assertEqual(self.client.post("/help-center/search-log", json={"q": "salary advance", "results": 0, "source": "help"}).status_code, 204)
        self.client.post("/help-center/search-log", json={"q": "salary advance", "results": 0, "source": "help"})
        # A help search WITH results is not a miss.
        self.client.post("/help-center/search-log", json={"q": "time off", "results": 4, "source": "help"})
        # Searched in the ticket form and filed anyway - always recorded.
        self.client.post("/help-center/search-log", json={"q": "printer jam", "results": 3, "source": "ticket-form"})
        self.assertEqual(self.client.post("/help-center/search-log", json={"q": "x", "source": "nope"}).status_code, 422)
        import kb_search
        db = database.SessionLocal()
        try:
            rows = {(m["query"], m["source"]): m for m in kb_search.misses(db, sources=("help", "ticket-form"))}
        finally:
            db.close()
        self.assertEqual(rows[("salary advance", "help")]["count"], 2)
        self.assertNotIn(("time off", "help"), rows)
        self.assertIn(("printer jam", "ticket-form"), rows)

    # ── Was This Helpful? + Help Signals ───────────────────────────────────
    def test_feedback_is_one_vote_per_person_and_signals_are_admin_only(self):
        self._as(EMP)
        r = self.client.post("/help-center/feedback", json={"target_kind": "guide", "target_id": "workday#request-time-off",
                                                             "helpful": True, "title": "Request Time Off"})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.post("/help-center/feedback", json={"target_kind": "guide", "target_id": "workday#request-time-off",
                                                             "helpful": False, "note": "No mention of half days", "title": "Request Time Off"})
        self.assertEqual(r.status_code, 200)
        self.client.post("/help-center/feedback", json={"target_kind": "answer", "question": "How do I clock in?", "helpful": False})
        self.assertEqual(self.client.post("/help-center/feedback", json={"target_kind": "answer", "helpful": True}).status_code, 422)
        db = database.SessionLocal()
        try:
            n = db.query(models.HelpFeedback).filter(models.HelpFeedback.user_email == EMP,
                                                     models.HelpFeedback.target_id == "workday#request-time-off").count()
        finally:
            db.close()
        self.assertEqual(n, 1)
        self.assertNotEqual(self.client.get("/help-center/signals").status_code, 200)
        self._as(ADM)
        s = self.client.get("/help-center/signals").json()
        ids = {a["id"]: a for a in s["not_helpful"]}
        self.assertIn("workday#request-time-off", ids)
        self.assertEqual(ids["workday#request-time-off"]["notes"][0]["note"], "No mention of half days")
        self.assertTrue(any(a["kind"] == "answer" and a["question"] == "How do I clock in?" for a in s["not_helpful"]))
        self.assertIn("failed_searches", s)
        self.assertIn("ticketed_after_search", s)

    # ── Known Issues ───────────────────────────────────────────────────────
    def test_known_issues_admin_posts_everyone_reads_expired_hide(self):
        self._as(EMP)
        self.assertNotEqual(self.client.put("/help-center/known-issues", json={"issues": []}).status_code, 200)
        self._as(ADM)
        r = self.client.put("/help-center/known-issues", json={"issues": [
            {"title": "Time Clock Is Slow", "note": "We are on it.", "severity": "outage"},
            {"title": "Old Notice", "severity": "info", "until": "2020-01-01"},
        ]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["canEdit"])
        self.assertEqual(len(r.json()["issues"]), 2)   # an administrator sees the expired one to clear it
        self.assertEqual(self.client.put("/help-center/known-issues", json={"issues": [{"title": "", "severity": "info"}]}).status_code, 422)
        self.assertEqual(self.client.put("/help-center/known-issues", json={"issues": [{"title": "x", "severity": "huge"}]}).status_code, 422)
        self._as(EMP)
        got = self.client.get("/help-center/known-issues").json()
        self.assertFalse(got["canEdit"])
        self.assertEqual([i["title"] for i in got["issues"]], ["Time Clock Is Slow"])
        self.assertEqual(got["issues"][0]["posted_by"], ADM)


if __name__ == "__main__":
    unittest.main()
