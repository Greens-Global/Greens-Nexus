"""The public careers page and apply form (Neil, Oct 27 2026) - routers/careers.py.

Only Open, unexpired openings are listed, and nothing about who owns or
asked for one, who applied, or a private pay range leaves; the JobPosting
JSON-LD carries baseSalary only when the public pay toggle is on; the
apply form checks its fields, the honeypot, consent and the resume's real
type and size, is on the sensitive rate-limit list, creates a candidate at
Applied linked to the opening (source Careers Page) and updates - never
duplicates - one who applies again.

Run with: python -m unittest test_careers_public -v
"""
import io
import json
import os
import tempfile
import unittest
import zipfile

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import database  # noqa: E402
import hiring_openings as ho  # noqa: E402
import models  # noqa: E402
import task_notify  # noqa: E402
from middleware_hardening import RequestRateLimit  # noqa: E402
from routers import careers, esign  # noqa: E402

ENT = "ent-careers"
OWNER_EMAIL = "olive.owner@greensglobal.com"
PDF = b"%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"


def _docx() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("word/document.xml", "<w:document/>")
    return buf.getvalue()


class CareersCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        actual = database.engine.url.database or ""
        assert os.path.abspath(actual) == os.path.abspath(_tmp_db.name), actual
        models.Base.metadata.create_all(bind=database.engine)
        app = FastAPI()
        app.include_router(careers.router)
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.HrJobOpening, models.HrCandidate, models.HrStageEvent, models.HrEntity,
                  models.NexusEmployee, models.NexusNotification, models.Task, models.HrHeadcountRequest):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=ENT, name="Greens Test Co", legal_name="Greens Test, LLC", country="US",
                                    website="https://greens.example", logo_url="https://cdn.example/logo.png",
                                    created_at="2026-01-01"))
        self.db.add(models.NexusEmployee(id="e-own", work_email=OWNER_EMAIL, first_name="Olive", last_name="O",
                                         company=ENT, status="active"))
        self.db.add(self._op("op-open", status="open", title="Staff Accountant"))
        self.db.add(self._op("op-draft", status="draft", title="Secret Draft"))
        self.db.add(self._op("op-paused", status="paused", title="Paused Job"))
        self.db.add(self._op("op-old", status="open", title="Expired Job", valid_through="2020-01-01"))
        self.db.commit()
        careers._ip_hits.clear()
        self.stored, self.mails = {}, []
        self._put, self._send, self._notify = esign._storage_put, careers._send_confirmation, task_notify.notify_task_event

        class _Up:
            is_success = True
        esign._storage_put = lambda bucket, path, data, ctype, upsert=False: (self.stored.__setitem__((bucket, path), (len(data), ctype)) or _Up())
        careers._send_confirmation = lambda to, subject, html: self.mails.append((to, subject, html))
        task_notify.notify_task_event = lambda *a, **k: None

    def tearDown(self):
        esign._storage_put, careers._send_confirmation, task_notify.notify_task_event = self._put, self._send, self._notify
        self.db.close()

    @staticmethod
    def _op(oid, **kw):
        base = dict(id=oid, company=ENT, department="Accounting", title="Job", employment_type="full_time", seats=1,
                    description="Close the books.\n\n- Reconcile accounts\n- Run payroll", city="Austin", region="TX",
                    postal_code="78701", country="US", status="open", opened_at="2026-10-20T10:00:00+00:00",
                    valid_through="2099-12-31", hiring_owner_email=OWNER_EMAIL, headcount_id="hc-secret-1",
                    pay_min=60000.0, pay_max=75000.0, pay_currency="USD", pay_period="year", show_pay=False,
                    created_at="2026-10-19", history=[])
        base.update(kw)
        return models.HrJobOpening(**base)

    def _apply(self, opening="op-open", files=None, **kw):
        data = {"first_name": "Jane", "last_name": "Doe", "email": "Jane@Example.com", "phone": "(512) 555-0100",
                "location": "Austin, TX", "linkedin_url": "https://www.linkedin.com/in/janedoe", "consent": "true",
                "website": ""}
        data.update(kw)
        if files is None:
            files = {"resume": ("Jane Doe.pdf", PDF, "application/pdf")}
        return self.client.post(f"/careers/apply/{opening}", data=data, files=files)

    def _cands(self):
        self.db.expire_all()
        return self.db.query(models.HrCandidate).all()


