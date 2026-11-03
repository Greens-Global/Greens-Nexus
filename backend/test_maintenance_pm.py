"""
Preventive maintenance (Construction plan phase 5, Neil 11/03/2026).

A schedule set straight on a property (fixed dates, after each completion, by
meter) files ONE ticket per occurrence through tickets.file_ticket - the
property set and locked, the schedule's team, assignee, checklist and due
day - and never a second for the same occurrence. Closing a preventive
ticket writes its maintenance record and moves a floating schedule on.
Company walls on every read, the overdue roll-up, Scan to Request (the
place sheet and Report a Problem), and the technician's Done (a photo is
required on a preventive ticket).

Throwaway sqlite file, no network: BackgroundTasks are never run.
Run with: python -m unittest test_maintenance_pm   (one file per process)
"""
import os
import tempfile
import unittest
from datetime import date, timedelta

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.pop("SUPABASE_URL", None)

from fastapi import BackgroundTasks, HTTPException   # noqa: E402

import cache                                          # noqa: E402
import database                                       # noqa: E402
import maintenance_services as MS                     # noqa: E402
import models                                         # noqa: E402
from routers.task_util import gen_id                  # noqa: E402
from routers import tickets as T                      # noqa: E402
from routers import property_tickets as P             # noqa: E402
from routers import maintenance as MW                 # noqa: E402

ADMIN = {"email": "neil@greensglobal.com", "role": "administrator", "level": 4}
PLAIN = {"email": "amy@greensglobal.com", "role": "employee", "level": 1}
MANAGER = "ankush@greensglobal.com"
MANAGER_USER = {"email": MANAGER, "role": "employee", "level": 2}
TECH = "tom@greensglobal.com"
TECH_USER = {"email": TECH, "role": "administrator", "level": 4}
OTHER = {"email": "olga@other.com", "role": "administrator", "level": 4}
TODAY = date.today()


def iso(days: int) -> str:
    return (TODAY + timedelta(days=days)).isoformat()


class PreventiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except OSError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.TicketMaintenanceRecord, models.PropertyMaintenanceService,
                  models.PropertyMaintenanceOccurrence, models.TaskActivity, models.TaskAttachment,
                  models.TaskComment, models.TaskNotification, models.NexusNotification, models.NexusEmployee,
                  models.NexusRole, models.PropertyAsset, models.HrDepartment, models.HrEntity,
                  models.PropertyRecord, models.NexusCounter, models.WorkflowEvent, models.NexusSetting,
                  models.NexusGroup, models.NexusGroupMember):
            self.db.query(m).execution_options(include_deleted=True).delete()
        for email, company, dept in ((ADMIN["email"], "c1", "Construction & Maintenance"), (PLAIN["email"], "c1", ""),
                                     (MANAGER, "c1", ""), (TECH, "c1", "Construction & Maintenance"),
                                     (OTHER["email"], "c2", "")):
            self.db.add(models.NexusEmployee(id=gen_id(), first_name=email.split("@")[0], work_email=email,
                                             status="active", identity_type="internal", company=company,
                                             department=dept))
        for email in (ADMIN["email"], TECH, OTHER["email"]):
            self.db.add(models.NexusRole(email=email, role="administrator"))
        self.db.add(models.HrEntity(id="c1", name="Greens Storage"))
        self.db.add(models.HrEntity(id="c2", name="Other Co"))
        self.db.add(models.HrDepartment(id="d-fac", company_id="c1", name="Construction & Maintenance"))
        self.db.add(models.HrDepartment(id="d-hr", company_id="c1", name="Human Resources"))
        self.db.add(models.HrDepartment(id="d-fac2", company_id="c2", name="Construction & Maintenance"))
        # Company walls on, so c1 and c2 are apart for administrators.
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        contacts = {"pm / asset manager": {"email": MANAGER}}
        self.db.add(models.PropertyAsset(
            id="gst", name="Greens Storage Temecula", manager="Ankush", asset_type="Self-Storage",
            payload={"id": "gst", "name": "Greens Storage Temecula", "kind": "property", "contacts": contacts,
                     "city": "Temecula", "state": "CA"}))
        self.db.add(models.PropertyAsset(id="truck", name="F-250", asset_type="Vehicle",
                                         payload={"kind": "vehicle", "odometer": "41,000"}))
        self.db.add(models.PropertyAsset(id="lift", name="Scissor Lift", asset_type="Heavy Equipment",
                                         payload={"kind": "equipment", "hours": 120}))
        self.db.add(models.PropertyAsset(id="vault", name="Private Deal", payload={"kind": "property", "private": True}))
        self.db.commit()
        cache.module_grants.invalidate()
        cache.settings_config.invalidate()

    def tearDown(self):
        self.db.close()

    # ── helpers ──
    def _schedule(self, user=ADMIN, **kw):
        body = P.ScheduleBody(**{"kind": "calendar", "subject": "HVAC Filter Change", "hr_department_id": "d-fac",
                                 "application": "HVAC", "next_due": iso(5), "recurrence_unit": "month",
                                 "recurrence_every": 1, "checklist": ["Change the filter", "Check the drain"], **kw})
        return P.create_schedule("gst", body, user=user, db=self.db)["serviceId"]

    def _svc(self, sid):
        self.db.expire_all()
        return self.db.get(models.PropertyMaintenanceService, sid)

    def _tickets(self, sid):
        self.db.expire_all()
        return self.db.query(models.TaskTicket).filter(models.TaskTicket.service_id == sid).all()

    def _events(self, key):
        return self.db.query(models.WorkflowEvent).filter(models.WorkflowEvent.key == key).count()

    def _resolve(self, tid, user=ADMIN):
        T.update_ticket(tid, T.TicketUpdate(status="resolved", resolution="fixed", resolution_note="Done",
                                            maintenance_cost="85"), BackgroundTasks(), user=user, db=self.db)

    # ── fixed calendar ──
    def test_a_fixed_schedule_files_one_ticket_on_its_lead_day_and_rolls_on(self):
        sid = self._schedule(lead_days=3, assignee_email=TECH)
        self.assertEqual(MS.run_preventive(self.db, TODAY)["filed"], 0)          # 5 days out, 3 days lead
        self.assertEqual(MS.run_preventive(self.db, TODAY + timedelta(days=2))["filed"], 1)
        [t] = self._tickets(sid)
        self.assertEqual((t.property_asset_id, t.property_locked, t.hr_department_id, t.source, t.pm_due_on),
                         ("gst", 1, "d-fac", "preventive", iso(5)))
        self.assertEqual(t.assignee_email, TECH)
        self.assertEqual([c["label"] for c in t.type_fields["checklist"]], ["Change the filter", "Check the drain"])
        self.assertEqual(t.company_id, "c1")
        svc = self._svc(sid)
        self.assertEqual(svc.next_due, MS.advance(date.fromisoformat(iso(5)), "month", 1).isoformat())
        self.assertEqual(svc.last_ticket_id, t.id)
        self.assertEqual(self._events("preventive.generated"), 1)
        # The next scan, and the same day again: nothing new.
        self.assertEqual(MS.run_preventive(self.db, TODAY + timedelta(days=3))["filed"], 0)
        self.assertEqual(len(self._tickets(sid)), 1)

    def test_a_property_holds_many_schedules_without_a_parent_ticket(self):
        ids = [self._schedule(subject=f"Service {i}") for i in range(3)]   # parent_ticket_id is unique: NULLs
        self.assertEqual(len(set(ids)), 3)
        self.assertTrue(all(self._svc(i).parent_ticket_id is None for i in ids))

    def test_one_ticket_per_occurrence_whoever_races(self):
        sid = self._schedule(next_due=iso(0))
        svc = self._svc(sid)
        first = MS.file_preventive(self.db, svc, iso(0), iso(0), ADMIN, BackgroundTasks())
        self.assertIsNotNone(first)
        svc = self._svc(sid)
        again = MS.file_preventive(self.db, svc, iso(0), iso(0), ADMIN, BackgroundTasks())
        self.assertIsNone(again)                          # the unique (schedule, due date) key
        self.assertEqual(len(self._tickets(sid)), 1)
        self.assertEqual(self.db.query(models.PropertyMaintenanceOccurrence).count(), 1)

    def test_open_now_files_the_coming_occurrence_once(self):
        sid = self._schedule(next_due=iso(20))
        out = P.open_service_now("gst", sid, user=MANAGER_USER, db=self.db)
        self.assertTrue(out["ticketId"])
        svc = self._svc(sid)
        self.assertEqual(svc.next_due, MS.advance(date.fromisoformat(iso(20)), "month", 1).isoformat())
        # The scan on the old due day finds nothing to file: its occurrence is done.
        self.assertEqual(MS.run_preventive(self.db, TODAY + timedelta(days=20))["filed"], 0)

    # ── floating ──
    def test_a_floating_schedule_waits_for_the_last_ticket_then_counts_from_its_close(self):
        sid = self._schedule(kind="floating", next_due=iso(0), recurrence_unit="day", recurrence_every=30)
        self.assertEqual(MS.run_preventive(self.db, TODAY)["filed"], 1)
        self.assertEqual(self._svc(sid).next_due, "")
        self.assertEqual(MS.run_preventive(self.db, TODAY + timedelta(days=40))["filed"], 0)   # still open
        [t] = self._tickets(sid)
        self._resolve(t.id)
        svc = self._svc(sid)
        closed_on = MS.business_date(self.db.get(models.TaskTicket, t.id).resolved_at)
        self.assertEqual(svc.next_due, (closed_on + timedelta(days=30)).isoformat())
        # ...and closing it wrote its maintenance record, the existing row.
        rec = self.db.query(models.TicketMaintenanceRecord).filter_by(ticket_id=t.id).one()
        self.assertEqual((rec.property_asset_id, rec.cost, rec.system), ("gst", "85.00", rec.system))

    def test_a_ticket_closed_without_work_writes_no_record(self):
        sid = self._schedule(next_due=iso(0))
        MS.run_preventive(self.db, TODAY)
        [t] = self._tickets(sid)
        T.update_ticket(t.id, T.TicketUpdate(status="closed", resolution="duplicate", resolution_note="Dup"),
                        BackgroundTasks(), user=ADMIN, db=self.db)
        self.assertEqual(self.db.query(models.TicketMaintenanceRecord).count(), 0)

    # ── meter ──
    def test_a_meter_schedule_files_when_the_reading_passes_and_waits_while_open(self):
        sid = self._schedule(kind="meter", asset_id="truck", meter_every=5000, meter_next=45000)
        self.assertEqual(MS.run_preventive(self.db, TODAY)["filed"], 0)       # 41,000 < 45,000
        self.db.add(models.PropertyRecord(id=gen_id(), property_id="truck", collection="odometer",
                                          payload={"date": iso(0), "mileage": "45,250"}))
        self.db.commit()
        self.assertEqual(MS.run_preventive(self.db, TODAY)["filed"], 1)
        [t] = self._tickets(sid)
        self.assertEqual((t.equipment_asset_id, t.property_asset_id), ("truck", "gst"))
        svc = self._svc(sid)
        self.assertEqual((svc.meter_last, svc.meter_next, svc.meter_field), (45250, 50000, "odometer"))
        self.db.add(models.PropertyRecord(id=gen_id(), property_id="truck", collection="odometer",
                                          payload={"date": iso(0), "mileage": "51000"}))
        self.db.commit()
        self.assertEqual(MS.run_preventive(self.db, TODAY)["filed"], 0)       # the last one is still open
        self._resolve(t.id)
        self.assertEqual(MS.run_preventive(self.db, TODAY)["filed"], 1)

    def test_equipment_hours_meter(self):
        sid = self._schedule(kind="meter", asset_id="lift", meter_every=250)
        self.assertEqual(self._svc(sid).meter_next, 370)                      # 120 h + 250
        self.assertEqual(self._svc(sid).meter_field, "hours")

    # ── rules and walls ──
    def test_a_schedule_follows_the_ticket_property_rules(self):
        with self.assertRaises(HTTPException) as cm:                          # HR never sits on a property
            self._schedule(hr_department_id="d-hr")
        self.assertEqual(cm.exception.status_code, 400)
        with self.assertRaises(HTTPException) as cm:                          # a vehicle is not a property
            P.create_schedule("truck", P.ScheduleBody(subject="x", hr_department_id="d-fac", next_due=iso(3)),
                              user=ADMIN, db=self.db)
        self.assertIn(cm.exception.status_code, (400, 404))
        with self.assertRaises(HTTPException):                                # a past first due date
            self._schedule(next_due=iso(-1))
        with self.assertRaises(HTTPException):                                # meter needs equipment
            self._schedule(kind="meter", meter_every=100)
        with self.assertRaises(HTTPException) as cm:                          # only the keepers
            self._schedule(user=PLAIN)
        self.assertIn(cm.exception.status_code, (403, 404))

    def test_another_companys_team_is_behind_the_wall(self):
        import auth
        if auth.company_scope(OTHER, self.db) is None:
            self.skipTest("company walls are not armed in this build")
        with self.assertRaises(HTTPException) as cm:
            self._schedule(hr_department_id="d-fac2")
        self.assertEqual(cm.exception.status_code, 404)

    def test_only_the_desk_names_an_assignee(self):
        with self.assertRaises(HTTPException) as cm:
            self._schedule(user=MANAGER_USER, assignee_email=TECH)
        self.assertEqual(cm.exception.status_code, 403)

    def test_the_property_lists_its_schedules_with_open_and_overdue(self):
        sid = self._schedule(next_due=iso(0))
        MS.run_preventive(self.db, TODAY)
        t = self._tickets(sid)[0]
        t.pm_due_on = iso(-2)
        self.db.commit()
        view = P.property_tickets("gst", user=MANAGER_USER, db=self.db)
        [svc] = [s for s in view["services"] if s["id"] == sid]
        self.assertEqual((svc["kind"], svc["openCount"], svc["overdueCount"]), ("calendar", 1, 1))
        self.assertEqual(svc["checklist"], ["Change the filter", "Check the drain"])
        self.assertEqual(view["preventive"], {"open": 1, "overdue": 1})

    def test_the_editor_offers_property_teams_and_equipment_readings(self):
        out = P.schedule_options("gst", user=ADMIN, db=self.db)
        self.assertEqual([d["id"] for d in out["departments"]], ["d-fac"])          # HR never; c2 walled off
        readings = {e["id"]: e["readingLabel"] for e in out["equipment"]}
        self.assertEqual(readings, {"lift": "120 h", "truck": "41,000 mi"})
        self.assertTrue(out["canAssign"])
        with self.assertRaises(HTTPException):
            P.schedule_options("gst", user=PLAIN, db=self.db)

    # ── overdue per site ──
    def test_the_roll_up_counts_overdue_per_property_and_company_and_tells_workflows_once(self):
        sid = self._schedule(next_due=iso(0))
        MS.run_preventive(self.db, TODAY)
        t = self._tickets(sid)[0]
        t.pm_due_on = iso(-3)
        self.db.commit()
        out = MW.rollup(user=ADMIN, db=self.db)
        self.assertEqual((out["open"], out["overdue"]), (1, 1))
        self.assertEqual(out["properties"][0]["propertyName"], "Greens Storage Temecula")
        self.assertEqual(out["companies"][0]["companyName"], "Greens Storage")
        MS.run_preventive(self.db, TODAY)
        MS.run_preventive(self.db, TODAY)
        self.assertEqual(self._events("preventive.overdue"), 1)
        with self.assertRaises(HTTPException):
            MW.rollup(user=PLAIN, db=self.db)

    def test_the_roll_up_and_the_place_sheet_stay_inside_the_wall(self):
        import auth
        if auth.company_scope(OTHER, self.db) is None:
            self.skipTest("company walls are not armed in this build")
        sid = self._schedule(next_due=iso(0))
        MS.run_preventive(self.db, TODAY)
        self.assertEqual(len(self._tickets(sid)), 1)
        self.assertEqual(MW.rollup(user=OTHER, db=self.db)["open"], 0)
        self.assertEqual(MW.place("gst", user=OTHER, db=self.db)["tickets"], [])

    # ── Scan to Request ──
    def test_a_site_tag_opens_its_open_tickets_and_reports_a_problem_with_the_equipment(self):
        out = MW.place("gst", asset="truck", user=PLAIN, db=self.db)
        self.assertEqual(out["asset"]["name"], "F-250")
        topics = {o["topic"] for o in out["topics"]}
        self.assertTrue(topics)
        topic = sorted(topics)[0]
        made = MW.report_problem("gst", MW.ReportBody(topic=topic, subject="Brakes squeal", asset_id="truck",
                                                      unit="Common Area"),
                                 BackgroundTasks(), user=PLAIN, db=self.db)
        t = self.db.get(models.TaskTicket, made["id"])
        self.assertEqual((t.property_asset_id, t.equipment_asset_id, t.property_locked, t.source),
                         ("gst", "truck", 1, "scan"))
        again = MW.place("gst", asset="truck", user=PLAIN, db=self.db)
        self.assertEqual([r["subject"] for r in again["tickets"]], ["Brakes squeal"])
        self.assertTrue(again["tickets"][0]["canOpen"])            # their own ticket
        self.assertEqual(MW.place("gst", asset="lift", user=PLAIN, db=self.db)["tickets"], [])

    def test_a_private_or_unknown_place_is_not_found(self):
        for pid, asset in (("vault", ""), ("nope", ""), ("gst", "nope"), ("truck", "")):
            with self.assertRaises(HTTPException) as cm:
                MW.place(pid, asset=asset, user=PLAIN, db=self.db)
            self.assertEqual(cm.exception.status_code, 404)

    def test_tags_are_the_site_and_its_equipment_with_the_company_name(self):
        self._schedule(kind="meter", asset_id="truck", meter_every=5000)
        out = MW.place_tags(MW.TagsBody(property_id="gst"), user=MANAGER_USER, db=self.db)
        self.assertEqual([(t["kind"], t["path"]) for t in out["tags"]],
                         [("site", "/tickets/place/gst"), ("equipment", "/tickets/place/gst/truck")])
        self.assertEqual(out["tags"][0]["companyName"], "Greens Storage")
        with self.assertRaises(HTTPException):
            MW.place_tags(MW.TagsBody(property_id="gst"), user=PLAIN, db=self.db)

    # ── My Work ──
    def test_my_work_lists_preventive_first_and_done_needs_a_photo(self):
        sid = self._schedule(next_due=iso(0), assignee_email=TECH)
        MS.run_preventive(self.db, TODAY)
        self._one_plain()
        work = MW.my_work(user=TECH_USER, db=self.db)
        self.assertGreaterEqual(len(work["tickets"]), 2)
        self.assertTrue(work["tickets"][0]["preventive"])
        tid = self._tickets(sid)[0].id
        MW.start_work(tid, BackgroundTasks(), user=TECH_USER, db=self.db)
        self.assertEqual(self.db.get(models.TaskTicket, tid).status, "in_progress")
        MW.tick(tid, MW.TickBody(label="Change the filter", done=True), BackgroundTasks(), user=TECH_USER, db=self.db)
        with self.assertRaises(HTTPException) as cm:
            MW.done_work(tid, MW.DoneBody(note="Swapped the filter"), BackgroundTasks(), user=TECH_USER, db=self.db)
        self.assertEqual(cm.exception.status_code, 400)
        MW.done_work(tid, MW.DoneBody(note="Swapped the filter", photos=["https://example.com/after.jpg"]),
                     BackgroundTasks(), user=TECH_USER, db=self.db)
        self.db.expire_all()
        t = self.db.get(models.TaskTicket, tid)
        self.assertEqual(t.status, "resolved")
        self.assertEqual([c["done"] for c in t.type_fields["checklist"]], [True, False])
        self.assertEqual(self.db.query(models.TaskAttachment).filter_by(task_id=tid, kind="image").count(), 1)
        self.assertEqual(self.db.query(models.TicketMaintenanceRecord).filter_by(ticket_id=tid).count(), 1)

    def _one_plain(self):
        body = T.TicketBody(subject="Gate stuck", application="Gate Access", hr_department_id="d-fac",
                            property_asset_id="gst", assignee_email=TECH, property_unit="Common Area")
        return T.create_ticket(body, BackgroundTasks(), user=ADMIN, db=self.db)

    # ── the legacy service from a ticket is untouched ──
    def test_a_service_set_from_a_ticket_keeps_its_old_path(self):
        t = self._one_plain()
        T.update_ticket(t["id"], T.TicketUpdate(status="resolved", resolution_note="Fixed"), BackgroundTasks(),
                        user=ADMIN, db=self.db)
        out = P.add_maintenance_record("gst", t["id"], P.MaintenanceRecordBody(
            description="Fixed", next_service_due=iso(30), recurrence_unit="year"), user=MANAGER_USER, db=self.db)
        svc = self._svc(out["serviceId"])
        self.assertEqual(svc.kind or "", "")
        self.assertEqual(MS.run_due(self.db, TODAY + timedelta(days=30))["opened"], 1)
        self.db.commit()
        child = self.db.query(models.TaskTicket).filter(models.TaskTicket.parent_ticket_id == t["id"]).one()
        self.assertEqual(child.pm_due_on, iso(30))
        self.assertEqual(MS.run_preventive(self.db, TODAY + timedelta(days=30))["filed"], 0)


if __name__ == "__main__":
    unittest.main()
