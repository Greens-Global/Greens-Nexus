"""Equipment reminders (Sep 2026): overdue checkout reminders + asset date
alerts routed to the asset manager instead of broadcast to every manager.

Covers: the overdue cadence up to the max, the owner joining after N days,
no same-day duplicates, a returned checkout going quiet, warranty and
inspection alerts reaching the asset manager (never recipient=''), the IT
Admin fallback, disabled = nothing, config validation, and the settings
endpoint gates + audit row.

The scan tests run inside one session that is rolled back at the end, so they
never leave notifications behind in a shared local database.

    python -m pytest test_equipment_reminders.py
"""
import json
import os
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from unittest import mock

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import equipment_reminder_config as erc
import equipment_reminders as er
import main
import models

models.Base.metadata.create_all(bind=database.engine)

P = "eqrem"                                  # prefix for every row this file makes
BORROWER = f"{P}.borrower@greensglobal.com"
ALLOCATOR = f"{P}.allocator@greensglobal.com"
LEAD = f"{P}.lead@greensglobal.com"
AM = f"{P}.assetmgr@greensglobal.com"
ITADMIN = f"{P}.itadmin@greensglobal.com"
INV_FULL = f"{P}.invfull@greensglobal.com"
INV_VIEW = f"{P}.invview@greensglobal.com"
MGR = f"{P}.mgr@greensglobal.com"
EMP = f"{P}.emp@greensglobal.com"
GRP_FULL, GRP_VIEW = f"grp-{P}-full", f"grp-{P}-view"
DEPT = "Eqrem Test Department"
TODAY = datetime.now(timezone.utc).date()


def _cfg(**over):
    c = erc.defaults()
    for k, v in over.items():
        c[k].update(v)
    return c


class _ScanBase(unittest.TestCase):
    """One session per test, rolled back at the end."""

    def setUp(self):
        self.db = database.SessionLocal()
        self.day = 0
        self.db.add(models.NexusRole(email=ITADMIN, role="administrator"))
        self.db.add(models.NexusEmployee(id=f"{P}-am", first_name="Eqrem", last_name="Assetmanager",
                                         work_email=AM, status="active"))
        self.db.add(models.HrDepartment(id=f"{P}-dept", company_id="", name=DEPT, lead_email=LEAD))
        self.db.flush()

    def tearDown(self):
        self.db.rollback()
        self.db.close()
        cache.settings_config.invalidate()

    def _on(self, fn, day, cfg):
        """Run `fn` as if today were TODAY + day."""
        d = TODAY + timedelta(days=day)
        now = datetime(d.year, d.month, d.day, 13, 0, tzinfo=timezone.utc).isoformat()
        with mock.patch.object(er, "_today", return_value=d), mock.patch.object(er, "_now_iso", return_value=now):
            n = fn(self.db, cfg)
        self.db.flush()
        return n

    def _notes(self, ref_id, ntype=None):
        q = self.db.query(models.NexusNotification).filter(models.NexusNotification.ref_id == ref_id)
        if ntype:
            q = q.filter(models.NexusNotification.type == ntype)
        return q.all()


# ── Overdue checkouts ───────────────────────────────────────────────────────
class OverdueCadenceTests(unittest.TestCase):
    def test_default_cadence(self):
        cfg = erc.defaults()["overdue"]
        fired = {d: er.overdue_fires(cfg, d) for d in range(-5, 40) if er.overdue_fires(cfg, d) is not None}
        # Due date, then day 1 and every 3 days, 5 reminders max.
        self.assertEqual(fired, {0: 0, 1: 1, 4: 2, 7: 3, 10: 4, 13: 5})

    def test_no_due_date_reminder_and_zero_max(self):
        cfg = dict(erc.defaults()["overdue"], onDueDate=False, maxReminders=0)
        self.assertFalse([d for d in range(-5, 40) if er.overdue_fires(cfg, d) is not None])

    def test_disabled(self):
        cfg = dict(erc.defaults()["overdue"], enabled=False)
        self.assertFalse([d for d in range(-5, 40) if er.overdue_fires(cfg, d) is not None])


