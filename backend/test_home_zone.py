"""Home time zone on /roles/me (Neil, 11/13/2026: "If we are out of our main
time zone it should show the original time zone we are from as a secondary
time zone"). The Dashboard clock shows `home_zone` beside the device's own
time whenever the two differ; it is the zone the person works in - their
shift preset's zone, else their company's / the tenant's team zone, else
California (item_due.zone_for, the one reading).

Runs against its own throwaway SQLite database:
    python -m pytest test_home_zone.py -q
"""
import json
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database  # noqa: E402
import models  # noqa: E402
from routers import roles  # noqa: E402

ME = {"email": "dana.zone@greensglobal.com", "role": "employee", "level": 1}


class HomeZone(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        self.db.query(models.NexusSetting).delete()
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_california_when_nothing_says_otherwise(self):
        self.assertEqual(roles.get_my_role(user=ME, db=self.db)["home_zone"], "America/Los_Angeles")

    def test_the_team_zone_when_one_is_saved(self):
        self.db.add(models.NexusSetting(key="shift_requests_config", value=json.dumps({"timeZone": "Asia/Kolkata"})))
        self.db.commit()
        self.assertEqual(roles.get_my_role(user=ME, db=self.db)["home_zone"], "Asia/Kolkata")

    def test_externals_get_one_too(self):
        out = roles.get_my_role(user={**ME, "external": True}, db=self.db)
        self.assertEqual(out["home_zone"], "America/Los_Angeles")


if __name__ == "__main__":
    unittest.main()
