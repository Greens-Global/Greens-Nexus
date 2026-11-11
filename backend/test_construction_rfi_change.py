"""Construction Round Three fixes (Neil, 11/11/2026, plan
https://claude.ai/artifact/VqZSQRz41ffF1VGouJUKLJ, item 1).

Pins:
  * an RFI or submittal saved with no number is numbered per job
    (RFI-001, SUB-001), one past the highest the job used; a typed number
    is kept as typed;
  * an RFI keeps files - this job's own construction-media only;
  * an RFI's Cost Impact is a dollar figure: the crew read it as None and
    cannot set it;
  * an answered RFI becomes ONE draft change order prefilled from it
    (title, question and answer, amount, days); an open RFI is refused, a
    second is refused while the first is live, a voided one frees it; the
    register row then names the change order by number;
  * the crew never makes one.

Run: python -m pytest test_construction_rfi_change.py -q
"""
import os
import tempfile

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ["SUPABASE_URL"] = "https://proj.supabase.co"
os.environ["SUPABASE_SERVICE_KEY"] = "service-key"
os.environ.pop("ANTHROPIC_API_KEY", None)

import models               # noqa: E402
from construction_jobs_testkit import CREW, MGR_A, MGR_B, JobsBase  # noqa: E402

PUB = "https://proj.supabase.co/storage/v1/object/public"
RFIS = "/construction/projects/pa/register/rfis"


class Base(JobsBase):
    tmp_db = _tmp.name

    def _rfi(self, **kw):
        self.as_(MGR_A)
        r = self.client.post(RFIS, json={"subject": "Footing depth at grid C", "question": "Drawings show 24 in, soils report 36 in?", **kw})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    def _answered(self, **kw):
        r = self._rfi(cost_impact=3800, schedule_impact_days=2, **kw)
        a = self.client.patch(f"/construction/register/rfis/{r['id']}",
                              json={"status": "answered", "answer": "Go to 36 in per the soils report."})
        self.assertEqual(a.status_code, 200, a.text)
        return a.json()


class Numbering(Base):
    def test_blank_numbers_are_per_job_and_typed_ones_kept(self):
        self.assertEqual(self._rfi()["number"], "RFI-001")
        self.assertEqual(self._rfi(number="RFI-014")["number"], "RFI-014")
        self.assertEqual(self._rfi()["number"], "RFI-015")
        # Review (11/11/2026): a number in another form never moves the sequence.
        self.assertEqual(self._rfi(number="ASI-2024")["number"], "ASI-2024")
        self.assertEqual(self._rfi()["number"], "RFI-016")
        s = self.client.post("/construction/projects/pa/register/submittals", json={"title": "Rebar shop drawings"})
        self.assertEqual(s.json()["number"], "SUB-001")
        self.as_(MGR_B)
        r = self.client.post("/construction/projects/pb/register/rfis", json={"subject": "Other job"})
        self.assertEqual(r.json()["number"], "RFI-001")


class Files(Base):
    def test_an_rfi_keeps_this_jobs_files_only(self):
        self.as_(MGR_A)
        bad = self.client.post(RFIS, json={"subject": "x", "document_urls": ["https://example.com/x.pdf"]})
        self.assertEqual(bad.status_code, 422)
        url = f"{PUB}/construction-media/construction/pa/sketch.jpg"
        r = self._rfi(document_urls=[url])
        self.assertEqual(r["documentUrls"], [url])
        self.as_(CREW)
        self.assertEqual(self.client.get(RFIS).json()[0]["documentUrls"], [url])


class CostImpact(Base):
    def test_the_crew_never_read_or_set_the_dollars(self):
        r = self._rfi(cost_impact=1200)
        self.assertEqual(r["costImpact"], 1200)
        self.as_(CREW)
        self.assertIsNone(self.client.get(RFIS).json()[0]["costImpact"])


class ChangeOrder(Base):
    def _make(self, rfi_id):
        return self.client.post("/construction/projects/pa/change-orders", json={"rfi_id": rfi_id})

    def test_an_answered_rfi_becomes_one_prefilled_draft(self):
        r = self._answered()
        res = self._make(r["id"])
        self.assertEqual(res.status_code, 201, res.text)
        co = res.json()
        self.assertEqual((co["number"], co["status"], co["rfiId"], co["amount"], co["scheduleImpactDays"], co["reason"]),
                         ("CO-001", "draft", r["id"], 3800, 2, "design"))
        self.assertEqual(co["title"], "RFI-001 Footing depth at grid C")
        self.assertIn("Answer: Go to 36 in", co["description"])
        self.assertEqual(self._make(r["id"]).status_code, 409)
        row = self.client.get(RFIS).json()[0]
        self.assertEqual(row["changeOrder"], {"id": co["id"], "number": "CO-001"})
        self.as_(CREW)
        self.assertEqual(self.client.get(RFIS).json()[0]["changeOrder"]["number"], "CO-001")

    def test_an_open_rfi_is_refused_and_a_void_frees_it(self):
        open_rfi = self._rfi()
        self.assertEqual(self._make(open_rfi["id"]).status_code, 409)
        r = self._answered()
        co = self._make(r["id"]).json()
        self.assertEqual(self.client.post(f"/construction/change-orders/{co['id']}/void",
                                          json={"reason": "Priced on the next one"}).status_code, 200)
        self.assertIsNone(self.client.get(RFIS).json()[1]["changeOrder"])
        self.assertEqual(self._make(r["id"]).status_code, 201)

    def test_the_crew_and_another_company_cannot(self):
        r = self._answered()
        self.as_(CREW)
        self.assertEqual(self._make(r["id"]).status_code, 403)
        self.as_(MGR_B)
        self.assertIn(self._make(r["id"]).status_code, (403, 404))
        self.assertEqual(self.db.query(models.ConstructionChangeOrder).count(), 0)
