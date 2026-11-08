"""Links features (11/08/2026): Request a Link (bells to every links admin,
Add / Decline), the click stamp, the weekly health pass with its two-miss
rule, and the address guard it fetches under. ONE FILE PER PROCESS.

    python -m pytest test_links_features.py
"""
import os
import socket
import unittest
from unittest import mock

import _testdb  # noqa: F401 - a throwaway SQLite, never greens_nexus.db; keep first

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import links_health  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import external_links as el  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

ADMIN = {"email": "admin@greensglobal.com", "role": "owner", "level": 5, "name": "Ada Admin"}
EMP = {"email": "eve@greensglobal.com", "role": "employee", "level": 1, "name": "Eve Employee"}


class _Base(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        db = database.SessionLocal()
        try:
            for t in (models.ExternalLink, models.ExternalLinkRequest, models.NexusNotification, models.NexusRole,
                      models.NexusGroup, models.NexusGroupMember, models.NexusSetting):
                db.query(t).delete()
            db.add(models.NexusRole(email="mgr@greensglobal.com", role="manager"))
            db.add(models.NexusRole(email="eve@greensglobal.com", role="employee"))
            db.add(models.NexusGroup(id="g-links", name="Links Editors", allowed_modules="external-links:editor"))
            db.add(models.NexusGroupMember(group_id="g-links", email="ed@greensglobal.com"))
            db.add(models.ExternalLink(id=1, name="Outlook", url="https://outlook.example.com", category="Productivity"))
            db.commit()
        finally:
            db.close()

    def tearDown(self):
        main.app.dependency_overrides.pop(auth.get_current_user, None)

    def _as(self, user):
        main.app.dependency_overrides[auth.get_current_user] = lambda: dict(user)


class RequestALinkTests(_Base):
    def test_anyone_asks_every_admin_is_belled_once_then_add_or_decline(self):
        self._as(EMP)
        r = self.client.post("/external-links/requests", json={"name": "Ramp", "url": "app.ramp.com", "note": "Expenses"})
        self.assertEqual(r.status_code, 201, r.text)
        req = r.json()
        self.assertEqual(req["url"], "https://app.ramp.com")
        db = database.SessionLocal()
        try:
            bells = db.query(models.NexusNotification).filter_by(type="link_request").all()
            self.assertEqual(sorted(b.recipient for b in bells), ["ed@greensglobal.com", "mgr@greensglobal.com"])
            self.assertTrue(all(b.recipient for b in bells))   # never a broadcast
            self.assertIn("Eve Employee", bells[0].body)
        finally:
            db.close()
        # An employee cannot read or decide the list.
        self.assertEqual(self.client.get("/external-links/requests").status_code, 401)
        self._as(ADMIN)
        self.assertEqual([x["id"] for x in self.client.get("/external-links/requests").json()], [req["id"]])
        r = self.client.patch(f"/external-links/requests/{req['id']}", json={"link_id": 1})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "added")
        self.assertEqual(r.json()["link_id"], 1)
        self.assertEqual(self.client.get("/external-links/requests").json(), [])
        # Decided once: a second decision is refused.
        self.assertEqual(self.client.post(f"/external-links/requests/{req['id']}/decline").status_code, 409)

    def test_decline(self):
        self._as(EMP)
        req = self.client.post("/external-links/requests", json={"name": "X", "url": "https://x.example.com"}).json()
        self._as(ADMIN)
        r = self.client.post(f"/external-links/requests/{req['id']}/decline")
        self.assertEqual(r.json()["status"], "declined")
        self.assertEqual(r.json()["decided_by"], ADMIN["email"])

    def test_blank_is_refused(self):
        self._as(EMP)
        self.assertEqual(self.client.post("/external-links/requests", json={"name": " ", "url": ""}).status_code, 400)


class ClickStampTests(_Base):
    def test_click_counts_and_stamps_last_opened(self):
        self._as(EMP)
        r = self.client.patch("/external-links/1/click")
        self.assertEqual(r.json()["clicks"], 1)
        self.assertTrue(r.json()["last_opened_at"].startswith("20"))


