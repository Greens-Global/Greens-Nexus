"""
A ticket on a property files under the property's company (Neil, 11/03/2026:
"Should a property ticket take the property's company?" - "Yes").

ticket_property_company is the ONE rule, read by every door: the desk's New
Ticket and the property's Tickets panel (create_ticket -> file_ticket),
Report a Problem (Scan to Request), Batch Create (walkthroughs), preventive
maintenance (the team's company still wins - review H1) and update_ticket
when the property changes. A property still under "Needs a Company" (only
the weak asset-manager guess) changes nothing; nobody is moved out of sight
of a ticket they filed or are named on.

Throwaway sqlite file, no network: BackgroundTasks are never run.
Run with: python -m unittest test_ticket_property_company   (one file per process)
"""
import os
import tempfile
import unittest
import uuid
from datetime import date, timedelta

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.pop("SUPABASE_URL", None)

from fastapi import BackgroundTasks, Response        # noqa: E402

import cache                                          # noqa: E402
import database                                       # noqa: E402
import maintenance_services as MS                     # noqa: E402
import models                                         # noqa: E402
import ticket_property_company as TPC                 # noqa: E402
from routers.task_util import gen_id                  # noqa: E402
from routers import tickets as T                      # noqa: E402
from routers import property_tickets as P             # noqa: E402
from routers import maintenance as MW                 # noqa: E402
from routers import ticket_walkthroughs as W          # noqa: E402

AMY = {"email": "amy@greensglobal.com", "role": "employee", "level": 1}          # c1
BOB = {"email": "bob@greensglobal.com", "role": "employee", "level": 1}          # c2
ADMIN = {"email": "neil@greensglobal.com", "role": "administrator", "level": 4}  # c1, Administrator
SUPER = {"email": "visesh@greensglobal.com", "role": "owner", "level": 5}        # Super Administrator
WALKER = {"email": "pranshu@greensglobal.com", "role": "employee", "level": 2}   # c1, Asset Team
MANAGER = "ankush@greensglobal.com"                                              # c2, asset manager
APP = "Plumbing or Water Leak"
TODAY = date.today()


