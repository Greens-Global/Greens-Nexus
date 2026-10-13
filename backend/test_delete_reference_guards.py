"""Deletes that used to leave rows pointing at something that is gone.

There are no foreign keys in this database, so each delete has to look for
what still references the row itself:

  - a company (HrEntity) is refused while people, departments, tasks, tickets,
    items, documents, groups or access scopes still carry its id - and the
    message says what and how many. Its own setup (holidays, work-site picks,
    monitoring policy, packet settings) goes with it.
  - a work site is refused while a person is assigned to it. Punches that
    name it are history and stay.
  - a letterhead is refused while a template or a document uses it.
  - a template takes its saved versions with it.
  - purging a trashed task never deletes its Asana link (a permanent record).
  - an employee code held by a REMOVED person is not handed out again.

Rows in the trash block too: restoring one would bring the dangling id back.

Run with: python -m unittest test_delete_reference_guards -v
"""
import json
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException

import database
import models
from routers.documents import delete_letterhead, delete_template
from routers.hr import _next_code, delete_entity, delete_work_site
from routers.task_util import purge_task_permanently


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(
            f"{__name__} deletes rows and is pointed at {actual!r}, not its own "
            f"temp database. Another test module imported `database` first. "
            f"Run it on its own: python -m unittest {__name__}"
        )


_assert_isolated()

ADMIN = {"email": "neil@greensglobal.com", "level": 5}
CO = "co-greens-india"
OTHER = "co-other"
SITE = "site-yard"
NOW = "2026-10-13T12:00:00+00:00"

_TABLES = (
    models.HrEntity, models.NexusEmployee, models.HrCandidate, models.HrDepartment,
    models.NexusGroup, models.NexusAccessScope, models.Item, models.Task, models.TaskTicket,
    models.Requisition, models.Document, models.HrSignTemplate, models.HrSignRequest,
    models.HrLifeEvent, models.HrChecklist, models.ExternalLink, models.HrCompanyWorkSite,
    models.HrCompanyHoliday, models.MonitoringPolicy, models.HrPacketSetting,
    models.HrChecklistTemplate, models.TicketDepartment, models.HrWorkSite,
    models.HrHolidayPolicy, models.NexusNotification, models.TimePunch, models.DocLetterhead,
    models.DocTemplate, models.DocTemplateVersion, models.AsanaTaskLink, models.TaskComment,
    models.TaskAttachment, models.TaskActivity,
)


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in _TABLES:
            self.db.query(m).execution_options(include_deleted=True).delete()
        self.db.add(models.HrEntity(id=CO, name="Greens India"))
        self.db.add(models.HrEntity(id=OTHER, name="Oversite"))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _add(self, *rows):
        for r in rows:
            self.db.add(r)
        self.db.commit()

    def _refused(self, fn, *args):
        with self.assertRaises(HTTPException) as ctx:
            fn(*args, user=ADMIN, db=self.db)
        self.db.rollback()
        self.assertEqual(ctx.exception.status_code, 409)
        return ctx.exception.detail

    def _count(self, model, *criteria):
        return self.db.query(model).execution_options(include_deleted=True).filter(*criteria).count()


