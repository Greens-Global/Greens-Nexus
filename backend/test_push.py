"""Web Push (push.py + routers/push.py, Frontline Reach, Nov 2026).

Pins: off until the three VAPID settings exist (config says so, nothing is
queued, subscribing is refused); one subscription row per endpoint; a bell
notice with a named recipient queues one outbox row per subscribed person
and a broadcast row queues nothing; a device the push service says is gone is
deleted; five failures disable a device; a success clears the count; only
the browsers' push services are accepted as endpoints; the tag is per bell
row; a send has a timeout and a timeout is one failure, not a gone device; a
device deleted or disabled mid-pass is not sent to again in that pass; the
Automations switch `push` pauses the outbox; a bell's action URL that points
off-site is replaced by "/".

Uses a throwaway sqlite file. Run with: python -m unittest test_push
"""
import os
import tempfile
import unittest
from unittest import mock

_t = tempfile.NamedTemporaryFile(suffix=".db", delete=False); _t.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_t.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ["NEXUS_DEV_EMAIL"] = "sagar.shoundik@greensglobal.com"
for _k in ("NEXUS_VAPID_PRIVATE_KEY", "NEXUS_VAPID_PUBLIC_KEY", "NEXUS_VAPID_SUBJECT"):
    os.environ.pop(_k, None)

from fastapi.testclient import TestClient  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402
import push  # noqa: E402
import main  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)
c = TestClient(main.app)
ME = "sagar.shoundik@greensglobal.com"
KEYS = {"NEXUS_VAPID_PRIVATE_KEY": "test-private", "NEXUS_VAPID_PUBLIC_KEY": "BPublicKeyForTests",
        "NEXUS_VAPID_SUBJECT": "mailto:it@greensglobal.com"}
SUB = {"endpoint": "https://fcm.googleapis.com/fcm/send/abc", "keys": {"p256dh": "p", "auth": "a"}, "userAgent": "iPhone Safari"}


def _clear():
    db = database.SessionLocal()
    try:
        for m in (models.NexusPushOutbox, models.NexusPushSubscription, models.NexusNotification):
            db.query(m).delete()
        db.commit()
    finally:
        db.close()


def _notice(recipient, title="Shift published", body="Your week is up.", action=""):
    from datetime import datetime, timezone
    db = database.SessionLocal()
    try:
        db.add(models.NexusNotification(id=f"n_{recipient or 'all'}_{title}", type="shift", recipient=recipient,
                                        title=title, body=body, action=action,
                                        created_at=datetime.now(timezone.utc).isoformat()))
        db.commit()
    finally:
        db.close()


def _outbox():
    db = database.SessionLocal()
    try:
        return [(r.email, r.title, r.url, r.sent_at) for r in db.query(models.NexusPushOutbox).all()]
    finally:
        db.close()


def db_error():
    db = database.SessionLocal()
    try:
        return "; ".join(r.error or "" for r in db.query(models.NexusPushOutbox).all())
    finally:
        db.close()


def _subs():
    db = database.SessionLocal()
    try:
        return [(s.email, s.endpoint, s.failures, bool(s.disabled)) for s in db.query(models.NexusPushSubscription).all()]
    finally:
        db.close()


class OffUntilConfigured(unittest.TestCase):
    def setUp(self):
        _clear()
        for k in KEYS:
            os.environ.pop(k, None)

    def test_config_says_off_and_hides_the_key(self):
        r = c.get("/push/config")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"enabled": False, "publicKey": ""})

    def test_subscribing_is_refused(self):
        self.assertEqual(c.post("/push/subscribe", json=SUB).status_code, 409)

    def test_a_notice_queues_nothing(self):
        db = database.SessionLocal()
        try:
            self.assertEqual(push.queue_push(db, [ME], "t", "b"), 0)
        finally:
            db.close()
        _notice(ME)
        self.assertEqual(_outbox(), [])

    def test_health_reports_push_off(self):
        self.assertIs(c.get("/health").json()["secrets"]["push"], False)


