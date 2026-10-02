"""Out-of-fence bells and emails read distances in US units (Oct 2).

    python -m unittest test_us_distance
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database  # noqa: E402
from routers.timeclock import _us_distance  # noqa: E402


class UsDistanceTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def test_miles_from_a_tenth_of_a_mile(self):
        self.assertEqual(_us_distance(3800), "2.4 mi")     # the "3.8 km from GS Temecula" punch
        self.assertEqual(_us_distance(25000), "16 mi")

    def test_feet_below_a_tenth_of_a_mile(self):
        self.assertEqual(_us_distance(78), "256 ft")
        self.assertEqual(_us_distance(0), "0 ft")
        self.assertEqual(_us_distance(None), "0 ft")


if __name__ == "__main__":
    unittest.main()
