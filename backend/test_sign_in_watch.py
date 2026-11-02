"""New sign-in notices and My Profile > Security (Neil, 11/02/2026).

Every BFF sign-in (an employee's Entra callback, a guest's passwordless code)
is recorded in nexus_sign_ins with the device and the approximate location;
a device this person has not signed in from in 180 days gets ONE bell and
one email - never on the very first sign-in, and never in the way of the
sign-in itself. /me/sessions lists where they are signed in (the session id
never leaves the server - rows are named by its hash) and signs the others
out; a sweep removes idle sessions and old sign-ins.
    python -m pytest test_sign_in_watch.py
"""
import base64
import hashlib
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock
from zoneinfo import ZoneInfo

# A throwaway sqlite of its own, so this file never ALTERs or clears a local
# greens_nexus.db (CLAUDE.md: one file per process).
_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_RATE_LIMIT", "off")
ME = "signin.me@greensglobal.com"
OTHER = "signin.other@greensglobal.com"
os.environ["NEXUS_DEV_EMAIL"] = ME

from fastapi.testclient import TestClient  # noqa: E402
from starlette.requests import Request  # noqa: E402

import auth  # noqa: E402
import bff_session as bff  # noqa: E402
import database  # noqa: E402
import ip_location  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import secret_box  # noqa: E402
import sign_in_watch  # noqa: E402
from routers import external_auth as ext_auth  # noqa: E402
from routers import shift_requests as sr  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

IPHONE = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
          "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1")
WINDOWS = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
           "Chrome/126.0.0.0 Safari/537.36")
PUBLIC_IP = "203.0.113.9"
LOCATION = "Laguna Niguel, CA, US"


def _iso(dt):
    return dt.isoformat()


def _ago(**kw):
    return _iso(datetime.now(timezone.utc) - timedelta(**kw))


def _located(ip):
    """Stand-in for a GeoLite2 lookup: public addresses resolve, nothing else."""
    return LOCATION if ip == PUBLIC_IP or ip.startswith("198.51.100.") else ""


def _fake_request(ua=WINDOWS, ip=PUBLIC_IP, cookies=""):
    headers = [(b"user-agent", ua.encode()), (b"x-forwarded-for", ip.encode())]
    if cookies:
        headers.append((b"cookie", cookies.encode()))
    return Request({"type": "http", "method": "POST", "path": "/", "query_string": b"",
                    "headers": headers, "client": ("10.0.0.1", 1234), "scheme": "https", "server": ("t", 443)})


