"""Asana is removed, its data is not (Sep 2026) - asana_legacy.py.

Pins the two promises: the audit finds every Nexus row still pointing at
Asana-hosted content (attachments, descriptions, comments) without touching
it, and every archived asana_* row is still there to be counted.

Run with: python -m unittest test_asana_legacy -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import asana_legacy  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
from routers.task_util import gen_id, now_iso  # noqa: E402

FILE = "https://asana-user-private-us-east-1.s3.amazonaws.com/assets/1/x.png?X-Amz=1"
FILE2 = "https://s3.amazonaws.com/asanausercontent.com/x.pdf"
LINK = "https://app.asana.com/0/123/456"
OURS = "https://abc.supabase.co/storage/v1/object/public/task-files/ok.png"


class AuditTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        actual = database.engine.url.database or ""
        assert os.path.abspath(actual) == os.path.abspath(_tmp_db.name), actual
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except FileNotFoundError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        t = models.Task(id="t1", code="TASK-1", title="Lease renewal", created_at=now_iso(),
                        description=f'<p>See <a href="{LINK}">Asana</a></p>', synced_with_asana=True)
        clean = models.Task(id="t2", code="TASK-2", title="Clean", created_at=now_iso(), description="<p>hi</p>")
        self.db.add_all([t, clean,
                         models.TaskAttachment(id=gen_id(), task_id="t1", name="dead.pdf", url=FILE2),
                         models.TaskAttachment(id=gen_id(), task_id="t1", name="ok.png", url=OURS),
                         models.TaskAttachment(id=gen_id(), task_id="t1", name="signed.png", url=FILE),
                         models.TaskComment(id=gen_id(), task_id="t1", author_email="a@x.com",
                                            body=f'<p><img src="{FILE2}"></p>', created_at=now_iso()),
                         models.AsanaTaskLink(id=gen_id(), nexus_task_id="t1", asana_gid="999")])
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        for m in (models.Task, models.TaskAttachment, models.TaskComment, models.AsanaTaskLink):
            self.db.query(m).delete()
        self.db.commit()
        self.db.close()

    def test_finds_every_row_still_pointing_at_asana(self):
        r = asana_legacy.audit(self.db)
        self.assertEqual(r["attachments"]["total"], 2)
        rows = {a["name"]: a for a in r["attachments"]["rows"]}
        self.assertEqual(set(rows), {"dead.pdf", "signed.png"})
        self.assertEqual({a["kind"] for a in rows.values()}, {"asana_file"})
        self.assertEqual(rows["dead.pdf"]["taskCode"], "TASK-1")
        self.assertEqual(r["descriptions"]["total"], 1)
        self.assertEqual(r["descriptions"]["rows"][0]["kind"], "asana_link")
        self.assertEqual(r["comments"]["total"], 1)
        self.assertEqual(r["syncedTasks"], 1)

    def test_the_archive_is_counted_not_dropped(self):
        r = asana_legacy.audit(self.db)
        self.assertEqual(r["archive"]["asana_task_links"], 1)

    def test_it_changes_nothing(self):
        asana_legacy.audit(self.db)
        a = self.db.query(models.TaskAttachment).filter_by(name="dead.pdf").one()
        self.assertEqual(a.url, FILE2)


if __name__ == "__main__":
    unittest.main()