class PublicReadTests(CareersCase):
    def test_only_open_unexpired_openings_are_listed_and_nothing_private_leaks(self):
        r = self.client.get("/careers/public/greens-test-co")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual([o["title"] for o in body["openings"]], ["Staff Accountant"])
        self.assertEqual(body["company"]["logoUrl"], "https://cdn.example/logo.png")
        raw = r.text
        for secret in (OWNER_EMAIL, "hc-secret-1", "60000", "75000", "Secret Draft", "Paused Job", "Expired Job"):
            self.assertNotIn(secret, raw)
        one = self.client.get("/careers/public/greens-test-co/op-open")
        self.assertEqual(one.status_code, 200)
        for secret in (OWNER_EMAIL, "hc-secret-1", "60000", "\"seats\"", "\"counts\"", "hiringOwner"):
            self.assertNotIn(secret, one.text)
        for hidden in ("op-draft", "op-paused", "op-old", "nope"):
            self.assertEqual(self.client.get(f"/careers/public/greens-test-co/{hidden}").status_code, 404)
        self.assertEqual(self.client.get("/careers/public/no-such-company").status_code, 404)

    def test_job_posting_structured_data(self):
        ld = self.client.get("/careers/public/greens-test-co/op-open").json()["jsonLd"]
        self.assertEqual((ld["@type"], ld["title"], ld["employmentType"]), ("JobPosting", "Staff Accountant", "FULL_TIME"))
        self.assertEqual(ld["datePosted"], "2026-10-20")
        self.assertEqual(ld["validThrough"], "2099-12-31T23:59:59")
        self.assertEqual(ld["hiringOrganization"]["name"], "Greens Test, LLC")
        self.assertEqual(ld["jobLocation"]["address"]["addressLocality"], "Austin")
        self.assertIn("<li>Reconcile accounts</li>", ld["description"])
        self.assertNotIn("baseSalary", ld)                      # the pay toggle is off
        self.db.query(models.HrJobOpening).filter_by(id="op-open").update({"show_pay": True})
        self.db.commit()
        ld = self.client.get("/careers/public/greens-test-co/op-open").json()["jsonLd"]
        self.assertEqual(ld["baseSalary"]["value"], {"@type": "QuantitativeValue", "unitText": "YEAR",
                                                     "minValue": 60000.0, "maxValue": 75000.0})

    def test_server_made_page_carries_the_json_ld_and_nothing_breaks_out(self):
        self.db.query(models.HrJobOpening).filter_by(id="op-open").update(
            {"title": "Clerk</script><script>alert(1)</script>", "description": "<b>bold</b> & more"})
        self.db.commit()
        page = self.client.get("/careers/page/greens-test-co/op-open").json()
        self.assertIn('<script type="application/ld+json">', page["headHtml"])
        self.assertEqual(page["headHtml"].count("</script>"), 1)       # only the JSON-LD's own close
        self.assertNotIn("<b>bold</b>", page["bodyHtml"])
        self.assertIn("&lt;b&gt;bold&lt;/b&gt; &amp; more", page["bodyHtml"])
        self.assertIn('rel="canonical"', page["headHtml"])
        lst = self.client.get("/careers/page/greens-test-co").json()
        self.assertIn("/careers/greens-test-co/op-open", lst["bodyHtml"])
        self.assertEqual(self.client.get("/careers/page/greens-test-co/op-draft").status_code, 404)

    def test_sitemap_lists_the_listed_openings(self):
        r = self.client.get("/careers/sitemap.xml")
        self.assertEqual(r.status_code, 200)
        self.assertIn("application/xml", r.headers["content-type"])
        self.assertIn("/careers/greens-test-co/op-open</loc>", r.text)
        self.assertNotIn("op-draft", r.text)

    def test_description_is_escaped_into_paragraphs_and_lists(self):
        html = ho.description_html("Hello <you>\nline two\n\n- one\n- two & three")
        self.assertEqual(html, "<p>Hello &lt;you&gt;<br>line two</p><ul><li>one</li><li>two &amp; three</li></ul>")

    def test_slug_collisions_get_a_number(self):
        self.db.add(models.HrEntity(id="ent-dup", name="Greens  Test Co!", created_at="2026-05-01"))
        self.db.commit()
        slugs = {e.id: s for s, e in ho.slug_map(self.db).items()}
        self.assertEqual((slugs[ENT], slugs["ent-dup"]), ("greens-test-co", "greens-test-co-2"))


