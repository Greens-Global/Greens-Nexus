"""Unified Audit Log (Oct 20 2026) - audit_capture.py, audit_modules.py,
the AuditMiddleware changes and routers/audit_events.py.

Covers: field-level capture on insert / update / delete with before and after
(and before-unknown for a value never loaded), redaction (secrets, JSON keys,
pay, PFS), a task comment posted under Act As showing the comment text and
both people, telemetry paths not written, the module map, keyset paging with
no gaps or repeats, record history, permissions, and that a failing audit
insert never fails the write.

Run alone (one file per process, CLAUDE.md):
    python -m pytest test_audit_unified.py
"""
import json
import os
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from unittest import mock

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import audit_capture  # noqa: E402
import audit_modules as am  # noqa: E402
import auth  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import audit_events  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)
main._run_migrations()

OWNER = "auditprobe.owner@greensglobal.com"
ADMIN = "auditprobe.admin@greensglobal.com"
EMP = "auditprobe.emp@greensglobal.com"


def _changes_for(table, record_id):
    db = database.SessionLocal()
    try:
        return (db.query(models.AuditChange)
                .filter(models.AuditChange.table_name == table, models.AuditChange.record_id == record_id)
                .order_by(models.AuditChange.id).all())
    finally:
        db.close()


def _in_request(actor=OWNER, acting_as=""):
    ctx, token = audit_capture.begin_request("/probe", "POST", "127.0.0.1")
    audit_capture.note_identity(actor, acting_as)
    return ctx, token


class _Roles(unittest.TestCase):
    def setUp(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusRole).filter(models.NexusRole.email.in_([OWNER, ADMIN, EMP])).delete(
                synchronize_session=False)
            db.add(models.NexusRole(email=OWNER, role="owner", assigned_by="test"))
            db.add(models.NexusRole(email=ADMIN, role="administrator", assigned_by="test"))
            db.add(models.NexusRole(email=EMP, role="employee", assigned_by="test"))
            db.commit()
        finally:
            db.close()
        auth.invalidate_role_cache()
        self._dev = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = OWNER
        audit_events._FACETS.clear()
        audit_events._CUTOFF.update(at=0.0, value=None)
        self.client = TestClient(main.app)

    def tearDown(self):
        if self._dev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._dev
        auth.invalidate_role_cache()


