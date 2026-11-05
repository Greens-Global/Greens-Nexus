"""Construction Round Two item 7 - subs on a job and their papers (Neil,
11/05/2026, plan https://claude.ai/artifact/EpG2gQr8KVi1ZZRaM6zVBE,
feat/construction-subs).

Pins:
  * a sub is one of Intacct's vendors, looked up through Accounting's
    partners read; a vendor Intacct does not know is refused; the same
    vendor twice is one link; only a job manager adds or removes;
  * the papers are one row per VENDORID (vendor_compliance) with ONE state
    rule: missing / expired / expiring / ok; a job manager, a manager-tier
    person or an Accounting grant holder saves them, the crew reads;
  * the expiry tick bells the job's managers at 30 / 7 / 0 days, once per
    paper and date; a sub taken off the job gets no bell;
  * walls: another company's job is a 404.

Run: python -m pytest test_construction_subs.py -q
"""
import os
import tempfile
from datetime import datetime, timedelta, timezone

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("SUPABASE_URL", None)

import models                                   # noqa: E402
import vendor_compliance as vc                  # noqa: E402
from construction_jobs_testkit import CREW, MGR_A, MGR_B, JobsBase  # noqa: E402
from routers import accounting_partners         # noqa: E402

VENDORS = [{"id": "V-100", "name": "Acme Plumbing", "status": "active"},
           {"id": "V-200", "name": "Bolt Electric", "status": "inactive"}]


async def fake_get(params):
    q = (params.get("q") or "").lower()
    return [v for v in VENDORS if q in v["id"].lower() or q in v["name"].lower()]


class Base(JobsBase):
    tmp_db = _tmp.name

    def setUp(self):
        super().setUp()
        self._get, accounting_partners._get = accounting_partners._get, fake_get
        self.db.query(models.VendorCompliance).delete()
        self.db.commit()

    def tearDown(self):
        accounting_partners._get = self._get
        super().tearDown()

    def add(self, vid="V-100", trade="Plumbing", who=MGR_A, job="pa"):
        self.as_(who)
        return self.client.post(f"/construction/projects/{job}/subs", json={"vendor_id": vid, "trade": trade})


class SubsOnAJob(Base):
    def test_a_manager_puts_an_intacct_vendor_on_the_job_once_and_the_crew_reads_it(self):
        r = self.add()
        self.assertEqual(r.status_code, 201, r.text)
        subs = r.json()["subs"]
        self.assertEqual([(s["name"], s["trade"], s["compliance"]["state"]) for s in subs],
                         [("Acme Plumbing", "Plumbing", "missing")])
        self.assertEqual(self.add(trade="Plumbing and gas").json()["subs"][0]["trade"], "Plumbing and gas")
        self.assertEqual(self.db.query(models.ConstructionJobLink).filter_by(kind="sub").count(), 1)
        self.assertEqual(self.add(vid="V-999").status_code, 422)
        self.assertEqual(self.add(who=CREW).status_code, 403)
        self.as_(CREW)
        r = self.client.get("/construction/projects/pa/subs")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["canEdit"])
        self.assertEqual(r.json()["subs"][0]["vendorId"], "V-100")
        self.as_(MGR_B)
        self.assertEqual(self.client.get("/construction/projects/pa/subs").status_code, 404)

    def test_the_picker_is_for_job_managers_and_carries_names_only(self):
        self.as_(MGR_A)
        r = self.client.get("/construction/vendors?q=bolt&job_id=pa")
        self.assertEqual(r.json(), {"vendors": [{"id": "V-200", "name": "Bolt Electric", "inactive": True}]})
        self.as_(CREW)
        self.assertEqual(self.client.get("/construction/vendors?q=bolt&job_id=pa").status_code, 403)

    def test_taking_a_sub_off_keeps_the_history(self):
        link_id = self.add().json()["subs"][0]["linkId"]
        self.as_(CREW)
        self.assertEqual(self.client.post(f"/construction/sub-links/{link_id}/end").status_code, 403)
        self.as_(MGR_A)
        self.assertEqual(self.client.post(f"/construction/sub-links/{link_id}/end").status_code, 200)
        self.assertEqual(self.client.get("/construction/projects/pa/subs").json()["subs"], [])
        self.assertTrue(self.fresh(models.ConstructionJobLink, link_id).ended_at)


