"""Filing & Sorting maps cache is shared through the database (Nov 4 2026).

Every cold API worker used to re-list the three index folders before its
real work, in a burst that tripped Egnyte's per-user throttle. The maps now
live in nexus_settings for every worker; only a complete rebuild is shared.

Run alone: python -m pytest test_filing_maps_cache.py
"""
import os
import tempfile
import unittest
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402
from routers import filing  # noqa: E402


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} writes rows and is pointed at {actual!r}. Run it on its own.")


_assert_isolated()

LISTINGS = {
    "/Shared/#Entities": {"folders": [{"name": "Greens Escondido, LLC", "path": "/Shared/#Entities/Greens Escondido, LLC"},
                                      {"name": "#Unsorted", "path": "/Shared/#Entities/#Unsorted"}], "files": []},
    "/Shared/--Operations": {"folders": [{"name": "04 - Escondido", "path": "/Shared/--Operations/04 - Escondido"}], "files": []},
    "/Shared/--Development/Projects": {"folders": [{"name": "Menifee", "path": "/Shared/--Development/Projects/Menifee"}], "files": []},
}


class MapsCacheTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except FileNotFoundError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        self.db.query(models.NexusSetting).filter(models.NexusSetting.key == filing._MAPS_KEY).delete()
        self.db.commit()
        filing._maps_cache.update({"at": 0.0, "maps": None})
        self.calls = []

    def tearDown(self):
        self.db.close()

    def _fake(self, fail_path=None):
        def fake_egnyte(token, fn, path):
            self.calls.append(path)
            if path == fail_path:
                raise HTTPException(403, "no access")
            return LISTINGS[path]
        return fake_egnyte

    def test_a_cold_worker_reads_the_shared_copy_instead_of_egnyte(self):
        with mock.patch.object(filing, "_egnyte", self._fake()):
            first = filing._live_maps("tok", self.db)
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(first.entities, ["Greens Escondido, LLC"])   # # folders left out
        self.assertEqual(first.facilities, {"Escondido": "/Shared/--Operations/04 - Escondido"})

        # Another worker: its own in-process cache is empty.
        filing._maps_cache.update({"at": 0.0, "maps": None})
        with mock.patch.object(filing, "_egnyte", self._fake()):
            second = filing._live_maps("tok", self.db)
        self.assertEqual(len(self.calls), 3)          # no new Egnyte calls
        self.assertEqual(second.projects, {"Menifee": "/Shared/--Development/Projects/Menifee"})

    def test_an_incomplete_rebuild_is_not_shared(self):
        with mock.patch.object(filing, "_egnyte", self._fake(fail_path="/Shared/--Operations")):
            filing._live_maps("tok", self.db)
        row = self.db.query(models.NexusSetting).filter(models.NexusSetting.key == filing._MAPS_KEY).first()
        self.assertIsNone(row)

    def test_a_stale_shared_copy_is_rebuilt(self):
        with mock.patch.object(filing, "_egnyte", self._fake()):
            filing._live_maps("tok", self.db)
        filing._maps_cache.update({"at": 0.0, "maps": None})
        with mock.patch.object(filing, "_egnyte", self._fake()), \
                mock.patch("time.time", return_value=10 ** 12):
            filing._live_maps("tok", self.db)
        self.assertEqual(len(self.calls), 6)


if __name__ == "__main__":
    unittest.main()