def _addr(ip):
    return [(socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0))]


class AddressGuardTests(unittest.TestCase):
    """The table the pass and Check Now refuse before any request is sent."""
    TABLE = {
        "http://localhost/": "127.0.0.1",
        "http://127.0.0.1:8000/": "127.0.0.1",
        "http://10.0.0.5/": "10.0.0.5",
        "http://192.168.1.1/": "192.168.1.1",
        "http://172.16.4.4/": "172.16.4.4",
        "http://169.254.169.254/latest/meta-data/": "169.254.169.254",
        "http://100.64.0.1/": "100.64.0.1",
        "http://[::1]/": "::1",
        "http://[fe80::1]/": "fe80::1",
        "http://[fd00::1]/": "fd00::1",
        "http://mapped.example/": "::ffff:10.0.0.1",
    }

    def test_private_and_special_hosts_are_refused(self):
        for url, ip in self.TABLE.items():
            with mock.patch.object(socket, "getaddrinfo", return_value=_addr(ip)):
                self.assertTrue(links_health.refused_reason(url), url)
                self.assertFalse(links_health.reachable(url), url)

    def test_non_http_and_junk_are_refused_without_resolving(self):
        with mock.patch.object(socket, "getaddrinfo", side_effect=AssertionError("must not resolve")):
            for url in ("ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)", "", "not a url"):
                self.assertTrue(links_health.refused_reason(url), url)

    def test_public_host_is_allowed(self):
        with mock.patch.object(socket, "getaddrinfo", return_value=_addr("93.184.216.34")):
            self.assertEqual(links_health.refused_reason("https://example.com/"), "")

    def test_unresolvable_host_is_refused(self):
        with mock.patch.object(socket, "getaddrinfo", side_effect=socket.gaierror):
            self.assertTrue(links_health.refused_reason("https://nope.invalid/"))


class WeeklyPassTests(_Base):
    def _run(self, answers):
        db = database.SessionLocal()
        try:
            out = links_health.run_weekly(db, fetch=lambda url: answers[url])
            return out, {l.name: l.unreachable_since for l in db.query(models.ExternalLink).all()}
        finally:
            db.close()

    def test_two_misses_in_a_row_mark_a_link_and_one_answer_clears_it(self):
        db = database.SessionLocal()
        db.add(models.ExternalLink(id=2, name="Down", url="https://down.example.com", category="X"))
        db.commit(); db.close()
        out, since = self._run({"https://outlook.example.com": True, "https://down.example.com": False})
        self.assertEqual((out["marked"], out["pending"]), (0, 1))
        self.assertEqual(since["Down"], "")                      # one miss is not a mark
        out, since = self._run({"https://outlook.example.com": True, "https://down.example.com": False})
        self.assertEqual(out["marked"], 1)
        self.assertTrue(since["Down"])
        out, since = self._run({"https://outlook.example.com": True, "https://down.example.com": True})
        self.assertEqual(out["cleared"], 1)
        self.assertEqual(since["Down"], "")

    def test_a_miss_then_an_answer_resets_the_strike(self):
        out, _ = self._run({"https://outlook.example.com": False})
        self.assertEqual(out["pending"], 1)
        out, _ = self._run({"https://outlook.example.com": True})
        self.assertEqual(out["pending"], 0)
        out, since = self._run({"https://outlook.example.com": False})
        self.assertEqual((out["marked"], since["Outlook"]), (0, ""))

    def test_check_now_marks_at_once_and_an_employee_may_not(self):
        self._as(EMP)
        self.assertEqual(self.client.post("/external-links/1/check").status_code, 401)
        self._as(ADMIN)
        with mock.patch.object(el, "asyncio") as aio:
            async def _thread(fn, *a):
                return False
            aio.to_thread = _thread
            r = self.client.post("/external-links/1/check")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["unreachable_since"])


if __name__ == "__main__":
    unittest.main()
