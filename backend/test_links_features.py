"""Links features (11/08/2026): Request a Link (bells to the links editors,
else the requester's company administrators, else the Super Administrators;
Add / Decline tell the requester), the click stamp, the weekly health pass
with its three answers and two-miss rule, and the address guard it fetches
under. ONE FILE PER PROCESS.

    python -m pytest test_links_features.py
"""
import os
import socket
import unittest
from unittest import mock

import _testdb  # noqa: F401 - a throwaway SQLite, never greens_nexus.db; keep first

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import links_health  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import safe_fetch  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

ADMIN = {"email": "admin@greensglobal.com", "role": "owner", "level": 5, "name": "Ada Admin"}
EMP = {"email": "eve@greensglobal.com", "role": "employee", "level": 1, "name": "Eve Employee"}


def _bells(db, ntype):
    return db.query(models.NexusNotification).filter_by(type=ntype).all()


class _Base(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        db = database.SessionLocal()
        try:
            for t in (models.ExternalLink, models.ExternalLinkRequest, models.NexusNotification, models.NexusRole,
                      models.NexusGroup, models.NexusGroupMember, models.NexusSetting, models.NexusEmployee):
                db.query(t).delete()
            db.add(models.NexusRole(email="mgr@greensglobal.com", role="manager"))
            db.add(models.NexusRole(email="adm-a@greensglobal.com", role="administrator"))
            db.add(models.NexusRole(email="adm-b@greensglobal.com", role="administrator"))
            db.add(models.NexusRole(email="super@greensglobal.com", role="owner"))
            db.add(models.NexusRole(email="eve@greensglobal.com", role="employee"))
            for em, co in (("eve@greensglobal.com", "co-a"), ("adm-a@greensglobal.com", "co-a"), ("adm-b@greensglobal.com", "co-b"),
                           ("mgr@greensglobal.com", "co-a")):
                db.add(models.NexusEmployee(id=f"e-{em}", first_name=em.split("@")[0], last_name="T", work_email=em, company=co,
                                            status="active", deleted_at=""))
            db.add(models.ExternalLink(id=1, name="Outlook", url="https://outlook.example.com", category="Productivity"))
            db.commit()
        finally:
            db.close()

    def tearDown(self):
        main.app.dependency_overrides.pop(auth.get_current_user, None)

    def _as(self, user):
        main.app.dependency_overrides[auth.get_current_user] = lambda: dict(user)

    def _grant_group(self):
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id="g-links", name="Links Editors", allowed_modules="external-links:editor"))
            db.add(models.NexusGroupMember(group_id="g-links", email="ed@greensglobal.com"))
            db.commit()
        finally:
            db.close()


