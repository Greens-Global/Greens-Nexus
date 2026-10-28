"""Confidential (HR) tickets do not leak through the audit log or the ticket
counter (release review, Oct 27 2026).

  * routers/audit_events.py: the feed, one event, a record's history, the CSV
    export and the old /audit-logs list leave out a confidential ticket - and
    its comments - for an administrator who could not open it
    (ticket_confidential.may_read); HR for the company still sees it
  * code_sequence: the next ticket number counts confidential tickets, so a
    new ticket never takes an HR ticket's code

    python -m pytest -q test_confidential_ticket_leaks.py
"""
import asyncio
import json
import os
import tempfile
import unittest
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException  # noqa: E402

import auth  # noqa: E402
import code_sequence  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
from routers import audit as legacy_audit  # noqa: E402
from routers import audit_events as AE  # noqa: E402

CO, OTHER = "co-leak", "co-leak-2"
HR = "hr.leak@greensglobal.com"
EMP = "emp.leak@greensglobal.com"
GA = {"email": "ga.leak@greensglobal.com", "level": 5}          # unrestricted administrator
WALLED = {"email": "walled.leak@greensglobal.com", "level": 4}  # administrator walled into the other company


def _scope(user, db):
    return {OTHER} if (user.get("email") or "") == WALLED["email"] else None


class LeakCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
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
        for m in (models.TaskTicket, models.TaskComment, models.TaskActivity, models.AuditLog, models.AuditChange,
                  models.HrEntity, models.NexusEmployee):
            self.db.query(m).execution_options(include_confidential=True, include_deleted=True).delete()
        self.db.commit()
        self.db.add(models.HrEntity(id=CO, name="Leak Co", hr_contact_email=HR))
        self.db.add(models.HrEntity(id=OTHER, name="Other Co", hr_contact_email=""))
        self.db.add(models.TaskTicket(id="t-hr", code="000500", subject="My visa renewal", confidential_desk="hr",
                                      company_id=CO, requester_email=EMP))
        self.db.add(models.TaskTicket(id="t-plain", code="000010", subject="Printer jammed", company_id=CO,
                                      requester_email=EMP))
        self.db.add(models.TaskComment(id="cm-hr", task_id="t-hr", author_email=EMP, body="Passport scan attached"))
        self.db.add(models.TaskActivity(id="ta-hr", entity_kind="ticket", entity_id="t-hr", entity_title="My visa renewal",
                                        type="created", actor_email=EMP, at="2026-01-01T00:00:00Z"))
        for i, (rid, res, table, rec) in enumerate((("rq-hr", "t-hr", "task_tickets", "t-hr"),
                                                     ("rq-cm", "", "task_comments", "cm-hr"),
                                                     ("rq-plain", "t-plain", "task_tickets", "t-plain"))):
            self.db.add(models.AuditLog(timestamp=f"2026-10-27T10:00:0{i}", user_email=EMP, action=f"Updated {rec}",
                                        resource_type="task-tickets", resource_id=res, request_id=rid, module="tickets",
                                        details=json.dumps({"path": "/task-tickets", "method": "PATCH"})))
            self.db.add(models.AuditChange(request_id=rid, at=f"2026-10-27T10:00:0{i}Z", actor=EMP, module="tickets",
                                           table_name=table, record_id=rec, op="update", summary=rec,
                                           changes=json.dumps({"subject": {"b": "a", "a": "b"}}), source="PATCH"))
        self.db.add(models.AuditChange(request_id="", at="2026-10-27T11:00:00Z", actor="system", module="tickets",
                                       table_name="task_tickets", record_id="t-hr", op="update", summary="t-hr",
                                       changes="{}", source="ticket_sla"))
        self.db.commit()
        AE._FACETS.clear()
        AE._CUTOFF.update(at=0.0, value=None)
        self._p = mock.patch.object(auth, "company_scope", _scope)
        self._p.start()

    def tearDown(self):
        self._p.stop()
        self.db.close()

    def _ids(self, user, **kw):
        params = dict(module=None, actor=None, acting_as=None, record_type=None, record_id=None, action=None,
                      q=None, from_=None, to=None, include_system=True)
        params.update(kw)
        out = AE.list_events(params=params, cursor=None, limit=200, user=dict(user), db=self.db)
        return " ".join(json.dumps(e) for e in out["events"])


class AuditLogTests(LeakCase):
    def test_walled_admin_does_not_see_the_hr_ticket(self):
        text = self._ids(WALLED)
        self.assertIn("t-plain", text)
        self.assertNotIn("t-hr", text)
        self.assertNotIn("cm-hr", text)
        self.assertNotIn("My visa renewal", text)

    def test_global_admin_still_sees_it(self):
        text = self._ids(GA)
        self.assertIn("t-hr", text)
        self.assertIn("cm-hr", text)

    def test_one_event_and_history_are_404(self):
        hr_row = self.db.query(models.AuditLog).filter_by(request_id="rq-hr").one()
        cm_row = self.db.query(models.AuditLog).filter_by(request_id="rq-cm").one()
        sys_row = self.db.query(models.AuditChange).filter_by(source="ticket_sla").one()
        for eid in (f"r{hr_row.id}", f"r{cm_row.id}", f"c{sys_row.id}", "h:task_activity:ta-hr"):
            with self.assertRaises(HTTPException) as e:
                AE.get_event(eid, dict(WALLED), self.db)
            self.assertEqual(e.exception.status_code, 404, eid)
        self.assertEqual(AE.get_event(f"r{hr_row.id}", dict(GA), self.db)["id"], f"r{hr_row.id}")
        with self.assertRaises(HTTPException) as e:
            AE.record_history("ticket", "t-hr", 500, dict(WALLED), self.db)
        self.assertEqual(e.exception.status_code, 404)

    def test_export_and_the_old_list(self):
        params = dict(module=None, actor=None, acting_as=None, record_type=None, record_id=None, action=None,
                      q=None, from_=None, to=None, include_system=True)
        resp = AE.export_csv(params=params, max_rows=1000, user=dict(WALLED), db=self.db)
        async def _read():
            return "".join([c if isinstance(c, str) else c.decode() async for c in resp.body_iterator])
        body = asyncio.run(_read())
        self.assertNotIn("t-hr", body)
        rows = legacy_audit.list_audit_logs(limit=200, offset=0, user_email=None, action=None, resource_type=None,
                                            user=dict(WALLED), db=self.db)["rows"]
        self.assertNotIn("t-hr", {r["resource_id"] for r in rows})
        self.assertIn("t-plain", {r["resource_id"] for r in rows})


class TicketCodeTests(LeakCase):
    def test_next_code_counts_confidential_tickets(self):
        self.db.execute(models.Base.metadata.tables["nexus_counters"].delete())
        self.db.commit()
        self.assertGreater(int(code_sequence.next_ticket_code(self.db)), 500)

    def test_code_taken_sees_confidential(self):
        self.assertTrue(code_sequence._ticket_code_taken(self.db, 500))


if __name__ == "__main__":
    unittest.main()