class TicketPropertyCompanyTests(unittest.TestCase):
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
        for m in (models.TaskTicket, models.TicketBatch, models.TicketMaintenanceRecord,
                  models.PropertyMaintenanceService, models.PropertyMaintenanceOccurrence, models.TaskActivity,
                  models.TaskAttachment, models.TaskComment, models.TaskNotification, models.NexusNotification,
                  models.NexusEmployee, models.NexusRole, models.PropertyAsset, models.HrDepartment,
                  models.TicketDepartment, models.HrEntity, models.PropertyRecord, models.NexusCounter,
                  models.WorkflowEvent, models.NexusSetting, models.NexusGroup, models.NexusGroupMember,
                  models.NexusAccessScope, models.Item, models.TicketItemLink):
            self.db.query(m).execution_options(include_deleted=True).delete()
        for email, company in ((AMY["email"], "c1"), (BOB["email"], "c2"), (ADMIN["email"], "c1"),
                               (SUPER["email"], "c1"), (WALKER["email"], "c1"), (MANAGER, "c2")):
            self.db.add(models.NexusEmployee(id=gen_id(), first_name=email.split("@")[0], work_email=email,
                                             status="active", identity_type="internal", company=company))
        self.db.add(models.NexusRole(email=ADMIN["email"], role="administrator"))
        self.db.add(models.NexusRole(email=SUPER["email"], role="owner"))
        self.db.add(models.NexusGroup(id="g-asset", name="Asset Team", allowed_modules="property-asset:editor"))
        self.db.add(models.NexusGroupMember(group_id="g-asset", email=WALKER["email"]))
        for cid, name in (("c1", "Greens Storage"), ("c2", "Greens Construction"), ("c3", "Greens Land")):
            self.db.add(models.HrEntity(id=cid, name=name))
        for did, cid in (("d-fac1", "c1"), ("d-fac2", "c2"), ("d-fac3", "c3")):
            self.db.add(models.HrDepartment(id=did, company_id=cid, name="Construction & Maintenance"))
        self.db.add(models.HrDepartment(id="d-shared", company_id="", name="Construction & Maintenance"))
        contacts = {"pm / asset manager": {"email": MANAGER}}
        self.db.add(models.PropertyAsset(id="p2", name="Temecula", asset_type="Self-Storage",
                                         payload={"kind": "property", "companyId": "c2"}))
        self.db.add(models.PropertyAsset(id="p3", name="Murrieta", asset_type="Self-Storage",
                                         payload={"kind": "property", "companyId": "c3"}))
        # Needs a Company: nothing but the asset manager (c2) - a weak guess.
        self.db.add(models.PropertyAsset(id="pblank", name="Hemet", manager="Ankush", asset_type="Self-Storage",
                                         payload={"kind": "property", "contacts": contacts}))
        # A parcel with no Company of its own: its lead property's (strong).
        self.db.add(models.PropertyAsset(id="p2-parcel", name="Temecula Parcel 2", parent_id="p2",
                                         payload={"kind": "property"}))
        self.db.commit()
        cache.module_grants.invalidate()
        cache.settings_config.invalidate()

    def tearDown(self):
        self.db.close()

    # ── helpers ──
    def _walls(self, on=True):
        self.db.query(models.NexusSetting).filter(models.NexusSetting.key == "company_walls").delete()
        if on:
            self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()

    def _file(self, user=AMY, prop="p2", dept="d-fac1", **kw):
        body = T.TicketBody(subject=kw.pop("subject", "Leak under sink"), application=APP,
                            hr_department_id=dept, property_asset_id=prop, property_unit="Common Area", **kw)
        out = T.create_ticket(body, BackgroundTasks(), user=user, db=self.db)
        self.db.expire_all()
        return self.db.get(models.TaskTicket, out["id"])

    def _where(self, t):
        return t.company_id, t.hr_department_id

    # ── the desk's New Ticket / the property's Tickets panel ──
    def test_a_ticket_on_a_property_takes_its_company_and_that_companys_team(self):
        t = self._file()
        self.assertEqual(self._where(t), ("c2", "d-fac2"))

    def test_from_the_property_tickets_panel_too(self):
        t = self._file(property_locked=True)
        self.assertEqual((t.property_locked, *self._where(t)), (1, "c2", "d-fac2"))

    def test_an_explicit_company_wins_only_when_it_matches(self):
        self.assertEqual(self._where(self._file(user=SUPER, company_id="c1")), ("c2", "d-fac2"))
        self.assertEqual(self._where(self._file(user=SUPER, company_id="c2", dept="d-fac2")), ("c2", "d-fac2"))

    def test_a_team_with_no_company_stays_on_the_ticket(self):
        self.assertEqual(self._where(self._file(dept="d-shared")), ("c2", "d-shared"))

    def test_a_parcel_takes_its_lead_propertys_company(self):
        self.assertEqual(self._where(self._file(prop="p2-parcel")), ("c2", "d-fac2"))

    def test_a_property_still_needing_a_company_files_as_before(self):
        # Only the asset manager (c2) places it - a weak guess never moves a ticket.
        self.assertEqual(self._where(self._file(prop="pblank")), ("c1", "d-fac1"))

    def test_no_ticket_without_a_property_changes(self):
        body = T.TicketBody(subject="Printer", application=APP, hr_department_id="d-fac1", property_none=True)
        out = T.create_ticket(body, BackgroundTasks(), user=AMY, db=self.db)
        self.assertEqual(out["companyId"], "c1")

    def test_with_no_team_of_that_name_the_ticket_keeps_its_company(self):
        self.db.query(models.HrDepartment).filter(models.HrDepartment.id == "d-fac2").delete()
        self.db.commit()
        self.assertEqual(self._where(self._file()), ("c1", "d-fac1"))

    def test_a_team_switched_off_for_intake_is_never_swapped_in(self):
        self.db.add(models.TicketDepartment(id="d-fac2", company_id="c2", name="Construction & Maintenance",
                                            enabled=False))
        self.db.commit()
        self.assertEqual(self._where(self._file()), ("c1", "d-fac1"))

    def test_equipment_of_another_company_keeps_the_ticket_where_it_was(self):
        self.db.add(models.Item(id="laptop", company_id="c1", name="Laptop"))
        self.db.commit()
        self.assertEqual(self._where(self._file(user=SUPER, item_ids=["laptop"])), ("c1", "d-fac1"))

    # ── walls ──
    def test_walled_requesters_never_lose_sight_of_their_ticket(self):
        self._walls()
        self.assertEqual(self._where(self._file(user=AMY)), ("c1", "d-fac1"))       # Amy sees c1 only
        # A Super Administrator reaches every company ...
        self.assertEqual(self._where(self._file(user=SUPER)), ("c2", "d-fac2"))
        # ... but filing for Amy keeps it where Amy can open it.
        self.assertEqual(self._where(self._file(user=SUPER, requester_email=AMY["email"])), ("c1", "d-fac1"))
        # Bob is c2's - his ticket goes to c2.
        self.assertEqual(self._where(self._file(user=SUPER, requester_email=BOB["email"])), ("c2", "d-fac2"))

    def test_an_administrator_of_another_company_keeps_their_own(self):
        # The desk shows an Administrator every company's tickets (hotfix
        # 11/04/2026), but the property's ticket list and the place sheet are
        # still walled for them - a c2 ticket would drop off both.
        self._walls()
        t = self._file(user=ADMIN, property_locked=True)
        self.assertEqual(self._where(t), ("c1", "d-fac1"))
        self.assertIn(t.id, [r["id"] for r in P.property_tickets("p2", user=ADMIN, db=self.db)["open"]])
        # Given c2 as well, the ticket goes to the property's company.
        self.db.add(models.NexusAccessScope(id=gen_id(), email=ADMIN["email"], module_id="hr", scope_type="entity",
                                               scope_id="c2"))
        self.db.commit()
        t = self._file(user=ADMIN, property_locked=True)
        self.assertEqual(self._where(t), ("c2", "d-fac2"))
        self.assertIn(t.id, [r["id"] for r in P.property_tickets("p2", user=ADMIN, db=self.db)["open"]])

    def test_the_walls_check_is_the_tickets_wall_and_the_property_wall(self):
        self._walls()
        self.assertTrue(TPC.reachable(self.db, SUPER, "c3"))
        self.assertFalse(TPC.reachable(self.db, ADMIN, "c3"))       # the property list is walled for them
        self.assertFalse(TPC.reachable(self.db, AMY, "c2"))
        self.assertFalse(TPC.reachable(self.db, SUPER, "c2", [AMY["email"]]))
        self.assertTrue(TPC.reachable(self.db, SUPER, "c2", [BOB["email"]]))
        self._walls(on=False)
        self.assertTrue(TPC.reachable(self.db, AMY, "c2", [BOB["email"]]))

    # ── Report a Problem (Scan to Request) ──
    def test_report_a_problem_offers_and_files_under_the_propertys_company(self):
        out = MW.place("p2", user=AMY, db=self.db)
        self.assertTrue(out["topics"])
        self.assertEqual({o["departmentId"] for o in out["topics"]}, {"d-fac2"})
        topic = out["topics"][0]["topic"]
        made = MW.report_problem("p2", MW.ReportBody(topic=topic, subject="Gate stuck", unit="Common Area"),
                                 BackgroundTasks(), user=AMY, db=self.db)
        self.db.expire_all()
        t = self.db.get(models.TaskTicket, made["id"])
        self.assertEqual((t.source, *self._where(t)), ("scan", "c2", "d-fac2"))

    def test_report_a_problem_at_a_property_needing_a_company_is_unchanged(self):
        out = MW.place("pblank", user=AMY, db=self.db)
        self.assertEqual({o["departmentId"] for o in out["topics"]}, {"d-fac1"})
        made = MW.report_problem("pblank", MW.ReportBody(topic=out["topics"][0]["topic"], subject="Gate stuck",
                                                         unit="Common Area"),
                                 BackgroundTasks(), user=AMY, db=self.db)
        self.assertEqual(made["companyId"], "c1")

    def test_report_a_problem_behind_the_wall_stays_the_scanners(self):
        self._walls()
        out = MW.place("p2", user=AMY, db=self.db)
        self.assertEqual({o["departmentId"] for o in out["topics"]}, {"d-fac1"})
        made = MW.report_problem("p2", MW.ReportBody(topic=out["topics"][0]["topic"], subject="Gate stuck",
                                                     unit="Common Area"),
                                 BackgroundTasks(), user=AMY, db=self.db)
        self.assertEqual(made["companyId"], "c1")

    # ── Batch Create (walkthroughs) ──
    def test_a_walkthrough_files_every_line_under_the_propertys_company(self):
        body = W.WalkthroughBody(batch_id=str(uuid.uuid4()), property_asset_id="p2", hr_department_id="d-fac1",
                                 lines=[W.WalkLine(subject="Paint door", application=APP),
                                        W.WalkLine(subject="Fix gutter", application=APP)])
        out = W.create_walkthrough(body, BackgroundTasks(), Response(), user=WALKER, db=self.db)
        self.db.expire_all()
        rows = [self.db.get(models.TaskTicket, t["id"]) for t in out["tickets"]]
        self.assertEqual({self._where(t) for t in rows}, {("c2", "d-fac2")})
        batch = self.db.get(models.TicketBatch, body.batch_id)
        self.assertEqual((batch.company_id, batch.hr_department_id), ("c2", "d-fac2"))

    # ── preventive maintenance ──
    def _schedule(self, prop="p2", dept="d-fac2"):
        body = P.ScheduleBody(kind="calendar", subject="HVAC Filter", hr_department_id=dept, application=APP,
                              next_due=(TODAY + timedelta(days=1)).isoformat(), recurrence_unit="month",
                              recurrence_every=1, lead_days=3)
        return P.create_schedule(prop, body, user=SUPER, db=self.db)["serviceId"]

    def _pm_ticket(self, sid):
        self.assertEqual(MS.run_preventive(self.db, TODAY)["filed"], 1)
        self.db.expire_all()
        [t] = self.db.query(models.TaskTicket).filter(models.TaskTicket.service_id == sid).all()
        return t

    def test_preventive_tickets_keep_the_teams_company(self):
        self.assertEqual(self._where(self._pm_ticket(self._schedule())), ("c2", "d-fac2"))

    def test_preventive_after_the_property_changed_company_still_carries_the_teams(self):
        sid = self._schedule()
        p = self.db.get(models.PropertyAsset, "p2")
        p.payload = {**p.payload, "companyId": "c3"}
        self.db.commit()
        self.assertEqual(self._where(self._pm_ticket(sid)), ("c2", "d-fac2"))   # trusted_company wins

    def test_preventive_with_a_team_of_no_company_takes_the_propertys(self):
        self.assertEqual(self._where(self._pm_ticket(self._schedule(dept="d-shared"))), ("c2", "d-shared"))

    # ── changing the property later ──
    def _move(self, t, prop, user=SUPER, **kw):
        T.update_ticket(t.id, T.TicketUpdate(property_asset_id=prop, **kw), BackgroundTasks(), user=user, db=self.db)
        self.db.expire_all()
        return self.db.get(models.TaskTicket, t.id)

    def test_a_ticket_that_followed_its_property_follows_the_new_one(self):
        t = self._file()
        self.assertEqual(self._where(self._move(t, "p3")), ("c3", "d-fac3"))
        acts = {a.type for a in self.db.query(models.TaskActivity).filter(models.TaskActivity.entity_id == t.id)}
        self.assertTrue({"company_changed", "department_changed", "property_changed"} <= acts)

    def test_a_company_nobody_derived_from_the_old_property_stays(self):
        t = self._file(prop="pblank")                          # c1: the requester's, not the property's
        self.assertEqual(self._where(self._move(t, "p2")), ("c1", "d-fac1"))

    def test_a_team_picked_in_the_same_edit_is_kept(self):
        t = self._file()
        # The editor's own pick (d-fac2, c2's) does not fit c3: nothing moves.
        self.assertEqual(self._where(self._move(t, "p3", hr_department_id="d-fac2")), ("c2", "d-fac2"))
        t = self._file()
        self.assertEqual(self._where(self._move(t, "p3", hr_department_id="d-fac3")), ("c3", "d-fac3"))

    def test_a_company_named_in_the_same_edit_wins(self):
        t = self._file()
        self.assertEqual(self._move(t, "p3", company_id="c2").company_id, "c2")

    def test_unlinking_the_property_moves_nothing(self):
        t = self._file()
        self.assertEqual(self._where(self._move(t, "")), ("c2", "d-fac2"))

    def test_never_out_of_the_requesters_sight(self):
        t = self._file(user=SUPER, requester_email=BOB["email"])
        self.assertEqual(self._where(t), ("c2", "d-fac2"))
        self._walls()                                          # Bob sees c2 only
        self.assertEqual(self._where(self._move(t, "p3")), ("c2", "d-fac2"))

    def test_the_working_assignee_may_move_the_property_but_not_the_company(self):
        # Bob works the desk (a Tickets grant, not a manager): once he holds it,
        # every field but the company is his.
        self.db.add(models.NexusGroup(id="g-desk", name="Desk", allowed_modules="tickets:viewer"))
        self.db.add(models.NexusGroupMember(group_id="g-desk", email=BOB["email"]))
        self.db.commit()
        cache.module_grants.invalidate()
        t = self._file()
        T.update_ticket(t.id, T.TicketUpdate(assignee_email=BOB["email"]), BackgroundTasks(), user=SUPER,
                        db=self.db)
        self.db.expire_all()
        self.assertEqual(self.db.get(models.TaskTicket, t.id).status, "in_progress")
        moved = self._move(t, "p3", user=BOB)
        self.assertEqual((moved.property_asset_id, *self._where(moved)), ("p3", "c2", "d-fac2"))


if __name__ == "__main__":
    unittest.main()