class CaptureTests(_Roles):
    def test_insert_update_delete_with_before_and_after(self):
        cid = "c-" + uuid.uuid4().hex[:10]
        ctx, tok = _in_request()
        try:
            db = database.SessionLocal()
            c = models.TaskComment(id=cid, task_id="t-x", author_email=OWNER,
                                   body="<p>Hello <b>world</b></p>", created_at="2026-10-20T00:00:00Z")
            db.add(c)
            db.commit()
            c = db.get(models.TaskComment, cid)
            c.body = "Second version"
            db.commit()
            db.expire(c, ["pinned"])       # never loaded before the write
            c.pinned = True
            db.commit()
            db.delete(db.get(models.TaskComment, cid))
            db.commit()
            db.close()
        finally:
            audit_capture.end_request(tok)
        rows = _changes_for("task_comments", cid)
        self.assertEqual([r.op for r in rows], ["insert", "update", "update", "delete"])
        ins = json.loads(rows[0].changes)
        self.assertEqual(ins["body"]["a"], "Hello world")
        self.assertEqual(ins["body"]["t"], "html")
        self.assertNotIn("b", ins["body"])
        upd = json.loads(rows[1].changes)
        self.assertEqual(upd["body"], {"b": "Hello world", "a": "Second version", "t": "html"})
        self.assertEqual(json.loads(rows[2].changes)["pinned"], {"bu": True, "a": True})
        dele = json.loads(rows[3].changes)
        self.assertEqual(dele["body"]["b"], "Second version")
        self.assertNotIn("a", dele["body"])
        self.assertTrue(all(r.actor == OWNER and r.request_id == ctx.request_id for r in rows))
        self.assertEqual(rows[0].module, "tasks")

    def test_unchanged_value_is_not_an_update(self):
        cid = "c-" + uuid.uuid4().hex[:10]
        db = database.SessionLocal()
        db.add(models.TaskComment(id=cid, task_id="t", body="same"))
        db.commit()
        c = db.get(models.TaskComment, cid)
        c.body = "same"
        db.commit()
        db.close()
        self.assertEqual([r.op for r in _changes_for("task_comments", cid)], ["insert"])

    def test_background_change_is_system_with_job(self):
        cid = "c-" + uuid.uuid4().hex[:10]
        with audit_capture.system_job("probe_loop"):
            db = database.SessionLocal()
            db.add(models.TaskComment(id=cid, task_id="t", body="from a job"))
            db.commit()
            db.close()
        row = _changes_for("task_comments", cid)[0]
        self.assertEqual((row.actor, row.source), ("system", "probe_loop"))

    def test_a_huge_flush_is_capped_with_a_summary_row(self):
        ctx, tok = _in_request()
        try:
            db = database.SessionLocal()
            for i in range(audit_capture.MAX_ROWS_PER_FLUSH + 5):
                db.add(models.TaskComment(id=f"bulk-{ctx.request_id[:8]}-{i}", task_id="t", body=str(i)))
            db.commit()
            db.close()
        finally:
            audit_capture.end_request(tok)
        db = database.SessionLocal()
        try:
            rows = db.query(models.AuditChange).filter(models.AuditChange.request_id == ctx.request_id).all()
        finally:
            db.close()
        self.assertEqual(len(rows), audit_capture.MAX_ROWS_PER_FLUSH + 1)
        self.assertEqual([r.summary for r in rows if r.op == "bulk"], ["5 more records"])

    def test_noise_tables_are_not_captured(self):
        nid = "n-" + uuid.uuid4().hex[:10]
        db = database.SessionLocal()
        db.add(models.NexusNotification(id=nid, type="x", recipient=OWNER, title="t", body="b", created_at="x"))
        db.commit()
        db.close()
        self.assertEqual(_changes_for("nexus_notifications", nid), [])

    def test_audit_failure_never_fails_the_write(self):
        cid = "c-" + uuid.uuid4().hex[:10]
        with mock.patch.object(audit_capture, "_write", side_effect=RuntimeError("audit down")):
            db = database.SessionLocal()
            db.add(models.TaskComment(id=cid, task_id="t", body="still saved"))
            db.commit()
            db.close()
        db = database.SessionLocal()
        try:
            self.assertIsNotNone(db.get(models.TaskComment, cid))
        finally:
            db.close()
        self.assertEqual(_changes_for("task_comments", cid), [])


class RedactionTests(_Roles):
    def test_secret_columns_and_json_keys(self):
        vid = "v-" + uuid.uuid4().hex[:10]
        key = "audit.probe." + uuid.uuid4().hex[:6]
        _ctx, tok = _in_request()     # settings are captured when a person saves them
        try:
            db = database.SessionLocal()
            db.add(models.VaultCredential(id=vid, name="Router", secret_enc="gAAAA-cipher", secret_hash="abc"))
            db.add(models.NexusSetting(key=key, value=json.dumps({"clientSecret": "s3cr3t", "apiToken": "t0k",
                                                                  "name": "visible"})))
            db.commit()
            db.close()
        finally:
            audit_capture.end_request(tok)
        v = json.loads(_changes_for("vault_credentials", vid)[0].changes)
        self.assertEqual(v["secret_enc"], {"r": "secret"})
        self.assertEqual(v["secret_hash"], {"r": "secret"})
        self.assertEqual(v["name"]["a"], "Router")
        s = json.loads(_changes_for("nexus_settings", key)[0].changes)
        self.assertEqual(s["value"]["a"], {"clientSecret": "[redacted]", "apiToken": "[redacted]",
                                           "name": "visible"})
        self.assertNotIn("s3cr3t", _changes_for("nexus_settings", key)[0].changes)

    def test_pay_and_pfs_values_are_never_stored(self):
        em = f"payprobe.{uuid.uuid4().hex[:6]}@greensglobal.com"
        db = database.SessionLocal()
        db.add(models.PayrollRate(employee_email=em, hourly_rate=42.5))
        pid = "p-" + uuid.uuid4().hex[:10]
        db.add(models.PfsProfile(id=pid, name="Probe Borrower"))
        db.commit()
        db.close()
        db = database.SessionLocal()
        try:
            rows = db.query(models.AuditChange).filter(models.AuditChange.table_name.in_(
                ["payroll_rates", "pfs_profiles"])).order_by(models.AuditChange.id.desc()).limit(2).all()
        finally:
            db.close()
        blob = " ".join(r.changes for r in rows)
        self.assertNotIn("42.5", blob)
        self.assertNotIn("Probe Borrower", blob)
        self.assertIn('"r": "pay"', blob)
        self.assertIn('"r": "pfs"', blob)

    def test_clean_value(self):
        big = "A" * 5000
        v, _ = audit_capture.clean_value(big)
        self.assertTrue(v.startswith("[binary data"))     # long base64-ish run
        v, _ = audit_capture.clean_value("word " * 1000)
        self.assertLessEqual(len(v), audit_capture.MAX_TEXT + 40)
        self.assertIn("truncated", v)
        for name in ("password", "refresh_token", "api_key", "ssn_last4", "routing_number", "signature_image",
                     "otp_code", "clientSecret"):
            self.assertTrue(audit_capture.is_secret_field(name), name)
        for name in ("pinned", "title", "status", "key", "scorecard", "description"):
            self.assertFalse(audit_capture.is_secret_field(name), name)