class OverdueCheckoutTests(_ScanBase):
    def _checkout(self, allocator=ALLOCATOR, approver="", days=5, status="allocated"):
        item_id, co_id = f"{P}-item-{uuid.uuid4().hex[:6]}", f"{P}-co-{uuid.uuid4().hex[:6]}"
        self.db.add(models.Item(id=item_id, name="Eqrem Drill", department=DEPT, ownership_type="transient",
                                status="checked_out"))
        handover = datetime.combine(TODAY - timedelta(days=days), datetime.min.time(), tzinfo=timezone.utc)
        self.db.add(models.ItemCheckout(
            id=co_id, item_id=item_id, item_name="Eqrem Drill", requested_by="Eqrem Borrower",
            requested_by_email=BORROWER, raised_by="Eqrem Borrower", department="Other", days=days,
            status=status, created_at=handover.isoformat(), allocated_at=handover.isoformat(),
            assigned_allocator_email=allocator, approver_email=approver))
        self.db.flush()
        return co_id   # due date = TODAY

    def _days_sent(self, co_id, cfg, upto=25):
        """Days (relative to the due date) on which each person was reminded."""
        seen = {}
        for day in range(0, upto):
            before = {n.recipient: n.created_at for n in self._notes(co_id, "checkout_overdue")}
            self._on(er.run_overdue_checkouts, day, cfg)
            for n in self._notes(co_id, "checkout_overdue"):
                if before.get(n.recipient) != n.created_at:
                    seen.setdefault(n.recipient, []).append(day)
        return seen

    def test_borrower_on_cadence_up_to_the_max(self):
        co = self._checkout()
        seen = self._days_sent(co, _cfg())
        self.assertEqual(seen[BORROWER], [0, 1, 4, 7, 10, 13])
        rows = self._notes(co, "checkout_overdue")
        # One notification per person, updated in place - never one per reminder.
        self.assertEqual(sorted(n.recipient for n in rows), sorted([BORROWER, ALLOCATOR]))
        b = next(n for n in rows if n.recipient == BORROWER)
        self.assertIn("last automatic reminder", b.body)
        self.assertEqual(json.loads(b.action)["sub"], "active-checkouts")
        self.assertNotIn(chr(0x2014), b.body + b.title)   # no em dashes in user copy

    def test_owner_added_after_n_days(self):
        co = self._checkout()
        seen = self._days_sent(co, _cfg(overdue={"notifyOwnerAfterDays": 3}))
        # The owner joins on the first reminder on/after day 3 (cadence 1, 4, 7...).
        self.assertEqual(seen[ALLOCATOR], [4, 7, 10, 13])
        owner = next(n for n in self._notes(co, "checkout_overdue") if n.recipient == ALLOCATOR)
        self.assertEqual(json.loads(owner.action)["sub"], "checkouts")
        self.assertIn("Eqrem Borrower", owner.body)

    def test_owner_falls_back_to_approver_then_department_lead(self):
        co = self._checkout(allocator="", approver=f"{P}.approver@greensglobal.com")
        self._on(er.run_overdue_checkouts, 4, _cfg())
        self.assertIn(f"{P}.approver@greensglobal.com", {n.recipient for n in self._notes(co)})
        co2 = self._checkout(allocator="", approver="")
        self._on(er.run_overdue_checkouts, 4, _cfg())
        self.assertEqual({n.recipient for n in self._notes(co2)}, {BORROWER, LEAD})

    def test_no_duplicates_on_the_same_day(self):
        co = self._checkout()
        self.assertEqual(self._on(er.run_overdue_checkouts, 1, _cfg()), 1)
        self.assertEqual(self._on(er.run_overdue_checkouts, 1, _cfg()), 0)
        self.assertEqual(len(self._notes(co)), 1)

    def test_returned_checkout_stops(self):
        co = self._checkout()
        self._on(er.run_overdue_checkouts, 1, _cfg())
        self.db.query(models.ItemCheckout).filter(models.ItemCheckout.id == co).update({"status": "returned"})
        self.db.flush()
        before = self._notes(co)[0].created_at
        for day in (4, 7, 10):
            self._on(er.run_overdue_checkouts, day, _cfg())
        self.assertEqual(self._notes(co)[0].created_at, before)

    def test_disabled_sends_nothing(self):
        co = self._checkout()
        for day in range(0, 8):
            self._on(er.run_overdue_checkouts, day, _cfg(overdue={"enabled": False}))
        self.assertEqual(self._notes(co), [])