class DeleteCompanyTests(_Base):
    def _company_exists(self, cid=CO):
        return self._count(models.HrEntity, models.HrEntity.id == cid) == 1

    def test_an_empty_company_is_deleted(self):
        self.assertEqual(delete_entity(CO, user=ADMIN, db=self.db), {"ok": True})
        self.assertFalse(self._company_exists())
        self.assertTrue(self._company_exists(OTHER))

    def test_the_message_names_what_is_left_and_how_many(self):
        self._add(*[models.NexusEmployee(id=f"e{i}", first_name="A", company=CO) for i in range(12)],
                  *[models.HrDepartment(id=f"d{i}", company_id=CO, name=f"Dept {i}") for i in range(3)])
        self.assertEqual(
            self._refused(delete_entity, CO),
            "This company still has 12 employees and 3 departments. Move or remove them first.")
        self.assertTrue(self._company_exists())

    def test_one_of_something_is_singular(self):
        self._add(models.Item(id="i1", name="Drill", company_id=CO))
        self.assertEqual(self._refused(delete_entity, CO),
                         "This company still has 1 inventory item. Move or remove them first.")

    def test_every_kind_of_record_blocks_on_its_own(self):
        makers = {
            "1 candidate": lambda: models.HrCandidate(id="c1", first_name="A", company=CO),
            "1 role or group": lambda: models.NexusGroup(id="g1", name="IT Lead", company_id=CO),
            "1 access scope": lambda: models.NexusAccessScope(
                id="s1", email="a@greensglobal.com", module_id="hr", scope_type="entity", scope_id=CO),
            "1 task": lambda: models.Task(id="t1", title="Roof", company_id=CO),
            "1 ticket": lambda: models.TaskTicket(id="k1", subject="Leak", company_id=CO),
            "1 requisition": lambda: models.Requisition(
                id="r1", employee_name="A", employee_dept="IT", item="Laptop",
                created_at=NOW, updated_at=NOW, company_id=CO),
            "1 document": lambda: models.Document(id="doc1", title="Offer", entity_id=CO),
            "1 signing template": lambda: models.HrSignTemplate(id="st1", name="NDA", entity_id=CO),
            "1 signing envelope": lambda: models.HrSignRequest(id="sr1", title="NDA", entity_id=CO),
            "1 HR life event": lambda: models.HrLifeEvent(id="le1", kind="hire", entity_id=CO),
            "1 checklist": lambda: models.HrChecklist(id="cl1", employee_id="e1", company=CO),
            "1 app link": lambda: models.ExternalLink(
                name="Intacct", url="https://x.example", category="Finance", companies=[CO, OTHER]),
        }
        for phrase, make in makers.items():
            with self.subTest(phrase):
                row = make()
                self._add(row)
                self.assertEqual(self._refused(delete_entity, CO),
                                 f"This company still has {phrase}. Move or remove them first.")
                self.db.delete(row)
                self.db.commit()
        self.assertTrue(self._company_exists())

    def test_another_companys_records_do_not_block(self):
        self._add(models.NexusEmployee(id="e1", first_name="A", company=OTHER),
                  models.Task(id="t1", title="Roof", company_id=OTHER),
                  models.NexusAccessScope(id="s1", email="a@greensglobal.com", module_id="accounting",
                                          scope_type="ledger", scope_id=CO),
                  models.ExternalLink(name="Intacct", url="https://x.example", category="Finance",
                                      companies=[OTHER]))
        delete_entity(CO, user=ADMIN, db=self.db)
        self.assertFalse(self._company_exists())

    def test_a_removed_employee_still_blocks(self):
        # Restoring them would bring back a person whose company is gone.
        self._add(models.NexusEmployee(id="e1", first_name="A", company=CO),
                  models.NexusEmployee(id="e2", first_name="B", company=CO, deleted_at=NOW))
        self.assertEqual(
            self._refused(delete_entity, CO),
            "This company still has 2 employees (1 removed, still restorable). Move or remove them first.")

    def test_trashed_tasks_and_deleted_tickets_still_block(self):
        self._add(models.Task(id="t1", title="Roof", company_id=CO, deleted_at=NOW),
                  models.TaskTicket(id="k1", subject="Leak", company_id=CO, deleted_at=NOW))
        self.assertEqual(
            self._refused(delete_entity, CO),
            "This company still has 1 task (1 in the trash) and 1 ticket (1 deleted, still restorable). "
            "Move or remove them first.")

    def test_the_companys_own_setup_goes_with_it(self):
        self._add(
            models.HrWorkSite(id=SITE, name="Yard", company=CO),
            models.HrCompanyWorkSite(id=f"{CO}:{SITE}", company_id=CO, site_id=SITE),
            models.HrCompanyWorkSite(id=f"{OTHER}:{SITE}", company_id=OTHER, site_id=SITE),
            models.HrCompanyHoliday(id="h1", company_id=CO, date="2026-12-25", name="Christmas"),
            models.HrCompanyHoliday(id="h2", company_id=OTHER, date="2026-12-25", name="Christmas"),
            models.MonitoringPolicy(id="mp1", company_id=CO),
            models.MonitoringPolicy(id="mp0", company_id=""),
            models.HrPacketSetting(id="ps1", event="hire", entity_id=CO),
            models.HrPacketSetting(id="ps0", event="hire", entity_id=""),
            models.HrChecklistTemplate(id="ct1", entity_id=CO),
            models.TicketDepartment(id="td1", company_id=CO, name="IT"),
        )
        delete_entity(CO, user=ADMIN, db=self.db)
        self.assertFalse(self._company_exists())
        for model, column in ((models.HrCompanyWorkSite, models.HrCompanyWorkSite.company_id),
                              (models.HrCompanyHoliday, models.HrCompanyHoliday.company_id),
                              (models.MonitoringPolicy, models.MonitoringPolicy.company_id),
                              (models.HrPacketSetting, models.HrPacketSetting.entity_id),
                              (models.HrChecklistTemplate, models.HrChecklistTemplate.entity_id),
                              (models.TicketDepartment, models.TicketDepartment.company_id)):
            self.assertEqual(self._count(model, column == CO), 0, model.__tablename__)
        # The site is a library entry other companies use: it stays, without
        # its old one-company pointer. The other company and the defaults too.
        site = self.db.query(models.HrWorkSite).filter(models.HrWorkSite.id == SITE).first()
        self.assertEqual(site.company, "")
        self.assertEqual(self._count(models.HrCompanyWorkSite), 1)
        self.assertEqual(self._count(models.HrCompanyHoliday), 1)
        self.assertEqual(self._count(models.MonitoringPolicy), 1)
        self.assertEqual(self._count(models.HrPacketSetting), 1)

    def test_setup_is_kept_when_the_delete_is_refused(self):
        self._add(models.HrCompanyHoliday(id="h1", company_id=CO, date="2026-12-25", name="Christmas"),
                  models.NexusEmployee(id="e1", first_name="A", company=CO))
        self._refused(delete_entity, CO)
        self.assertEqual(self._count(models.HrCompanyHoliday), 1)

    def test_history_and_shared_library_rows_neither_block_nor_go(self):
        self._add(models.NexusNotification(id="n1", type="approved", title="T", body="B",
                                           created_at=NOW, company=CO),
                  models.HrHolidayPolicy(id="hp1", name="US Federal", company_id=CO))
        delete_entity(CO, user=ADMIN, db=self.db)
        self.assertFalse(self._company_exists())
        self.assertEqual(self._count(models.NexusNotification), 1)
        self.assertEqual(self._count(models.HrHolidayPolicy), 1)

    def test_a_missing_company_is_still_ok(self):
        self.assertEqual(delete_entity("nope", user=ADMIN, db=self.db), {"ok": True})