class ApplyTests(CareersCase):
    def test_the_apply_route_is_on_the_sensitive_rate_limit_list(self):
        self.assertTrue("/careers/apply/op-open".startswith(RequestRateLimit.SENSITIVE_PREFIXES))
        # The public reads are not - crawlers and job seekers browse them.
        self.assertFalse("/careers/public/x".startswith(RequestRateLimit.SENSITIVE_PREFIXES))
        for _ in range(careers.APPLY_PER_IP_HOUR):
            self.assertTrue(careers._ip_allowed("203.0.113.9"))
        self.assertFalse(careers._ip_allowed("203.0.113.9"))

    def test_apply_creates_a_candidate_at_applied_linked_to_the_opening(self):
        r = self._apply()
        self.assertEqual(r.status_code, 200, r.text)
        cands = self._cands()
        self.assertEqual(len(cands), 1)
        c = cands[0]
        self.assertEqual((c.stage, c.source, c.opening_id, c.company), ("applied", "Careers Page", "op-open", ENT))
        self.assertEqual((c.email, c.role_title, c.location), ("jane@example.com", "Staff Accountant", "Austin, TX"))
        self.assertTrue(c.consent_at and c.applied_at)
        self.assertTrue(c.resume_url.startswith(f"candidates/{c.id}/"))
        (bucket, path), (size, ctype) = next(iter(self.stored.items()))
        self.assertEqual((bucket, path, ctype), ("hr-docs", c.resume_url, "application/pdf"))
        bells = self.db.query(models.NexusNotification).filter_by(recipient=OWNER_EMAIL).all()
        self.assertEqual(len(bells), 1)
        self.assertIn("New Applicant", bells[0].title)
        self.assertEqual(len(self.mails), 1)
        self.assertEqual(self.mails[0][0], "jane@example.com")
        self.assertIn("Staff Accountant", self.mails[0][1])

    def test_screening_starts_with_the_task_only_no_bell_per_applicant(self):
        head = "hal.head@greensglobal.com"
        self.db.add(models.NexusEmployee(id="e-head", work_email=head, first_name="Hal", last_name="H",
                                         company=ENT, status="active"))
        self.db.add(models.HrDepartment(id="d-acct-c", company_id=ENT, name="Accounting", lead_email=head))
        self.db.commit()
        try:
            self.assertEqual(self._apply().status_code, 200)
            c = self._cands()[0]
            self.assertTrue(c.screen_task_id)
            task = self.db.query(models.Task).filter_by(id=c.screen_task_id).first()
            self.assertIn(head, task.assignee_emails or [task.assignee_email])
            self.assertEqual(self.db.query(models.NexusNotification).filter_by(recipient=head).count(), 0)
        finally:
            self.db.query(models.HrDepartment).filter_by(id="d-acct-c").delete()
            self.db.commit()

    def test_the_same_person_again_updates_not_duplicates(self):
        self.assertEqual(self._apply().status_code, 200)
        r = self._apply(phone="512-555-0199", files={"resume": ("cv.docx", _docx(), "application/octet-stream")})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), careers._OK)                 # the answer never says which it was
        cands = self._cands()
        self.assertEqual(len(cands), 1)
        self.assertEqual(cands[0].phone, "512-555-0199")
        self.assertTrue(cands[0].resume_url.endswith("cv.docx"))
        self.assertEqual(len(self.db.query(models.NexusNotification).filter_by(recipient=OWNER_EMAIL).all()), 1)
        self.assertEqual(len(self.mails), 1)                   # no second email the same day
        # Another person is a second applicant in the same grouped bell.
        self._apply(email="sam@example.com", first_name="Sam")
        bells = self.db.query(models.NexusNotification).filter_by(recipient=OWNER_EMAIL).all()
        self.assertEqual(len(bells), 1)
        self.assertIn("2 applicants", bells[0].body)

    def test_honeypot_looks_like_success_and_keeps_nothing(self):
        r = self._apply(website="http://spam.example")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), careers._OK)
        self.assertEqual(self._cands(), [])
        self.assertEqual(self.stored, {})
        self.assertEqual(self.mails, [])

    def test_field_checks(self):
        for kw, word in (({"consent": ""}, "agree"), ({"email": "not-an-email"}, "email"),
                         ({"phone": "12"}, "phone"), ({"linkedin_url": "https://evil.example/in/x"}, "LinkedIn"),
                         ({"first_name": ""}, "First name"), ({"location": "  "}, "Location")):
            r = self._apply(**kw)
            self.assertEqual(r.status_code, 400, kw)
            self.assertIn(word, r.json()["detail"])
        self.assertEqual(self._cands(), [])

    def test_the_resume_must_really_be_a_pdf_or_word_file(self):
        bad = (("cv.pdf", b"MZ\x90\x00 this is an exe"), ("cv.docx", b"PK\x03\x04 not really a zip"),
               ("cv.doc", PDF), ("cv.exe", PDF), ("cv.docx", self._zip_without_word()))
        for name, raw in bad:
            r = self._apply(files={"resume": (name, raw, "application/pdf")})
            self.assertEqual(r.status_code, 400, name)
        self.assertEqual(self._apply(files={}).status_code, 400)            # none attached
        big = PDF + b"0" * (careers.MAX_RESUME_BYTES + 1)
        self.assertEqual(self._apply(files={"resume": ("big.pdf", big, "application/pdf")}).status_code, 400)
        self.assertEqual(self._cands(), [])
        self.assertEqual(careers.resume_kind("x.doc", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1rest"), "doc")
        self.assertEqual(careers.resume_kind("x.docx", _docx()), "docx")

    @staticmethod
    def _zip_without_word():
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("evil.sh", "rm -rf /")
        return buf.getvalue()

    def test_only_a_listed_opening_takes_applications(self):
        for oid in ("op-draft", "op-paused", "op-old", "nope"):
            self.assertEqual(self._apply(opening=oid).status_code, 404, oid)
        self.assertEqual(self._cands(), [])

    def test_the_confirmation_email_is_capped_per_address(self):
        for i in range(careers.EMAILS_PER_ADDRESS_DAY + 1):
            self.db.add(self._op(f"op-x{i}", title=f"Job {i}"))
        self.db.commit()
        for i in range(careers.EMAILS_PER_ADDRESS_DAY + 1):
            self.assertEqual(self._apply(opening=f"op-x{i}").status_code, 200)
        self.assertEqual(len(self.mails), careers.EMAILS_PER_ADDRESS_DAY)

    def test_public_json_never_names_an_applicant(self):
        self._apply()
        for url in ("/careers/public/greens-test-co", "/careers/public/greens-test-co/op-open",
                    "/careers/page/greens-test-co/op-open", "/careers/sitemap.xml"):
            text = self.client.get(url).text
            self.assertNotIn("jane", text.lower(), url)
            self.assertNotIn("555-0100", text, url)
        json.loads(self.client.get("/careers/public/greens-test-co").text)


if __name__ == "__main__":
    unittest.main()