# ── Asset alerts ────────────────────────────────────────────────────────────
class AssetAlertTests(_ScanBase):
    def _property(self, manager="Eqrem Assetmanager", contacts=None, parent=""):
        pid = f"{P}-prop-{uuid.uuid4().hex[:6]}"
        payload = {"id": pid, "name": "Eqrem Tower", "manager": manager}
        if contacts:
            payload["contacts"] = contacts
        self.db.add(models.PropertyAsset(id=pid, name="Eqrem Tower", manager=manager, parent_id=parent,
                                         payload=payload))
        self.db.flush()
        return pid

    def _record(self, pid, collection, field, days):
        rid = f"{P}-rec-{uuid.uuid4().hex[:6]}"
        payload = {"id": rid, "propertyId": pid, field: (TODAY + timedelta(days=days)).isoformat(),
                   "scope": "Roof", "type": "Fire"}
        self.db.add(models.PropertyRecord(id=rid, property_id=pid, collection=collection, payload=payload))
        self.db.flush()
        return rid

    def test_warranty_and_inspection_go_to_the_asset_manager(self):
        pid = self._property()
        w = self._record(pid, "warranties", "expiration", 40)
        i = self._record(pid, "inspections", "nextDue", 10)
        self._on(er.run_asset_alerts, 0, _cfg())
        for rid in (w, i):
            rows = self._notes(rid)
            self.assertEqual([n.recipient for n in rows], [AM], rid)
        self.assertIn("in 40 days", self._notes(w)[0].body)
        self.assertIn(TODAY.strftime("%Y") , self._notes(w)[0].body)
        self.assertNotIn(TODAY.isoformat(), self._notes(w)[0].body)   # US dates, not ISO

    def test_contact_email_and_parent_inheritance(self):
        pid = self._property(manager="Somebody Unknown",
                             contacts={"pm / asset manager": {"email": "Eqrem.Contact@GreensGlobal.com"}})
        child = self._property(manager="", parent=pid)
        w = self._record(child, "warranties", "expiration", 5)
        self._on(er.run_asset_alerts, 0, _cfg())
        self.assertEqual([n.recipient for n in self._notes(w)], [f"{P}.contact@greensglobal.com"])

    def test_nobody_set_falls_back_to_it_admins(self):
        pid = self._property(manager="")
        w = self._record(pid, "warranties", "expiration", 5)
        self._on(er.run_asset_alerts, 0, _cfg())
        recips = {n.recipient for n in self._notes(w)}
        self.assertIn(ITADMIN, recips)
        self.assertNotIn("", recips)
        self.assertNotIn(None, recips)

    def test_once_per_tier_and_a_new_tier_updates_in_place(self):
        pid = self._property()
        w = self._record(pid, "warranties", "expiration", 60)
        cfg = _cfg(warranty={"daysBefore": [90, 30]})
        self.assertEqual(self._on(er.run_asset_alerts, 0, cfg), 1)
        self.assertEqual(self._on(er.run_asset_alerts, 1, cfg), 0)       # no repeat
        self.assertEqual(self._on(er.run_asset_alerts, 30, cfg), 1)      # 30-day tier reached
        self.assertEqual(self._on(er.run_asset_alerts, 31, cfg), 0)
        self.assertEqual(len(self._notes(w)), 1)                        # same row, updated
        self.assertEqual(json.loads(self._notes(w)[0].action)["lead"], 30)

    def test_legacy_broadcast_row_is_not_resent(self):
        pid = self._property()
        w = self._record(pid, "warranties", "expiration", 50)
        self.db.add(models.NexusNotification(
            id=str(uuid.uuid4()), type="asset_warranty_expiry", recipient="", title="old", body="old",
            ref_id=w, action="", actioned=False, read_by="", created_at="2026-01-01T00:00:00+00:00"))
        self.db.flush()
        self.assertEqual(self._on(er.run_asset_alerts, 0, _cfg()), 0)

    def test_outside_the_window_and_disabled(self):
        pid = self._property()
        far = self._record(pid, "warranties", "expiration", 200)
        near = self._record(pid, "warranties", "expiration", 10)
        self._on(er.run_asset_alerts, 0, _cfg(warranty={"enabled": False}))
        self.assertEqual(self._notes(near), [])
        self._on(er.run_asset_alerts, 0, _cfg())
        self.assertEqual(self._notes(far), [])
        self.assertEqual(len(self._notes(near)), 1)

    def test_vehicle_registration_goes_to_operator(self):
        pid = f"{P}-veh-{uuid.uuid4().hex[:6]}"
        self.db.add(models.PropertyAsset(id=pid, name="Eqrem Truck", manager=AM, payload={
            "id": pid, "kind": "vehicle", "manager": AM,
            "regExpiration": (TODAY + timedelta(days=20)).isoformat()}))
        self.db.flush()
        self._on(er.run_asset_alerts, 0, _cfg())
        self.assertEqual([n.recipient for n in self._notes(f"{pid}:regExpiration")], [AM])


