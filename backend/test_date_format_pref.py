"""Profile > Date Format (Pranshu, Oct 20 2026): a person picks the order they
read dates in; /roles/me hands it to the frontend (lib/datetime.js), the
US MM/DD/YYYY order until they pick, and only the four known formats save.

Runs against its own throwaway SQLite database:
    python -m pytest test_date_format_pref.py -q
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
from routers import roles  # noqa: E402

ME = {"email": "Dana.Fmt@greensglobal.com", "role": "employee", "level": 1}
OTHER = {"email": "other.fmt@greensglobal.com", "role": "employee", "level": 1}


class DateFormatPref(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        self.db.query(models.NexusPersonPref).delete()
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_default_then_saved_per_person(self):
        self.assertEqual(roles.get_my_role(user=ME, db=self.db)["date_format"], "MM/DD/YYYY")
        roles.save_my_date_format(roles.DateFormatIn(date_format="DD MMM YYYY"), user=ME, db=self.db)
        self.assertEqual(roles.get_my_role(user=ME, db=self.db)["date_format"], "DD MMM YYYY")
        self.assertEqual(roles.get_my_role(user=OTHER, db=self.db)["date_format"], "MM/DD/YYYY")
        roles.save_my_date_format(roles.DateFormatIn(date_format="YYYY-MM-DD"), user=ME, db=self.db)
        self.assertEqual(roles.get_my_role(user=ME, db=self.db)["date_format"], "YYYY-MM-DD")

    def test_unknown_format_refused(self):
        with self.assertRaises(HTTPException) as e:
            roles.save_my_date_format(roles.DateFormatIn(date_format="DD.MM.YYYY"), user=ME, db=self.db)
        self.assertEqual(e.exception.status_code, 422)
        self.assertEqual(self.db.query(models.NexusPersonPref).count(), 0)


if __name__ == "__main__":
    unittest.main()
