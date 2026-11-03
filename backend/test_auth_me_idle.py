"""GET /auth/me says how many idle days a session lives (field offline, Neil
11/03/2026): the phone stores it with the remembered sign-in and refuses to
open offline once the session must have expired (frontend/src/bffAuth.js).

Run alone (one file per process): python -m pytest test_auth_me_idle.py
"""
import os
import tempfile
import unittest

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ.setdefault("NEXUS_DEV_EMAIL", "crew@greensglobal.com")

import atexit  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


class AuthMeIdleDays(unittest.TestCase):
    def test_me_carries_the_session_idle_days(self):
        r = TestClient(main.app).get("/auth/me")
        self.assertEqual(r.status_code, 200, r.text)
        days = r.json()["sessionIdleDays"]
        self.assertIsInstance(days, int)
        self.assertTrue(1 <= days <= 30)


if __name__ == "__main__":
    unittest.main()
