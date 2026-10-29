"""Knowledge Base access matrix (WP 2.5, Oct 29 2026): EVERY /kb route,
called as another company's author, as a plain reader, and on a draft.

- `ROUTES` classifies every /kb route the app serves; a new route fails
  test_every_route_is_classified until someone decides how it is walled.
- "wall" routes act on company A's own rows (a page, a draft, a revision, a
  course, a plan, a rule, a flag, a request, a certificate, an attempt...):
  company B's author must get 403 or 404, never a 2xx and never a 422 (a
  422 means the body was wrong and the wall was never reached). Every "wall"
  GET is also called by A's author, who must get a 2xx, so a wrong id can
  never pass as a refusal.
- "list" routes may answer B, but nothing of company A may be in the answer.
- READER routes: A's employee with no Knowledge Base grant gets 403 or 404.

ONE FILE PER PROCESS."""
import json
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_RATE_LIMIT", "off")

from fastapi.routing import APIRoute  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import kb_blocks  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

COA, COB = "ent-kbm-a", "ent-kbm-b"
AAUTH = "kbm.a.author@example.com"     # company A, manager role: author + manage
ALRN = "kbm.a.reader@example.com"      # company A, employee, no Knowledge Base grant
BAUTH = "kbm.b.author@example.com"     # company B, manager role: author + manage, walled off from A
SECRET = "Alpha Secret"                # every company A title carries it; B must never see it

