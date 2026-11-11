"""Construction Round Three item 4 - outside parties (Neil, 11/11/2026, plan
https://claude.ai/artifact/VqZSQRz41ffF1VGouJUKLJ).

Pins:
  * a job manager sends a link for one open RFI or one sub on the job; the
    URL is in that answer only (the database keeps a SHA-256 of the token);
    the crew and another company cannot; the list never carries a token;
  * the RFI page shows that RFI only; an answer (with a file) marks it
    Answered once, as the sender, names the outside person, bells the
    sender; a second answer is refused;
  * a sub's page lists only the punch items given to that sub; Done needs a
    photo, goes through Tasks as the sender (the task is completed), and
    Verify stays inside;
  * a revoked or expired link is 410; a sender who no longer manages the
    job ends the link; a made-up token is 404; a link of one kind never
    acts as the other;
  * guests: a guest on the crew sees only that job and no money; a guest
    is refused as a job manager.

Run: python -m pytest test_construction_outside.py -q
"""
import os
import tempfile
from unittest import mock

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ["SUPABASE_URL"] = "https://proj.supabase.co"
os.environ["SUPABASE_SERVICE_KEY"] = "service-key"
os.environ.pop("ANTHROPIC_API_KEY", None)

import models               # noqa: E402
from construction_jobs_testkit import A, CREW, MGR_A, MGR_B, JobsBase, iso  # noqa: E402
from routers import construction_outside as co, esign  # noqa: E402
from services import construction_storage as storage  # noqa: E402

GUEST = "pat@partnerbuild.com"
PNG = ("done.png", b"\x89PNG\r\n\x1a\n-fake-", "image/png")


