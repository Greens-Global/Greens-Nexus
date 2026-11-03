"""Construction phase 2 - equipment on a job (Neil, 11/03/2026, plan
https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr).

Equipment on a job = ordinary Items checkouts with a construction-owned
link row (ConstructionJobLink kind 'checkout'); Items' tables and routes
are untouched. Pins:
  * only a checkout that is out (allocated / awaiting receipt) to one of
    the job's people can be put on it; candidates list exactly those;
  * a resend with the phone's id answers with the first link;
  * moving a checkout to another job ends the old link (history kept);
    taking it off ends the link, never deletes it;
  * walls and membership: another company is a 404, an outsider a 403.

Run: python -m pytest test_construction_jobs_items.py -q
"""
import os
import tempfile

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ.pop("ANTHROPIC_API_KEY", None)

import models               # noqa: E402
from construction_jobs_testkit import (A, CREW, CREW2, MGR_A, MGR_B, OUTSIDER, JobsBase, iso)  # noqa: E402


class Equipment(JobsBase):
    tmp_db = _tmp.name

    def setUp(self):
        super().setUp()
        for cid, who, st in (("co-1", CREW, "allocated"), ("co-2", CREW2, "pending"),
                             ("co-3", OUTSIDER, "allocated"), ("co-4", CREW2, "pending_receipt")):
            self.db.add(models.ItemCheckout(id=cid, item_id=f"i-{cid}", item_name=f"Laser Level {cid}",
                                            item_type="Tool", requested_by=who, requested_by_email=who,
                                            raised_by=who, status=st, created_at=iso()))
        self.db.add(self.job("pc", "Second Job", A, managers=[MGR_A], workers=[CREW]))
        self.db.commit()

    def test_candidates_are_what_the_jobs_people_hold(self):
        self.as_(CREW)
        out = self.client.get("/construction/projects/pa/equipment").json()
        self.assertEqual(sorted(c["checkoutId"] for c in out["candidates"]), ["co-1", "co-4"])
        self.assertEqual(out["equipment"], [])

    def test_link_resend_move_and_end(self):
        self.as_(CREW)
        r = self.client.post("/construction/projects/pa/equipment", json={"id": "lk-1", "checkout_id": "co-1"})
        self.assertEqual(r.status_code, 201, r.text)
        again = self.client.post("/construction/projects/pa/equipment", json={"id": "lk-1", "checkout_id": "co-1"})
        self.assertEqual(again.json()["linkId"], "lk-1")
        self.assertEqual(self.client.post("/construction/projects/pa/equipment",
                                          json={"checkout_id": "co-2"}).status_code, 422)   # not out yet
        self.assertEqual(self.client.post("/construction/projects/pa/equipment",
                                          json={"checkout_id": "co-3"}).status_code, 422)   # not the job's people
        out = self.client.get("/construction/projects/pa/equipment").json()
        self.assertEqual([e["checkoutId"] for e in out["equipment"]], ["co-1"])
        # Moved to the second job: the old link ends, the history stays.
        self.client.post("/construction/projects/pc/equipment", json={"id": "lk-2", "checkout_id": "co-1"})
        old = self.fresh(models.ConstructionJobLink, "lk-1")
        self.assertTrue(old.ended_at)
        self.assertEqual(self.client.get("/construction/projects/pa/equipment").json()["equipment"], [])
        self.assertEqual(self.client.post("/construction/equipment-links/lk-2/end").status_code, 200)
        self.assertTrue(self.fresh(models.ConstructionJobLink, "lk-2").ended_at)
        self.assertEqual(self.db.query(models.ConstructionJobLink).filter_by(kind="checkout").count(), 2)
        # Items' own rows are untouched.
        self.assertEqual(self.fresh(models.ItemCheckout, "co-1").status, "allocated")

    def test_walls_and_membership(self):
        self.as_(MGR_B)
        self.assertEqual(self.client.get("/construction/projects/pa/equipment").status_code, 404)
        self.assertEqual(self.client.post("/construction/projects/pa/equipment",
                                          json={"checkout_id": "co-1"}).status_code, 404)
        self.as_(OUTSIDER)
        self.assertEqual(self.client.post("/construction/projects/pa/equipment",
                                          json={"checkout_id": "co-1"}).status_code, 403)


if __name__ == "__main__":
    import unittest
    unittest.main()
