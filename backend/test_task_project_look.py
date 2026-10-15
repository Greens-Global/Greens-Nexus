"""
A project's look - its color and icon (Neil, Oct 15 2026).

`icon` is a key from the Tasks module's icon set; "" (sent to the browser
as null, like every empty field here - see _nz) is the default folder every
project showed before. Both are cleaned on the way in (a bad value is
stored as "", never as itself), a PATCH that does not mention them leaves
them alone, and a duplicate keeps them.

Uses a throwaway sqlite file. No network.

Run with: python -m unittest test_task_project_look -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402
from routers.task_util import gen_id, now_iso  # noqa: E402
from routers.task_projects import (  # noqa: E402
    update_project, create_project, duplicate_project, ProjectBody, DuplicateProjectBody,
    clean_project_color, clean_project_icon, project_to_dict,
)

OWNER = {"email": "owner@greensglobal.com", "level": 1}
EDITOR = {"email": "editor@greensglobal.com", "level": 1}


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(
            f"{__name__} deletes rows and is pointed at {actual!r}, not its own "
            f"temp database. Run it on its own: python -m unittest {__name__}"
        )


_assert_isolated()


class ProjectLookTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
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
        for m in (models.Task, models.TaskProject):
            self.db.query(m).execution_options(include_deleted=True).delete()
        self.db.commit()
        self.p = models.TaskProject(
            id=gen_id(), name="Smith Street", access_level="restricted", owner_email=OWNER["email"],
            member_emails=[EDITOR["email"]], member_roles={EDITOR["email"]: "editor"},
            created_at=now_iso(), modified_at=now_iso())
        self.db.add(self.p)
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_cleaning(self):
        self.assertEqual(clean_project_color("#DB2777"), "#db2777")
        self.assertEqual(clean_project_color(" #16a34a "), "#16a34a")
        for bad in ("", None, "red", "#fff", "#12345g", "rgb(0,0,0)", "#2563eb; background:url(x)"):
            self.assertEqual(clean_project_color(bad), "", bad)
        self.assertEqual(clean_project_icon("hard-hat"), "hard-hat")
        self.assertEqual(clean_project_icon("Building"), "building")
        for bad in ("", None, "-x", "has space", "a" * 41, "<svg>", "x/y"):
            self.assertEqual(clean_project_icon(bad), "", bad)

    def test_a_project_that_never_chose_reads_as_the_default(self):
        d = project_to_dict(self.p)
        self.assertEqual((d["color"], d["icon"]), (None, None))

    def test_the_owner_sets_both_and_they_come_back(self):
        d = update_project(self.p.id, ProjectBody(color="#DB2777", icon="hard-hat"), user=OWNER, db=self.db)
        self.assertEqual((d["color"], d["icon"]), ("#db2777", "hard-hat"))
        self.db.expire_all()
        row = self.db.query(models.TaskProject).filter_by(id=self.p.id).first()
        self.assertEqual((row.color, row.icon), ("#db2777", "hard-hat"))

    def test_an_edit_that_does_not_mention_the_look_keeps_it(self):
        update_project(self.p.id, ProjectBody(color="#16a34a", icon="truck"), user=OWNER, db=self.db)
        # A form from before icons existed: sends the name only.
        d = update_project(self.p.id, ProjectBody(name="Smith St"), user=OWNER, db=self.db)
        self.assertEqual((d["name"], d["color"], d["icon"]), ("Smith St", "#16a34a", "truck"))

    def test_reset_to_default_and_bad_values_store_empty(self):
        update_project(self.p.id, ProjectBody(color="#16a34a", icon="truck"), user=OWNER, db=self.db)
        d = update_project(self.p.id, ProjectBody(color="", icon=""), user=OWNER, db=self.db)
        self.assertEqual((d["color"], d["icon"]), (None, None))
        d = update_project(self.p.id, ProjectBody(color="javascript:alert(1)", icon="<b>x</b>"), user=OWNER, db=self.db)
        self.assertEqual((d["color"], d["icon"]), (None, None))
        self.db.expire_all()
        row = self.db.query(models.TaskProject).filter_by(id=self.p.id).first()
        self.assertEqual((row.color, row.icon), ("", ""))

    def test_only_the_owner_tier_changes_the_look(self):
        with self.assertRaises(HTTPException) as e:
            update_project(self.p.id, ProjectBody(icon="truck"), user=EDITOR, db=self.db)
        self.assertEqual(e.exception.status_code, 403)

    def test_a_new_project_takes_its_look_from_the_form(self):
        d = create_project(ProjectBody(name="New Build", color="#0D9488", icon="building"), user=OWNER, db=self.db)
        self.assertEqual((d["color"], d["icon"]), ("#0d9488", "building"))
        d = create_project(ProjectBody(name="Plain"), user=OWNER, db=self.db)
        self.assertEqual((d["color"], d["icon"]), (None, None))

    def test_a_duplicate_keeps_the_look_unless_told_otherwise(self):
        update_project(self.p.id, ProjectBody(color="#7c3aed", icon="landmark"), user=OWNER, db=self.db)
        d = duplicate_project(self.p.id, DuplicateProjectBody(include_tasks=False), user=OWNER, db=self.db)
        self.assertEqual((d["color"], d["icon"]), ("#7c3aed", "landmark"))
        d = duplicate_project(self.p.id, DuplicateProjectBody(include_tasks=False, icon="leaf"), user=OWNER, db=self.db)
        self.assertEqual(d["icon"], "leaf")


if __name__ == "__main__":
    unittest.main()