# ── Config validation ───────────────────────────────────────────────────────
class ValidationTests(unittest.TestCase):
    def test_defaults_match_the_old_windows(self):
        c = erc.defaults()
        self.assertEqual([c[k]["daysBefore"] for k in erc.DATE_TYPES], [[90], [30], [60], [30]])
        self.assertTrue(c["overdue"]["enabled"])

    def test_rejects_bad_input(self):
        bad = [
            {"nope": {}},
            {"overdue": {"everyDays": 0}},
            {"overdue": {"everyDays": 31}},
            {"overdue": {"maxReminders": 21}},
            {"overdue": {"notifyOwnerAfterDays": 61}},
            {"overdue": {"onDueDate": "yes"}},
            {"overdue": {"daysBefore": [1]}},
            {"warranty": {"daysBefore": [400]}},
            {"warranty": {"daysBefore": []}},
            {"warranty": {"daysBefore": [1.5]}},
            {"warranty": {"enabled": 1}},
            {"inspection": {"everyDays": 3}},
        ]
        for payload in bad:
            with self.assertRaises(erc.ReminderConfigError, msg=payload):
                erc.validate(payload)

    def test_partial_merge_and_normalize(self):
        out = erc.validate({"warranty": {"daysBefore": [30, 90, 30]}, "overdue": {"everyDays": 7}})
        self.assertEqual(out["warranty"]["daysBefore"], [90, 30])
        self.assertEqual(out["overdue"]["everyDays"], 7)
        self.assertEqual(out["inspection"], erc.DEFAULTS["inspection"])