class _Base(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self.db = database.SessionLocal()
        for model in (models.NexusSignIn, models.ServerSession, models.NexusNotification, models.TimePunch,
                      models.NexusSetting):
            self.db.query(model).delete(synchronize_session=False)
        self.db.query(models.NexusEmployee).execution_options(include_deleted=True).delete(synchronize_session=False)
        self.db.commit()
        # Email goes out in a thread after commit; here it is delivered in line
        # and captured, so a test can read what was sent.
        self.sent = []
        self._deliver = mock.patch.object(sign_in_watch, "_deliver", side_effect=lambda batch: self.sent.extend(batch))
        self._deliver.start()
        self._geo = mock.patch.object(ip_location, "lookup", side_effect=_located)
        self._geo.start()

    def tearDown(self):
        self._geo.stop()
        self._deliver.stop()
        self.db.close()
        auth.SKIP_AUTH = self._skip

    def _session(self, email=ME, last_seen=None):
        sid, _csrf = bff.create_passwordless_session(self.db, email)
        if last_seen:
            row = self.db.query(models.ServerSession).filter_by(id=sid).first()
            row.last_seen = last_seen
            self.db.commit()
        return sid

    def _bells(self, to=ME):
        return self.db.query(models.NexusNotification).filter_by(recipient=to).all()


class Record(_Base):
    def test_first_sign_in_ever_is_never_new(self):
        sid = self._session()
        row = sign_in_watch.record(self.db, email=ME, session_id=sid, ip=PUBLIC_IP, user_agent=WINDOWS)
        self.assertFalse(row.is_new)
        self.assertEqual(row.ua_summary, "Windows 10/11 - Chrome")
        self.assertEqual(row.location, LOCATION)
        self.assertEqual(row.ip, PUBLIC_IP)
        self.assertEqual(row.user_agent, WINDOWS)
        self.assertTrue(row.device_key)
        # The session row carries the same facts (My Profile > Security reads them).
        sess = self.db.query(models.ServerSession).filter_by(id=sid).first()
        self.assertEqual((sess.ip, sess.user_agent, sess.ua_summary, sess.location),
                         (PUBLIC_IP, WINDOWS, "Windows 10/11 - Chrome", LOCATION))

    def test_same_device_again_is_not_new(self):
        sign_in_watch.record(self.db, email=ME, session_id=self._session(), ip=PUBLIC_IP, user_agent=WINDOWS)
        # Same browser from another address in the same /24: the same device.
        row = sign_in_watch.record(self.db, email=ME, session_id=self._session(), ip="203.0.113.200", user_agent=WINDOWS)
        self.assertFalse(row.is_new)

    def test_new_device_is_new(self):
        sign_in_watch.record(self.db, email=ME, session_id=self._session(), ip=PUBLIC_IP, user_agent=WINDOWS)
        row = sign_in_watch.record(self.db, email=ME, session_id=self._session(), ip="198.51.100.7", user_agent=IPHONE)
        self.assertTrue(row.is_new)
        self.assertEqual(row.ua_summary, "iOS - Safari")

    def test_a_device_not_seen_in_180_days_is_new_again(self):
        old = sign_in_watch.record(self.db, email=ME, session_id=self._session(), ip=PUBLIC_IP, user_agent=WINDOWS)
        old.at = _ago(days=200)
        self.db.commit()
        row = sign_in_watch.record(self.db, email=ME, session_id=self._session(), ip=PUBLIC_IP, user_agent=WINDOWS)
        self.assertTrue(row.is_new)

    def test_other_people_do_not_count(self):
        sign_in_watch.record(self.db, email=OTHER, session_id=self._session(OTHER), ip=PUBLIC_IP, user_agent=WINDOWS)
        row = sign_in_watch.record(self.db, email=ME, session_id=self._session(), ip=PUBLIC_IP, user_agent=WINDOWS)
        self.assertFalse(row.is_new)    # ME's first ever

    def test_private_ip_has_no_location(self):
        row = sign_in_watch.record(self.db, email=ME, session_id=self._session(), ip="10.0.0.5", user_agent=WINDOWS)
        self.assertEqual(row.location, "")

    def test_device_key(self):
        k = sign_in_watch.device_key
        self.assertEqual(k("Windows 10/11 - Chrome", "203.0.113.9"), k("Windows 10/11 - Chrome", "203.0.113.250"))
        self.assertNotEqual(k("Windows 10/11 - Chrome", "203.0.113.9"), k("Windows 10/11 - Chrome", "203.0.114.9"))
        self.assertNotEqual(k("Windows 10/11 - Chrome", "203.0.113.9"), k("iOS - Safari", "203.0.113.9"))
        self.assertEqual(k("iOS - Safari", "2001:db8:abcd:1::1"), k("iOS - Safari", "2001:db8:abcd:ffff::9"))
        self.assertNotEqual(k("iOS - Safari", "2001:db8:abcd:1::1"), k("iOS - Safari", "2001:db8:abce:1::1"))
        self.assertEqual(len(k("x", "not an ip")), 64)


class Notify(_Base):
    def _new_row(self, ip="198.51.100.7", ua=IPHONE):
        sign_in_watch.record(self.db, email=ME, session_id=self._session(), ip=PUBLIC_IP, user_agent=WINDOWS)
        row = sign_in_watch.record(self.db, email=ME, session_id=self._session(), ip=ip, user_agent=ua)
        row.at = "2026-11-02T16:33:00+00:00"    # 8:33 AM Pacific (PST on 11/02/2026)
        self.db.commit()
        return row

    def test_when_text_is_us_format_in_the_persons_zone(self):
        # No zone known: Pacific, said in words - never a bare "PT".
        self.assertEqual(sign_in_watch.when_text("2026-11-02T16:33:00+00:00"), "Mon 11/02/2026 8:33 AM (Pacific time)")
        self.assertEqual(sign_in_watch.when_text("2026-07-04T19:05:00+00:00"), "Sat 07/04/2026 12:05 PM (Pacific time)")
        self.assertEqual(sign_in_watch.when_text(""), "")
        # A known zone prints its own short name.
        self.assertEqual(sign_in_watch.when_text("2026-11-02T16:33:00+00:00", ZoneInfo("America/Los_Angeles")),
                         "Mon 11/02/2026 8:33 AM PST")
        self.assertEqual(sign_in_watch.when_text("2026-07-04T19:05:00+00:00", ZoneInfo("America/Los_Angeles")),
                         "Sat 07/04/2026 12:05 PM PDT")
        self.assertEqual(sign_in_watch.when_text("2026-11-02T16:33:00+00:00", ZoneInfo("Asia/Kolkata")),
                         "Mon 11/02/2026 10:03 PM IST")

    def test_person_zone_reads_the_punch_then_the_country_then_the_saved_shift_zone(self):
        pz = sign_in_watch.person_zone
        self.assertIsNone(pz(self.db, ME))                                    # nothing known
        self.db.add(models.NexusEmployee(id="emp-signin-me", work_email=ME, first_name="Me", last_name="Test",
                                         status="active", deleted_at="", company="co-in", country="IN"))
        self.db.commit()
        self.assertEqual(str(pz(self.db, ME)), "Asia/Kolkata")                # People country
        self.db.add(models.TimePunch(id="p-signin-1", employee_email=ME, kind="in", at=_ago(hours=2),
                                     local_date="2026-11-02", tz_offset_min=420))
        self.db.commit()
        self.assertEqual(str(pz(self.db, ME)), "America/Los_Angeles")        # the latest punch wins
        self.db.add(models.TimePunch(id="p-signin-2", employee_email=ME, kind="out", at=_ago(hours=1),
                                     local_date="2026-11-02", tz_offset_min=-330))
        self.db.commit()
        self.assertEqual(str(pz(self.db, ME)), "Asia/Kolkata")
        # No punch and no country: the company's SAVED shift zone, never the unsaved default.
        self.db.add(models.NexusEmployee(id="emp-signin-other", work_email=OTHER, first_name="Other", last_name="Test",
                                         status="active", deleted_at="", company="co-x", country=""))
        self.db.commit()
        self.assertIsNone(pz(self.db, OTHER))
        sr._store_settings(self.db, {"email": ME}, sr._settings_key("co-x"), {"timeZone": "Asia/Kolkata"})
        self.db.commit()
        self.assertEqual(str(pz(self.db, OTHER)), "Asia/Kolkata")

    def test_the_notice_is_stamped_in_the_persons_own_zone(self):
        row = self._new_row()
        self.db.add(models.TimePunch(id="p-signin-ist", employee_email=ME, kind="in", at=_ago(hours=1),
                                     local_date="2026-11-02", tz_offset_min=-330))
        self.db.commit()
        sign_in_watch.notify_new(self.db, row)
        self.assertEqual(self._bells()[0].body, "Mon 11/02/2026 10:03 PM IST - Laguna Niguel, CA, US - iOS - Safari. "
                                                "Not you? Open Profile > Security and sign out other devices.")
        self.assertIn("10:03 PM IST", self.sent[0][2])
        self.assertNotIn("Pacific", self.sent[0][2])

    def test_one_bell_and_one_email_with_the_facts(self):
        row = self._new_row()
        sign_in_watch.notify_new(self.db, row)
        bells = self._bells()
        self.assertEqual(len(bells), 1)
        b = bells[0]
        self.assertEqual(b.title, "New Sign-In To Nexus")
        self.assertEqual(b.body, "Mon 11/02/2026 8:33 AM (Pacific time) - Laguna Niguel, CA, US - iOS - Safari. "
                                 "Not you? Open Profile > Security and sign out other devices.")
        self.assertEqual(json.loads(b.action)["view"], "profile")
        self.assertEqual(json.loads(b.action)["sub"], "security")
        self.assertEqual(b.recipient, ME)
        self.assertEqual(len(self.sent), 1)
        to, subject, html = self.sent[0]
        self.assertEqual(to, ME)
        self.assertEqual(subject, "New Sign-In To Nexus")
        for fact in ("11/02/2026", "8:33 AM (Pacific time)", "Laguna Niguel, CA, US", "iOS - Safari", "198.51.100.7",
                     "Open Profile &gt; Security"):
            self.assertIn(fact, html)
        self.assertNotIn("My Profile", html)                      # the menu is "Profile"
        self.assertNotIn("2026-11-02", html)                      # never a raw ISO date
        sess = self.db.query(models.ServerSession).filter_by(id=row.session_id).first()
        self.assertNotIn(sess.id, html)                           # the session id never leaves the server
        self.assertNotIn(row.session_id, b.body)
        self.db.refresh(row)
        self.assertTrue(row.notified)

    def test_unknown_location_is_dropped_from_the_sentence(self):
        row = self._new_row(ip="10.0.0.5")
        sign_in_watch.notify_new(self.db, row)
        self.assertEqual(self._bells()[0].body, "Mon 11/02/2026 8:33 AM (Pacific time) - iOS - Safari. "
                                                "Not you? Open Profile > Security and sign out other devices.")
        self.assertNotIn("Unknown", self.sent[0][2])

    def test_each_new_sign_in_gets_its_own_bell(self):
        sign_in_watch.notify_new(self.db, self._new_row())
        sign_in_watch.notify_new(self.db, self._new_row(ip="198.51.100.9", ua=WINDOWS.replace("Chrome/", "Edg/")))
        self.assertEqual(len(self._bells()), 2)

    def test_watch_records_and_notifies_only_when_new(self):
        sign_in_watch.watch(self.db, email=ME, session_id=self._session(), ip=PUBLIC_IP, user_agent=WINDOWS)
        self.assertEqual(len(self._bells()), 0)
        sign_in_watch.watch(self.db, email=ME, session_id=self._session(), ip="198.51.100.7", user_agent=IPHONE)
        self.assertEqual(len(self._bells()), 1)
        self.assertEqual(self.db.query(models.NexusSignIn).filter_by(email=ME).count(), 2)

    def test_watch_never_raises(self):
        with mock.patch.object(sign_in_watch, "record", side_effect=RuntimeError("db down")):
            self.assertIsNone(sign_in_watch.watch(self.db, email=ME, session_id="x", ip=PUBLIC_IP, user_agent=WINDOWS))
        with mock.patch.object(sign_in_watch, "notify_new", side_effect=RuntimeError("mail down")):
            sign_in_watch.watch(self.db, email=ME, session_id=self._session(), ip=PUBLIC_IP, user_agent=WINDOWS)
            row = sign_in_watch.watch(self.db, email=ME, session_id=self._session(), ip="198.51.100.7", user_agent=IPHONE)
        self.assertIsNotNone(row)   # recorded even though the notice failed


class SignInDoors(_Base):
    def test_entra_callback_records_the_sign_in(self):
        payload = base64.urlsafe_b64encode(json.dumps(
            {"email": ME, "preferred_username": ME, "auth_time": 1700000000}).encode()).decode().rstrip("=")
        token_resp = {"id_token": f"h.{payload}.s", "access_token": "a", "refresh_token": "r", "expires_in": 3600}
        login_cookie = secret_box.encrypt(json.dumps({"s": "st8", "v": "ver", "n": "/"}))
        with mock.patch.object(bff, "exchange_code", return_value=token_resp):
            r = self.client.get("/auth/callback", params={"code": "abc", "state": "st8"},
                                cookies={bff.LOGIN_COOKIE: login_cookie},
                                headers={"User-Agent": WINDOWS, "X-Forwarded-For": PUBLIC_IP},
                                follow_redirects=False)
        self.assertEqual(r.status_code, 302, r.text)
        sid = r.cookies.get(bff.SESSION_COOKIE)
        self.assertTrue(sid)
        sess = self.db.query(models.ServerSession).filter_by(id=sid).first()
        self.assertEqual((sess.ip, sess.ua_summary, sess.location), (PUBLIC_IP, "Windows 10/11 - Chrome", LOCATION))
        rows = self.db.query(models.NexusSignIn).filter_by(email=ME).all()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].session_id, sid)
        self.assertFalse(rows[0].is_new)

    def test_callback_still_signs_in_when_the_watch_breaks(self):
        payload = base64.urlsafe_b64encode(json.dumps({"email": ME, "preferred_username": ME}).encode()).decode().rstrip("=")
        token_resp = {"id_token": f"h.{payload}.s", "access_token": "a", "refresh_token": "r", "expires_in": 3600}
        login_cookie = secret_box.encrypt(json.dumps({"s": "st9", "v": "ver", "n": "/"}))
        with mock.patch.object(bff, "exchange_code", return_value=token_resp), \
             mock.patch.object(sign_in_watch, "record", side_effect=RuntimeError("boom")):
            r = self.client.get("/auth/callback", params={"code": "abc", "state": "st9"},
                                cookies={bff.LOGIN_COOKIE: login_cookie}, follow_redirects=False)
        self.assertEqual(r.status_code, 302)
        self.assertTrue(r.cookies.get(bff.SESSION_COOKIE))
        self.assertNotIn("auth_error", r.headers.get("location", ""))

    def test_passwordless_session_response_records_the_sign_in(self):
        resp = ext_auth._session_response(self.db, OTHER, {"ok": True}, _fake_request(ua=IPHONE))
        self.assertEqual(resp.status_code, 200)
        rows = self.db.query(models.NexusSignIn).filter_by(email=OTHER).all()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].ua_summary, "iOS - Safari")
        self.assertEqual(rows[0].ip, PUBLIC_IP)
        sess = self.db.query(models.ServerSession).filter_by(id=rows[0].session_id).first()
        self.assertEqual(sess.user_email, OTHER)
        self.assertEqual(sess.ua_summary, "iOS - Safari")


