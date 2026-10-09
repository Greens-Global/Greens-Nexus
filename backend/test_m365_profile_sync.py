"""
Microsoft 365 contact info, both ways (Neil, Oct 7).

Three-way merge per field against the value Microsoft 365 last had: a change
made in M365 comes into Nexus, a change made in Nexus goes out, and when both
changed Nexus wins. First sync fills empty Nexus fields and pushes filled ones.
A job title's level marker stays in Nexus. An emptied field clears in M365.

Uses a throwaway sqlite file.

    python -m unittest test_m365_profile_sync
"""
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database  # noqa: E402
import m365_profile_sync as sync  # noqa: E402


def _emp(**kw):
    base = dict(id="e1", work_email="a@x.com", m365_id="g1", phone="", office_phone="", location="",
                street_address="", city="", state="", postal_code="", country="", job_title="",
                department="", m365_sync={})
    base.update(kw)
    return SimpleNamespace(**base)


def _graph(**kw):
    g = {"id": "g1", "mobilePhone": None, "businessPhones": [], "officeLocation": None, "streetAddress": None,
         "city": None, "state": None, "postalCode": None, "country": None, "jobTitle": None, "department": None}
    g.update(kw)
    return g


class _Resp:
    is_success = True
    status_code = 204
    text = ""


class MergeTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def test_first_sync_fills_empty_and_pushes_filled(self):
        e = _emp(city="San Clemente")
        pulled, push = sync.merge(e, _graph(officeLocation="India", city="Pune", country="India"))
        self.assertEqual(e.location, "India")
        self.assertEqual(e.country, "IN")               # the name comes in as the code
        self.assertEqual(e.city, "San Clemente")         # Nexus had a value - it wins
        self.assertEqual(set(pulled), {"location", "country"})
        self.assertEqual(push, {"city"})

    def test_change_in_m365_comes_in(self):
        e = _emp(location="San Clemente", m365_sync={"base": {"location": "San Clemente"}})
        pulled, push = sync.merge(e, _graph(officeLocation="India"))
        self.assertEqual(e.location, "India")
        self.assertEqual(pulled, {"location": ("San Clemente", "India")})
        self.assertNotIn("location", push)
        self.assertEqual(e.m365_sync["base"]["location"], "India")

    def test_change_in_nexus_goes_out_and_wins_a_conflict(self):
        e = _emp(phone="555-0100", m365_sync={"base": {"phone": "555-0000"}})
        pulled, push = sync.merge(e, _graph(mobilePhone="555-0999"))   # both moved
        self.assertEqual(e.phone, "555-0100")
        self.assertIn("phone", push)
        self.assertNotIn("phone", pulled)

    def test_level_marker_is_not_a_difference(self):
        e = _emp(job_title="Site Manager II", m365_sync={"base": {"job_title": "Site Manager"}})
        pulled, push = sync.merge(e, _graph(jobTitle="Site Manager"))
        self.assertEqual(e.job_title, "Site Manager II")
        self.assertEqual((pulled, push - {"job_title"}), ({}, set()))
        self.assertNotIn("job_title", push)

    def test_push_clears_an_emptied_field_and_sets_the_base(self):
        e = _emp(office_phone="", country="IN", m365_sync={"base": {"office_phone": "949-555-0101"}})
        with mock.patch.object(sync.httpx, "patch", return_value=_Resp()) as patch:
            sync.push("tok", e, ["office_phone", "country"])
        body = patch.call_args.kwargs["json"]
        self.assertEqual(body, {"businessPhones": [], "country": "India"})
        self.assertEqual(e.m365_sync["base"]["office_phone"], "")
        self.assertEqual(e.m365_sync["base"]["country"], "IN")


if __name__ == "__main__":
    unittest.main()
