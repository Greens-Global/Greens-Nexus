"""Construction phase 2 - finding jobs (Neil, 11/03/2026, plan
https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr).

Pins:
  * the header search's Jobs group: name / code / address / phase, prefix
    matches first, only jobs the caller may read (the company wall, the
    job's own lists), nothing under two characters;
  * a property's Jobs panel (Asset Management, read only): its open and
    recent jobs the caller may read; a private property they may not see is
    a 404; another company's job never shows.

Run: python -m pytest test_construction_jobs_search.py -q
"""
import os
import tempfile

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ.pop("ANTHROPIC_API_KEY", None)

import models               # noqa: E402
from construction_jobs_testkit import (A, ADMIN, B, CREW, MGR_A, MGR_B, OUTSIDER, JobsBase)  # noqa: E402


class Search(JobsBase):
    tmp_db = _tmp.name

    def setUp(self):
        super().setUp()
        self.db.add(self.job("pc", "Gate Repair East", A, managers=[MGR_A], code="WO-77", address="12 Gate Rd"))
        self.db.add(self.job("pd", "Big Gate Build", B, managers=[MGR_B]))
        self.db.add(models.PropertyAsset(id="prop-1", payload={"name": "Escondido Yard", "asset_kind": "property"}))
        self.db.add(models.PropertyAsset(id="prop-priv", payload={"name": "Owner House", "asset_kind": "property",
                                                                  "private": True}))
        self.db.add(self.job("pe", "Yard Paving", A, managers=[MGR_A], property_id="prop-1"))
        self.db.add(self.job("pf", "Old Fence", A, managers=[MGR_A], property_id="prop-1", status="complete"))
        self.db.add(self.job("pg", "Other Company Yard Job", B, managers=[MGR_B], property_id="prop-1"))
        self.db.commit()

    def test_jobs_search_is_walled_and_ranks_prefix_first(self):
        self.as_(MGR_A)
        out = self.client.get("/construction/search", params={"q": "gate"}).json()
        self.assertEqual([j["id"] for j in out["jobs"]], ["pc"])
        self.assertEqual(self.client.get("/construction/search", params={"q": "wo-77"}).json()["jobs"][0]["id"], "pc")
        self.assertEqual(self.client.get("/construction/search", params={"q": "g"}).json()["jobs"], [])
        self.as_(MGR_B)
        self.assertEqual([j["id"] for j in self.client.get("/construction/search", params={"q": "gate"}).json()["jobs"]],
                         ["pd"])
        self.as_(CREW)    # on Job A only
        self.assertEqual([j["id"] for j in self.client.get("/construction/search", params={"q": "job"}).json()["jobs"]],
                         ["pa"])
        self.as_(OUTSIDER)
        self.assertEqual(self.client.get("/construction/search", params={"q": "job"}).json()["jobs"], [])

    def test_a_propertys_jobs_panel(self):
        self.as_(MGR_A)
        out = self.client.get("/construction/properties/prop-1/jobs").json()
        self.assertEqual([j["id"] for j in out["open"]], ["pe"])
        self.assertEqual([j["id"] for j in out["recent"]], ["pf"])
        self.assertNotIn("contractValue", out["open"][0])
        self.assertEqual(self.client.get("/construction/properties/prop-priv/jobs").status_code, 404)
        # Asset Management scope rows narrow it: scoped to another property, a 404.
        self.db.add(models.NexusAccessScope(id="sc-1", email=MGR_A, module_id="property-asset",
                                            scope_type="property", scope_id="prop-other", created_at=""))
        self.db.commit()
        self.assertEqual(self.client.get("/construction/properties/prop-1/jobs").status_code, 404)
        self.db.query(models.NexusAccessScope).delete()
        self.db.commit()
        self.as_(ADMIN)    # a Super Administrator sees the private property and every company
        self.assertEqual(self.client.get("/construction/properties/prop-priv/jobs").status_code, 200)
        ids = sorted(j["id"] for j in self.client.get("/construction/properties/prop-1/jobs").json()["open"])
        self.assertEqual(ids, ["pe", "pg"])


if __name__ == "__main__":
    import unittest
    unittest.main()