class MeSessions(_Base):
    def test_list_hides_the_sid_and_marks_current(self):
        here = self._session()
        there = self._session()
        self._session(OTHER)
        idle = self._session(last_seen=_ago(days=40))
        for sid, ua, ip in ((here, WINDOWS, PUBLIC_IP), (there, IPHONE, "198.51.100.7")):
            sign_in_watch.record(self.db, email=ME, session_id=sid, ip=ip, user_agent=ua)
        r = self.client.get("/me/sessions", cookies={bff.SESSION_COOKIE: here})
        self.assertEqual(r.status_code, 200, r.text)
        rows = r.json()["sessions"]
        self.assertEqual(len(rows), 2)                    # mine, inside the idle window
        ids = {x["id"] for x in rows}
        self.assertNotIn(here, ids); self.assertNotIn(there, ids); self.assertNotIn(idle, ids)
        self.assertIn(hashlib.sha256(here.encode()).hexdigest(), ids)
        self.assertTrue(all(len(x["id"]) == 64 for x in rows))
        self.assertNotIn("sid", json.dumps(rows))
        cur = [x for x in rows if x["current"]]
        self.assertEqual(len(cur), 1)
        self.assertEqual(cur[0]["id"], hashlib.sha256(here.encode()).hexdigest())
        self.assertEqual(cur[0]["device"], "Windows 10/11 - Chrome")
        self.assertEqual(cur[0]["location"], LOCATION)
        self.assertEqual(cur[0]["ip"], PUBLIC_IP)
        self.assertTrue(cur[0]["lastSeen"] and cur[0]["createdAt"])
        self.assertEqual(rows[0]["id"], cur[0]["id"])     # this device first

    def test_others_sign_out_leaves_the_current_row(self):
        here = self._session()
        self._session(); self._session()
        keep = self._session(OTHER)
        r = self.client.post("/me/sessions/others", cookies={bff.SESSION_COOKIE: here})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"signedOut": 2})
        left = {s.id for s in self.db.query(models.ServerSession).all()}
        self.assertEqual(left, {here, keep})

    def test_sign_out_one(self):
        here = self._session()
        there = self._session()
        h = hashlib.sha256(there.encode()).hexdigest()
        r = self.client.delete(f"/me/sessions/{h}", cookies={bff.SESSION_COOKIE: here})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["signedOut"], 1)
        self.assertIsNone(self.db.query(models.ServerSession).filter_by(id=there).first())
        self.assertIsNotNone(self.db.query(models.ServerSession).filter_by(id=here).first())
        self.assertEqual(self.client.delete(f"/me/sessions/{h}").status_code, 404)   # gone

    def test_another_persons_row_is_404_and_the_sid_itself_is_404(self):
        here = self._session()
        theirs = self._session(OTHER)
        r = self.client.delete(f"/me/sessions/{hashlib.sha256(theirs.encode()).hexdigest()}",
                               cookies={bff.SESSION_COOKIE: here})
        self.assertEqual(r.status_code, 404)
        self.assertIsNotNone(self.db.query(models.ServerSession).filter_by(id=theirs).first())
        # The raw sid is not a handle either.
        self.assertEqual(self.client.delete(f"/me/sessions/{here}").status_code, 404)

    def test_recent_sign_ins(self):
        for i in range(25):
            row = sign_in_watch.record(self.db, email=ME, session_id=self._session(), ip=PUBLIC_IP, user_agent=WINDOWS)
            row.at = _ago(days=25 - i)
        new = sign_in_watch.record(self.db, email=ME, session_id=self._session(), ip="198.51.100.7", user_agent=IPHONE)
        sign_in_watch.record(self.db, email=OTHER, session_id=self._session(OTHER), ip=PUBLIC_IP, user_agent=WINDOWS)
        self.db.commit()
        r = self.client.get("/me/sign-ins")
        self.assertEqual(r.status_code, 200, r.text)
        rows = r.json()["signIns"]
        self.assertEqual(len(rows), 20)
        self.assertEqual(rows[0]["id"], new.id)
        self.assertTrue(rows[0]["isNew"])
        self.assertEqual(rows[0]["device"], "iOS - Safari")
        self.assertEqual(rows[0]["location"], LOCATION)
        self.assertFalse(rows[1]["isNew"])
        self.assertNotIn("session_id", json.dumps(rows)); self.assertNotIn("sessionId", json.dumps(rows))
        self.assertTrue(all(x["at"] > y["at"] for x, y in zip(rows, rows[1:])))


