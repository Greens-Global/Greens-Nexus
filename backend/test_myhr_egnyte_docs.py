"""My HR -> Documents (Egnyte) listing: the subfolders are listed side by side
and in Egnyte's order, a subfolder that fails to list is skipped rather than
failing the whole page, and the per-person cache (cache.myhr_egnyte_docs)
serves repeat visits without touching Egnyte again (Sep 29: the walk took
~19 s on dev for every My HR visit).

Run alone: python -m unittest test_myhr_egnyte_docs
"""
import os
import threading
import time
import unittest
from unittest import mock

os.environ.setdefault("DATABASE_URL", "sqlite:///./_test_myhr_egnyte_docs.db")
os.environ["NEXUS_SKIP_AUTH"] = "true"

import cache                                   # noqa: E402
import egnyte_wiring as wiring                 # noqa: E402
from services import egnyte as svc             # noqa: E402


class ListPersonDocumentGroups(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.lock = threading.Lock()

    def _fake_list(self, path, token=None):
        with self.lock:
            self.calls.append(path)
        if path.endswith("/Person"):
            return {"folders": [{"name": "Contractor Documents"}, {"name": "Confidential"}, {"name": "Broken"}, {"name": "Payroll"}],
                    "files": [{"name": "offer.pdf", "path": path + "/offer.pdf", "size": 1}]}
        if path.endswith("/Broken"):
            raise svc.EgnyteError("nope")
        time.sleep(0.15)   # a slow Egnyte round trip
        return {"folders": [], "files": [{"name": path.rsplit("/", 1)[-1] + ".pdf", "path": path + "/x.pdf", "size": 2}]}

    def test_subfolders_listed_in_parallel_in_egnyte_order_skipping_failures(self):
        with mock.patch.object(svc, "list_folder", side_effect=self._fake_list), \
             mock.patch.object(wiring, "is_excluded_child", side_effect=lambda n: n == "Confidential"):
            t0 = time.monotonic()
            got = wiring.list_person_document_groups("/Shared/HR/Person")
            took = time.monotonic() - t0
        self.assertEqual([f["name"] for f in got["folders"]], ["Contractor Documents", "Payroll"])
        self.assertEqual(got["rootFiles"][0]["name"], "offer.pdf")
        self.assertEqual(got["folders"][1]["files"][0]["name"], "Payroll.pdf")
        # two slow listings of 0.15 s each ran side by side, not one after another
        self.assertLess(took, 0.28, f"subfolder listings ran serially ({took:.2f}s)")
        self.assertNotIn("/Shared/HR/Person/Confidential", self.calls)


class MyEgnyteDocumentsCache(unittest.TestCase):
    def setUp(self):
        cache.myhr_egnyte_docs.invalidate()

    def test_second_visit_is_served_from_cache(self):
        from routers import myhr
        loads = []

        def resolve(slot, emp, db):
            loads.append(slot)
            return {"folder": "/Shared/HR/Person", "source": "template", "proposed": ""}

        with mock.patch.object(svc, "configured", return_value=True), \
             mock.patch.object(myhr, "_me", return_value=object()), \
             mock.patch.object(wiring, "resolve_person_folder", side_effect=resolve), \
             mock.patch.object(wiring, "list_person_document_groups", return_value={"rootFiles": [], "folders": []}):
            first = myhr.my_egnyte_documents(user={"email": "Sam@Example.com"}, db=None)
            second = myhr.my_egnyte_documents(user={"email": "sam@example.com"}, db=None)
        self.assertTrue(first["available"])
        self.assertEqual(first, second)
        self.assertEqual(len(loads), 1, "the second visit walked Egnyte again")

    def test_no_folder_yet_is_cached_too(self):
        from routers import myhr
        with mock.patch.object(svc, "configured", return_value=True), \
             mock.patch.object(myhr, "_me", return_value=object()), \
             mock.patch.object(wiring, "resolve_person_folder", return_value={"folder": None}) as res:
            for _ in range(3):
                got = myhr.my_egnyte_documents(user={"email": "new@example.com"}, db=None)
        self.assertEqual(got, {"available": False})
        self.assertEqual(res.call_count, 1)


if __name__ == "__main__":
    unittest.main()