class ModuleMapTests(unittest.TestCase):
    def test_resources(self):
        cases = {"hr": "people", "employee": "people", "myhr": "people", "jobroles": "people",
                 "timeclock": "time", "timesheet-review": "time", "tasks": "tasks", "task-projects": "tasks",
                 "task-tickets": "tickets", "ticket-ai": "tickets", "items": "inventory",
                 "property-assets": "assets", "accounting": "accounting", "pfs": "pfs", "leasing": "leasing",
                 "ops-projects": "operations", "unit-map": "operations", "esign": "documents",
                 "roles": "settings", "branding": "settings", "external-auth": "security",
                 "external_auth": "security", "act-as": "security", "client-errors": "system",
                 "nonsense": "other", "": "other"}
        for r, m in cases.items():
            self.assertEqual(am.module_for_resource(r), m, r)
        self.assertEqual(am.module_for_resource("tasks", "Authorization denied"), "security")

    def test_tables(self):
        cases = {"nexus_employees": "people", "hr_candidates": "people", "hr_sign_requests": "documents",
                 "time_punches": "time", "scheduled_shifts": "time", "tasks": "tasks", "task_comments": "tasks",
                 "task_tickets": "tickets", "items": "inventory", "pfs_lines": "pfs", "vault_credentials": "vault",
                 "accounting_flux_notes": "accounting", "leases": "leasing", "nexus_roles": "settings"}
        for t, m in cases.items():
            self.assertEqual(am.module_for_table(t), m, t)
        for k in set(am._RESOURCES.values()) | set(am._TABLES.values()):
            self.assertIn(k, am.MODULE_LABELS)

    def test_telemetry(self):
        for p in ("/timeclock/agent/activity", "/timeclock/agent/checkin", "/timeclock/agent/screenshot",
                  "/timeclock/track/ping", "/timeclock/location-trail/ping", "/client-errors",
                  "/tours/welcome/seen", "/task-notifications/read-all"):
            self.assertTrue(am.is_telemetry(p), p)
        for p in ("/timeclock/punch", "/timeclock/agent/enroll", "/tasks/1/comments", "/timeclock/track/start"):
            self.assertFalse(am.is_telemetry(p), p)

    def test_kind(self):
        self.assertEqual(am.kind_for("POST", "tasks", "Created tasks",
                                     [("task_comments", "insert"), ("tasks", "update")]), "comment")
        self.assertEqual(am.kind_for("PATCH", "tasks", "x", [("task_activity", "insert"), ("tasks", "update")]),
                         "update")
        self.assertEqual(am.kind_for("POST", "x", "Authorization denied", []), "denied")
        self.assertEqual(am.kind_for("POST", "auth", "x", []), "login")
        self.assertEqual(am.kind_for("DELETE", "x", "x", []), "delete")


class MiddlewareTests(_Roles):
    def _count(self, path_part):
        db = database.SessionLocal()
        try:
            return db.query(models.AuditLog).filter(models.AuditLog.details.like(f"%{path_part}%")).count()
        finally:
            db.close()

    def test_telemetry_paths_not_written(self):
        before = self._count("/timeclock/agent/activity")
        self.client.post("/timeclock/agent/activity", json={})
        self.client.post("/timeclock/agent/checkin", json={})
        self.assertEqual(self._count("/timeclock/agent/activity"), before)
        self.assertEqual(self._count('"/timeclock/agent/checkin"'), 0)


