"""
Shifts Phase 3a - shared shifts onto Outlook calendars (shift_calendar.py).

The Graph callable is a fake that records every call and answers what the
test says. Uses a throwaway sqlite file; nothing reaches Microsoft.

Run with: python -m unittest test_shift_calendar -v
"""
import json
import os
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

import database                                          # noqa: E402
import models                                            # noqa: E402
import shift_calendar                                    # noqa: E402

ENT = "ent-cal"
AMY, BOB, NOMAIL = "amy@greensglobal.com", "bob@greensglobal.com", "nomail@greensglobal.com"
DAY = (datetime.now(timezone.utc).date() + timedelta(days=5)).isoformat()
NOW = datetime(2026, 10, 14, 15, 0, tzinfo=timezone.utc)


class FakeGraph:
    """Answers (status, data) per method; records every call."""

    def __init__(self, create_status=201, patch_status=200, delete_status=204):
        self.calls = []
        self.create_status, self.patch_status, self.delete_status = create_status, patch_status, delete_status
        self.n = 0

    def __call__(self, method, path, body=None):
        self.calls.append((method, path, body))
        if method == "POST":
            self.n += 1
            return self.create_status, {"id": f"evt-{self.n}"} if self.create_status < 300 else {"error": {"message": "no"}}
        if method == "PATCH":
            return self.patch_status, {}
        return self.delete_status, {}

    def by(self, method):
        return [c for c in self.calls if c[0] == method]


class _Case(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.ShiftCalendarEvent, models.ScheduledShift, models.Shift, models.ShiftGroup, models.HrWorkSite,
                  models.NexusEmployee, models.NexusPersonPref, models.NexusSetting, models.HrEntity):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=ENT, name="Greens"))
        for em, first, m365 in ((AMY, "Amy", "m365-amy"), (BOB, "Bob", "m365-bob"), (NOMAIL, "Nomail", "")):
            self.db.add(models.NexusEmployee(id=f"emp-{em}", first_name=first, last_name="Lee", work_email=em,
                                             status="active", deleted_at="", company=ENT, m365_id=m365))
        self.db.add(models.Shift(id="gsv", code="GSV", name="Store", start_hhmm="07:00", end_hhmm="15:30",
                                 timezone="America/Los_Angeles"))
        self.db.add(models.HrWorkSite(id="site-1", name="Harbor View"))
        self.db.add(models.ShiftGroup(id="grp-1", name="Yard Crew", work_site_id="site-1"))
        self.db.commit()
        shift_calendar._disabled_until, shift_calendar._disabled_reason = 0.0, ""
        shift_calendar._backfill_checked = True   # the backfill test turns it back on

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _shift(self, sid, email=AMY, start="07:00", end="15:30", label="", published=1, work_date=DAY, **kw):
        r = models.ScheduledShift(id=sid, employee_email=email, work_date=work_date, shift_id="gsv", start_hhmm=start,
                                  end_hhmm=end, label=label, published=published, group_id="grp-1", **kw)
        self.db.add(r)
        self.db.commit()
        return r

    def _rows(self, sid=None):
        self.db.expire_all()
        q = self.db.query(models.ShiftCalendarEvent)
        if sid:
            q = q.filter(models.ShiftCalendarEvent.shift_id == sid)
        return q.order_by(models.ShiftCalendarEvent.employee_email).all()

    def _settings(self, **kw):
        self.db.add(models.NexusSetting(key=f"shift_requests_config:{ENT}", value=json.dumps(kw)))
        self.db.commit()


