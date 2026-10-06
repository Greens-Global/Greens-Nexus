"""
Property Tickets (Neil, 10/05): a ticket links to an Asset Management property.

The link is validated (real estate only: no vehicle, equipment, deleted or
hidden-private asset), the name is snapshotted, only building teams may link,
and the property's asset manager is told once - not made a watcher. A closed
property ticket is that property's maintenance record, so it cannot be
deleted or moved off the property until it is reopened. Ticket codes are
issued under a lock so concurrent creates never share one.

Uses a throwaway sqlite file. No network: BackgroundTasks are never run.
Run with: python -m unittest test_property_tickets
"""
import os
import sqlite3
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException   # noqa: E402

import cache                                          # noqa: E402
import database                                       # noqa: E402
import models                                         # noqa: E402
from routers.task_util import gen_id                  # noqa: E402
from routers import tickets as T                      # noqa: E402
from routers import property_tickets as P             # noqa: E402

ADMIN = {"email": "neil@greensglobal.com", "role": "administrator", "level": 4}
PLAIN = {"email": "amy@greensglobal.com", "role": "employee", "level": 1}
MANAGER = "ankush@greensglobal.com"


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
        for m in (models.TaskTicket, models.TaskActivity, models.TaskAttachment, models.TaskComment,
                  models.TaskNotification, models.NexusNotification, models.NexusEmployee, models.NexusRole,
                  models.PropertyAsset, models.HrDepartment, models.PropertyRecord,
                  models.PropertyActivityLog, models.PropertyWorkspaceMeta):
            self.db.query(m).delete()
        for email in (ADMIN["email"], PLAIN["email"], MANAGER):
            self.db.add(models.NexusEmployee(id=gen_id(), first_name=email.split("@")[0], work_email=email,
                                             status="active", identity_type="internal"))
        self.db.add(models.NexusRole(email=ADMIN["email"], role="administrator"))
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
        self.db.commit()
        cache.module_grants.invalidate()

    def tearDown(self):
        self.db.close()

    def _one(self, user=PLAIN, **kw):
        body = T.TicketBody(subject=kw.pop("subject", "Leak under sink"), application="Plumbing or Water Leak",
                            hr_department_id=kw.pop("hr_department_id", "d-fac"), **kw)
        return T.create_ticket(body, BackgroundTasks(), user=user, db=self.db)

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


if __name__ == "__main__":
    unittest.main()
