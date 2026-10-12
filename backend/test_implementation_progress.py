"""
Implementation Guide progress (Neil, Oct 6): one shared done-list for every
administrator, stamped with who ticked each check and when. Unticking removes
it; an id that is not a plain slug is refused.

Uses a throwaway sqlite file.

    python -m unittest test_implementation_progress
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402
from routers.implementation import CheckIn, get_progress, set_check  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

A = {"email": "admin.a@greensglobal.com", "level": 4}
B = {"email": "admin.b@greensglobal.com", "level": 4}


class ImplementationProgressTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        self.db.query(models.NexusSetting).delete()
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_shared_ticks_with_who(self):
        set_check("company.holidays", CheckIn(done=True), user=A, db=self.db)
        set_check("roles.teams", CheckIn(done=True), user=B, db=self.db)
        done = get_progress(user=B, db=self.db)["done"]
        self.assertEqual(done["company.holidays"]["by"], A["email"])
        self.assertEqual(done["roles.teams"]["by"], B["email"])
        set_check("company.holidays", CheckIn(done=False), user=B, db=self.db)
        self.assertNotIn("company.holidays", get_progress(user=A, db=self.db)["done"])

    def test_rejects_odd_ids(self):
        for bad in ("", "../x", "Has Spaces", "x" * 90):
            with self.assertRaises(HTTPException):
                set_check(bad, CheckIn(done=True), user=A, db=self.db)


if __name__ == "__main__":
    unittest.main()
