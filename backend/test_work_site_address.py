"""Work sites set by address, not a map pin (Pranshu, Sep 30).

A site's coordinates count as verified only when they came from an address the
person searched and picked. Any other change to the coordinates clears it, so
the "Verify Address" badge never vouches for a point nobody checked.

    python -m unittest test_work_site_address
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database                                                              # noqa: E402
import models                                                                # noqa: E402
from routers.hr import (WorkSiteIn, WorkSiteUpdate, create_work_site,        # noqa: E402
                        update_work_site)

models.Base.metadata.create_all(bind=database.engine)

ADMIN = {"email": "hr.admin@greensglobal.com", "level": 5}


def call(fn, *a, **kw):
    db = database.SessionLocal()
    try:
        return fn(*a, user=ADMIN, db=db, **kw)
    finally:
        db.close()


class WorkSiteAddressTest(unittest.TestCase):
    def test_a_picked_address_verifies_the_site(self):
        s = call(create_work_site, WorkSiteIn(name="GS Temecula", address="40940 County Center Dr, Temecula, CA",
                                              latitude="33.518600", longitude="-117.155000", address_verified=True))
        self.assertTrue(s["addressVerifiedAt"])
        self.assertEqual(s["addressVerifiedBy"], ADMIN["email"])

    def test_a_site_without_a_picked_address_is_not_verified(self):
        s = call(create_work_site, WorkSiteIn(name="Old pin", latitude="33.7", longitude="-117.2"))
        self.assertEqual(s["addressVerifiedAt"], "")

    def test_verifying_an_old_pin_site_later(self):
        s = call(create_work_site, WorkSiteIn(name="Menifee", latitude="33.70", longitude="-117.20"))
        s = call(update_work_site, s["id"], WorkSiteUpdate(address="29844 Haun Rd, Menifee, CA", latitude="33.681000",
                                                           longitude="-117.188000", address_verified=True))
        self.assertTrue(s["addressVerifiedAt"])

    def test_coordinates_changed_any_other_way_clear_it(self):
        s = call(create_work_site, WorkSiteIn(name="Escondido", latitude="33.17015", longitude="-117.106812", address_verified=True))
        s = call(update_work_site, s["id"], WorkSiteUpdate(latitude="33.2", longitude="-117.2"))
        self.assertEqual(s["addressVerifiedAt"], "")

    def test_editing_name_or_radius_keeps_it(self):
        s = call(create_work_site, WorkSiteIn(name="Fairfield", latitude="38.25", longitude="-122.04", address_verified=True))
        s = call(update_work_site, s["id"], WorkSiteUpdate(name="GS Fairfield", radius_m=200, address_verified=False))
        self.assertTrue(s["addressVerifiedAt"])


if __name__ == "__main__":
    unittest.main()