class DeleteWorkSiteTests(_Base):
    def setUp(self):
        super().setUp()
        self._add(models.HrWorkSite(id=SITE, name="Yard"),
                  models.HrWorkSite(id=SITE + "-2", name="Yard 2"),
                  models.HrCompanyWorkSite(id=f"{CO}:{SITE}", company_id=CO, site_id=SITE))

    def _site_exists(self):
        return self._count(models.HrWorkSite, models.HrWorkSite.id == SITE) == 1

    def test_an_unassigned_site_is_deleted_with_its_company_links(self):
        self.assertEqual(delete_work_site(SITE, user=ADMIN, db=self.db), {"ok": True})
        self.assertFalse(self._site_exists())
        self.assertEqual(self._count(models.HrCompanyWorkSite), 0)

    def test_blocked_while_it_is_someones_assigned_site(self):
        self._add(models.NexusEmployee(id="e1", first_name="A", work_site_id=SITE))
        self.assertEqual(self._refused(delete_work_site, SITE),
                         "This work site is still assigned to 1 employee. Assign them to another site first.")
        self.assertTrue(self._site_exists())
        self.assertEqual(self._count(models.HrCompanyWorkSite), 1)

    def test_blocked_while_it_is_on_someones_allowed_list(self):
        self._add(models.NexusEmployee(id="e1", first_name="A", work_site_ids=json.dumps(["x", SITE])),
                  models.NexusEmployee(id="e2", first_name="B", work_site_id=SITE))
        self.assertEqual(self._refused(delete_work_site, SITE),
                         "This work site is still assigned to 2 employees. Assign them to another site first.")

    def test_a_removed_employee_still_blocks(self):
        self._add(models.NexusEmployee(id="e1", first_name="A", work_site_id=SITE, deleted_at=NOW))
        self.assertEqual(
            self._refused(delete_work_site, SITE),
            "This work site is still assigned to 1 employee (1 removed, still restorable). "
            "Assign them to another site first.")

    def test_a_longer_id_containing_this_one_does_not_block(self):
        self._add(models.NexusEmployee(id="e1", first_name="A", work_site_ids=json.dumps([SITE + "-2"])))
        delete_work_site(SITE, user=ADMIN, db=self.db)
        self.assertFalse(self._site_exists())

    def test_punch_history_neither_blocks_nor_is_deleted(self):
        self._add(models.TimePunch(id="p1", employee_email="a@greensglobal.com", kind="in",
                                   at=NOW, work_site_id=SITE))
        delete_work_site(SITE, user=ADMIN, db=self.db)
        self.assertFalse(self._site_exists())
        punch = self.db.query(models.TimePunch).filter(models.TimePunch.id == "p1").first()
        self.assertEqual(punch.work_site_id, SITE)