class ActAsCommentTests(_Roles):
    def test_comment_under_act_as_shows_text_and_both_people(self):
        tid = "t-" + uuid.uuid4().hex[:10]
        sid = "s-" + uuid.uuid4().hex[:10]
        db = database.SessionLocal()
        db.add(models.Task(id=tid, code="AUD-1", title="Q3 close", created_at="2026-10-20T00:00:00Z"))
        future = (datetime.now(timezone.utc) + timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
        db.add(models.ActAsSession(id=sid, real_email=OWNER, target_email=ADMIN,
                                   started_at="2026-10-20T00:00:00Z", expires_at=future))
        db.commit()
        db.close()
        r = self.client.post(f"/tasks/{tid}/comments", json={"body": "<p>Numbers are <b>final</b></p>"},
                             headers={"X-Act-As-Session": sid})
        self.assertEqual(r.status_code, 201, r.text)
        cid = r.json()["id"]
        row = _changes_for("task_comments", cid)[0]
        self.assertEqual((row.actor, row.acting_as), (OWNER, ADMIN))
        self.assertIn("Numbers are final", row.changes)

        ev = self.client.get("/audit/events", params={"module": "tasks", "action": "comment",
                                                      "acting_as": "any", "limit": 5}).json()["events"]
        mine = [e for e in ev if (e.get("target") or {}).get("id") == tid]
        self.assertTrue(mine, ev)
        e = mine[0]
        self.assertEqual(e["title"], 'Commented on task "Q3 close"')
        self.assertIn("Numbers are final", e["summary"])
        self.assertEqual(e["actor"]["email"], OWNER)
        self.assertEqual(e["actingAs"]["email"], ADMIN)
        self.assertEqual(e["action"], "comment")
        self.assertTrue(e["at"].endswith("Z"))
        self.assertIn("preview", e)

        d = self.client.get(f"/audit/events/{e['id']}").json()
        bodies = [c for c in d["changes"] if c["field"] == "body" and c["record"]["table"] == "task_comments"]
        self.assertEqual(bodies[0]["after"], "Numbers are final")
        self.assertEqual(d["request"]["path"], f"/tasks/{tid}/comments")

        # editing it records the prior text
        r = self.client.patch(f"/tasks/comments/{cid}", json={"body": "Numbers are draft"},
                              headers={"X-Act-As-Session": sid})
        self.assertEqual(r.status_code, 200, r.text)
        h = self.client.get(f"/audit/records/comment/{cid}/history").json()
        self.assertEqual(h["record"]["table"], "task_comments")
        upd = [x for x in h["entries"] if x["op"] == "update"]
        self.assertTrue(upd)
        body = next(c for c in upd[-1]["changes"] if c["field"] == "body")
        self.assertEqual((body["before"], body["after"]), ("Numbers are final", "Numbers are draft"))
        # the task's own history carries the comment as a related record
        th = self.client.get(f"/audit/records/task/{tid}/history").json()
        rel = [rr for x in th["entries"] for rr in x.get("related", []) if rr["table"] == "task_comments"]
        self.assertTrue(rel)


class FeedTests(_Roles):
    def _seed(self, n, module="time"):
        tag = uuid.uuid4().hex[:8]
        db = database.SessionLocal()
        base = datetime(2025, 3, 1, 12, 0, 0)
        for i in range(n):
            ts = (base + timedelta(seconds=i // 2)).isoformat()   # pairs share a timestamp
            db.add(models.AuditLog(timestamp=ts, user_email=f"pager.{tag}@greensglobal.com", action="Updated x",
                                   resource_type="timeclock", resource_id=str(i), details="{}",
                                   request_id="", module="", kind=""))
        db.commit()
        db.close()
        return tag

    def test_keyset_pages_have_no_gaps_or_repeats(self):
        tag = self._seed(7)
        seen, cursor = [], None
        for _ in range(10):
            params = {"actor": f"pager.{tag}", "limit": 3, "from": "2025-03-01", "to": "2025-03-01"}
            if cursor:
                params["cursor"] = cursor
            body = self.client.get("/audit/events", params=params).json()
            seen += [e["target"]["id"] for e in body["events"]]
            cursor = body["nextCursor"]
            if not cursor:
                break
        self.assertEqual(sorted(seen, key=int), [str(i) for i in range(7)])
        self.assertEqual(len(seen), len(set(seen)))
        ats = []
        body = self.client.get("/audit/events", params={"actor": f"pager.{tag}", "limit": 7}).json()
        ats = [e["at"] for e in body["events"]]
        self.assertEqual(ats, sorted(ats, reverse=True))
        self.assertTrue(all(e["module"] == "time" for e in body["events"]))

    def test_legacy_telemetry_hidden_unless_system(self):
        tag = uuid.uuid4().hex[:8]
        db = database.SessionLocal()
        db.add(models.AuditLog(timestamp="2025-04-01T00:00:00", user_email=f"tele.{tag}@x.com",
                               action="Created timeclock", resource_type="timeclock", resource_id="agent",
                               details=json.dumps({"path": "/timeclock/agent/activity", "status": 200})))
        db.commit()
        db.close()
        q = {"actor": f"tele.{tag}"}
        self.assertEqual(self.client.get("/audit/events", params=q).json()["events"], [])
        shown = self.client.get("/audit/events", params={**q, "include_system": "true"}).json()["events"]
        self.assertEqual(len(shown), 1)

    def test_facets_and_export(self):
        self._seed(3)
        f = self.client.get("/audit/facets", params={"from": "2025-03-01", "to": "2025-03-02"}).json()
        self.assertEqual([d["date"] for d in f["days"]], ["2025-03-01", "2025-03-02"])
        self.assertGreaterEqual(next(m["count"] for m in f["modules"] if m["key"] == "time"), 3)
        r = self.client.get("/audit/export.csv", params={"from": "2025-03-01", "to": "2025-03-01"})
        self.assertEqual(r.status_code, 200)
        lines = r.text.strip().splitlines()
        self.assertTrue(lines[0].startswith("Date (UTC),Time (UTC)"))
        self.assertIn("03/01/2025", lines[1])
        self.assertRegex(lines[1], r"\d{1,2}:\d{2}:\d{2} (AM|PM)")

    def test_non_admin_is_refused_and_pfs_hidden_from_admin(self):
        os.environ["NEXUS_DEV_EMAIL"] = EMP
        for url in ("/audit/events", "/audit/facets", "/audit/export.csv"):
            self.assertIn(self.client.get(url).status_code, (401, 403), url)
        os.environ["NEXUS_DEV_EMAIL"] = ADMIN
        self.assertEqual(self.client.get("/audit/events", params={"module": "pfs"}).status_code, 403)
        f = self.client.get("/audit/facets").json()
        self.assertNotIn("pfs", [m["key"] for m in f["modules"]])
        os.environ["NEXUS_DEV_EMAIL"] = OWNER
        f = self.client.get("/audit/facets").json()
        self.assertIn("pfs", [m["key"] for m in f["modules"]])

    def test_old_endpoint_still_works(self):
        r = self.client.get("/audit-logs", params={"limit": 5})
        self.assertEqual(r.status_code, 200)
        self.assertIn("rows", r.json())


if __name__ == "__main__":
    unittest.main()


class PerRecordRowsTests(unittest.TestCase):
    """One request that writes an audit row per person (the Intacct code Apply,
    Oct 21) titles each row after ITS person, not the request's first change."""

    def test_each_row_is_about_its_own_record(self):
        rid = "req-" + uuid.uuid4().hex
        db = database.SessionLocal()
        try:
            rows = []
            for i, (pid, name, old, new) in enumerate((("p-1", "Ricky Cotton", "GG-120", "E-0167"),
                                                       ("p-2", "Ada Sample", "GG-006", "E-0193"),
                                                       ("p-3", "Ben Example", "GG-001", "E-0194"))):
                db.add(models.AuditChange(request_id=rid, at=f"2026-10-21T09:28:0{i}Z", actor="hr@x.com", module="people",
                                          table_name="nexus_employees", record_id=pid, op="update", summary=name,
                                          changes=json.dumps({"employee_code": {"b": old, "a": new}}), source="POST /hr/intacct-codes/apply"))
                row = models.AuditLog(timestamp=f"2026-10-21T09:28:0{i}", user_email="hr@x.com", action="Employee code from Intacct",
                                      resource_type="employee", resource_id=pid, request_id=rid, module="people",
                                      details=json.dumps({"changes": {"employee_code": [old, new]}}))
                db.add(row)
                rows.append(row)
            db.commit()
            for r in rows:
                db.refresh(r)
            evs = audit_events._request_events(db, rows, {})
            titles = [e["title"] for e in evs]
            self.assertEqual(len(set(titles)), 3, titles)
            self.assertIn("Ada Sample", titles[1])
            self.assertIn("Ben Example", titles[2])
            self.assertNotIn("other record", evs[1]["summary"])
            self.assertEqual(evs[2]["preview"][0]["after"], "E-0194")
        finally:
            db.close()