class Outside(JobsBase):
    tmp_db = _tmp.name

    def setUp(self):
        super().setUp()
        for m in (models.ConstructionOutsideLink, models.VendorCompliance):
            self.db.query(m).delete(synchronize_session=False)
        self.db.add(models.ConstructionRfi(id="r1", project_id="pa", number="RFI-001", subject="Footing depth",
                                           question="24 or 36 in?", status="open", document_urls=[], deleted_at="",
                                           created_at=iso()))
        self.db.add(models.ConstructionRfi(id="r2", project_id="pa", number="RFI-002", subject="Other", status="open",
                                           document_urls=[], deleted_at="", created_at=iso()))
        self.db.add(models.ConstructionJobLink(id="lk1", project_id="pa", kind="sub", ref_id="V-100", created_at=iso(),
                                               ended_at="", note="Plumbing"))
        self.db.add(models.VendorCompliance(vendor_id="V-100", vendor_name="Acme Plumbing"))
        self.db.commit()
        self._p = [mock.patch.object(esign, "_storage_put", return_value=esign._StorageResult(True)),
                   mock.patch.object(storage, "fetch_url", side_effect=lambda u, pid=None: f"{u}?signed=1"),
                   mock.patch.object(co, "_mail", return_value=None)]
        for p in self._p:
            p.start()

    def tearDown(self):
        for p in self._p:
            p.stop()
        super().tearDown()

    def send(self, kind="rfi", ref="r1", **kw):
        body = {"kind": kind, "ref_id": ref, "name": "Morgan Arch", "email": "morgan@archfirm.com", **kw}
        return self.client.post("/construction/projects/pa/outside-links", json=body)

    def token(self, r):
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["url"].rsplit("/", 1)[-1]

    # ── sending ─────────────────────────────────────────────────────────────
    def test_only_a_job_manager_sends_and_the_token_is_never_stored(self):
        self.as_(CREW)
        self.assertEqual(self.send().status_code, 403)
        self.as_(MGR_B)
        self.assertEqual(self.send().status_code, 404)
        self.as_(MGR_A)
        self.assertEqual(self.send(ref="nope").status_code, 422)
        self.assertEqual(self.send(kind="sub", ref="V-999").status_code, 422)
        self.assertEqual(self.send(email="").status_code, 422)            # emailing needs an address
        tok = self.token(self.send())
        row = self.db.query(models.ConstructionOutsideLink).one()
        self.assertNotEqual(row.token_hash, tok)
        self.assertEqual(row.token_hash, co._hash(tok))
        listed = self.client.get("/construction/projects/pa/outside-links").json()["links"]
        self.assertNotIn(tok, str(listed))
        self.assertTrue(listed[0]["live"])
        self.assertEqual(self.token(self.send(email="", send_email=False)).__len__() > 20, True)   # copy-only link

    # ── an RFI ──────────────────────────────────────────────────────────────
    def test_an_architect_answers_one_rfi_once_as_the_sender(self):
        self.as_(MGR_A)
        tok = self.token(self.send())
        page = self.client.get(f"/construction-outside/{tok}").json()
        self.assertEqual((page["kind"], page["rfi"]["number"], page["canAnswer"]), ("rfi", "RFI-001", True))
        self.assertNotIn("Other", str(page))                              # the other RFI is not here
        self.assertNotIn("contractValue", str(page))
        r = self.client.post(f"/construction-outside/{tok}/answer", data={"answer": "Go to 36 in per soils."},
                             files=[("files", ("sketch.pdf", b"%PDF-1.4 x", "application/pdf"))])
        self.assertEqual(r.status_code, 200, r.text)
        rfi = self.fresh(models.ConstructionRfi, "r1")
        self.assertEqual((rfi.status, rfi.answer, rfi.answered_by), ("answered", "Go to 36 in per soils.", "Morgan Arch <morgan@archfirm.com>"))
        self.assertEqual(len(rfi.document_urls), 1)
        self.assertTrue(storage.url_ok(rfi.document_urls[0], "pa"))
        act = self.db.query(models.ConstructionActivity).filter_by(entity_id="r1", type="answered_outside").one()
        self.assertEqual(act.actor_email, MGR_A)
        self.assertIn("Morgan Arch", act.detail)
        self.assertTrue(self.db.query(models.NexusNotification).filter_by(recipient=MGR_A).count() >= 1)
        self.assertEqual(self.client.post(f"/construction-outside/{tok}/answer", data={"answer": "again"}).status_code, 409)
        self.assertFalse(self.client.get(f"/construction-outside/{tok}").json()["canAnswer"])
        # Reopened and answered inside: the outside credit goes (review, 11/11/2026).
        self.client.patch("/construction/register/rfis/r1", json={"status": "open"})
        self.assertEqual(self.fresh(models.ConstructionRfi, "r1").answered_by, "")
        bad = self.client.post(f"/construction-outside/{tok}/answer", data={"answer": "x y"},
                               files=[("files", ("a.exe", b"MZ", "application/octet-stream"))])
        self.assertIn(bad.status_code, (409, 422))

    def test_revoked_expired_unknown_and_a_sender_who_left(self):
        self.as_(MGR_A)
        tok = self.token(self.send())
        self.assertEqual(self.client.get("/construction-outside/not-a-real-token-at-all-xx").status_code, 404)
        link = self.db.query(models.ConstructionOutsideLink).one()
        self.client.post(f"/construction/outside-links/{link.id}/revoke")
        self.assertEqual(self.client.get(f"/construction-outside/{tok}").status_code, 410)
        tok2 = self.token(self.send(ref="r2"))
        row = self.db.query(models.ConstructionOutsideLink).filter_by(ref_id="r2").one()
        row.expires_at = "2020-01-01T00:00:00+00:00"
        self.db.commit()
        self.assertEqual(self.client.get(f"/construction-outside/{tok2}").status_code, 410)
        tok3 = self.token(self.send(ref="r2"))
        job = self.db.get(models.ConstructionProject, "pa")
        self.db.query(models.NexusRole).filter_by(email=MGR_A).delete()
        job.manager_emails = []
        self.db.commit()
        import auth
        auth.invalidate_role_cache()
        self.assertEqual(self.client.get(f"/construction-outside/{tok3}").status_code, 410)

    # ── a sub's punch list ──────────────────────────────────────────────────
    def test_a_sub_marks_only_their_items_done_with_a_photo(self):
        self.as_(MGR_A)
        self.assertEqual(self.client.post("/construction/projects/pa/task-project", json={}).status_code, 201)
        for pid, title in (("p-1", "Tighten trap"), ("p-2", "Ours, not theirs")):
            self.assertEqual(self.client.post("/construction/projects/pa/punch", json={"id": pid, "title": title}).status_code, 201)
        self.assertEqual(self.client.post("/construction/punch/p-1/sub", json={"vendor_id": "V-999"}).status_code, 422)
        self.assertEqual(self.client.post("/construction/punch/p-1/sub", json={"vendor_id": "V-100"}).status_code, 200)
        tok = self.token(self.send(kind="sub", ref="V-100", name="Acme Office", email="office@acme.com"))
        page = self.client.get(f"/construction-outside/{tok}").json()
        self.assertEqual(page["sub"]["name"], "Acme Plumbing")
        self.assertEqual([i["id"] for i in page["items"]], ["p-1"])
        self.assertEqual(self.client.post(f"/construction-outside/{tok}/done/p-2", files={"photo": PNG}).status_code, 404)
        self.assertEqual(self.client.post(f"/construction-outside/{tok}/done/p-1").status_code, 422)   # no photo
        r = self.client.post(f"/construction-outside/{tok}/done/p-1", files={"photo": PNG}, data={"note": "Trap tightened"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(self.fresh(models.Task, "p-1").completed)
        meta = self.fresh(models.ConstructionPunchMeta, "p-1")
        self.assertEqual((meta.done_by, meta.verified_by), ("office@acme.com", ""))
        self.assertTrue(meta.done_media_id)
        self.assertEqual(self.client.post(f"/construction-outside/{tok}/done/p-1", files={"photo": PNG}).status_code, 409)
        # Review (11/11/2026): a sub taken off the job loses the link at once.
        lk = self.db.get(models.ConstructionJobLink, "lk1")
        lk.ended_at = iso()
        self.db.commit()
        self.assertEqual(self.client.get(f"/construction-outside/{tok}").status_code, 410)
        lk.ended_at = ""
        self.db.commit()
        # an RFI link never acts on a punch list, nor the other way
        rfi_tok = self.token(self.send())
        self.assertEqual(self.client.post(f"/construction-outside/{rfi_tok}/done/p-1", files={"photo": PNG}).status_code, 404)
        self.assertEqual(self.client.post(f"/construction-outside/{tok}/answer", data={"answer": "hello"}).status_code, 404)


class Guests(JobsBase):
    tmp_db = _tmp.name

    def setUp(self):
        super().setUp()
        self.db.add(models.NexusEmployee(id="e-guest", first_name="Pat", last_name="Partner", work_email=GUEST,
                                         status="active", deleted_at="", company=A, identity_type="guest"))
        self.db.add(self.job("pc", "Job C", A, managers=[MGR_A]))
        # A guest reaches /construction only through an Access Group's Operations
        # grant (auth.MODULE_API_PREFIXES["ops"]); the job reads then confine them.
        for m in (models.NexusGroup, models.NexusGroupMember):
            self.db.query(m).delete(synchronize_session=False)
        self.db.add(models.NexusGroup(id="grp-guest-ops", name="Partner Crew", allowed_modules="ops:editor"))
        self.db.add(models.NexusGroupMember(group_id="grp-guest-ops", email=GUEST))
        job = self.db.get(models.ConstructionProject, "pa")
        job.worker_emails = list(job.worker_emails) + [GUEST]
        job.contract_value = 50000.0
        self.db.commit()
        import cache
        cache.module_grants.invalidate()

    def test_a_guest_on_the_crew_sees_that_job_only_and_no_money(self):
        self.as_(GUEST)
        jobs = self.client.get("/construction/projects").json()
        self.assertEqual([j["id"] for j in jobs], ["pa"])
        self.assertNotIn("contractValue", jobs[0])
        self.assertEqual(self.client.get("/construction/projects/pc").status_code in (403, 404), True)

    def test_a_guest_is_never_a_job_manager(self):
        self.as_(MGR_A)
        r = self.client.patch("/construction/projects/pa", json={"manager_emails": [MGR_A, GUEST]})
        self.assertEqual(r.status_code, 422, r.text)
        self.assertIn("guest", r.json()["detail"])
        self.assertEqual(self.client.patch("/construction/projects/pa", json={"worker_emails": [CREW, GUEST]}).status_code, 200)
