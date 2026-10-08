"""PFS file lock, affiliated entities and per-borrower executive profiles
(Charmi, 10/04) - the rules as tests.

The lock: every PFS file (a guarantor) answers 423 on every read, write and
export until the person opening it types a six-digit code emailed to them; the
code is hashed at rest, lives 10 minutes, takes 5 wrong tries, and opens that
one file in that one browser session for 30 minutes. The borrowers are told,
and every step is in the access log.

Runs on its own temporary database:

    python -m pytest test_pfs_access.py
"""
import os
import re
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_RATE_LIMIT", "off")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import accounting, pfs_access  # noqa: E402

OWNER = "owner.lock.test@greensglobal.com"
EDITOR = "editor.lock.test@greensglobal.com"
VIEWER = "viewer.lock.test@greensglobal.com"
OUTSIDER = "admin.lock.test@greensglobal.com"     # administrator, no pfs grant
BORROWER = "borrower.lock.test@example.com"
CO_BORROWER = "co.lock.test@example.com"
TAB_A = {"X-Pfs-Session": "tab-a"}
TAB_B = {"X-Pfs-Session": "tab-b"}


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


class LockTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        actual = database.engine.url.database or ""
        assert os.path.abspath(actual) == os.path.abspath(_tmp_db.name), actual
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        pfs_access.LOCK_ENABLED = True
        db = database.SessionLocal()
        try:
            for t in (models.PfsAccessChallenge, models.PfsAccessLog, models.PfsAffiliate, models.PfsProfileExtra,
                      models.PfsLine, models.PfsStatement, models.PfsProfile, models.NexusGroupMember, models.NexusGroup, models.NexusRole):
                db.query(t).delete()
            db.add(models.NexusGroup(id="grp-lock-ed", name="grp-lock-ed", allowed_modules="pfs:editor"))
            db.add(models.NexusGroupMember(group_id="grp-lock-ed", email=EDITOR))
            db.add(models.NexusGroup(id="grp-lock-vw", name="grp-lock-vw", allowed_modules="pfs:viewer"))
            db.add(models.NexusGroupMember(group_id="grp-lock-vw", email=VIEWER))
            db.add(models.NexusRole(email=OWNER, role="owner"))
            db.add(models.NexusRole(email=OUTSIDER, role="administrator"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        getattr(auth, "_role_cache", {}).clear()

        # Codes are captured here instead of mailed; the borrower notice too.
        self.codes = []
        self._deliver = pfs_access._deliver_code
        pfs_access._deliver_code = lambda to, code, name: self.codes.append((to, code, name))
        self._get = accounting._acct_get

        async def fake_get(path, params):
            return {"ok": True, "sections": [], "entities": [{"code": "60100", "name": "Business - ANK"}]}
        accounting._acct_get = fake_get

        _as(EDITOR)
        r = self.client.post("/pfs/profiles", headers=TAB_A, json={
            "name": "Rajesh Kadakia", "kind": "joint",
            "details": {"email": BORROWER, "coBorrower": {"name": "Darshana Kadakia", "email": CO_BORROWER}}})
        self.assertEqual(r.status_code, 201, r.text)
        self.pid = r.json()["id"]
        r = self.client.post("/pfs/profiles", headers=TAB_A, json={"name": "Second File", "kind": "individual"})
        self.other = r.json()["id"]

    def tearDown(self):
        pfs_access._deliver_code = self._deliver
        accounting._acct_get = self._get
        auth.SKIP_AUTH = self._skip

    def _code(self, pid=None, headers=TAB_B):
        r = self.client.post(f"/pfs-access/files/{pid or self.pid}/code", headers=headers)
        self.assertEqual(r.status_code, 200, r.text)
        return self.codes[-1][1]

    def _rows(self, model, **flt):
        db = database.SessionLocal()
        try:
            q = db.query(model)
            for k, v in flt.items():
                q = q.filter(getattr(model, k) == v)
            return q.all()
        finally:
            db.close()

    def _age(self, field, seconds):
        db = database.SessionLocal()
        try:
            for c in db.query(models.PfsAccessChallenge).filter(models.PfsAccessChallenge.profile_id == self.pid).all():
                setattr(c, field, (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat())
            db.commit()
        finally:
            db.close()

    # ── the lock ────────────────────────────────────────────────────────────
    def test_every_route_of_a_locked_file_answers_423(self):
        _as(VIEWER)
        for method, path in (("get", f"/pfs/profiles/{self.pid}"), ("get", f"/pfs/profiles/{self.pid}/statement?asof=2026-09-28"),
                             ("get", f"/pfs/profiles/{self.pid}/statements"), ("get", f"/pfs/profiles/{self.pid}/affiliates"),
                             ("get", f"/pfs/profiles/{self.pid}/executive-profiles")):
            r = getattr(self.client, method)(path, headers=TAB_B)
            self.assertEqual(r.status_code, 423, path)
            self.assertEqual(r.json()["detail"]["code"], "pfs_locked")
        r = self.client.post(f"/pfs/profiles/{self.pid}/statements", headers=TAB_B, json={"asof": "2026-09-28"})
        self.assertEqual(r.status_code, 423)
        # The list of files and the vocabulary are not a file: they stay open.
        self.assertEqual(self.client.get("/pfs/profiles", headers=TAB_B).status_code, 200)
        self.assertEqual(self.client.get("/pfs/meta", headers=TAB_B).status_code, 200)

    def test_the_creator_opens_a_new_file_without_a_code(self):
        _as(EDITOR)
        self.assertEqual(self.client.get(f"/pfs/profiles/{self.pid}", headers=TAB_A).status_code, 200)
        self.assertEqual(self.client.get(f"/pfs/profiles/{self.pid}", headers=TAB_B).status_code, 423)   # not in another tab

    def test_a_code_opens_that_file_in_that_session_only(self):
        _as(VIEWER)
        code = self._code()
        self.assertEqual(self.codes[-1][0], VIEWER)            # the code goes to the viewer, never the borrower
        r = self.client.post(f"/pfs-access/files/{self.pid}/verify", headers=TAB_B, json={"code": code})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.client.get(f"/pfs/profiles/{self.pid}", headers=TAB_B).status_code, 200)
        self.assertEqual(self.client.get(f"/pfs/profiles/{self.pid}/statement?asof=2026-09-28", headers=TAB_B).status_code, 200)
        self.assertEqual(self.client.get(f"/pfs/profiles/{self.other}", headers=TAB_B).status_code, 423)   # another file
        self.assertEqual(self.client.get(f"/pfs/profiles/{self.pid}", headers={"X-Pfs-Session": "tab-c"}).status_code, 423)
        _as(EDITOR)
        self.assertEqual(self.client.get(f"/pfs/profiles/{self.pid}", headers=TAB_B).status_code, 423)   # another person
        _as(VIEWER)
        status = self.client.get("/pfs-access/status", headers=TAB_B).json()
        self.assertIn(self.pid, status["unlocked"])
        self.assertNotIn(self.other, status["unlocked"])
        # Locking again closes it at once.
        self.assertEqual(self.client.post(f"/pfs-access/files/{self.pid}/lock", headers=TAB_B).status_code, 204)
        self.assertEqual(self.client.get(f"/pfs/profiles/{self.pid}", headers=TAB_B).status_code, 423)

    def test_a_code_for_one_file_does_not_open_another(self):
        _as(VIEWER)
        code = self._code()
        r = self.client.post(f"/pfs-access/files/{self.other}/verify", headers=TAB_B, json={"code": code})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.client.get(f"/pfs/profiles/{self.other}", headers=TAB_B).status_code, 423)

    def test_the_code_is_hashed_at_rest(self):
        _as(VIEWER)
        code = self._code()
        rows = self._rows(models.PfsAccessChallenge, profile_id=self.pid, email=VIEWER)
        self.assertEqual(len(rows), 1)
        for col in ("id", "session_hash", "code_hash", "target", "created_at", "expires_at"):
            self.assertNotEqual(getattr(rows[0], col), code)
        self.assertNotIn(code, rows[0].code_hash)
        self.assertTrue(re.fullmatch(r"[0-9a-f]{64}", rows[0].code_hash))
        self.assertTrue(re.fullmatch(r"\d{6}", code))

    def test_a_code_expires_after_ten_minutes(self):
        _as(VIEWER)
        code = self._code()
        self._age("expires_at", 1)
        r = self.client.post(f"/pfs-access/files/{self.pid}/verify", headers=TAB_B, json={"code": code})
        self.assertEqual(r.status_code, 400)
        self.assertIn("expired", r.json()["detail"])
        self.assertEqual(self.client.get(f"/pfs/profiles/{self.pid}", headers=TAB_B).status_code, 423)

    def test_five_wrong_codes_burn_it(self):
        _as(VIEWER)
        code = self._code()
        wrong = "000000" if code != "000000" else "111111"
        for i in range(5):
            r = self.client.post(f"/pfs-access/files/{self.pid}/verify", headers=TAB_B, json={"code": wrong})
            self.assertIn(r.status_code, (400, 429))
        r = self.client.post(f"/pfs-access/files/{self.pid}/verify", headers=TAB_B, json={"code": code})
        self.assertEqual(r.status_code, 429)       # even the right code, now
        self.assertEqual(self.client.get(f"/pfs/profiles/{self.pid}", headers=TAB_B).status_code, 423)
        self.assertEqual(len(self._rows(models.PfsAccessLog, profile_id=self.pid, action="failed")), 5)

    def test_a_new_code_voids_the_one_before_and_sending_is_limited(self):
        _as(VIEWER)
        first = self._code()
        r = self.client.post(f"/pfs-access/files/{self.pid}/code", headers=TAB_B)
        self.assertEqual(r.status_code, 429)        # one code per 30 seconds
        self._age("created_at", 60)
        second = self._code()
        if first != second:
            self.assertEqual(self.client.post(f"/pfs-access/files/{self.pid}/verify", headers=TAB_B, json={"code": first}).status_code, 400)
        self.assertEqual(self.client.post(f"/pfs-access/files/{self.pid}/verify", headers=TAB_B, json={"code": second}).status_code, 200)

    def test_the_unlock_lasts_thirty_minutes(self):
        _as(VIEWER)
        code = self._code()
        self.client.post(f"/pfs-access/files/{self.pid}/verify", headers=TAB_B, json={"code": code})
        self.assertEqual(self.client.get(f"/pfs/profiles/{self.pid}", headers=TAB_B).status_code, 200)
        self._age("granted_until", 1)
        self.assertEqual(self.client.get(f"/pfs/profiles/{self.pid}", headers=TAB_B).status_code, 423)

    def test_outsiders_get_no_code(self):
        _as(OUTSIDER)
        self.assertEqual(self.client.post(f"/pfs-access/files/{self.pid}/code", headers=TAB_B).status_code, 403)
        self.assertEqual(self.codes, [])

    # ── the log and the borrower notice ─────────────────────────────────────
    def test_every_step_is_logged_and_the_borrowers_are_told(self):
        _as(VIEWER)
        told = []
        self._send = pfs_access._send
        pfs_access._send = lambda to, subject, html: told.append((to, subject, html))
        configured = pfs_access.graph_mail.graph_configured
        pfs_access.graph_mail.graph_configured = lambda: True
        auth_skip = auth.SKIP_AUTH
        try:
            code = self._code()
            self.client.post(f"/pfs-access/files/{self.pid}/verify", headers=TAB_B, json={"code": "999999" if code != "999999" else "000000"})
            r = self.client.post(f"/pfs-access/files/{self.pid}/verify", headers=TAB_B, json={"code": code})
            self.assertEqual(r.status_code, 200)
            auth.SKIP_AUTH = False
            # The real send path (with NEXUS_SKIP_AUTH the notice is only printed).
            pfs_access.notify_borrowers(self.pid, VIEWER, r.json()["unlockedUntil"])
        finally:
            auth.SKIP_AUTH = auth_skip
            pfs_access._send = self._send
            pfs_access.graph_mail.graph_configured = configured
        self.assertTrue(told)
        to, subject, html = told[-1]
        self.assertEqual(sorted(to), sorted([BORROWER, CO_BORROWER]))
        self.assertIn("Your personal financial statement was accessed by", html)
        self.assertIn("Viewer", html)
        self.assertRegex(html, r"\d{2}/\d{2}/\d{4} at \d{1,2}:\d{2} (AM|PM)")
        self.client.get(f"/pfs/profiles/{self.pid}", headers=TAB_B)
        self.client.get(f"/pfs/profiles/{self.pid}", headers=TAB_B)          # viewed is logged once per 10 minutes
        self.client.post(f"/pfs/profiles/{self.pid}/statements", headers=TAB_B, json={"asof": "2026-09-28"})
        actions = [r.action for r in self._rows(models.PfsAccessLog, profile_id=self.pid, email=VIEWER)]
        for a in ("otp_sent", "failed", "unlocked", "viewed", "exported", "notified"):
            self.assertIn(a, actions)
        self.assertEqual(actions.count("viewed"), 1)
        # Only owners and editors read the log.
        self.assertEqual(self.client.get("/pfs-access/log").status_code, 403)
        _as(EDITOR)
        log = self.client.get(f"/pfs-access/log?profile_id={self.pid}").json()
        self.assertTrue(all(x["fileName"] == "Rajesh Kadakia" for x in log))
        self.assertIn("exported", [x["action"] for x in log])
        # Never a code, anywhere in the log.
        self.assertNotIn(code, str(log))

    def test_a_kept_statement_is_locked_with_its_file(self):
        _as(EDITOR)
        r = self.client.post(f"/pfs/profiles/{self.pid}/statements", headers=TAB_A, json={"asof": "2026-09-28"})
        self.assertEqual(r.status_code, 201, r.text)
        sid = r.json()["id"]
        self.assertEqual(self.client.get(f"/pfs/statements/{sid}", headers=TAB_A).status_code, 200)
        self.assertEqual(self.client.get(f"/pfs/statements/{sid}", headers=TAB_B).status_code, 423)

    def test_the_time_reads_the_us_way(self):
        s = pfs_access.us_datetime(datetime(2026, 10, 6, 21, 5, tzinfo=timezone.utc))
        self.assertRegex(s, r"^10/06/2026 at (2:05 PM PT|9:05 PM UTC)$")

    # ── affiliated entities and executive profiles ──────────────────────────
    def test_affiliated_entities(self):
        _as(EDITOR)
        h = TAB_A
        base = f"/pfs/profiles/{self.pid}/affiliates"
        self.assertEqual(self.client.get("/pfs/affiliates/meta", headers=h).json()["entityTypes"][0]["label"], "Single-Member LLC")
        got = self.client.get(base, headers=h).json()
        self.assertEqual([b["name"] for b in got["borrowers"]], ["Rajesh Kadakia", "Darshana Kadakia"])
        a = self.client.post(base, headers=h, json={"name": "Greens Storage LLC", "entityType": "multi_member_llc", "einLast4": "12-34",
                                                     "state": "CA", "ownership": {"primary": 50, "co": 50}, "beneficialPct": 100,
                                                     "role": "Managing Member", "ledgerEntity": "60100"})
        self.assertEqual(a.status_code, 201, a.text)
        self.assertEqual(a.json()["einLast4"], "1234")
        b = self.client.post(base, headers=h, json={"name": "Family Trust", "entityType": "trust", "role": "Trustee"}).json()
        # Never a full EIN; never more than 100%.
        self.assertEqual(self.client.post(base, headers=h, json={"name": "X", "einLast4": "12-3456789"}).status_code, 400)
        self.assertEqual(self.client.post(base, headers=h, json={"name": "X", "ownership": {"primary": 120}}).status_code, 400)
        r = self.client.put(f"{base}/{b['id']}", headers=h, json={"name": "Kadakia Family Trust", "entityType": "trust", "role": "Beneficiary", "beneficialPct": 25})
        self.assertEqual(r.json()["name"], "Kadakia Family Trust")
        r = self.client.put(f"/pfs/profiles/{self.pid}/affiliates-order", headers=h, json={"ids": [b["id"], a.json()["id"]]})
        self.assertEqual([x["name"] for x in r.json()["rows"]], ["Kadakia Family Trust", "Greens Storage LLC"])
        # The statement carries them, in that order.
        st = self.client.get(f"/pfs/profiles/{self.pid}/statement?asof=2026-09-28", headers=h).json()
        self.assertEqual([x["name"] for x in st["affiliated"]["rows"]], ["Kadakia Family Trust", "Greens Storage LLC"])
        self.assertEqual(st["affiliated"]["rows"][1]["entityTypeLabel"], "Multi-Member LLC")
        self.assertEqual(self.client.delete(f"{base}/{b['id']}", headers=h).status_code, 204)
        self.assertEqual(len(self.client.get(base, headers=h).json()["rows"]), 1)
        # A viewer reads but does not change.
        _as(VIEWER)
        code = self._code()
        self.client.post(f"/pfs-access/files/{self.pid}/verify", headers=TAB_B, json={"code": code})
        self.assertEqual(self.client.get(base, headers=TAB_B).status_code, 200)
        self.assertEqual(self.client.post(base, headers=TAB_B, json={"name": "Y"}).status_code, 403)

    def test_each_borrower_has_an_executive_profile(self):
        _as(EDITOR)
        h = TAB_A
        url = f"/pfs/profiles/{self.pid}/executive-profiles"
        self.client.put(url, headers=h, json={"key": "primary", "text": "Founder of Greens Global."})
        r = self.client.put(url, headers=h, json={"key": "co", "text": "Runs the family office."})
        self.assertEqual(r.status_code, 200, r.text)
        profiles = {p["key"]: p for p in r.json()["profiles"]}
        self.assertEqual(profiles["primary"]["text"], "Founder of Greens Global.")
        self.assertEqual(profiles["co"]["text"], "Runs the family office.")
        self.assertEqual(profiles["co"]["name"], "Darshana Kadakia")
        # The borrower's profile is the one the profile itself carries; the co-borrower's is separate.
        self.assertEqual(self.client.get(f"/pfs/profiles/{self.pid}", headers=h).json()["executiveProfile"], "Founder of Greens Global.")
        st = self.client.get(f"/pfs/profiles/{self.pid}/statement?asof=2026-09-28", headers=h).json()
        self.assertEqual([p["text"] for p in st["executiveProfiles"]], ["Founder of Greens Global.", "Runs the family office."])
        self.assertEqual(self.client.put(url, headers=h, json={"key": "third", "text": "x"}).status_code, 400)
        # Deleting the file takes them with it.
        _as(OWNER)
        code = self._code(headers=TAB_A)
        self.client.post(f"/pfs-access/files/{self.pid}/verify", headers=TAB_A, json={"code": code})
        self.assertEqual(self.client.delete(f"/pfs/profiles/{self.pid}", headers=TAB_A).status_code, 204)
        self.assertEqual(self._rows(models.PfsProfileExtra, profile_id=self.pid), [])
        self.assertTrue(self._rows(models.PfsAccessLog, profile_id=self.pid))   # the log stays


if __name__ == "__main__":
    unittest.main()
