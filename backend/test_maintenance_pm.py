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
                  models.NexusGroup, models.NexusGroupMember, models.NexusAccessScope):
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

    def _photo(self, tid):
        self.db.add(models.TaskAttachment(id=gen_id(), task_id=tid, name="after.jpg", size="", kind="image",
                                          url="https://example.com/after.jpg", added_at="", added_by=ADMIN["email"]))
        self.db.commit()

    def _resolve(self, tid, user=ADMIN, photo=True):
        if photo:
            self._photo(tid)
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
        # A ticket-born service keeps its old behavior (review L3): no due day,
        # so no Preventive queue, no overdue, no photo rule.
        self.assertEqual(child.pm_due_on, "")
        self.assertFalse(MS.is_preventive_ticket(child))
        self.assertEqual(MW.rollup(user=ADMIN, db=self.db)["open"], 0)
        self.assertEqual(MS.run_preventive(self.db, TODAY + timedelta(days=30))["filed"], 0)
        T.update_ticket(child.id, T.TicketUpdate(status="resolved", resolution_note="Done again"), BackgroundTasks(),
                        user=ADMIN, db=self.db)      # no photo needed

    # ── code review fixes (11/03/2026) ──
    def _editor(self, email="eddie@greensglobal.com", company="c2"):
        self.db.add(models.NexusEmployee(id=gen_id(), first_name="Eddie", work_email=email, status="active",
                                         identity_type="internal", company=company))
        self.db.add(models.NexusGroup(id="g-ed", name="Asset Editors", allowed_modules="property-asset:editor"))
        self.db.add(models.NexusGroupMember(group_id="g-ed", email=email))
        self.db.commit()
        cache.module_grants.invalidate()
        return {"email": email, "role": "employee", "level": 2}

    def _walls_off(self):
        self.db.query(models.NexusSetting).filter(models.NexusSetting.key == "company_walls").delete()
        self.db.commit()
        cache.settings_config.invalidate()

    def test_h1_the_ticket_carries_the_teams_company_whoever_saved_the_schedule(self):
        self._walls_off()
        ed = self._editor(company="c2")                 # a non-admin asset editor from another company
        sid = self._schedule(user=ed, next_due=iso(0))
        self.assertEqual(MS.run_preventive(self.db, TODAY)["filed"], 1)
        [t] = self._tickets(sid)
        self.assertEqual((t.company_id, t.hr_department_id, t.created_by_email), ("c1", "d-fac", ed["email"]))

    def test_h1_a_team_from_another_company_than_the_propertys_is_refused(self):
        self._walls_off()
        with self.assertRaises(HTTPException) as cm:     # past every wall (a Super Administrator); gst is c1's
            self._schedule(user={"email": ADMIN["email"], "role": "owner", "level": 5}, hr_department_id="d-fac2")
        self.assertEqual(cm.exception.status_code, 400)
        self.assertIn("company this property belongs to", cm.exception.detail)

    def test_m1_an_occurrence_already_filed_moves_the_schedule_on_never_a_second_ticket(self):
        sid = self._schedule(next_due=iso(0))
        self.db.add(models.PropertyMaintenanceOccurrence(id=gen_id(), service_id=sid, due_key=iso(0), due_on=iso(0),
                                                         ticket_id="elsewhere", created_at=""))
        self.db.commit()
        out = MS.run_preventive(self.db, TODAY)
        self.assertEqual((out["filed"], out["collided"]), (0, 1))
        self.assertEqual(self._tickets(sid), [])
        self.assertEqual(self._svc(sid).next_due, MS.advance(TODAY, "month", 1).isoformat())
        self.assertEqual(MS.run_preventive(self.db, TODAY)["collided"], 0)      # not stuck

    def test_m1_a_save_onto_a_filed_date_or_from_a_stale_editor_is_refused(self):
        sid = self._schedule(next_due=iso(0))
        MS.run_preventive(self.db, TODAY)                                       # files iso(0)
        svc = self._svc(sid)
        with self.assertRaises(HTTPException) as cm:
            P.update_service("gst", sid, P.ServicePatch(next_due=iso(0), rev=svc.updated_at), user=ADMIN, db=self.db)
        self.assertEqual(cm.exception.status_code, 400)
        with self.assertRaises(HTTPException) as cm:
            P.update_service("gst", sid, P.ServicePatch(subject="Renamed", rev="an-old-rev"), user=ADMIN, db=self.db)
        self.assertEqual(cm.exception.status_code, 409)
        P.update_service("gst", sid, P.ServicePatch(subject="Renamed", rev=self._svc(sid).updated_at),
                         user=ADMIN, db=self.db)
        self.assertEqual(self._svc(sid).template["subject"], "Renamed")

    def _log(self, mileage, day):
        self.db.add(models.PropertyRecord(id=gen_id(), property_id="truck", collection="odometer",
                                          payload={"date": day, "mileage": str(mileage)}))
        self.db.commit()

    def test_m2_the_newest_reading_counts_not_the_largest(self):
        self._log(60000, iso(-30))
        self._log(45000, iso(-1))
        self.assertEqual(MS.asset_reading(self.db, self.db.get(models.PropertyAsset, "truck"), "odometer"), 45000)

    def test_m2_a_reset_meter_rebases_and_tells_the_manager(self):
        sid = self._schedule(kind="meter", asset_id="truck", meter_every=5000, meter_next=45000)
        self._log(45250, iso(-1))
        self.assertEqual(MS.run_preventive(self.db, TODAY)["filed"], 1)
        self._resolve(self._tickets(sid)[0].id)
        self._log(1200, iso(0))                                                 # a new odometer
        self.assertEqual(MS.run_preventive(self.db, TODAY)["filed"], 0)
        svc = self._svc(sid)
        self.assertEqual((svc.meter_last, svc.meter_next, svc.attention), (1200, 6200, "reset:1200"))
        bells = self.db.query(models.NexusNotification).filter_by(type="task_pm_attention", recipient=MANAGER).all()
        self.assertEqual(len(bells), 1)

    def test_m2_a_huge_jump_waits_for_a_person_to_confirm(self):
        sid = self._schedule(kind="meter", asset_id="truck", meter_every=5000, meter_next=45000)
        self._log(45250, iso(-1))
        MS.run_preventive(self.db, TODAY)
        self._resolve(self._tickets(sid)[0].id)
        self._log(95000, iso(0))                                                # > 3 x 5,000 past 45,250
        self.assertEqual(MS.run_preventive(self.db, TODAY)["filed"], 0)
        self.assertEqual(MS.run_preventive(self.db, TODAY)["filed"], 0)          # still held, one bell
        self.assertEqual(self._svc(sid).attention, "reading:95000")
        self.assertEqual(self.db.query(models.NexusNotification).filter_by(type="task_pm_attention").count(), 1)
        P.update_service("gst", sid, P.ServicePatch(confirm_reading=True, rev=self._svc(sid).updated_at),
                         user=ADMIN, db=self.db)
        self.assertEqual(MS.run_preventive(self.db, TODAY)["filed"], 1)

    def test_m3_today_is_the_companys_calendar(self):
        from datetime import datetime
        from unittest import mock
        from zoneinfo import ZoneInfo
        import shift_expect
        with mock.patch.object(shift_expect, "team_tz", lambda db, cid="": "Pacific/Kiritimati" if cid == "c1" else "Pacific/Pago_Pago"):
            self.assertEqual(MS.local_today(self.db, "c1"), datetime.now(ZoneInfo("Pacific/Kiritimati")).date())
            self.assertEqual(MS.local_today(self.db, "c2"), datetime.now(ZoneInfo("Pacific/Pago_Pago")).date())

    def test_m4_a_stranger_who_scans_sees_only_that_something_is_open(self):
        body = T.TicketBody(subject="Gate stuck", application="Gate Access", hr_department_id="d-fac",
                            property_asset_id="gst", property_unit="Common Area")
        T.create_ticket(body, BackgroundTasks(), user=ADMIN, db=self.db)
        [line] = MW.place("gst", user=PLAIN, db=self.db)["tickets"]
        self.assertEqual((line["subject"], line["priority"], line["unit"], line["canOpen"]), ("Open Request", "", "", False))
        self.assertTrue(line["id"].startswith("open-"))
        ed = self._editor(company="c1")
        [line] = MW.place("gst", user=ed, db=self.db)["tickets"]                # the asset team sees the summary
        self.assertEqual(line["subject"], "Gate stuck")

    def test_m4_property_asset_scope_rows_narrow_the_place_and_the_picker(self):
        self.db.add(models.NexusAccessScope(id=gen_id(), email=PLAIN["email"], module_id="property-asset",
                                            scope_type="property", scope_id="somewhere-else"))
        self.db.commit()
        with self.assertRaises(HTTPException) as cm:
            MW.place("gst", user=PLAIN, db=self.db)
        self.assertEqual(cm.exception.status_code, 404)
        self.assertEqual([p["id"] for p in P.list_ticket_properties(user=PLAIN, db=self.db)["properties"]], [])

    def test_l1_a_schedule_nobody_can_file_as_needs_an_owner_one_bell(self):
        sid = self._schedule(next_due=iso(0))
        svc = self._svc(sid)
        svc.updated_by_email = svc.created_by_email = "gone@greensglobal.com"
        self.db.commit()
        MS.run_preventive(self.db, TODAY)
        MS.run_preventive(self.db, TODAY)
        self.assertEqual(self._svc(sid).attention, "owner")
        self.assertEqual(self.db.query(models.NexusNotification).filter_by(type="task_pm_attention").count(), 1)
        view = P.property_tickets("gst", user=MANAGER_USER, db=self.db)
        self.assertEqual([s["attentionLabel"] for s in view["services"]], ["Needs an Owner"])
        P.update_service("gst", sid, P.ServicePatch(subject="Mine Now", rev=self._svc(sid).updated_at),
                         user=ADMIN, db=self.db)                                 # a save takes it over
        self.assertEqual(self._svc(sid).attention, "")
        self.assertEqual(MS.run_preventive(self.db, TODAY)["filed"], 1)

    def test_l1_the_keeper_gets_no_requester_mail(self):
        import ticket_notify
        sid = self._schedule(next_due=iso(0))
        MS.run_preventive(self.db, TODAY)
        [t] = self._tickets(sid)
        self.assertEqual(t.source, "preventive")
        seen = []
        orig, orig_render = ticket_notify._recipients_for, ticket_notify._render

        def render(*a, **k):
            seen.append(a)
            raise RuntimeError("stop here - the mail would have been built")
        try:
            ticket_notify._recipients_for = lambda db, tt, ev, cfg: [(tt.requester_email, "requester")]
            ticket_notify._render = render
            ticket_notify.notify_ticket_event(t.id, "resolved", "x@greensglobal.com")
            self.assertEqual(seen, [])                       # the keeper: no mail at all
            t.source = ""                                    # the same ticket filed by a person: the requester hears
            self.db.commit()
            try:
                ticket_notify.notify_ticket_event(t.id, "resolved", "x@greensglobal.com")
            except RuntimeError:
                pass
        finally:
            ticket_notify._recipients_for, ticket_notify._render = orig, orig_render
        self.assertEqual(len(seen), 1)

    def test_l2_deleting_a_floating_schedules_open_ticket_restarts_it(self):
        sid = self._schedule(kind="floating", next_due=iso(0), recurrence_unit="day", recurrence_every=30)
        MS.run_preventive(self.db, TODAY)
        [t] = self._tickets(sid)
        t.deleted_at, t.deleted_by = "2026-11-03T10:00:00Z", ADMIN["email"]
        self.db.commit()
        svc = self._svc(sid)
        self.assertEqual(svc.next_due, MS.local_today(self.db, "c1").isoformat())
        out = MS.run_preventive(self.db, MS.local_today(self.db, "c1"))
        self.assertEqual(out["filed"] + out["collided"], 1)                      # never stuck

    def test_l4_one_failing_schedule_never_stops_the_scan(self):
        from unittest import mock
        bad = self._schedule(subject="Bad", next_due=iso(0))
        good = self._schedule(subject="Good", next_due=iso(0))
        real = MS.due_occurrence

        def flaky(db, svc, today):
            if svc.id == bad:
                raise RuntimeError("boom")
            return real(db, svc, today)
        with mock.patch.object(MS, "due_occurrence", flaky):
            out = MS.run_preventive(self.db, TODAY)
        self.assertEqual((out["failed"], out["filed"]), (1, 1))
        self.assertEqual(len(self._tickets(good)), 1)

    def test_l5_overdue_is_told_even_when_the_next_ticket_is_refused(self):
        from unittest import mock
        sid = self._schedule(kind="calendar", next_due=iso(0), recurrence_unit="day", recurrence_every=1)
        MS.run_preventive(self.db, TODAY)
        [t] = self._tickets(sid)
        t.pm_due_on = iso(-2)
        self.db.commit()

        def refuse(*a, **k):
            raise HTTPException(400, "nope")
        with mock.patch.object(T, "file_ticket", refuse):
            out = MS.run_preventive(self.db, TODAY + timedelta(days=1))
        self.assertEqual(out["skipped"], 1)
        self.assertEqual(self._events("preventive.overdue"), 1)

    def test_l6_the_editor_offers_only_equipment_in_the_callers_scope(self):
        ed = self._editor(company="c1")
        self.db.add(models.NexusAccessScope(id=gen_id(), email=ed["email"], module_id="property-asset",
                                            scope_type="property", scope_id="gst"))
        self.db.commit()
        out = P.schedule_options("gst", user=ed, db=self.db)
        self.assertEqual(out["equipment"], [])

    def test_l7_every_resolve_path_needs_the_photo_on_a_preventive_ticket(self):
        sid = self._schedule(next_due=iso(0))
        MS.run_preventive(self.db, TODAY)
        [t] = self._tickets(sid)
        with self.assertRaises(HTTPException) as cm:                             # the drawer's PATCH
            self._resolve(t.id, photo=False)
        self.assertEqual(cm.exception.status_code, 400)
        T.update_ticket(t.id, T.TicketUpdate(status="closed", resolution="duplicate", resolution_note="Dup"),
                        BackgroundTasks(), user=ADMIN, db=self.db)              # closed without work: no photo


if __name__ == "__main__":
    unittest.main()
