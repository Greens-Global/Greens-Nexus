"""
Property Tickets (Neil, 10/05): a ticket links to an Asset Management property.

The link is validated (real estate only: no vehicle, equipment, deleted or
hidden-private asset), the name is snapshotted, only building teams may link,
and the property's asset manager is told once - not made a watcher. A closed
property ticket is that property's maintenance record, so it cannot be
deleted or moved off the property until it is reopened. Ticket codes are
issued under a lock so concurrent creates never share one.

A Property Walkthrough files many tickets at one property in ONE transaction:
all-or-nothing, idempotent on batch_id AND its line fingerprint, one bell per
person.

Uses a throwaway sqlite file. No network: BackgroundTasks are never run.
Run with: python -m unittest test_property_tickets
"""
import os
import sqlite3
import tempfile
import unittest
import uuid

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException, Response   # noqa: E402

import cache                                          # noqa: E402
import database                                       # noqa: E402
import models                                         # noqa: E402
from routers.task_util import gen_id                  # noqa: E402
from routers import tickets as T                      # noqa: E402
from routers import property_tickets as P             # noqa: E402
from routers import ticket_walkthroughs as W          # noqa: E402

ADMIN = {"email": "neil@greensglobal.com", "role": "administrator", "level": 4}
PLAIN = {"email": "amy@greensglobal.com", "role": "employee", "level": 1}
MANAGER = "ankush@greensglobal.com"
WALKER = {"email": "pranshu@greensglobal.com", "role": "employee", "level": 2}
DESK2 = "visesh@greensglobal.com"
EDITOR = {"email": "sagar@greensglobal.com", "role": "employee", "level": 2}
MANAGER_USER = {"email": MANAGER, "role": "employee", "level": 2}