# ── Endpoints ───────────────────────────────────────────────────────────────
class EndpointTests(unittest.TestCase):
    def setUp(self):
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GRP_FULL, name="Eqrem Full", allowed_modules="inventory:full"))
            db.add(models.NexusGroupMember(group_id=GRP_FULL, email=INV_FULL))
            db.add(models.NexusGroup(id=GRP_VIEW, name="Eqrem View", allowed_modules="inventory:editor"))
            db.add(models.NexusGroupMember(group_id=GRP_VIEW, email=INV_VIEW))
            for email, role in ((MGR, "manager"), (ITADMIN, "administrator"), (EMP, "employee"),
                                (INV_FULL, "employee"), (INV_VIEW, "employee")):
                db.add(models.NexusRole(email=email, role=role))
            db.commit()
        finally:
            db.close()
        self._flush()
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        self._cleanup()
        self._flush()

    def _flush(self):
        cache.settings_config.invalidate()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusSetting).filter(models.NexusSetting.key == erc._SETTINGS_KEY).delete()
            db.query(models.NexusGroupMember).filter(
                models.NexusGroupMember.group_id.in_([GRP_FULL, GRP_VIEW])).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(
                models.NexusGroup.id.in_([GRP_FULL, GRP_VIEW])).delete(synchronize_session=False)
            db.query(models.NexusRole).filter(models.NexusRole.email.like(f"{P}.%")).delete(synchronize_session=False)
            db.query(models.AuditLog).filter(
                models.AuditLog.action == "equipment_reminder_settings_updated",
                models.AuditLog.user_email.like(f"{P}.%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        self._flush()

    def test_view_gate(self):
        for who, code in ((EMP, 401), (MGR, 200), (INV_VIEW, 200), (INV_FULL, 200), (ITADMIN, 200)):
            self._as(who)
            self.assertEqual(self.client.get("/equipment-reminder-settings").status_code, code, who)

    def test_get_defaults_and_edit_flag(self):
        self._as(MGR)
        body = self.client.get("/equipment-reminder-settings").json()
        self.assertEqual(body["config"], erc.DEFAULTS)
        self.assertFalse(body["canEdit"])
        self._as(INV_FULL)
        self.assertTrue(self.client.get("/equipment-reminder-settings").json()["canEdit"])

    def test_manual_asset_scan_is_targeted(self):
        pid, rid = f"{P}-scanprop", f"{P}-scanrec"
        db = database.SessionLocal()
        try:
            db.add(models.PropertyAsset(id=pid, name="Eqrem Scan", manager=MGR, payload={"id": pid, "manager": MGR}))
            db.add(models.PropertyRecord(id=rid, property_id=pid, collection="warranties", payload={
                "id": rid, "scope": "HVAC", "expiration": (TODAY + timedelta(days=15)).isoformat()}))
            db.commit()
            self._as(ITADMIN)
            r = self.client.post("/property-assets/reminders/scan")
            self.assertEqual(r.status_code, 200)
            self.assertGreaterEqual(r.json()["created"], 1)
            rows = db.query(models.NexusNotification).filter(models.NexusNotification.ref_id == rid).all()
            self.assertEqual([n.recipient for n in rows], [MGR])
            self.assertEqual(self.client.post("/property-assets/reminders/scan").status_code, 200)
            self.assertEqual(db.query(models.NexusNotification).filter(
                models.NexusNotification.ref_id == rid).count(), 1)
        finally:
            db.query(models.NexusNotification).filter(models.NexusNotification.ref_id == rid).delete()
            db.query(models.PropertyRecord).filter(models.PropertyRecord.id == rid).delete()
            db.query(models.PropertyAsset).filter(models.PropertyAsset.id == pid).delete()
            db.commit()
            db.close()

    def test_save_gate_validation_and_audit(self):
        payload = {"config": {"overdue": {"everyDays": 2}}}
        for who in (EMP, MGR, INV_VIEW):
            self._as(who)
            self.assertEqual(self.client.put("/equipment-reminder-settings", json=payload).status_code, 401, who)
        self._as(INV_FULL)
        r = self.client.put("/equipment-reminder-settings", json={"overdue": {"everyDays": 99}})
        self.assertEqual(r.status_code, 422)
        self.assertIn("between 1 and 30", r.json()["detail"])
        self._as(ITADMIN)
        r = self.client.put("/equipment-reminder-settings", json=payload)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["config"]["overdue"]["everyDays"], 2)
        db = database.SessionLocal()
        try:
            self.assertEqual(erc.get_config(db)["overdue"]["everyDays"], 2)
            audit = db.query(models.AuditLog).filter(
                models.AuditLog.action == "equipment_reminder_settings_updated",
                models.AuditLog.user_email == ITADMIN).all()
            self.assertEqual(len(audit), 1)
            self.assertIn("overdue", json.loads(audit[0].details))
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