class Configured(unittest.TestCase):
    def setUp(self):
        _clear()
        self._env = mock.patch.dict(os.environ, KEYS)
        self._env.start()

    def tearDown(self):
        self._env.stop()

    def test_config_is_on_with_the_public_key(self):
        self.assertEqual(c.get("/push/config").json(), {"enabled": True, "publicKey": "BPublicKeyForTests"})
        self.assertIs(c.get("/health").json()["secrets"]["push"], True)

    def test_one_row_per_endpoint_and_mine_only(self):
        r = c.post("/push/subscribe", json=SUB)
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["userAgent"], "iPhone Safari")
        # The same browser subscribes again (new keys): one row, refreshed.
        again = dict(SUB, keys={"p256dh": "p2", "auth": "a2"})
        self.assertEqual(c.post("/push/subscribe", json=again).status_code, 201)
        self.assertEqual(len(_subs()), 1)
        mine = c.get("/push/subscriptions").json()
        self.assertEqual([m["endpoint"] for m in mine], [SUB["endpoint"]])
        self.assertEqual(c.request("DELETE", "/push/subscribe", json={"endpoint": SUB["endpoint"]}).status_code, 204)
        self.assertEqual(_subs(), [])

    def test_a_bad_subscription_is_refused(self):
        self.assertEqual(c.post("/push/subscribe", json=dict(SUB, endpoint="http://not-https")).status_code, 400)
        self.assertEqual(c.post("/push/subscribe", json=dict(SUB, keys={"p256dh": "", "auth": ""})).status_code, 400)

    def test_a_named_bell_notice_queues_one_push_and_a_broadcast_none(self):
        c.post("/push/subscribe", json=SUB)
        _notice(ME, title="Shift published", action='{"url": "/shifts"}')
        _notice(None, title="Managers only")
        _notice("nobody.subscribed@greensglobal.com", title="Not a device in sight")
        rows = _outbox()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][:3], (ME, "Shift published", "/shifts"))
        self.assertEqual(rows[0][3], "")   # waiting for the loop

    def test_two_devices_get_the_same_notice_and_a_gone_one_is_deleted(self):
        c.post("/push/subscribe", json=SUB)
        c.post("/push/subscribe", json=dict(SUB, endpoint="https://web.push.apple.com/laptop"))
        _notice(ME)
        sent = []

        def fake_send(sub, payload):
            sent.append(sub.endpoint)
            if sub.endpoint.endswith("/laptop"):
                return False, "410 Gone", True
            return True, "", False
        with mock.patch.object(push, "_send_one", side_effect=fake_send):
            self.assertEqual(push._send_batch(), 1)
        self.assertEqual(sorted(sent), [SUB["endpoint"], "https://web.push.apple.com/laptop"])
        subs = _subs()
        self.assertEqual([s[1] for s in subs], [SUB["endpoint"]])
        self.assertEqual(subs[0][2], 0)          # the good device's count stays clear
        self.assertNotEqual(_outbox()[0][3], "")  # the row is marked sent

    def test_five_failures_disable_a_device_and_a_success_resets(self):
        c.post("/push/subscribe", json=SUB)
        with mock.patch.object(push, "_send_one", return_value=(False, "timeout", False)):
            for i in range(5):
                _notice(ME, title=f"Notice {i}")
                push._send_batch()
        self.assertEqual(_subs()[0][2:], (5, True))
        # Disabled devices are not queued for and not sent to.
        _notice(ME, title="After")
        self.assertEqual([r for r in _outbox() if r[1] == "After"], [])
        # Subscribing again from that browser brings it back clean.
        c.post("/push/subscribe", json=SUB)
        self.assertEqual(_subs()[0][2:], (0, False))
        _notice(ME, title="Back")
        with mock.patch.object(push, "_send_one", return_value=(True, "", False)):
            push._send_batch()
        self.assertEqual(_subs()[0][2], 0)

    def test_only_the_browsers_push_services_are_accepted(self):
        for ok in ("https://fcm.googleapis.com/fcm/send/x", "https://web.push.apple.com/QAbc",
                   "https://wns2-par02p.notify.windows.com/w/?token=x",
                   "https://updates.push.services.mozilla.com/wpush/v2/g",
                   "https://updates-autopush.stage.mozaws.net".replace("mozaws.net", "push.services.mozilla.com")):
            self.assertEqual(c.post("/push/subscribe", json=dict(SUB, endpoint=ok)).status_code, 201, ok)
        for bad in ("https://10.0.0.5/collect", "https://evil.example.com/fcm.googleapis.com",
                    "https://fcm.googleapis.com.evil.example/send", "https://notify.windows.com.attacker.test/x"):
            r = c.post("/push/subscribe", json=dict(SUB, endpoint=bad))
            self.assertEqual(r.status_code, 400, bad)
            self.assertEqual(r.json()["detail"], "Unknown push service")

    def test_tag_is_per_bell_row_and_an_offsite_action_url_falls_back(self):
        c.post("/push/subscribe", json=SUB)
        _notice(ME, title="Task A", action='{"url": "/tasks/1"}')
        _notice(ME, title="Task B", action='{"url": "//evil.example/x"}')
        _notice(ME, title="Task C", action='{"url": "/\\\\evil.example/x"}')
        db = database.SessionLocal()
        try:
            rows = {r.title: r for r in db.query(models.NexusPushOutbox).all()}
        finally:
            db.close()
        self.assertEqual(rows["Task A"].url, "/tasks/1")
        self.assertEqual(rows["Task B"].url, "/")
        self.assertEqual(rows["Task C"].url, "/")
        self.assertEqual(len({r.tag for r in rows.values()}), 3)   # one tag per row, never one per type
        self.assertTrue(all(r.tag.startswith("shift:") for r in rows.values()))

    def test_a_send_timeout_is_one_failure_not_a_gone_device_and_has_a_timeout(self):
        import inspect
        self.assertIn("timeout=SEND_TIMEOUT", inspect.getsource(push._send_one))
        c.post("/push/subscribe", json=SUB)
        _notice(ME)
        fake_wp = mock.MagicMock()
        fake_wp.WebPushException = type("WebPushException", (Exception,), {})
        import requests
        fake_wp.webpush.side_effect = requests.exceptions.ReadTimeout("read timed out")
        with mock.patch.dict("sys.modules", {"pywebpush": fake_wp}):
            push._send_batch()
        self.assertEqual(_subs()[0][2:], (1, False))      # one failure, still there, still enabled
        self.assertIn("timed out", db_error())

    def test_a_device_gone_mid_pass_is_not_sent_to_again_in_that_pass(self):
        c.post("/push/subscribe", json=SUB)
        for i in range(3):
            _notice(ME, title=f"Notice {i}")
        sent = []
        with mock.patch.object(push, "_send_one", side_effect=lambda sub, payload: (sent.append(sub.endpoint), (False, "410 Gone", True))[1]):
            self.assertEqual(push._send_batch(), 3)
        self.assertEqual(len(sent), 1)          # the first 410 settles it for the pass
        self.assertEqual(_subs(), [])

    def test_the_automations_switch_pauses_the_outbox(self):
        import job_switch
        from workflows import automations
        self.assertIn("push", [j["key"] for j in automations.jobs()])
        c.post("/push/subscribe", json=SUB)
        _notice(ME)
        with mock.patch.object(job_switch, "off", side_effect=lambda k: k == "push"), \
             mock.patch.object(push, "_send_one", return_value=(True, "", False)) as send:
            self.assertEqual(push._send_batch(), 0)
        send.assert_not_called()
        self.assertEqual(_outbox()[0][3], "")   # still waiting

    def test_the_loop_never_sends_on_the_event_loop(self):
        import inspect
        self.assertTrue(inspect.iscoroutinefunction(push.push_loop))
        src = inspect.getsource(push.push_loop)
        self.assertIn("to_thread", src)


if __name__ == "__main__":
    unittest.main()
