"""Filing & Sorting apply: renames in place and collisions (Nov 4 2026).

A rename that only changes letter case must not collide with the file
itself, a renamed file frees its old name for the rest of the batch, and a
real collision is still refused - never an overwrite. Egnyte is mocked.

Run alone: python -m pytest test_filing_apply.py
"""
import os
import tempfile
import unittest
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database  # noqa: E402
import models  # noqa: E402
from routers import filing  # noqa: E402
from services import egnyte as svc  # noqa: E402


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} writes rows and is pointed at {actual!r}. Run it on its own.")


_assert_isolated()

FOLDER = "/Shared/#Unsorted"
USER = {"email": "tester@greensglobal.com", "level": 3, "role": "manager"}


class ApplyTests(unittest.TestCase):
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
        self.moved = []

    def tearDown(self):
        self.db.close()

    def _run(self, moves, files):
        def fake_egnyte(token, fn, *args):
            if fn is svc.list_folder:
                return {"files": [{"name": n} for n in files], "folders": []}
            if fn is svc.move_item:
                self.moved.append(args)
                return {"path": args[1]}
            raise AssertionError(f"unexpected call {fn}")

        body = filing.ApplyBody(moves=[filing.MoveBody(**m) for m in moves])
        request = mock.MagicMock()
        with mock.patch.object(filing, "_egnyte", fake_egnyte), \
                mock.patch.object(filing, "_browse_token", lambda user, db: None), \
                mock.patch.object(filing, "client_ip", lambda request: "127.0.0.1"):
            return filing.apply(body, request, user=USER, db=self.db)

    def test_case_only_rename_in_place_is_not_a_collision(self):
        out = self._run([{"sourcePath": f"{FOLDER}/Plan.PDF", "destFolder": FOLDER, "newName": "Plan.pdf"}],
                        files=["Plan.PDF"])
        self.assertEqual(out["moved"], 1, out["results"])
        self.assertEqual(self.moved, [(f"{FOLDER}/Plan.PDF", f"{FOLDER}/Plan.pdf")])

    def test_a_renamed_file_frees_its_old_name_in_the_same_batch(self):
        out = self._run([
            {"sourcePath": f"{FOLDER}/A.pdf", "destFolder": FOLDER, "newName": "2020-01-01 - A.pdf"},
            {"sourcePath": f"{FOLDER}/B.pdf", "destFolder": FOLDER, "newName": "A.pdf"},
        ], files=["A.pdf", "B.pdf"])
        self.assertEqual(out["moved"], 2, out["results"])

    def test_a_real_collision_is_refused_never_overwritten(self):
        out = self._run([{"sourcePath": f"{FOLDER}/B.pdf", "destFolder": FOLDER, "newName": "A.pdf"}],
                        files=["A.pdf", "B.pdf"])
        self.assertEqual(out["moved"], 0)
        self.assertIn("already there", out["results"][0]["error"])
        self.assertEqual(self.moved, [])

    def test_every_move_is_audited_with_from_and_to(self):
        self._run([{"sourcePath": f"{FOLDER}/C.pdf", "destFolder": FOLDER, "newName": "2020-01-01 - C.pdf"}],
                  files=["C.pdf"])
        row = (self.db.query(models.AuditLog).filter(models.AuditLog.resource_type == "filing")
               .order_by(models.AuditLog.id.desc()).first())
        self.assertIsNotNone(row)
        self.assertIn(f"{FOLDER}/C.pdf", row.details)
        self.assertIn("2020-01-01 - C.pdf", row.details)


if __name__ == "__main__":
    unittest.main()