# Every /kb route -> how it is walled. "wall": acts on one of A's rows
# (tested below as B). "list": answers anyone, filtered (leak-checked).
# "create": makes the caller's own row. "own": only the caller's own data.
# "org": no company data, or an organization tool.
ROUTES = {
    ("GET", "/kb/activity"): "list",
    ("POST", "/kb/ask"): "org",                       # read-only AI over pages the caller can see
    ("DELETE", "/kb/assignments/{aid}"): "wall",
    ("GET", "/kb/audience/options"): "org",           # department / title / location names
    ("POST", "/kb/audience/preview"): "list",
    ("GET", "/kb/certificates/lookup"): "org",        # verify a serial: by design for anyone holding it
    ("GET", "/kb/certificates/{cert_id}"): "wall",
    ("GET", "/kb/certificates/{cert_id}/pdf"): "wall",
    ("POST", "/kb/checkpoint/{aid}/submit"): "wall",
    ("GET", "/kb/collections"): "org",                # shared folders (see test_collections_are_shared_folders)
    ("POST", "/kb/collections"): "create",
    ("GET", "/kb/collections/{cid}"): "list",         # the folder is shared; the pages in it are walled
    ("PATCH", "/kb/collections/{cid}"): "wall",
    ("GET", "/kb/compliance"): "list",
    ("POST", "/kb/compliance/nudge"): "wall",
    ("GET", "/kb/courses"): "list",
    ("POST", "/kb/courses"): "create",
    ("GET", "/kb/courses/{cid}"): "wall",
    ("PATCH", "/kb/courses/{cid}"): "wall",
    ("POST", "/kb/courses/{cid}/archive"): "wall",
    ("POST", "/kb/courses/{cid}/assign"): "wall",
    ("GET", "/kb/courses/{cid}/assignments"): "wall",
    ("GET", "/kb/courses/{cid}/builder"): "wall",
    ("POST", "/kb/courses/{cid}/discard-draft"): "wall",
    ("POST", "/kb/courses/{cid}/generate"): "wall",
    ("POST", "/kb/courses/{cid}/lessons/{lid}/checkpoint/start"): "wall",
    ("POST", "/kb/courses/{cid}/lessons/{lid}/done"): "wall",
    ("POST", "/kb/courses/{cid}/publish"): "wall",
    ("POST", "/kb/courses/{cid}/quiz/start"): "wall",
    ("GET", "/kb/courses/{cid}/report"): "wall",
    ("POST", "/kb/courses/{cid}/unlock"): "wall",
    ("GET", "/kb/courses/{cid}/versions"): "wall",
    ("POST", "/kb/flags/{fid}/resolve"): "wall",
    ("GET", "/kb/health"): "list",
    ("GET", "/kb/home"): "list",
    ("POST", "/kb/import"): "create",
    ("GET", "/kb/jobs/{job_id}"): "wall",
    ("GET", "/kb/me"): "own",
    ("POST", "/kb/media"): "create",
    ("GET", "/kb/migrate"): "org",                    # the one-time conversion report (Manage)
    ("POST", "/kb/migrate"): "org",
    ("GET", "/kb/pages"): "list",
    ("POST", "/kb/pages"): "create",
    ("GET", "/kb/pages/{doc_id}"): "wall",
    ("PATCH", "/kb/pages/{doc_id}"): "wall",
    ("POST", "/kb/pages/{doc_id}/archive"): "wall",
    ("GET", "/kb/pages/{doc_id}/comments"): "wall",
    ("POST", "/kb/pages/{doc_id}/comments"): "wall",
    ("POST", "/kb/pages/{doc_id}/feedback"): "wall",
    ("POST", "/kb/pages/{doc_id}/flag"): "wall",
    ("POST", "/kb/pages/{doc_id}/nudge"): "wall",
    ("GET", "/kb/pages/{doc_id}/original"): "wall",
    ("POST", "/kb/pages/{doc_id}/pin"): "wall",
    ("POST", "/kb/pages/{doc_id}/publish"): "wall",
    ("POST", "/kb/pages/{doc_id}/restore"): "wall",
    ("POST", "/kb/pages/{doc_id}/review"): "wall",
    ("POST", "/kb/pages/{doc_id}/revisions"): "wall",
    ("POST", "/kb/pages/{doc_id}/sign"): "wall",
    ("GET", "/kb/pages/{doc_id}/signatures"): "wall",
    ("POST", "/kb/pages/{doc_id}/start-task"): "wall",
    ("POST", "/kb/pages/{doc_id}/submit"): "wall",
    ("POST", "/kb/pages/{doc_id}/suggest"): "wall",
    ("GET", "/kb/pages/{doc_id}/tasks"): "wall",
    ("POST", "/kb/pages/{doc_id}/translate"): "wall",
    ("GET", "/kb/pages/{doc_id}/translations/{lang}"): "wall",
    ("POST", "/kb/pages/{doc_id}/verify"): "wall",
    ("GET", "/kb/pages/{doc_id}/versions/{vid}"): "wall",
    ("POST", "/kb/pages/{doc_id}/withdraw"): "wall",
    ("GET", "/kb/people"): "list",
    ("GET", "/kb/plans"): "list",
    ("POST", "/kb/plans"): "create",
    ("PATCH", "/kb/plans/{pid}"): "wall",
    ("POST", "/kb/plans/{pid}/assign"): "wall",
    ("GET", "/kb/print/{doc_id}"): "wall",
    ("POST", "/kb/quiz/{aid}/submit"): "wall",
    ("POST", "/kb/requests"): "create",
    ("POST", "/kb/requests/{rid}/close"): "wall",
    ("GET", "/kb/revisions/{rid}"): "wall",
    ("PATCH", "/kb/revisions/{rid}"): "wall",
    ("POST", "/kb/revisions/{rid}/discard"): "wall",
    ("POST", "/kb/revisions/{rid}/review"): "wall",
    ("POST", "/kb/revisions/{rid}/submit"): "wall",
    ("GET", "/kb/rules"): "list",
    ("POST", "/kb/rules"): "create",
    ("PATCH", "/kb/rules/{rid}"): "wall",
    ("DELETE", "/kb/rules/{rid}"): "wall",
    ("GET", "/kb/search"): "list",
    ("GET", "/kb/tags"): "org",
    ("POST", "/kb/tags"): "create",
    ("GET", "/kb/training/me"): "own",
}