class EventTests(_Case):
    def test_create_carries_subject_zone_showas_body_and_transaction_id(self):
        self._shift("s1", label="")
        shift_calendar.enqueue(self.db, ["s1"])
        self.db.commit()
        g = FakeGraph()
        out = shift_calendar.sync_once(self.db, now=NOW, graph=g)
        self.assertEqual(out["created"], 1, out)
        (method, path, body), = g.calls
        self.assertEqual((method, path), ("POST", "/users/m365-amy/events"))
        self.assertEqual(body["subject"], "Shift · 7:00 AM - 3:30 PM · GSV")   # the shift type when no label
        self.assertEqual(body["start"], {"dateTime": f"{DAY}T07:00:00", "timeZone": "America/Los_Angeles"})
        self.assertEqual(body["end"], {"dateTime": f"{DAY}T15:30:00", "timeZone": "America/Los_Angeles"})
        self.assertEqual(body["showAs"], "free")
        self.assertFalse(body["isReminderOn"])
        self.assertEqual(body["categories"], ["Nexus Shift"])
        self.assertEqual(body["transactionId"], "s1")
        self.assertIn("Team: Yard Crew", body["body"]["content"])
        self.assertIn("Site: Harbor View", body["body"]["content"])
        self.assertIn("/shifts/mine", body["body"]["content"])
        row, = self._rows("s1")
        self.assertEqual((row.state, row.event_id), ("ok", "evt-1"))
        self.assertTrue(row.synced_hash and row.synced_at)

    def test_label_wins_over_the_shift_type_in_the_subject(self):
        self._shift("s1", label="Front Desk")
        shift_calendar.enqueue(self.db, ["s1"])
        self.db.commit()
        g = FakeGraph()
        shift_calendar.sync_once(self.db, now=NOW, graph=g)
        self.assertEqual(g.calls[0][2]["subject"], "Shift · 7:00 AM - 3:30 PM · Front Desk")

    def test_overnight_shift_ends_the_next_day(self):
        self._shift("s1", start="22:00", end="04:00")
        shift_calendar.enqueue(self.db, ["s1"])
        self.db.commit()
        g = FakeGraph()
        shift_calendar.sync_once(self.db, now=NOW, graph=g)
        body = g.calls[0][2]
        nxt = (datetime.strptime(DAY, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
        self.assertEqual(body["start"]["dateTime"], f"{DAY}T22:00:00")
        self.assertEqual(body["end"]["dateTime"], f"{nxt}T04:00:00")

    def test_show_as_follows_the_company_setting(self):
        self._settings(outlookShowAs="busy")
        self._shift("s1")
        shift_calendar.enqueue(self.db, ["s1"])
        self.db.commit()
        g = FakeGraph()
        shift_calendar.sync_once(self.db, now=NOW, graph=g)
        self.assertEqual(g.calls[0][2]["showAs"], "busy")

    def test_unchanged_shift_is_not_sent_again_but_a_change_is_patched(self):
        r = self._shift("s1")
        shift_calendar.enqueue(self.db, ["s1"])
        self.db.commit()
        g = FakeGraph()
        shift_calendar.sync_once(self.db, now=NOW, graph=g)
        self.assertEqual(len(g.calls), 1)
        # Re-queued with nothing changed: no call, state ok.
        shift_calendar.enqueue(self.db, ["s1"])
        self.db.commit()
        out = shift_calendar.sync_once(self.db, now=NOW, graph=g)
        self.assertEqual((out["unchanged"], len(g.calls)), (1, 1))
        self.assertEqual(self._rows("s1")[0].state, "ok")
        # A time change: PATCH on the known event, no transactionId.
        r = self.db.get(models.ScheduledShift, "s1")
        r.end_hhmm = "16:00"
        shift_calendar.enqueue(self.db, ["s1"])
        self.db.commit()
        out = shift_calendar.sync_once(self.db, now=NOW, graph=g)
        self.assertEqual(out["updated"], 1)
        method, path, body = g.calls[-1]
        self.assertEqual((method, path), ("PATCH", "/users/m365-amy/events/evt-1"))
        self.assertNotIn("transactionId", body)
        self.assertEqual(body["end"]["dateTime"], f"{DAY}T16:00:00")

    def test_a_404_on_update_recreates_the_event_with_a_fresh_transaction_id(self):
        self._shift("s1")
        shift_calendar.enqueue(self.db, ["s1"])
        self.db.commit()
        g = FakeGraph()
        shift_calendar.sync_once(self.db, now=NOW, graph=g)
        r = self.db.get(models.ScheduledShift, "s1")
        r.label = "Moved"
        shift_calendar.enqueue(self.db, ["s1"])
        self.db.commit()
        g.patch_status = 404
        out = shift_calendar.sync_once(self.db, now=NOW, graph=g)
        self.assertEqual((out["created"], out["updated"]), (1, 0))
        self.assertEqual([c[0] for c in g.calls], ["POST", "PATCH", "POST"])
        self.assertNotEqual(g.calls[-1][2]["transactionId"], "s1")
        self.assertTrue(g.calls[-1][2]["transactionId"].startswith("s1."))
        self.assertEqual(self._rows("s1")[0].event_id, "evt-2")

    def test_a_403_pauses_the_sync_with_the_setup_doc_in_the_reason(self):
        self._shift("s1")
        self._shift("s2", email=BOB)
        shift_calendar.enqueue(self.db, ["s1", "s2"])
        self.db.commit()
        g = FakeGraph(create_status=403)
        out = shift_calendar.sync_once(self.db, now=NOW, graph=g)
        self.assertIn("Calendars.ReadWrite", out["disabled"])
        self.assertIn("docs/Outlook-Calendar-Setup.md", out["disabled"])
        self.assertEqual(len(g.calls), 1)                      # stopped at the first refusal
        self.assertEqual([r.state for r in self._rows()], ["pending", "pending"])   # nothing lost
        st = shift_calendar.status(self.db)
        self.assertFalse(st["enabled"])
        self.assertIn("Outlook-Calendar-Setup", st["reason"])
        self.assertEqual(st["pending"], 2)
        # Nothing runs again until the pause lapses...
        g2 = FakeGraph()
        self.assertEqual(shift_calendar.sync_once(self.db, now=NOW, graph=g2)["processed"], 0)
        self.assertEqual(g2.calls, [])
        # ...then it picks up where it left off.
        shift_calendar._disabled_until = time.monotonic() - 1
        self.assertEqual(shift_calendar.sync_once(self.db, now=NOW, graph=g2)["created"], 2)

    def test_a_server_error_marks_the_row_and_goes_on(self):
        self._shift("s1")
        shift_calendar.enqueue(self.db, ["s1"])
        self.db.commit()
        out = shift_calendar.sync_once(self.db, now=NOW, graph=FakeGraph(create_status=500))
        self.assertEqual(out["errors"], 1)
        row, = self._rows("s1")
        self.assertEqual(row.state, "error")
        self.assertIn("500", row.last_error)
        self.assertEqual(row.attempts, 1)
        self.assertEqual(shift_calendar.status(self.db)["errors"], 1)

    # Review (Oct 15): an errored row is retried after 15 minutes, five times,
    # then left alone until the shift changes - never spun on forever.
    def test_an_errored_row_is_retried_until_max_attempts_then_waits_for_a_change(self):
        self._shift("s1")
        shift_calendar.enqueue(self.db, ["s1"])
        self.db.commit()
        bad = FakeGraph(create_status=500)
        shift_calendar.sync_once(self.db, now=NOW, graph=bad)
        # Too soon: not picked up again.
        soon = NOW + timedelta(minutes=5)
        self.assertEqual(shift_calendar.sync_once(self.db, now=soon, graph=bad)["processed"], 0)
        t = NOW
        for n in range(2, shift_calendar.MAX_ATTEMPTS + 1):
            t += timedelta(seconds=shift_calendar.ERROR_RETRY_SEC + 1)
            self.assertEqual(shift_calendar.sync_once(self.db, now=t, graph=bad)["errors"], 1, n)
            self.assertEqual(self._rows("s1")[0].attempts, n)
        # Out of tries: a later tick leaves it, still visible as an error.
        t += timedelta(seconds=shift_calendar.ERROR_RETRY_SEC + 1)
        self.assertEqual(shift_calendar.sync_once(self.db, now=t, graph=bad)["processed"], 0)
        self.assertEqual(shift_calendar.status(self.db)["errors"], 1)
        # The shift changes: queued again with its tries back, and this time it lands.
        shift_calendar.enqueue(self.db, ["s1"])
        self.db.commit()
        row, = self._rows("s1")
        self.assertEqual((row.state, row.attempts), ("pending", 0))
        self.assertEqual(shift_calendar.sync_once(self.db, now=t, graph=FakeGraph())["created"], 1)

    def test_a_400_is_never_retried_until_the_shift_changes(self):
        self._shift("s1")
        shift_calendar.enqueue(self.db, ["s1"])
        self.db.commit()
        out = shift_calendar.sync_once(self.db, now=NOW, graph=FakeGraph(create_status=400))
        self.assertEqual(out["errors"], 1)
        row, = self._rows("s1")
        self.assertEqual((row.state, row.attempts), ("error", shift_calendar.MAX_ATTEMPTS))
        later = NOW + timedelta(days=1)
        self.assertEqual(shift_calendar.sync_once(self.db, now=later, graph=FakeGraph(create_status=400))["processed"], 0)

    def test_a_503_or_a_lost_token_pauses_the_tick_and_keeps_the_row_queued(self):
        self._shift("s1")
        self._shift("s2", email=BOB)
        shift_calendar.enqueue(self.db, ["s1", "s2"])
        self.db.commit()
        out = shift_calendar.sync_once(self.db, now=NOW, graph=FakeGraph(create_status=503))
        self.assertIn("503", out["disabled"])
        self.assertEqual(out["processed"], 0)
        self.assertEqual({r.state for r in self._rows()}, {"pending"})
        self.assertEqual(shift_calendar.status(self.db)["enabled"], False)
        shift_calendar._disabled_until = 0.0
        # The real Graph caller with no token: the same pause, nothing marked.
        from unittest import mock
        with mock.patch("graph_mail.graph_configured", lambda: True), \
                mock.patch("graph_mail.access_token", side_effect=RuntimeError("tenant said no")):
            out = shift_calendar.sync_once(self.db, now=NOW, graph=None)
        self.assertIn("tenant said no", out["disabled"])
        self.assertEqual({r.state for r in self._rows()}, {"pending"})
        shift_calendar._disabled_until = 0.0
        self.assertEqual(shift_calendar.sync_once(self.db, now=NOW, graph=FakeGraph())["created"], 2)


class SkipTests(_Case):
    def _synced(self, sid="s1", **kw):
        self._shift(sid, **kw)
        shift_calendar.enqueue(self.db, [sid])
        self.db.commit()
        g = FakeGraph()
        shift_calendar.sync_once(self.db, now=NOW, graph=g)
        self.assertEqual(self._rows(sid)[0].state, "ok")
        return g

    def test_company_switch_off_skips_and_removes_an_existing_event(self):
        g = self._synced()
        self._settings(outlookCalendar=False)
        shift_calendar.enqueue(self.db, ["s1"])
        self.db.commit()
        out = shift_calendar.sync_once(self.db, now=NOW, graph=g)
        self.assertEqual((out["skipped"], out["deleted"]), (1, 1))
        self.assertEqual(g.calls[-1][:2], ("DELETE", "/users/m365-amy/events/evt-1"))
        row, = self._rows("s1")
        self.assertEqual((row.state, row.event_id), ("skipped", ""))
        self.assertIn("off for this company", row.last_error)

    def test_person_opt_out_skips_and_opting_back_in_recreates(self):
        g = self._synced()
        self.db.add(models.NexusPersonPref(email=AMY, shift_calendar=0))
        shift_calendar.enqueue(self.db, ["s1"])
        self.db.commit()
        out = shift_calendar.sync_once(self.db, now=NOW, graph=g)
        self.assertEqual((out["skipped"], out["deleted"]), (1, 1))
        self.assertIn("opted out", self._rows("s1")[0].last_error)
        self.db.query(models.NexusPersonPref).filter(models.NexusPersonPref.email == AMY).first().shift_calendar = 1
        shift_calendar.enqueue(self.db, ["s1"])
        self.db.commit()
        out = shift_calendar.sync_once(self.db, now=NOW, graph=g)
        self.assertEqual(out["created"], 1)
        self.assertEqual(self._rows("s1")[0].event_id, "evt-2")

    def test_no_m365_account_is_skipped_without_a_call(self):
        self._shift("s1", email=NOMAIL)
        shift_calendar.enqueue(self.db, ["s1"])
        self.db.commit()
        g = FakeGraph()
        out = shift_calendar.sync_once(self.db, now=NOW, graph=g)
        self.assertEqual((out["skipped"], g.calls), (1, []))
        self.assertIn("m365_id", self._rows("s1")[0].last_error)

    def test_a_past_shift_with_no_event_is_skipped_but_one_with_an_event_is_kept_in_step(self):
        # The queue waited weeks for the permission: old shifts must not be written now.
        gone = (datetime.now(timezone.utc).date() - timedelta(days=3)).isoformat()
        self._shift("old", work_date=gone)
        shift_calendar.enqueue(self.db, ["old"])
        self.db.commit()
        g = FakeGraph()
        out = shift_calendar.sync_once(self.db, now=datetime.now(timezone.utc), graph=g)
        self.assertEqual((out["skipped"], out["created"]), (1, 0))
        self.assertEqual(self._rows("old")[0].last_error, "already in the past")
        # Yesterday still counts (a zone behind UTC may still be on it).
        self._shift("yday", work_date=(datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat())
        shift_calendar.enqueue(self.db, ["yday"])
        self.db.commit()
        self.assertEqual(shift_calendar.sync_once(self.db, now=datetime.now(timezone.utc), graph=g)["created"], 1)
        # A past shift that already has an event follows a change (a weather cancel, say).
        row = self._rows("yday")[0]
        self.db.query(models.ScheduledShift).filter(models.ScheduledShift.id == "yday").update({"work_date": gone, "label": "Moved"})
        self.db.commit()
        shift_calendar.enqueue(self.db, ["yday"])
        self.db.commit()
        self.assertEqual(shift_calendar.sync_once(self.db, now=datetime.now(timezone.utc), graph=g)["updated"], 1)
        self.assertEqual(self._rows("yday")[0].event_id, row.event_id)

    def test_a_draft_is_never_sent(self):
        self._shift("s1", published=0)
        shift_calendar.enqueue(self.db, ["s1"])
        self.db.commit()
        g = FakeGraph()
        out = shift_calendar.sync_once(self.db, now=NOW, graph=g)
        self.assertEqual((out["skipped"], g.calls), (1, []))

    def test_weather_cancel_removes_the_event_and_reinstate_brings_it_back(self):
        g = self._synced()
        r = self.db.get(models.ScheduledShift, "s1")
        r.weather_status = "cancelled"
        shift_calendar.enqueue(self.db, ["s1"])
        self.db.commit()
        out = shift_calendar.sync_once(self.db, now=NOW, graph=g)
        self.assertEqual((out["skipped"], out["deleted"]), (1, 1))
        self.assertIn("weather", self._rows("s1")[0].last_error)
        r = self.db.get(models.ScheduledShift, "s1")
        r.weather_status = ""
        shift_calendar.enqueue(self.db, ["s1"])
        self.db.commit()
        self.assertEqual(shift_calendar.sync_once(self.db, now=NOW, graph=g)["created"], 1)

    def test_a_shared_removal_deletes_the_event_and_the_row(self):
        g = self._synced()
        r = self.db.get(models.ScheduledShift, "s1")
        self.db.delete(r)
        self.assertTrue(shift_calendar.enqueue_delete(self.db, "s1", AMY))
        self.db.commit()
        self.assertEqual(self._rows("s1")[0].state, "delete")
        out = shift_calendar.sync_once(self.db, now=NOW, graph=g)
        self.assertEqual(out["deleted"], 1)
        self.assertEqual(g.calls[-1][:2], ("DELETE", "/users/m365-amy/events/evt-1"))
        self.assertEqual(self._rows("s1"), [])

    def test_enqueue_delete_of_a_row_without_an_event_just_drops_it(self):
        self._shift("s1")
        shift_calendar.enqueue(self.db, ["s1"])
        self.assertTrue(shift_calendar.enqueue_delete(self.db, "s1", AMY))
        self.db.commit()
        self.assertEqual(self._rows("s1"), [])
        self.assertFalse(shift_calendar.enqueue_delete(self.db, "s1", AMY))

    def test_a_shift_handed_to_someone_else_moves_the_event(self):
        g = self._synced()
        r = self.db.get(models.ScheduledShift, "s1")
        r.employee_email = BOB   # an offer approved
        shift_calendar.enqueue(self.db, ["s1"])
        self.db.commit()
        states = {x.employee_email: x.state for x in self._rows("s1")}
        self.assertEqual(states, {AMY: "delete", BOB: "pending"})
        out = shift_calendar.sync_once(self.db, now=NOW, graph=g)
        self.assertEqual((out["deleted"], out["created"]), (1, 1))
        paths = [c[1] for c in g.calls[1:]]
        self.assertIn("/users/m365-amy/events/evt-1", paths)
        self.assertIn("/users/m365-bob/events", paths)
        rows = self._rows("s1")
        self.assertEqual([(x.employee_email, x.state) for x in rows], [(BOB, "ok")])


class QueueTests(_Case):
    def test_a_shift_placed_in_the_same_request_is_queued_before_it_is_flushed(self):
        # shift_requests._apply adds the claimed copy of an open shift and
        # queues it in one go; sessions run with autoflush off.
        self.db.add(models.ScheduledShift(id="claimed", employee_email=AMY, work_date=DAY, start_hhmm="07:00",
                                          end_hhmm="15:30", published=1))
        self.assertEqual(shift_calendar.enqueue(self.db, ["claimed"]), 1)
        self.db.commit()
        self.assertEqual([(r.shift_id, r.employee_email, r.state) for r in self._rows()], [("claimed", AMY, "pending")])

    def test_queueing_the_same_shift_twice_in_one_request_makes_one_row(self):
        self._shift("s1")
        shift_calendar.enqueue(self.db, ["s1"])
        shift_calendar.enqueue(self.db, ["s1"])
        self.db.commit()
        self.assertEqual(len(self._rows("s1")), 1)


class BackfillTests(_Case):
    def test_first_tick_with_an_empty_table_queues_every_upcoming_shared_shift_once(self):
        shift_calendar._backfill_checked = False
        self._shift("up", email=AMY)
        self._shift("draft", email=BOB, published=0)
        self.db.add(models.ScheduledShift(id="past", employee_email=AMY, work_date="2020-01-01", published=1))
        self.db.add(models.ScheduledShift(id="open", employee_email="", work_date=DAY, published=1, open_slots=1))
        self.db.commit()
        g = FakeGraph()
        out = shift_calendar.sync_once(self.db, now=NOW, graph=g)
        self.assertEqual(out.get("backfilled"), 1)
        self.assertEqual(out["created"], 1)
        self.assertEqual([r.shift_id for r in self._rows()], ["up"])
        # A second tick does not backfill again, even with the queue drained.
        out = shift_calendar.sync_once(self.db, now=NOW, graph=g)
        self.assertNotIn("backfilled", out)
        self.assertEqual(len(g.calls), 1)

    def test_backfill_is_skipped_when_the_table_already_has_rows(self):
        shift_calendar._backfill_checked = False
        self._shift("s1")
        self.db.add(models.ShiftCalendarEvent(id="x", shift_id="s1", employee_email=AMY, state="ok", event_id="e",
                                              synced_hash="h", updated_at="2026-01-01T00:00:00"))
        self.db.commit()
        out = shift_calendar.sync_once(self.db, now=NOW, graph=FakeGraph())
        self.assertNotIn("backfilled", out)


class BatchTests(_Case):
    def test_a_tick_takes_at_most_fifty_rows(self):
        for i in range(55):
            self.db.add(models.ScheduledShift(id=f"s{i}", employee_email=AMY, work_date=DAY, published=1,
                                              start_hhmm="07:00", end_hhmm="15:30"))
        self.db.commit()
        shift_calendar.enqueue(self.db, [f"s{i}" for i in range(55)])
        self.db.commit()
        g = FakeGraph()
        out = shift_calendar.sync_once(self.db, now=NOW, graph=g)
        self.assertEqual(out["processed"], 50)
        self.assertEqual(shift_calendar.status(self.db)["pending"], 5)
        out = shift_calendar.sync_once(self.db, now=NOW, graph=g)
        self.assertEqual(out["processed"], 5)
        self.assertEqual(shift_calendar.status(self.db)["ok"], 55)


if __name__ == "__main__":
    unittest.main()