class RequestALinkTests(_Base):
    def _request(self):
        self._as(EMP)
        r = self.client.post("/external-links/requests", json={"name": "Ramp", "url": "app.ramp.com", "note": "Expenses"})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    def test_the_links_editors_are_belled_when_a_group_grants_the_module(self):
        self._grant_group()
        self._request()
        db = database.SessionLocal()
        try:
            bells = _bells(db, "link_request")
            self.assertEqual([b.recipient for b in bells], ["ed@greensglobal.com"])   # not the managers, not the admins
            self.assertIn("Eve Employee", bells[0].body)
        finally:
            db.close()

    def test_without_a_group_the_requesters_company_administrators_are_belled(self):
        self._request()
        db = database.SessionLocal()
        try:
            self.assertEqual([b.recipient for b in _bells(db, "link_request")], ["adm-a@greensglobal.com"])  # co-a only
        finally:
            db.close()

    def test_with_no_company_administrator_the_super_administrators_are_belled(self):
        db = database.SessionLocal()
        db.query(models.NexusRole).filter(models.NexusRole.email == "adm-a@greensglobal.com").delete()
        db.commit(); db.close()
        self._request()
        db = database.SessionLocal()
        try:
            bells = _bells(db, "link_request")
            self.assertEqual([b.recipient for b in bells], ["super@greensglobal.com"])
            self.assertTrue(all(b.recipient for b in bells))   # never a broadcast
        finally:
            db.close()

    def test_add_tells_the_requester_and_closes_the_request(self):
        req = self._request()
        self.assertEqual(req["url"], "https://app.ramp.com")
        self.assertEqual(self.client.get("/external-links/requests").status_code, 401)   # not for an employee
        self._as(ADMIN)
        self.assertEqual([x["id"] for x in self.client.get("/external-links/requests").json()], [req["id"]])
        r = self.client.patch(f"/external-links/requests/{req['id']}", json={"link_id": 1})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["status"], r.json()["link_id"]), ("added", 1))
        self.assertEqual(self.client.get("/external-links/requests").json(), [])
        self.assertEqual(self.client.post(f"/external-links/requests/{req['id']}/decline").status_code, 409)
        db = database.SessionLocal()
        try:
            b = _bells(db, "link_request_decided")
            self.assertEqual([x.recipient for x in b], ["eve@greensglobal.com"])
            self.assertEqual(b[0].title, "Link Added")
            self.assertIn('"Outlook" is now in Links', b[0].body)
            self.assertRegex(b[0].body, r"\d\d/\d\d/\d{4}")   # US date
        finally:
            db.close()

    def test_decline_tells_the_requester(self):
        req = self._request()
        self._as(ADMIN)
        r = self.client.post(f"/external-links/requests/{req['id']}/decline")
        self.assertEqual((r.json()["status"], r.json()["decided_by"]), ("declined", ADMIN["email"]))
        db = database.SessionLocal()
        try:
            b = _bells(db, "link_request_decided")
            self.assertEqual((b[0].recipient, b[0].title), ("eve@greensglobal.com", "Link Request Declined"))
            self.assertIn("Ada Admin", b[0].body)
        finally:
            db.close()

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
    """What the guard refuses is SKIPPED (not checked), never a miss - and
    nothing is ever requested for it."""
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
        "http://vpn-only.greensglobal.com/": "10.8.0.4",
    }

    def test_private_and_special_hosts_are_skipped_without_a_request(self):
        def _refusing_client(timeout):
            def _no(request):
                raise AssertionError(f"must not connect: {request.url}")
            return httpx.Client(timeout=timeout, follow_redirects=False, transport=httpx.MockTransport(_no))
        for url, ip in self.TABLE.items():
            with mock.patch.object(socket, "getaddrinfo", return_value=_addr(ip)), \
                 mock.patch.object(safe_fetch, "_new_client", side_effect=_refusing_client):
                self.assertEqual(links_health.check(url), links_health.SKIPPED, url)

    def test_non_http_and_junk_are_skipped_without_resolving(self):
        with mock.patch.object(socket, "getaddrinfo", side_effect=AssertionError("must not resolve")):
            for url in ("ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)", "", "not a url"):
                self.assertEqual(links_health.check(url), links_health.SKIPPED, url)

    def test_a_public_host_that_does_not_resolve_is_a_miss(self):
        # safe_fetch refuses "does not resolve" the same way as private; the
        # DNS failure of a public name is told apart by trying DNS first.
        with mock.patch.object(socket, "getaddrinfo", side_effect=socket.gaierror):
            self.assertEqual(links_health.check("https://nope.invalid/"), links_health.MISS)


class AnswerTests(unittest.TestCase):
    """Any HTTP answer proves the host serves; 5xx and no answer are misses."""
    def _with(self, status):
        return mock.patch.object(safe_fetch, "fetch", return_value=safe_fetch.Fetched("u", status, {}, b""))

    def test_2xx_3xx_4xx_are_ok(self):
        for st in (200, 204, 301, 302, 401, 403, 404, 429):
            with self._with(st):
                self.assertEqual(links_health.check("https://x.example.com/"), links_health.OK, st)

    def test_5xx_and_no_answer_are_misses(self):
        for st in (500, 502, 503):
            with self._with(st):
                self.assertEqual(links_health.check("https://x.example.com/"), links_health.MISS, st)
        with mock.patch.object(safe_fetch, "fetch", side_effect=httpx.ConnectError("refused")):
            self.assertEqual(links_health.check("https://x.example.com/"), links_health.MISS)
        with mock.patch.object(safe_fetch, "fetch", side_effect=httpx.ReadTimeout("slow")):
            self.assertEqual(links_health.check("https://x.example.com/"), links_health.MISS)

    def test_too_large_still_answered(self):
        with mock.patch.object(safe_fetch, "fetch", side_effect=safe_fetch.FetchRefused("response is larger than the cap")):
            self.assertEqual(links_health.check("https://x.example.com/"), links_health.OK)