class PropertyTicketTests(unittest.TestCase):
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
        for m in (models.TaskTicket, models.TicketBatch, models.TicketMaintenanceRecord, models.PropertyMaintenanceService, models.NexusGroup, models.NexusGroupMember, models.TaskActivity, models.TaskAttachment, models.TaskComment,
                  models.TaskNotification, models.NexusNotification, models.NexusEmployee, models.NexusRole,
                  models.PropertyAsset, models.HrDepartment, models.PropertyRecord,
                  models.PropertyActivityLog, models.PropertyWorkspaceMeta):
            self.db.query(m).delete()
        for email in (ADMIN["email"], PLAIN["email"], MANAGER, WALKER["email"], DESK2, EDITOR["email"]):
            self.db.add(models.NexusEmployee(id=gen_id(), first_name=email.split("@")[0], work_email=email,
                                             status="active", identity_type="internal"))
        for email in (ADMIN["email"], DESK2):   # no desk roster configured -> administrators
            self.db.add(models.NexusRole(email=email, role="administrator"))
        self.db.add(models.NexusGroup(id="g-asset", name="Asset Team", allowed_modules="property-asset:viewer"))
        self.db.add(models.NexusGroupMember(group_id="g-asset", email=WALKER["email"]))
        self.db.add(models.NexusGroupMember(group_id="g-asset", email=MANAGER))
        self.db.add(models.NexusGroup(id="g-asset-ed", name="Asset Editors", allowed_modules="property-asset:editor"))
        self.db.add(models.NexusGroupMember(group_id="g-asset-ed", email=EDITOR["email"]))
        self.db.add(models.HrDepartment(id="d-fac", company_id="c1", name="Construction & Maintenance"))
        self.db.add(models.HrDepartment(id="d-hr", company_id="c1", name="Human Resources"))
        contacts = {"pm / asset manager": {"email": MANAGER}}
        self.db.add(models.PropertyAsset(
            id="gst", name="Greens Storage Temecula", manager="Ankush", asset_type="Self-Storage",
            payload={"id": "gst", "name": "Greens Storage Temecula", "kind": "property",
                     "contacts": contacts, "tenantUnits": [{"label": "Office"}], "city": "Temecula", "state": "CA"}))
        self.db.add(models.PropertyAsset(id="gst-p2", name="Temecula Parcel 2", parent_id="gst",
                                         payload={"id": "gst-p2", "kind": "property"}))
        self.db.add(models.PropertyAsset(id="truck", name="F-250", asset_type="Vehicle", payload={"kind": "vehicle"}))
        self.db.add(models.PropertyAsset(id="old", name="Sold Lot", payload={"kind": "property", "deleted": True}))
        self.db.add(models.PropertyAsset(id="vault", name="Private Deal", payload={"kind": "property", "private": True}))
        # Parcels of GST a plain viewer must not see through the roll-up.
        self.db.add(models.PropertyAsset(id="gst-secret", name="Secret Parcel", parent_id="gst",
                                         payload={"kind": "property", "private": True}))
        self.db.add(models.PropertyAsset(id="gst-sold", name="Sold Parcel", parent_id="gst",
                                         payload={"kind": "property", "deleted": True}))
        self.db.commit()
        cache.module_grants.invalidate()

    def tearDown(self):
        self.db.close()

    def _one(self, user=PLAIN, **kw):
        body = T.TicketBody(subject=kw.pop("subject", "Leak under sink"), application="Plumbing or Water Leak",
                            hr_department_id=kw.pop("hr_department_id", "d-fac"), **kw)
        return T.create_ticket(body, BackgroundTasks(), user=user, db=self.db)

    def _walk(self, lines, user=WALKER, batch_id=None, prop="gst", dept="d-fac"):
        body = W.WalkthroughBody(batch_id=batch_id or str(uuid.uuid4()), property_asset_id=prop,
                                 hr_department_id=dept, lines=[W.WalkLine(**ln) for ln in lines])
        resp = Response()
        out = W.create_walkthrough(body, BackgroundTasks(), resp, user=user, db=self.db)
        return out, resp

    def _line(self, subject, app="Painting", **kw):
        return {"subject": subject, "application": app, **kw}

    def _bells(self, email, kind=None):
        q = self.db.query(models.TaskNotification).filter(models.TaskNotification.for_email == email)
        if kind:
            q = q.filter(models.TaskNotification.kind == kind)
        return q.all()

    def test_a_ticket_links_to_a_property_and_its_manager_is_told_not_subscribed(self):
        out = self._one(property_asset_id="gst")
        self.assertEqual(out["propertyAssetId"], "gst")
        self.assertEqual(out["propertyName"], "Greens Storage Temecula")
        self.assertNotIn(MANAGER, out["watcherIds"])           # no per-status-move bells later
        bells = self._bells(MANAGER, "ticket_property")
        self.assertEqual(len(bells), 1)
        self.assertEqual(bells[0].title, "New ticket at Greens Storage Temecula")

    def test_a_ticket_without_a_property_is_unchanged(self):
        out = self._one()
        self.assertEqual((out["propertyAssetId"], out["propertyName"]), (None, None))   # blank = None, like every field
        self.assertEqual(self._bells(MANAGER), [])

    def test_only_building_teams_link_to_a_property(self):
        with self.assertRaises(HTTPException) as cm:
            self._one(subject="Complaint about the site manager", hr_department_id="d-hr", property_asset_id="gst")
        self.assertEqual(cm.exception.status_code, 400)
        self.assertEqual(self.db.query(models.TaskTicket).count(), 0)
        t = self._one(user=ADMIN, property_asset_id="gst")      # moving a linked ticket to HR: refused too
        with self.assertRaises(HTTPException) as cm:
            T.update_ticket(t["id"], T.TicketUpdate(hr_department_id="d-hr"), BackgroundTasks(), user=ADMIN, db=self.db)
        self.assertEqual(cm.exception.status_code, 400)

    def test_vehicles_deleted_private_and_unknown_assets_are_refused(self):
        for pid in ("truck", "old", "vault", "nope"):
            with self.assertRaises(HTTPException) as cm:
                self._one(property_asset_id=pid)
            self.assertEqual(cm.exception.status_code, 400, pid)

    def test_the_picker_hides_what_cannot_be_linked(self):
        out = P.list_ticket_properties(user=PLAIN, db=self.db)
        self.assertEqual([p["id"] for p in out["properties"]], ["gst", "gst-p2"])   # lead first, then its parcel
        gst = out["properties"][0]
        self.assertEqual((gst["city"], gst["state"], gst["units"]), ("Temecula", "CA", ["Office"]))
        self.assertEqual(out["properties"][1]["parentName"], "Greens Storage Temecula")
        self.assertFalse(out["canWalkthrough"])               # a plain employee files one at a time
        owner = {**ADMIN, "level": 5}
        self.assertIn("vault", [p["id"] for p in P.list_ticket_properties(user=owner, db=self.db)["properties"]])

    def test_repointing_tells_the_new_manager_and_logs_it(self):
        t = self._one(user=ADMIN)
        T.update_ticket(t["id"], T.TicketUpdate(property_asset_id="gst"), BackgroundTasks(), user=ADMIN, db=self.db)
        row = self.db.get(models.TaskTicket, t["id"])
        self.assertEqual(row.property_name, "Greens Storage Temecula")
        self.assertNotIn(MANAGER, row.watcher_emails or [])
        self.assertEqual(len(self._bells(MANAGER, "ticket_property")), 1)
        kinds = [a.type for a in self.db.query(models.TaskActivity).filter_by(entity_id=t["id"]).all()]
        self.assertIn("property_changed", kinds)
        # Re-sending the same property is a no-op: no second bell, no second log line.
        T.update_ticket(t["id"], T.TicketUpdate(property_asset_id="gst"), BackgroundTasks(), user=ADMIN, db=self.db)
        self.assertEqual(len(self._bells(MANAGER, "ticket_property")), 1)

    def test_cost_is_normalized_or_refused(self):
        t = self._one(user=ADMIN, property_asset_id="gst")
        out = T.update_ticket(t["id"], T.TicketUpdate(maintenance_cost="$1,250.5", maintenance_vendor=" ABC  Plumbing "),
                              BackgroundTasks(), user=ADMIN, db=self.db)
        self.assertEqual((out["maintenanceCost"], out["maintenanceVendor"]), ("1250.50", "ABC Plumbing"))
        with self.assertRaises(HTTPException):
            T.update_ticket(t["id"], T.TicketUpdate(maintenance_cost="about 300"),
                            BackgroundTasks(), user=ADMIN, db=self.db)

    def test_a_closed_property_ticket_cannot_be_deleted_or_moved(self):
        t = self._one(user=ADMIN, property_asset_id="gst")
        T.update_ticket(t["id"], T.TicketUpdate(status="resolved", resolution_note="Fixed", maintenance_cost="90"),
                        BackgroundTasks(), user=ADMIN, db=self.db)
        with self.assertRaises(HTTPException) as cm:
            T.delete_ticket(t["id"], user=ADMIN, db=self.db)
        self.assertEqual(cm.exception.status_code, 409)
        with self.assertRaises(HTTPException) as cm:
            T.update_ticket(t["id"], T.TicketUpdate(property_asset_id=""), BackgroundTasks(), user=ADMIN, db=self.db)
        self.assertEqual(cm.exception.status_code, 409)
        # Correcting the invoice amount is normal and allowed.
        out = T.update_ticket(t["id"], T.TicketUpdate(maintenance_cost="95"), BackgroundTasks(), user=ADMIN, db=self.db)
        self.assertEqual(out["maintenanceCost"], "95.00")
        # Reopened, it is no longer history: it can move, and vendor/cost are kept.
        T.update_ticket(t["id"], T.TicketUpdate(status="reopened", reopen_reason="Still dripping"),
                        BackgroundTasks(), user=ADMIN, db=self.db)
        out = T.update_ticket(t["id"], T.TicketUpdate(property_asset_id=""), BackgroundTasks(), user=ADMIN, db=self.db)
        self.assertEqual((out["propertyAssetId"], out["maintenanceCost"]), (None, "95.00"))

    def test_an_open_property_ticket_still_deletes(self):
        t = self._one(user=ADMIN, property_asset_id="gst")
        T.delete_ticket(t["id"], user=ADMIN, db=self.db)
        self.assertIsNone(self.db.get(models.TaskTicket, t["id"]))

    def test_codes_stay_consecutive(self):
        a, b = self._one(user=ADMIN), self._one(user=ADMIN, property_asset_id="gst")
        self.assertEqual((a["code"], b["code"]), ("000001", "000002"))

    def test_the_sqlite_code_lock_takes_the_write_lock_before_the_read(self):
        T._lock_ticket_codes(self.db)                           # holds SQLite's write lock until commit
        other = sqlite3.connect(_tmp_db.name, timeout=0.1)
        try:
            with self.assertRaises(sqlite3.OperationalError):    # a second writer must wait
                other.execute("BEGIN IMMEDIATE")
        finally:
            other.close()
            self.db.rollback()

    def test_saving_the_asset_workspace_never_touches_tickets(self):
        from routers import property_assets as PA
        t = self._one(user=ADMIN, property_asset_id="gst")
        PA.put_workspace(PA.Workspace(properties=[{"id": "other", "name": "Other"}, {"id": "x", "name": "X"}]),
                         db=self.db, user=ADMIN)
        row = self.db.get(models.TaskTicket, t["id"])
        self.assertEqual((row.property_asset_id, row.property_name), ("gst", "Greens Storage Temecula"))

    # ── Property Walkthrough ──
    def test_a_walkthrough_files_every_line_at_the_property_with_consecutive_codes(self):
        self._one(user=ADMIN)                                 # an existing ticket: 000001
        out, resp = self._walk([self._line("Repaint stairwell"),
                                self._line("Broken handrail", "Railings or Stairs", location="Office", priority="high"),
                                self._line("Flooring lifting", "Flooring or Tile")])
        self.assertEqual([t["code"] for t in out["tickets"]], ["000002", "000003", "000004"])
        self.assertTrue(all(t["propertyAssetId"] == "gst" and t["batchId"] == out["batchId"] for t in out["tickets"]))
        self.assertEqual(out["tickets"][1]["typeFields"], {"svc_unit": "Office"})
        self.assertEqual(out["tickets"][1]["priority"], "high")
        self.assertEqual(self.db.get(models.TicketBatch, out["batchId"]).ticket_count, 3)
        self.assertFalse(out["replayed"])
        self.assertNotIn(MANAGER, out["tickets"][0]["watcherIds"])

    def test_one_bad_line_files_nothing_and_names_the_line(self):
        with self.assertRaises(HTTPException) as cm:
            self._walk([self._line("Fine"), self._line("", "Painting"), self._line("No topic", "")])
        self.assertEqual(cm.exception.status_code, 422)
        self.assertEqual(sorted({e["index"] for e in cm.exception.detail["lines"]}), [1, 2])
        self.assertEqual(self.db.query(models.TaskTicket).count(), 0)
        self.assertEqual(self.db.query(models.TicketBatch).count(), 0)

    def test_the_same_submit_twice_files_once(self):
        bid = str(uuid.uuid4())
        first, _ = self._walk([self._line("A"), self._line("B")], batch_id=bid)
        again, resp = self._walk([self._line("A"), self._line("B")], batch_id=bid)
        self.assertTrue(again["replayed"])
        self.assertEqual(resp.status_code, 200)
        self.assertEqual([t["id"] for t in again["tickets"]], [t["id"] for t in first["tickets"]])
        self.assertEqual(self.db.query(models.TaskTicket).count(), 2)

    def test_a_retry_with_different_lines_is_never_a_silent_replay(self):
        bid = str(uuid.uuid4())
        self._walk([self._line("A"), self._line("B")], batch_id=bid)
        with self.assertRaises(HTTPException) as cm:            # line C added after the lost response
            self._walk([self._line("A"), self._line("B"), self._line("C")], batch_id=bid)
        self.assertEqual(cm.exception.status_code, 409)
        self.assertEqual(cm.exception.detail["code"], "batch_mismatch")
        self.assertEqual([t["subject"] for t in cm.exception.detail["tickets"]], ["A", "B"])
        self.assertEqual(self.db.query(models.TaskTicket).count(), 2)
        again, _ = self._walk([self._line(" A "), self._line("B")], batch_id=bid)   # same text: replays
        self.assertTrue(again["replayed"])

    def test_someone_elses_batch_id_is_refused(self):
        bid = str(uuid.uuid4())
        self._walk([self._line("A")], batch_id=bid)
        with self.assertRaises(HTTPException) as cm:
            self._walk([self._line("A")], batch_id=bid, user=ADMIN)
        self.assertEqual(cm.exception.status_code, 409)

    def test_one_bell_per_person_per_walkthrough(self):
        self._walk([self._line(f"Issue {i}") for i in range(12)])
        self.assertEqual(len(self._bells(MANAGER)), 1)
        self.assertEqual(self._bells(MANAGER)[0].title, "12 new tickets at Greens Storage Temecula")
        for desk in (ADMIN["email"], DESK2):
            self.assertEqual(len(self._bells(desk, "ticket_needs_assignment")), 1)
        self.assertEqual(len(self._bells(WALKER["email"])), 0)   # nothing about your own action

    def test_limits_access_and_assignment(self):
        with self.assertRaises(HTTPException) as cm:            # a plain employee files one at a time
            self._walk([self._line("x")], user=PLAIN)
        self.assertEqual(cm.exception.status_code, 403)
        with self.assertRaises(HTTPException) as cm:
            self._walk([self._line(f"x{i}") for i in range(W.MAX_LINES + 1)])
        self.assertEqual(cm.exception.status_code, 422)
        with self.assertRaises(HTTPException) as cm:            # only the desk assigns while filing
            self._walk([self._line("x", assignee_email=DESK2)])
        self.assertEqual(cm.exception.detail["lines"][0]["field"], "assignee_email")
        with self.assertRaises(HTTPException):                  # base64 photos are refused
            self._walk([self._line("x", images=["data:image/png;base64,AAAA"])])
        with self.assertRaises(HTTPException) as cm:            # HR tickets never land on a property
            self._walk([self._line("x")], dept="d-hr")
        self.assertEqual(cm.exception.status_code, 422)
        with self.assertRaises(HTTPException) as cm:            # nor on a vehicle
            self._walk([self._line("x")], prop="truck")
        self.assertEqual(cm.exception.status_code, 400)

    def test_the_desk_can_assign_while_filing(self):
        out, _ = self._walk([self._line("Leak", "Plumbing or Water Leak", assignee_email=DESK2)], user=ADMIN)
        t = out["tickets"][0]
        self.assertEqual((t["assigneeId"], t["status"]), (DESK2, "in_progress"))
        self.assertEqual(len(self._bells(DESK2, "ticket_assigned")), 1)
        self.assertEqual(len(self._bells(DESK2, "ticket_needs_assignment")), 0)   # one bell, the actionable one

    def test_a_gated_type_parks_for_approval_and_cannot_be_born_assigned(self):
        out, _ = self._walk([self._line("Badge for contractor", "Gate Access", type="access_request")], user=ADMIN)
        self.assertEqual(out["tickets"][0]["approvalStatus"], "pending")
        with self.assertRaises(HTTPException):
            self._walk([self._line("Badge", "Gate Access", type="access_request", assignee_email=DESK2)], user=ADMIN)

    def test_the_walkthrough_email_goes_once_per_person(self):
        import ticket_notify
        sent = []
        real = ticket_notify.graph_mail.send_mail
        ticket_notify.graph_mail.send_mail = lambda **kw: sent.append(kw) or {}
        try:
            out, _ = self._walk([self._line(f"Issue {i}") for i in range(5)])
            ticket_notify.notify_walkthrough(out["batchId"], WALKER["email"])
            ticket_notify.notify_walkthrough(out["batchId"], WALKER["email"])   # a replayed submit: no second send
        finally:
            ticket_notify.graph_mail.send_mail = real
        to = sorted(r for kw in sent for r in kw["to"])
        self.assertEqual(to, sorted({MANAGER, ADMIN["email"], DESK2}))
        self.assertTrue(all(kw["subject"] == "5 new tickets at Greens Storage Temecula - Property Walkthrough"
                            for kw in sent))

    # ── Asset Management: a property's tickets ──
    def test_open_history_and_closed_without_work(self):
        out, _ = self._walk([self._line("Leak", "Plumbing or Water Leak"), self._line("Dup"), self._line("Paint")],
                            user=ADMIN)
        leak, dup, _paint = (t["id"] for t in out["tickets"])
        T.update_ticket(leak, T.TicketUpdate(status="resolved", resolution_note="Replaced trap", maintenance_cost="180"),
                        BackgroundTasks(), user=ADMIN, db=self.db)
        T.update_ticket(dup, T.TicketUpdate(status="closed", resolution="duplicate", resolution_note="Same as the leak"),
                        BackgroundTasks(), user=ADMIN, db=self.db)
        view = P.property_tickets("gst", user=ADMIN, db=self.db)
        self.assertEqual(len(view["open"]), 1)
        recs = {h["id"]: h for h in view["history"]}
        self.assertTrue(recs[leak]["maintenanceRecord"])
        self.assertEqual(recs[leak]["system"], "Plumbing")
        self.assertFalse(recs[dup]["maintenanceRecord"])
        self.assertTrue(recs[leak]["needsAction"])                 # resolved: the asset manager reviews it
        self.assertFalse(recs[dup]["needsAction"])                 # closed without work: nothing to record
        self.assertEqual(view["spend"], "0.00")                    # nothing logged yet
        # Reopened: back in Open, out of history; vendor/cost kept for the next resolve.
        T.update_ticket(leak, T.TicketUpdate(status="reopened", reopen_reason="Dripping again"),
                        BackgroundTasks(), user=ADMIN, db=self.db)
        view = P.property_tickets("gst", user=ADMIN, db=self.db)
        self.assertIn(leak, [o["id"] for o in view["open"]])
        self.assertEqual(self.db.get(models.TaskTicket, leak).maintenance_cost, "180.00")

    def test_a_ticket_raised_from_support_shows_on_the_property(self):
        t = self._one(property_asset_id="gst", subject="Gate keypad dead")   # a plain employee, from Support
        self.assertIn(t["id"], [o["id"] for o in P.property_tickets("gst", user=ADMIN, db=self.db)["open"]])

    def test_a_lead_property_rolls_up_its_parcels(self):
        self._one(user=ADMIN, property_asset_id="gst-p2", subject="Fence down")
        self.assertTrue(P.property_tickets("gst", user=ADMIN, db=self.db)["open"][0]["onParcel"])
        self.assertFalse(P.property_tickets("gst-p2", user=ADMIN, db=self.db)["open"][0]["onParcel"])

    def test_the_roll_up_hides_private_and_deleted_parcels(self):
        secret = models.TaskTicket(id=gen_id(), code="000900", subject="Vault leak", status="open",
                                   property_asset_id="gst-secret", property_name="Secret Parcel", company_id="")
        sold = models.TaskTicket(id=gen_id(), code="000901", subject="Old fence", status="open",
                                 property_asset_id="gst-sold", property_name="Sold Parcel", company_id="")
        self.db.add_all([secret, sold])
        self.db.commit()
        view = P.property_tickets("gst", user=WALKER, db=self.db)
        self.assertEqual(view["open"], [])
        self.assertEqual(view["property"]["parcels"], [{"id": "gst-p2", "name": "Temecula Parcel 2"}])
        owner = {**ADMIN, "level": 5}                          # can see private: sees the private parcel only
        self.assertEqual([o["id"] for o in P.property_tickets("gst", user=owner, db=self.db)["open"]], [secret.id])

    def test_follow_is_for_editors_and_the_manager_never_a_viewer(self):
        t = self._one(user=ADMIN, property_asset_id="gst")
        view = P.property_tickets("gst", user=WALKER, db=self.db)
        self.assertFalse(view["canFollow"])
        self.assertEqual(view["open"][0]["requesterName"], "")    # viewers never see who raised it
        with self.assertRaises(HTTPException) as cm:
            P.follow_property_ticket("gst", t["id"], user=WALKER, db=self.db)
        self.assertEqual(cm.exception.status_code, 403)
        for who in (EDITOR, MANAGER_USER):
            self.assertFalse(P.property_tickets("gst", user=who, db=self.db)["open"][0]["canOpen"])
            P.follow_property_ticket("gst", t["id"], user=who, db=self.db)
            self.assertTrue(P.property_tickets("gst", user=who, db=self.db)["open"][0]["canOpen"])
        acts = [a.detail for a in self.db.query(models.TaskActivity).filter_by(entity_id=t["id"], type="watcher_added")]
        self.assertEqual(len(acts), 2)                          # each Follow is on the record

    def test_a_ticket_at_another_property_cannot_be_followed_through_this_one(self):
        t = self._one(user=ADMIN)                              # no property
        with self.assertRaises(HTTPException) as cm:
            P.follow_property_ticket("gst", t["id"], user=EDITOR, db=self.db)
        self.assertEqual(cm.exception.status_code, 404)

    # ── Maintenance record + recurring services (Pranshu, 10/06) ──
    def _resolved(self, user=ADMIN, prop="gst", subject="HVAC quarterly service", **kw):
        t = self._one(user=user, property_asset_id=prop, subject=subject, **kw)
        T.update_ticket(t["id"], T.TicketUpdate(status="resolved", resolution_note="Serviced the unit",
                                                maintenance_vendor="CoolAir", maintenance_cost="300"),
                        BackgroundTasks(), user=ADMIN, db=self.db)
        return t["id"]

    def _record(self, tid, user=MANAGER_USER, **kw):
        body = P.MaintenanceRecordBody(**{"service_date": "2026-10-01", "system": "HVAC",
                                          "description": "Serviced the unit", "vendor": "CoolAir", "cost": "$300", **kw})
        return P.add_maintenance_record("gst", tid, body, user=user, db=self.db)

    def test_a_ticket_raised_from_the_property_keeps_it(self):
        t = self._one(property_asset_id="gst", property_locked=True)
        self.assertTrue(t["propertyLocked"])
        with self.assertRaises(HTTPException) as cm:
            T.update_ticket(t["id"], T.TicketUpdate(property_asset_id="gst-p2"), BackgroundTasks(), user=ADMIN, db=self.db)
        self.assertEqual(cm.exception.status_code, 409)
        out, _ = self._walk([self._line("Paint")], user=ADMIN)        # a walkthrough from Support: not locked
        self.assertFalse(out["tickets"][0]["propertyLocked"])

    def test_resolving_tells_the_asset_manager_to_review_it(self):
        tid = self._resolved()
        bells = [b for b in self._bells(MANAGER) if "is resolved" in b.title]
        self.assertEqual(len(bells), 1)
        view = P.property_tickets("gst", user=MANAGER_USER, db=self.db)
        self.assertEqual([t["id"] for t in view["needsAction"]], [tid])

    def test_adding_to_the_record_closes_the_ticket_and_counts_the_spend(self):
        tid = self._resolved()
        self._record(tid)
        row = self.db.get(models.TaskTicket, tid)
        self.assertEqual((row.status, row.maintenance_cost), ("closed", "300.00"))
        view = P.property_tickets("gst", user=MANAGER_USER, db=self.db)
        self.assertEqual(view["needsAction"], [])
        self.assertEqual([(r["system"], r["cost"]) for r in view["records"]], [("HVAC", "300.00")])
        self.assertEqual(view["spend"], "300.00")
        with self.assertRaises(HTTPException) as cm:            # once only
            self._record(tid)
        self.assertEqual(cm.exception.status_code, 409)

    def test_only_the_manager_or_an_editor_keeps_the_record(self):
        tid = self._resolved()
        with self.assertRaises(HTTPException) as cm:
            self._record(tid, user=WALKER)                       # a plain asset viewer
        self.assertEqual(cm.exception.status_code, 403)
        self._record(tid, user=EDITOR)

    def test_a_recurring_service_reminds_opens_and_rolls_forward(self):
        import maintenance_services as MS
        from datetime import date, timedelta
        tid = self._resolved(type_fields={"svc_unit": "Office"})
        due = (date.today() + timedelta(days=30)).isoformat()
        out = self._record(tid, next_service_due=due, recurrence_unit="year", recurrence_every=1)
        svc = self.db.get(models.PropertyMaintenanceService, out["serviceId"])
        # 20 days out: nothing. 15 days out: one reminder, never twice.
        self.assertEqual(MS.run_due(self.db, date.today() + timedelta(days=10)), {"reminded": 0, "opened": 0})
        self.assertEqual(MS.run_due(self.db, date.today() + timedelta(days=16))["reminded"], 1)
        self.assertEqual(MS.run_due(self.db, date.today() + timedelta(days=17))["reminded"], 0)
        self.assertEqual(len([b for b in self._bells(MANAGER) if b.title.startswith("Service due")]), 1)
        # Due and nobody opened it: a child ticket opens with the parent's details.
        self.assertEqual(MS.run_due(self.db, date.today() + timedelta(days=30))["opened"], 1)
        self.db.commit()
        child = self.db.query(models.TaskTicket).filter(models.TaskTicket.parent_ticket_id == tid).one()
        self.assertEqual((child.subject, child.property_asset_id, child.property_locked, child.status),
                         ("HVAC quarterly service", "gst", 1, "open"))
        self.assertEqual(child.type_fields, {"svc_unit": "Office"})
        self.assertEqual(svc.next_due, MS.advance(date.fromisoformat(due), "year", 1).isoformat())
        self.assertEqual(MS.run_due(self.db, date.today() + timedelta(days=31))["opened"], 0)   # never twice

    def test_open_now_moves_the_schedule_on_and_a_child_sets_no_schedule(self):
        from datetime import date, timedelta
        tid = self._resolved()
        due = (date.today() + timedelta(days=60)).isoformat()
        sid = self._record(tid, next_service_due=due, recurrence_unit="month", recurrence_every=3)["serviceId"]
        out = P.open_service_now("gst", sid, user=MANAGER_USER, db=self.db)
        with self.assertRaises(HTTPException):
            P.open_service_now("gst", sid, user=MANAGER_USER, db=self.db)                 # same due date: once
        child = out["ticketId"]
        T.update_ticket(child, T.TicketUpdate(status="resolved", resolution_note="Done again", maintenance_cost="320"),
                        BackgroundTasks(), user=ADMIN, db=self.db)
        with self.assertRaises(HTTPException) as cm:            # children never set a schedule
            self._record(child, next_service_due=(date.today() + timedelta(days=90)).isoformat(), recurrence_unit="year")
        self.assertEqual(cm.exception.status_code, 400)
        self._record(child, cost="320")
        view = P.property_tickets("gst", user=MANAGER_USER, db=self.db)
        svc = view["services"][0]
        self.assertEqual(svc["recurrenceLabel"], "Every 3 Months")
        self.assertEqual([(r["isParent"], r["cost"]) for r in svc["tickets"]], [(True, "300.00"), (False, "320.00")])
        self.assertEqual(svc["totalCost"], "620.00")

    def test_a_one_time_service_ends_once_its_ticket_opens_and_can_be_stopped(self):
        from datetime import date, timedelta
        tid = self._resolved()
        sid = self._record(tid, next_service_due=(date.today() + timedelta(days=5)).isoformat())["serviceId"]
        P.open_service_now("gst", sid, user=MANAGER_USER, db=self.db)
        self.assertFalse(self.db.get(models.PropertyMaintenanceService, sid).active)
        tid2 = self._resolved(subject="Roof inspection")
        sid2 = self._record(tid2, next_service_due=(date.today() + timedelta(days=5)).isoformat(),
                            recurrence_unit="week", recurrence_every=2)["serviceId"]
        P.update_service("gst", sid2, P.ServicePatch(active=False), user=MANAGER_USER, db=self.db)
        self.assertFalse(self.db.get(models.PropertyMaintenanceService, sid2).active)
        with self.assertRaises(HTTPException):                  # dates in the past are refused
            self._record(self._resolved(subject="x"), next_service_due="2020-01-01")


if __name__ == "__main__":
    unittest.main()