class Sweep(_Base):
    def test_sweep_removes_idle_sessions_and_old_sign_ins(self):
        live = self._session()
        idle = self._session(last_seen=_ago(days=bff.session_idle_days() + 2))
        fresh = sign_in_watch.record(self.db, email=ME, session_id=live, ip=PUBLIC_IP, user_agent=WINDOWS)
        old = sign_in_watch.record(self.db, email=ME, session_id=idle, ip=PUBLIC_IP, user_agent=WINDOWS)
        old.at = _ago(days=181)
        self.db.commit()
        out = sign_in_watch.sweep(self.db)
        self.assertEqual(out, {"sessions": 1, "signIns": 1})
        self.assertIsNotNone(self.db.query(models.ServerSession).filter_by(id=live).first())
        self.assertIsNone(self.db.query(models.ServerSession).filter_by(id=idle).first())
        self.assertEqual([r.id for r in self.db.query(models.NexusSignIn).all()], [fresh.id])

    def test_sweep_obeys_its_switch_and_is_registered(self):
        import job_switch
        from workflows import automations
        self.assertIn("sign_in_watch", [j["key"] for j in automations.jobs()])
        self._session(last_seen=_ago(days=60))
        with mock.patch.object(job_switch, "off", side_effect=lambda k: k == "sign_in_watch"):
            self.assertEqual(sign_in_watch.sweep(self.db), {"sessions": 0, "signIns": 0})
        self.assertEqual(self.db.query(models.ServerSession).count(), 1)


class Location(unittest.TestCase):
    def test_skips_private_loopback_cloudflare_and_blank(self):
        for ip in ("", "10.0.0.5", "192.168.1.9", "172.16.4.4", "127.0.0.1", "::1", "fe80::1", "104.16.1.1", "not-an-ip"):
            self.assertEqual(ip_location.lookup(ip), "", ip)

    def test_public_ip_without_a_database_is_blank(self):
        with mock.patch.dict(os.environ, {"NEXUS_GEOIP_DB": "/nonexistent/GeoLite2-City.mmdb"}):
            ip_location._cache.clear()
            self.assertEqual(ip_location.lookup(PUBLIC_IP), "")


if __name__ == "__main__":
    unittest.main()