class WeeklyPassTests(_Base):
    def _run(self, answers, **kw):
        db = database.SessionLocal()
        try:
            out = links_health.run_weekly(db, fetch=lambda url: answers[url], **kw)
            return out, {l.name: l.unreachable_since for l in db.query(models.ExternalLink).all()}
        finally:
            db.close()

    def _add_down(self):
        db = database.SessionLocal()
        db.add(models.ExternalLink(id=2, name="Down", url="https://down.example.com", category="X"))
        db.commit(); db.close()

    def test_two_misses_in_a_row_mark_a_link_and_one_answer_clears_it(self):
        self._add_down()
        up, down = "https://outlook.example.com", "https://down.example.com"
        out, since = self._run({up: "ok", down: "miss"})
        self.assertEqual((out["marked"], out["pending"]), (0, 1))
        self.assertEqual(since["Down"], "")                      # one miss is not a mark
        out, since = self._run({up: "ok", down: "miss"})
        self.assertEqual(out["marked"], 1)
        self.assertTrue(since["Down"])
        out, since = self._run({up: "ok", down: "ok"})
        self.assertEqual(out["cleared"], 1)
        self.assertEqual(since["Down"], "")

    def test_a_miss_then_an_answer_resets_the_strike(self):
        u = "https://outlook.example.com"
        out, _ = self._run({u: "miss"})
        self.assertEqual(out["pending"], 1)
        out, _ = self._run({u: "ok"})
        self.assertEqual(out["pending"], 0)
        out, since = self._run({u: "miss"})
        self.assertEqual((out["marked"], since["Outlook"]), (0, ""))

    def test_skipped_touches_nothing(self):
        u = "https://outlook.example.com"
        self._run({u: "miss"})                                  # one strike
        out, since = self._run({u: "skipped"})
        self.assertEqual((out["skipped"], out["pending"], out["marked"], since["Outlook"]), (1, 1, 0, ""))
        db = database.SessionLocal()
        db.query(models.ExternalLink).filter_by(id=1).update({"unreachable_since": "2026-10-01T00:00:00+00:00"})
        db.commit(); db.close()
        out, since = self._run({u: "skipped"})
        self.assertEqual((out["cleared"], since["Outlook"]), (0, "2026-10-01T00:00:00+00:00"))

    def test_the_budget_leaves_unreached_links_as_they_were(self):
        self._add_down()
        import time
        def slow(url):
            if "down" in url:
                time.sleep(2)
            return "miss"
        db = database.SessionLocal()
        try:
            out = links_health.run_weekly(db, fetch=slow, budget_sec=0.5)
            self.assertEqual((out["unfinished"], out["pending"]), (1, 1))
        finally:
            db.close()


class CheckNowTests(_Base):
    def test_check_now_follows_the_one_rule_and_an_employee_may_not(self):
        self._as(EMP)
        self.assertEqual(self.client.post("/external-links/1/check").status_code, 401)
        self._as(ADMIN)
        with mock.patch.object(links_health, "check", return_value="miss"):
            r = self.client.post("/external-links/1/check")
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual((r.json()["result"], r.json()["link"]["unreachable_since"]), ("miss", ""))   # first strike
            r = self.client.post("/external-links/1/check")
            self.assertTrue(r.json()["link"]["unreachable_since"])                                   # second marks
        with mock.patch.object(links_health, "check", return_value="skipped"):
            r = self.client.post("/external-links/1/check")
            self.assertTrue(r.json()["link"]["unreachable_since"])                                   # untouched
            self.assertEqual(r.json()["message"], links_health.SKIPPED_TEXT)
        with mock.patch.object(links_health, "check", return_value="ok"):
            r = self.client.post("/external-links/1/check")
            self.assertEqual(r.json()["link"]["unreachable_since"], "")


if __name__ == "__main__":
    unittest.main()