class ThePapers(Base):
    def test_one_state_rule_and_who_may_save(self):
        self.add()
        today = datetime.now(timezone.utc).date()
        body = {"coi_expires_on": (today + timedelta(days=200)).isoformat(),
                "wc_expires_on": (today + timedelta(days=10)).isoformat(),
                "license_number": "C36-12345", "w9_on_file": True, "notes": "COI names Greens as additional insured"}
        self.as_(CREW)
        self.assertEqual(self.client.put("/construction/vendors/V-100/compliance", json=body).status_code, 403)
        self.as_(MGR_A)
        self.assertEqual(self.client.put("/construction/vendors/V-100/compliance", json={"coi_expires_on": "soon"}).status_code, 422)
        r = self.client.put("/construction/vendors/V-100/compliance", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        c = r.json()["compliance"]
        self.assertEqual(c["state"], "expiring")
        self.assertRegex(c["issues"][0], r"^Workers Comp Certificate expires \d\d/\d\d/\d{4} \(in (9|10) days\)\.$")
        self.assertTrue(c["w9OnFile"])
        self.assertEqual(c["vendorName"], "Acme Plumbing")
        r = self.client.put("/construction/vendors/V-100/compliance", json={"wc_expires_on": (today - timedelta(days=1)).isoformat()})
        self.assertEqual(r.json()["compliance"]["state"], "expired")
        r = self.client.put("/construction/vendors/V-100/compliance", json={"wc_expires_on": ""})
        self.assertEqual(r.json()["compliance"]["state"], "ok")
        # The Subs tab reads the same row.
        self.assertEqual(self.client.get("/construction/projects/pa/subs").json()["subs"][0]["compliance"]["licenseNumber"], "C36-12345")
        # A vendor with no row yet: made on first save, Intacct checked.
        self.assertEqual(self.client.put("/construction/vendors/V-999/compliance", json={"w9_on_file": True}).status_code, 422)
        r = self.client.put("/construction/vendors/V-200/compliance", json={"w9_on_file": True})
        self.assertEqual(r.json()["compliance"]["vendorName"], "Bolt Electric")
        self.assertEqual(r.json()["compliance"]["state"], "missing")
        # The crew may not read the papers of a vendor either.
        self.as_(CREW)
        self.assertEqual(self.client.get("/construction/vendors/V-100/compliance").status_code, 403)

    def test_expiry_bells_the_managers_at_30_7_and_0_days_once_each(self):
        self.add()
        N = models.NexusNotification
        today = datetime.now(timezone.utc).date()
        in30 = (today + timedelta(days=30)).isoformat()
        self.as_(MGR_A)
        self.client.put("/construction/vendors/V-100/compliance", json={"coi_expires_on": in30, "license_expires_on": today.isoformat()})
        noon = datetime.combine(today, datetime.min.time(), tzinfo=timezone.utc).replace(hour=20)
        self.assertEqual(vc.expiry_tick(self.db, now=noon), 2)
        bells = self.db.query(N).filter(N.recipient == MGR_A).order_by(N.title).all()
        self.assertEqual([(b.title, b.ref_id) for b in bells],
                         [("Sub Papers Expired", "sub-papers:V-100:license_expires_on"),
                          ("Sub Papers Expiring", "sub-papers:V-100:coi_expires_on")])
        self.assertIn("Acme Plumbing's insurance certificate expires", bells[1].body)
        self.assertIn("Job A", bells[1].body)
        # Same day again: nothing new.
        self.assertEqual(vc.expiry_tick(self.db, now=noon), 0)
        self.assertEqual(self.db.query(N).filter(N.recipient == MGR_A).count(), 2)
        # 29 days out is quiet; 7 days out bells again.
        self.assertEqual(vc.expiry_tick(self.db, now=noon + timedelta(days=1)), 0)
        self.assertEqual(vc.expiry_tick(self.db, now=noon + timedelta(days=23)), 1)
        # Off the job: no bell for the lapse.
        link_id = self.client.get("/construction/projects/pa/subs").json()["subs"][0]["linkId"]
        self.client.post(f"/construction/sub-links/{link_id}/end")
        self.assertEqual(vc.expiry_tick(self.db, now=noon + timedelta(days=30)), 0)