class DeleteLetterheadAndTemplateTests(_Base):
    def setUp(self):
        super().setUp()
        self._add(models.DocLetterhead(id="lh1", name="Standard", created_by=ADMIN["email"]))

    def _letterhead_exists(self):
        return self._count(models.DocLetterhead, models.DocLetterhead.id == "lh1") == 1

    def test_an_unused_letterhead_is_deleted(self):
        self._add(models.DocTemplate(id="tp1", name="Offer", letterhead_id="lh-other"))
        self.assertEqual(delete_letterhead("lh1", user=ADMIN, db=self.db), {"ok": True})
        self.assertFalse(self._letterhead_exists())

    def test_blocked_while_a_template_uses_it(self):
        self._add(models.DocTemplate(id="tp1", name="Offer", letterhead_id="lh1"))
        self.assertEqual(
            self._refused(delete_letterhead, "lh1"),
            "Cannot delete a letterhead that is still used by 1 template - "
            "switch them to another letterhead first")
        self.assertTrue(self._letterhead_exists())

    def test_blocked_while_documents_use_it(self):
        self._add(models.DocTemplate(id="tp1", name="Offer", letterhead_id="lh1"),
                  models.Document(id="d1", title="A", letterhead_id="lh1"),
                  models.Document(id="d2", title="B", letterhead_id="lh1", status="archived"))
        self.assertEqual(
            self._refused(delete_letterhead, "lh1"),
            "Cannot delete a letterhead that is still used by 1 template and 2 documents - "
            "switch them to another letterhead first")
        self.assertTrue(self._letterhead_exists())

    def test_deleting_a_template_takes_its_versions_with_it(self):
        self._add(models.DocTemplate(id="tp1", name="Offer"),
                  models.DocTemplate(id="tp2", name="NDA"),
                  models.DocTemplateVersion(id="v1", template_id="tp1", version_no=1),
                  models.DocTemplateVersion(id="v2", template_id="tp1", version_no=2),
                  models.DocTemplateVersion(id="v3", template_id="tp2", version_no=1))
        self.assertEqual(delete_template("tp1", user=ADMIN, db=self.db), {"ok": True})
        left = [v.id for v in self.db.query(models.DocTemplateVersion).all()]
        self.assertEqual(left, ["v3"])

    def test_a_template_with_documents_keeps_its_versions(self):
        self._add(models.DocTemplate(id="tp1", name="Offer"),
                  models.DocTemplateVersion(id="v1", template_id="tp1", version_no=1),
                  models.Document(id="d1", title="A", template_id="tp1"))
        self._refused(delete_template, "tp1")
        self.assertEqual(self._count(models.DocTemplateVersion), 1)


class PurgeKeepsAsanaLinkTests(_Base):
    def test_purging_a_task_leaves_its_asana_link(self):
        self._add(models.Task(id="t1", title="Roof", code="TASK-001", deleted_at=NOW),
                  models.Task(id="t2", title="Tiles", parent_task_id="t1", deleted_at=NOW),
                  models.TaskComment(id="c1", task_id="t1"),
                  models.AsanaTaskLink(id="a1", nexus_task_id="t1"),
                  models.AsanaTaskLink(id="a2", nexus_task_id="t2"))
        self.assertTrue(purge_task_permanently(self.db, "t1", ADMIN["email"]))
        self.db.commit()
        self.assertEqual(self._count(models.Task), 0)
        self.assertEqual(self._count(models.TaskComment), 0)
        self.assertEqual(self._count(models.AsanaTaskLink), 2)


class EmployeeCodeTests(_Base):
    def test_a_removed_persons_code_is_not_reissued(self):
        self._add(models.NexusEmployee(id="e1", first_name="A", employee_code="GG-004"),
                  models.NexusEmployee(id="e2", first_name="B", employee_code="GG-009", deleted_at=NOW))
        self.assertEqual(_next_code(self.db), "GG-010")

    def test_first_code(self):
        self.assertEqual(_next_code(self.db), "GG-001")


if __name__ == "__main__":
    unittest.main()