# Bodies that pass validation, so the call reaches the wall.
BODIES = {
    "/kb/checkpoint/{aid}/submit": {"answers": {}},
    "/kb/quiz/{aid}/submit": {"answers": {}},
    "/kb/compliance/nudge": {"emails": [ALRN]},
    "/kb/courses/{cid}/assign": {"emails": [ALRN]},
    "/kb/courses/{cid}/generate": {"doc_ids": []},
    "/kb/courses/{cid}/unlock": {"email": ALRN},
    "/kb/pages/{doc_id}/comments": {"text": "hello"},
    "/kb/pages/{doc_id}/feedback": {"helpful": True},
    "/kb/pages/{doc_id}/flag": {"text": "out of date"},
    "/kb/pages/{doc_id}/review": {"decision": "approve"},
    "/kb/pages/{doc_id}/sign": {"typed_name": "P Two"},
    "/kb/pages/{doc_id}/suggest": {"instruction": "shorter"},
    "/kb/pages/{doc_id}/translate": {"lang": "es"},
    "/kb/plans/{pid}/assign": {"emails": [ALRN]},
    "/kb/revisions/{rid}/review": {"decision": "approve"},
    "/kb/collections/{cid}": {"name": "Taken Over"},
    "/kb/pages/{doc_id}": {"summary": "taken over"},
    "/kb/courses/{cid}": {"title": "Taken Over"},
    "/kb/plans/{pid}": {"name": "Taken Over"},
    "/kb/rules/{rid}": {"due_days": 1},
    "/kb/revisions/{rid}": {"summary": "taken over"},
}

# GETs whose owner answer is not a plain 2xx in this fixture (nothing to show yet).
NO_OWNER_CHECK = {"/kb/pages/{doc_id}/translations/{lang}", "/kb/pages/{doc_id}/versions/{vid}"}

# What A's plain reader may never open: drafts, and every author-only route on A's rows.
READER = [
    ("GET", "/kb/pages/{draft}"), ("PATCH", "/kb/pages/{doc_id}"), ("POST", "/kb/pages/{doc_id}/publish"),
    ("POST", "/kb/pages/{doc_id}/revisions"), ("GET", "/kb/revisions/{rid}"), ("GET", "/kb/print/{draft}"),
    ("GET", "/kb/courses/{cid}/builder"), ("PATCH", "/kb/courses/{cid}"), ("GET", "/kb/courses/{cid}/report"),
    ("POST", "/kb/courses/{cid}/assign"), ("GET", "/kb/plans"), ("PATCH", "/kb/plans/{pid}"), ("GET", "/kb/rules"),
    ("DELETE", "/kb/rules/{rid}"), ("POST", "/kb/flags/{fid}/resolve"), ("POST", "/kb/requests/{rid}/close"),
    ("POST", "/kb/requests/{rid}/assign"), ("PATCH", "/kb/collections/{cid}"), ("GET", "/kb/audience/options"), ("POST", "/kb/migrate"),
]


class KbAccessMatrixCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)
        db = database.SessionLocal()
        try:
            db.add(models.HrEntity(id=COA, name="Alpha Co"))
            db.add(models.HrEntity(id=COB, name="Beta Co"))
            for i, (email, co, role) in enumerate([(AAUTH, COA, "manager"), (ALRN, COA, "employee"), (BAUTH, COB, "manager")]):
                db.add(models.NexusEmployee(id=f"e-kbm-{i}", first_name="P", last_name=str(i), work_email=email, status="active",
                                            deleted_at="", company=co, department="Operations",
                                            manager_email=AAUTH if email == ALRN else ""))
                db.add(models.NexusRole(email=email, role=role, display_name=f"P {i}"))
            db.add(models.KbCollection(id="col-kbm-a", name="Ops Folder", owner_email=AAUTH, reading_order="[]", active=True))
            db.add(models.NexusSetting(key="company_walls", value="on"))
            db.commit()
        finally:
            db.close()
        cache.settings_config.invalidate()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()
        cls._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        cls.ids = cls._make_company_a()

    @classmethod
    def tearDownClass(cls):
        auth.SKIP_AUTH = cls._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)
        database.engine.dispose()
        os.remove(_tmp_db.name)

    @classmethod
    def _as(cls, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache()

    @classmethod
    def _ok(cls, r):
        assert r.status_code < 300, f"{r.request.method} {r.request.url}: {r.status_code} {r.text[:300]}"
        return r.json() if r.content else {}

    @classmethod
    def _make_company_a(cls) -> dict:
        """Company A's rows, made the way people make them where a route exists."""
        c = cls.client
        blocks = kb_blocks.doc([kb_blocks.heading("Steps"), kb_blocks.steps([kb_blocks.step("Open the gate")])])
        cls._as(AAUTH)
        pub = cls._ok(c.post("/kb/pages", json={"title": f"{SECRET} Gate Code", "page_type": "how_to", "collection_id": "col-kbm-a", "blocks": blocks}))
        cls._ok(c.post(f"/kb/pages/{pub['id']}/publish", json={}))
        draft = cls._ok(c.post("/kb/pages", json={"title": f"{SECRET} Draft", "page_type": "how_to", "collection_id": "col-kbm-a", "blocks": blocks}))
        rev = cls._ok(c.post(f"/kb/pages/{pub['id']}/revisions", json={}))
        cls._ok(c.post("/kb/courses", json={"title": f"{SECRET} Course"}))
        cls._ok(c.post("/kb/plans", json={"name": f"{SECRET} Plan"}))
        db = database.SessionLocal()
        try:
            course = db.query(models.KbCourse).filter(models.KbCourse.title == f"{SECRET} Course").first()
            plan = db.query(models.KbTrainingPlan).filter(models.KbTrainingPlan.name == f"{SECRET} Plan").first()
            cid, pid = course.id, plan.id
        finally:
            db.close()
        rule = cls._ok(c.post("/kb/rules", json={"kind": "course", "target_id": cid, "audience": {"departments": ["Operations"]}}))
        cls._as(ALRN)
        flag = cls._ok(c.post(f"/kb/pages/{pub['id']}/flag", json={"text": f"{SECRET} flag"}))
        cls._ok(c.post("/kb/requests", json={"query": f"{SECRET} Request"}))
        db = database.SessionLocal()
        try:
            req = db.query(models.KbPageRequest).filter(models.KbPageRequest.query == f"{SECRET} Request").first()
            db.add(models.KbCourseAssignment(id="asg-kbm-a", course_id=cid, user_email=ALRN, due_date="2030-01-01", source="manual"))
            db.add(models.KbCertificate(id="cert-kbm-a", serial="CERT-2026-90001", course_id=cid, course_title=f"{SECRET} Course",
                                        user_email=ALRN, user_name="P 1", issued_at="2026-10-01", revoked_at=""))
            db.add(models.KbQuizAttempt(id="att-kbm-a", course_id=cid, user_email=ALRN, status="open", course_major=0))
            db.add(models.KbQuizAttempt(id="chk-kbm-a", course_id=cid, user_email=ALRN, status="open", course_major=-1,
                                        answers=json.dumps({"lesson": "L1"})))
            db.add(models.KbJob(id="job-kbm-a", kind="import", created_by=AAUTH))
            db.commit()
            rid_rev = rev.get("id") or rev.get("revision", {}).get("id")
            return {"doc_id": pub["id"], "draft": draft["id"], "rid_rev": rid_rev, "cid": cid, "pid": pid, "rule": rule["id"],
                    "fid": flag["id"], "req": req.id, "aid_asg": "asg-kbm-a", "cert_id": "cert-kbm-a", "aid_quiz": "att-kbm-a",
                    "aid_chk": "chk-kbm-a", "job_id": "job-kbm-a", "col": "col-kbm-a", "lid": "L1", "lang": "es", "vid": "v-none"}
        finally:
            db.close()

    def _url(self, path: str) -> str:
        i = self.ids
        fill = {
            "{doc_id}": i["doc_id"], "{draft}": i["draft"], "{cid}": i["cid"], "{pid}": i["pid"], "{fid}": i["fid"],
            "{cert_id}": i["cert_id"], "{job_id}": i["job_id"], "{lid}": i["lid"], "{lang}": i["lang"], "{vid}": i["vid"],
        }
        # ids whose placeholder name is shared between routes
        if path.startswith("/kb/collections/"):
            fill["{cid}"] = i["col"]
        if path.startswith("/kb/revisions/"):
            fill["{rid}"] = i["rid_rev"]
        elif path.startswith("/kb/rules/"):
            fill["{rid}"] = i["rule"]
        elif path.startswith("/kb/requests/"):
            fill["{rid}"] = i["req"]
        if path.startswith("/kb/assignments/"):
            fill["{aid}"] = i["aid_asg"]
        elif path.startswith("/kb/quiz/"):
            fill["{aid}"] = i["aid_quiz"]
        elif path.startswith("/kb/checkpoint/"):
            fill["{aid}"] = i["aid_chk"]
        for k, v in fill.items():
            path = path.replace(k, v)
        assert "{" not in path, path
        return path

    def _call(self, method: str, path: str):
        body = BODIES.get(path, {}) if method in ("POST", "PATCH", "PUT") else None
        return self.client.request(method, self._url(path), json=body)

    # ── the matrix ───────────────────────────────────────────────────────────
    def test_every_route_is_classified(self):
        served = {(m, r.path) for r in main.app.routes if isinstance(r, APIRoute) and r.path.startswith("/kb/") for m in r.methods}
        self.assertEqual(sorted(served - set(ROUTES)), [], "new /kb routes: add them to ROUTES and decide how they are walled")
        self.assertEqual(sorted(set(ROUTES) - served), [], "ROUTES lists routes that no longer exist")

    def test_another_company_is_refused_on_every_row_route(self):
        self._as(AAUTH)
        for (method, path), kind in ROUTES.items():
            if kind == "wall" and method == "GET" and path not in NO_OWNER_CHECK:
                r = self._call(method, path)
                self.assertLess(r.status_code, 300, f"owner control {method} {path}: {r.status_code} {r.text[:200]}")
        self._as(BAUTH)
        leaks = []
        for (method, path), kind in sorted(ROUTES.items()):
            if kind != "wall":
                continue
            r = self._call(method, path)
            if path == "/kb/compliance/nudge":
                ok = r.status_code in (403, 404) or (r.status_code == 200 and r.json().get("nudged") == 0)
            else:
                ok = r.status_code in (403, 404)
            if not ok:
                leaks.append(f"{method} {path} -> {r.status_code} {r.text[:120]}")
        self.assertEqual(leaks, [], "company B reached company A's rows")
        self._unchanged()

    def test_lists_never_show_another_companys_rows(self):
        self._as(BAUTH)
        secret_ids = [v for k, v in self.ids.items() if k not in ("lid", "lang", "vid", "col")]
        calls = [
            ("GET", "/kb/activity", None), ("GET", "/kb/pages", None), ("GET", "/kb/pages?q=Alpha", None),
            ("GET", "/kb/search?q=Alpha%20Secret", None), ("GET", "/kb/courses?all=true", None), ("GET", "/kb/plans", None),
            ("GET", "/kb/rules", None), ("GET", "/kb/health", None), ("GET", "/kb/home", None), ("GET", "/kb/me", None),
            ("GET", "/kb/training/me", None), ("GET", "/kb/compliance?scope=company", None),
            ("GET", f"/kb/compliance?scope=direct&manager={AAUTH}", None), ("GET", "/kb/people", None),
            ("GET", f"/kb/collections/{self.ids['col']}", None),
            ("POST", "/kb/audience/preview", {"audience": {"everyone": True}}),
        ]
        for method, url, body in calls:
            r = self.client.request(method, url, json=body)
            self.assertIn(r.status_code, (200, 403), f"{url}: {r.status_code} {r.text[:200]}")
            text = json.dumps(self._without_shared_folders(url, r.json()))
            for needle in [SECRET, AAUTH, ALRN, *secret_ids]:
                self.assertNotIn(needle, text, f"{method} {url} shows company A's {needle}")

    @staticmethod
    def _without_shared_folders(url: str, data):
        """Folders are shared by design (owner included); everything else on
        the screen is still checked."""
        if url == "/kb/home" and isinstance(data, dict):
            data = {k: v for k, v in data.items() if k != "collections"}
        if url.startswith("/kb/collections/") and isinstance(data, dict):
            data = {k: v for k, v in data.items() if k not in ("collection", "owner_email", "owner_name", "path")}
        return data

    def test_a_reader_never_opens_drafts_or_author_routes(self):
        self._as(ALRN)
        for method, path in READER:
            r = self._call(method, path)
            self.assertIn(r.status_code, (403, 404), f"reader {method} {path}: {r.status_code} {r.text[:200]}")
        self._as(AAUTH)
        self.assertEqual(self.client.get(f"/kb/pages/{self.ids['draft']}").status_code, 200)

    def test_collections_are_shared_folders(self):
        # The Library shows every folder to everyone (a folder is a heading,
        # the pages in it are walled); only changing one stays in its company.
        self._as(BAUTH)
        self.assertIn("col-kbm-a", [c["id"] for c in self.client.get("/kb/collections").json()])
        self.assertEqual(self.client.patch("/kb/collections/col-kbm-a", json={"name": "Taken Over"}).status_code, 404)

    def test_training_is_never_built_from_another_companys_pages(self):
        # A page lesson and Generate read the page: only pages the author may open (Oct 29 2026).
        from unittest import mock
        import kb_ai
        self._as(BAUTH)
        r = self.client.post("/kb/courses", json={"title": "Beta Course", "lessons": [
            {"type": "page", "docId": self.ids["doc_id"], "title": "Borrowed"},
            {"type": "page", "docId": self.ids["draft"], "title": "Borrowed Draft"},
            {"type": "text", "title": "Our Own", "blocks": {"type": "doc", "content": []}}]})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertNotIn(SECRET, r.text)
        lessons = r.json()["draft"]["lessons"]
        self.assertEqual([L.get("type") for L in lessons], ["text"])
        cid = r.json()["course"]["id"]
        with mock.patch.object(kb_ai, "available", return_value=True):
            r = self.client.post(f"/kb/courses/{cid}/generate", json={"doc_ids": [self.ids["doc_id"]]})
        self.assertEqual(r.status_code, 422, r.text)

    def _unchanged(self):
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.KbDocument).filter(models.KbDocument.id == self.ids["doc_id"]).first().status, "approved")
            self.assertEqual(db.query(models.KbCollection).filter(models.KbCollection.id == "col-kbm-a").first().name, "Ops Folder")
            self.assertEqual(db.query(models.KbPageRequest).filter(models.KbPageRequest.id == self.ids["req"]).first().status, "open")
            self.assertTrue(db.query(models.KbAssignmentRule).filter(models.KbAssignmentRule.id == self.ids["rule"]).first().active)
            self.assertEqual(db.query(models.KbFlag).filter(models.KbFlag.id == self.ids["fid"]).first().status, "open")
            self.assertEqual(db.query(models.NexusNotification).filter(models.NexusNotification.recipient == ALRN,
                                                                       models.NexusNotification.requested_by == BAUTH).count(), 0)
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
