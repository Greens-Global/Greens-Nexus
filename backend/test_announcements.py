"""Announcements (Essentials, Oct 7): routers/announcements.py end to end.

Administrators post, edit and delete and read the receipt list; employees
can only list, read and acknowledge. A department post reaches its department
(and the author / administrators), pinned posts sit above newer ones, the
read / ack marks upsert onto one row per person, a soft delete hides the row,
and a new post leaves one bell notification per person in its audience.

Throwaway sqlite, NEXUS_SKIP_AUTH identity. No network.

Run alone: python -m pytest test_announcements.py
"""
import os
import tempfile
import unittest
import uuid

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

import atexit

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


ADMIN = "ann.admin@greensglobal.com"       # administrator (level 4), Operations
OPS = "ann.ops@greensglobal.com"           # employee, Operations
FIN = "ann.fin@greensglobal.com"           # employee, Finance
PEOPLE = {ADMIN: ("Ada", "Admin", "Operations"),
          OPS: ("Oscar", "Ops", "Operations"),
          FIN: ("Fiona", "Fin", "Finance")}


class AnnouncementsTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._cleanup()
        db = database.SessionLocal()
        try:
            for email, (first, last, dept) in PEOPLE.items():
                db.add(models.NexusEmployee(id=f"e-{email}", first_name=first, last_name=last,
                                            work_email=email, department=dept, status="active", deleted_at=""))
            db.add(models.NexusRole(email=ADMIN, role="administrator"))
            db.add(models.NexusRole(email=OPS, role="employee"))
            db.add(models.NexusRole(email=FIN, role="employee"))
            db.commit()
        finally:
            db.close()
        self._flush()

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)
        self._flush()

    def _flush(self):
        auth.invalidate_role_cache()
        cache.settings_config.invalidate()
        cache.people_directory.invalidate()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email.like("ann.%")).delete(synchronize_session=False))
            db.query(models.NexusRole).filter(models.NexusRole.email.like("ann.%")).delete(synchronize_session=False)
            db.query(models.Announcement).delete(synchronize_session=False)
            db.query(models.AnnouncementRead).delete(synchronize_session=False)
            db.query(models.NexusNotification).filter(models.NexusNotification.type == "announcement").delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache()

    def _post(self, as_email=ADMIN, **body):
        self._as(as_email)
        payload = {"title": "Office closed Friday", "body": "The office is closed on Friday.\nWork from home.", "audience": "company"}
        payload.update(body)
        return self.client.post("/announcements", json=payload)

    def _list(self, as_email):
        self._as(as_email)
        r = self.client.get("/announcements")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    # ── Permissions ──────────────────────────────────────────────────────────

    def test_admin_can_post_edit_and_delete(self):
        r = self._post()
        self.assertEqual(r.status_code, 201, r.text)
        a = r.json()
        self.assertEqual(a["title"], "Office closed Friday")
        self.assertEqual(a["author_email"], ADMIN)
        self.assertEqual(a["author_name"], "Ada Admin")
        self.assertFalse(a["pinned"])
        self.assertEqual((a["read_count"], a["ack_count"]), (0, 0))

        r = self.client.patch(f"/announcements/{a['id']}", json={"title": "Office closed Monday", "requires_ack": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["title"], "Office closed Monday")
        self.assertTrue(r.json()["requires_ack"])
        self.assertEqual(r.json()["body"], a["body"])      # partial update keeps the rest

        r = self.client.delete(f"/announcements/{a['id']}")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._list(ADMIN), [])

    def test_employee_cannot_post_edit_delete_or_read_receipts(self):
        a = self._post().json()
        self._as(OPS)
        self.assertEqual(self.client.post("/announcements", json={"title": "x", "body": "y"}).status_code, 401)
        self.assertEqual(self.client.patch(f"/announcements/{a['id']}", json={"title": "x"}).status_code, 401)
        self.assertEqual(self.client.delete(f"/announcements/{a['id']}").status_code, 401)
        self.assertEqual(self.client.get(f"/announcements/{a['id']}/reads").status_code, 401)
        # ...but can list, read and acknowledge
        self.assertEqual(len(self._list(OPS)), 1)
        self.assertEqual(self.client.post(f"/announcements/{a['id']}/read", json={}).status_code, 200)
        self.assertEqual(self.client.post(f"/announcements/{a['id']}/ack", json={}).status_code, 200)

    # ── Validation ───────────────────────────────────────────────────────────

    def test_bad_input_is_422_never_500(self):
        cases = [
            {"title": "", "body": "b"},
            {"title": "t" * 201, "body": "b"},
            {"title": "t", "body": ""},
            {"title": "t", "body": "b" * 20001},
            {"title": "t", "body": "b", "audience": "everyone"},
            {"title": "t", "body": "b", "audience": "department", "department": ""},
            {"title": "t", "body": "b", "pinned_until": "10/20/2026"},
            {"title": "t", "body": "b", "pinned_until": "2026-02-30"},
            {"title": "t", "body": "b", "requires_ack": "sometimes"},
            {"title": ["not", "text"], "body": "b"},
        ]
        for body in cases:
            r = self._post(**body)
            self.assertEqual(r.status_code, 422, f"{body!r} -> {r.status_code} {r.text}")
            self.assertTrue(r.json()["detail"])
        self._as(ADMIN)
        self.assertEqual(self.client.post("/announcements", json=["not", "an", "object"]).status_code, 422)
        self.assertEqual(self.client.patch("/announcements/nope", json={"title": "x"}).status_code, 404)
        self.assertEqual(self.client.post("/announcements/nope/read", json={}).status_code, 404)

    # ── Audience ─────────────────────────────────────────────────────────────

    def test_department_announcement_reaches_only_that_department(self):
        self._post(title="Company wide")
        self._post(title="Finance only", audience="department", department="finance")
        self.assertEqual([a["title"] for a in self._list(FIN)], ["Finance only", "Company wide"])
        self.assertEqual([a["title"] for a in self._list(OPS)], ["Company wide"])
        # administrators see every announcement so they can manage it
        self.assertEqual(len(self._list(ADMIN)), 2)
        dept = [a for a in self._list(FIN) if a["title"] == "Finance only"][0]
        self.assertEqual(dept["department"], "finance")

    # ── Ordering ─────────────────────────────────────────────────────────────

    def test_pinned_announcements_come_first_then_newest(self):
        db = database.SessionLocal()
        try:
            def row(title, created, pinned_until=""):
                db.add(models.Announcement(id=str(uuid.uuid4()), title=title, body="b", author_email=ADMIN,
                                           audience="company", pinned_until=pinned_until,
                                           created_at=created, updated_at=created, deleted_at=""))
            row("Oldest pinned", "2026-01-01T00:00:00+00:00", "2099-12-31")
            row("Expired pin", "2026-03-01T00:00:00+00:00", "2020-01-01")
            row("Middle", "2026-02-01T00:00:00+00:00")
            row("Newest", "2026-04-01T00:00:00+00:00")
            db.commit()
        finally:
            db.close()
        titles = [a["title"] for a in self._list(OPS)]
        self.assertEqual(titles, ["Oldest pinned", "Newest", "Expired pin", "Middle"])
        rows = self._list(OPS)
        self.assertTrue(rows[0]["pinned"])
        self.assertFalse(rows[2]["pinned"])      # an expired pin is not pinned

    def test_list_is_capped_at_fifty(self):
        db = database.SessionLocal()
        try:
            for i in range(55):
                db.add(models.Announcement(id=str(uuid.uuid4()), title=f"A{i}", body="b", author_email=ADMIN,
                                           audience="company", created_at=f"2026-01-{(i % 28) + 1:02d}T00:00:00+00:00",
                                           updated_at="", deleted_at=""))
            db.commit()
        finally:
            db.close()
        self.assertEqual(len(self._list(OPS)), 50)

    # ── Read / acknowledge ───────────────────────────────────────────────────

    def test_read_and_ack_upsert_one_row_per_person(self):
        a = self._post(requires_ack=True).json()
        self._as(OPS)
        r1 = self.client.post(f"/announcements/{a['id']}/read", json={}).json()
        self.assertTrue(r1["read_at"])
        self.assertEqual(r1["acknowledged_at"], "")
        r2 = self.client.post(f"/announcements/{a['id']}/read", json={}).json()
        self.assertEqual(r2["read_at"], r1["read_at"])          # a second read keeps the first stamp
        r3 = self.client.post(f"/announcements/{a['id']}/ack", json={}).json()
        self.assertEqual(r3["read_at"], r1["read_at"])
        self.assertTrue(r3["acknowledged_at"])
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.AnnouncementRead)
                               .filter(models.AnnouncementRead.announcement_id == a["id"]).count(), 1)
        finally:
            db.close()
        mine = self._list(OPS)[0]
        self.assertEqual(mine["read_at"], r1["read_at"])
        self.assertEqual(mine["acknowledged_at"], r3["acknowledged_at"])
        self.assertNotIn("read_count", mine)                   # counts are for administrators only
        # ack straight away (no prior read) sets both stamps
        self._as(FIN)
        r4 = self.client.post(f"/announcements/{a['id']}/ack", json={}).json()
        self.assertTrue(r4["read_at"] and r4["acknowledged_at"])
        theirs = self._list(ADMIN)[0]
        self.assertEqual((theirs["read_count"], theirs["ack_count"]), (2, 2))

    def test_reads_list_names_people_and_is_admin_only(self):
        a = self._post().json()
        self._as(OPS)
        self.client.post(f"/announcements/{a['id']}/read", json={})
        self._as(FIN)
        self.client.post(f"/announcements/{a['id']}/ack", json={})
        self._as(ADMIN)
        r = self.client.get(f"/announcements/{a['id']}/reads")
        self.assertEqual(r.status_code, 200, r.text)
        rows = r.json()
        self.assertEqual([x["email"] for x in rows], [FIN, OPS])     # acknowledged first
        self.assertEqual(rows[0]["name"], "Fiona Fin")
        self.assertTrue(rows[0]["acknowledged_at"])
        self.assertEqual(rows[1]["acknowledged_at"], "")
        self._as(OPS)
        self.assertEqual(self.client.get(f"/announcements/{a['id']}/reads").status_code, 401)

    # ── Soft delete ──────────────────────────────────────────────────────────

    def test_soft_delete_hides_but_keeps_the_row(self):
        a = self._post().json()
        self._as(OPS)
        self.client.post(f"/announcements/{a['id']}/read", json={})
        self._as(ADMIN)
        self.assertEqual(self.client.delete(f"/announcements/{a['id']}").status_code, 200)
        self.assertEqual(self._list(OPS), [])
        self._as(OPS)
        self.assertEqual(self.client.post(f"/announcements/{a['id']}/read", json={}).status_code, 404)
        self._as(ADMIN)
        self.assertEqual(self.client.delete(f"/announcements/{a['id']}").status_code, 404)
        db = database.SessionLocal()
        try:
            row = db.query(models.Announcement).filter(models.Announcement.id == a["id"]).first()
            self.assertIsNotNone(row)
            self.assertTrue(row.deleted_at)
            self.assertEqual(db.query(models.AnnouncementRead)
                               .filter(models.AnnouncementRead.announcement_id == a["id"]).count(), 1)
        finally:
            db.close()

    # ── Bell ─────────────────────────────────────────────────────────────────

    def test_post_leaves_one_bell_notification_per_person_in_the_audience(self):
        a = self._post(audience="department", department="Operations").json()
        db = database.SessionLocal()
        try:
            rows = (db.query(models.NexusNotification)
                      .filter(models.NexusNotification.type == "announcement",
                              models.NexusNotification.ref_id == a["id"]).all())
            self.assertEqual([r.recipient for r in rows], [OPS])     # not the author, not Finance
            self.assertEqual(rows[0].title, "Announcement: Office closed Friday")
            self.assertIn("Ada Admin", rows[0].body)
        finally:
            db.close()
        b = self._post(title="Everyone").json()
        db = database.SessionLocal()
        try:
            rows = (db.query(models.NexusNotification)
                      .filter(models.NexusNotification.type == "announcement",
                              models.NexusNotification.ref_id == b["id"]).all())
            self.assertEqual(sorted(r.recipient for r in rows), sorted([OPS, FIN]))
        finally:
            db.close()
        # ...and the bell shows it to the employee
        self._as(OPS)
        r = self.client.get("/notifications")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("Announcement: Everyone", [n["title"] for n in r.json()])


if __name__ == "__main__":
    unittest.main()
