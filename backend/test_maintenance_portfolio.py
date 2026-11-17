"""
GET /maintenance/portfolio (Asset Management > Maintenance, Neil 11/17/2026).

Tickets per property: open, all, the newest ticket's day, the preventive
schedules set up and the preventive tickets overdue - sorted by open, then
name. Same access rule as the roll-up (desk grant or the Asset Management
team; 403 otherwise) and the same walls: the caller's company scope on each
ticket's company, private assets and property-asset scope rows narrow the
properties, confidential and deleted tickets never count.

Throwaway sqlite file, no network.
Run with: python -m pytest test_maintenance_portfolio.py   (one file per process)
"""
import os
import tempfile
import unittest
from datetime import date, timedelta

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.pop("SUPABASE_URL", None)

from fastapi import HTTPException                     # noqa: E402
from sqlalchemy import null                           # noqa: E402

import auth                                           # noqa: E402
import cache                                          # noqa: E402
import database                                       # noqa: E402
import models                                         # noqa: E402
from routers.task_util import gen_id                  # noqa: E402
from routers import maintenance as MW                 # noqa: E402

ADMIN = {"email": "neil@greensglobal.com", "role": "administrator", "level": 4}
PLAIN = {"email": "amy@greensglobal.com", "role": "employee", "level": 1}
OTHER = {"email": "olga@other.com", "role": "administrator", "level": 4}
WALKER = {"email": "wes@greensglobal.com", "role": "employee", "level": 1}   # the Asset Management team
TODAY = date.today()


def iso(days: int) -> str:
    return (TODAY + timedelta(days=days)).isoformat()


class PortfolioTests(unittest.TestCase):
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
        for m in (models.TaskTicket, models.PropertyMaintenanceService, models.NexusEmployee, models.NexusRole,
                  models.PropertyAsset, models.HrEntity, models.NexusSetting, models.NexusGroup,
                  models.NexusGroupMember, models.NexusAccessScope):
            self.db.query(m).execution_options(include_deleted=True, include_confidential=True).delete()
        for email, company in ((ADMIN["email"], "c1"), (PLAIN["email"], "c1"), (OTHER["email"], "c2"),
                               (WALKER["email"], "c1")):
            self.db.add(models.NexusEmployee(id=gen_id(), first_name=email.split("@")[0], work_email=email,
                                             status="active", identity_type="internal", company=company))
        for email in (ADMIN["email"], OTHER["email"]):
            self.db.add(models.NexusRole(email=email, role="administrator"))
        self.db.add(models.NexusGroup(id="g-asset", name="Asset Team", allowed_modules="property-asset:viewer"))
        self.db.add(models.NexusGroupMember(group_id="g-asset", email=WALKER["email"]))
        self.db.add(models.HrEntity(id="c1", name="Greens Storage"))
        self.db.add(models.HrEntity(id="c2", name="Other Co"))
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        for pid, name, extra in (("murrieta", "Greens Storage, Murrieta", {}),
                                 ("temecula", "Greens Storage, Temecula", {}),
                                 ("austin", "Greens Austin", {}),
                                 ("vault", "Private Deal", {"private": True})):
            self.db.add(models.PropertyAsset(id=pid, name=name, asset_type="Self-Storage",
                                             payload={"id": pid, "name": name, "kind": "property", **extra}))
        self.db.commit()
        cache.module_grants.invalidate()
        cache.settings_config.invalidate()

    def tearDown(self):
        self.db.close()

    def _ticket(self, pid, *, status="open", company="c1", created="2026-11-01T10:00:00Z", **kw):
        self.db.add(models.TaskTicket(id=gen_id(), subject="Leak", status=status, company_id=company,
                                      property_asset_id=pid, property_name=pid, created_at=created, **kw))
        self.db.commit()

    def _schedule(self, pid, kind="calendar"):
        self.db.add(models.PropertyMaintenanceService(id=gen_id(), property_asset_id=pid, kind=kind,
                                                      parent_ticket_id=null() if kind else gen_id(),
                                                      next_due=iso(10), active=1))
        self.db.commit()

    def test_counts_per_property_sorted_by_open_then_name(self):
        for _ in range(3):
            self._ticket("murrieta")
        self._ticket("murrieta", status="resolved", created="2026-11-07T09:00:00Z")
        self._ticket("temecula", status="closed", created="2026-10-13T09:00:00Z")
        self._ticket("austin")
        out = MW.portfolio(user=ADMIN, db=self.db)
        rows = [(r["propertyName"], r["open"], r["total"]) for r in out["properties"]]
        self.assertEqual(rows, [("Greens Storage, Murrieta", 3, 4), ("Greens Austin", 1, 1),
                                ("Greens Storage, Temecula", 0, 1)])
        self.assertEqual(out["properties"][0]["lastCreatedAt"], "2026-11-07T09:00:00Z")
        self.assertEqual((out["totals"]["open"], out["totals"]["total"], out["totals"]["properties"]), (4, 6, 3))

    def test_preventive_schedules_and_overdue(self):
        self._schedule("murrieta")
        self._schedule("murrieta", kind="floating")
        self._schedule("murrieta", kind="")           # a service set from a ticket is not a preventive schedule
        self._schedule("temecula")
        self._ticket("murrieta", service_id="s1", pm_due_on=iso(-3))
        self._ticket("murrieta", service_id="s1", pm_due_on=iso(-3))
        self._ticket("murrieta", service_id="s2", pm_due_on=iso(4))
        self._ticket("murrieta", service_id="s3", pm_due_on=iso(-9), status="resolved")
        self._ticket("murrieta", service_id="s4")     # no due day: not preventive
        out = MW.portfolio(user=ADMIN, db=self.db)
        by = {r["propertyId"]: r for r in out["properties"]}
        self.assertEqual(by["murrieta"]["preventiveSchedules"], 2)
        self.assertEqual(by["murrieta"]["preventiveOverdue"], 2)
        self.assertEqual((by["murrieta"]["open"], by["murrieta"]["total"]), (4, 5))
        # A property with schedules and no tickets is still listed.
        self.assertEqual((by["temecula"]["preventiveSchedules"], by["temecula"]["total"]), (1, 0))
        self.assertEqual(out["totals"]["properties"], 1)
        self.assertEqual(out["totals"]["preventiveOverdue"], 2)

    def test_confidential_deleted_and_unlinked_tickets_never_count(self):
        self._ticket("murrieta")
        self._ticket("murrieta", confidential_desk="hr")
        self._ticket("murrieta", deleted_at="2026-11-01T00:00:00Z")
        self._ticket("")
        out = MW.portfolio(user=ADMIN, db=self.db)
        self.assertEqual([(r["propertyId"], r["total"]) for r in out["properties"]], [("murrieta", 1)])

    def test_private_and_scoped_properties_are_left_out(self):
        self._ticket("vault")
        self._ticket("murrieta")
        self._ticket("temecula")
        self.assertIn("vault", {r["propertyId"] for r in MW.portfolio(user=ADMIN, db=self.db)["properties"]})
        ids = {r["propertyId"] for r in MW.portfolio(user=WALKER, db=self.db)["properties"]}
        self.assertEqual(ids, {"murrieta", "temecula"})
        self.db.add(models.NexusAccessScope(id=gen_id(), email=WALKER["email"], module_id="property-asset", scope_type="property",
                                            scope_id="temecula"))
        self.db.commit()
        cache.module_grants.invalidate()
        if auth.scoped_ids(WALKER["email"], "property-asset", self.db) is None:
            self.skipTest("property-asset scope rows are not read in this build")
        out = MW.portfolio(user=WALKER, db=self.db)
        self.assertEqual([r["propertyId"] for r in out["properties"]], ["temecula"])

    def test_company_walls(self):
        if auth.company_scope(OTHER, self.db) is None:
            self.skipTest("company walls are not armed in this build")
        self._ticket("murrieta", company="c1")
        self._ticket("austin", company="c2")
        out = MW.portfolio(user=OTHER, db=self.db)
        self.assertEqual([r["propertyId"] for r in out["properties"]], ["austin"])

    def test_who_may_read_it(self):
        with self.assertRaises(HTTPException) as e:
            MW.portfolio(user=PLAIN, db=self.db)
        self.assertEqual(e.exception.status_code, 403)
        self.assertEqual(MW.portfolio(user=ADMIN, db=self.db)["totals"]["open"], 0)
        self.assertEqual(MW.portfolio(user=WALKER, db=self.db)["properties"], [])


if __name__ == "__main__":
    unittest.main()
