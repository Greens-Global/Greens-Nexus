"""Who may create, change and delete a task custom field (Oct 13 2026 review).

The three routes took no user: anyone with a tasks or tickets grant could
rename, retype or delete a field under every project using it. Now a field's
definition is a manager's, and what is left to everyone else is exactly what
the list view's "+ Column" menu does - make a field for a project they can
edit, and put an existing field on that project or take it off.

Run with: python -m unittest test_task_custom_field_access -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException

import auth
import database
import models
from routers import task_config as C
from routers.task_config import CustomFieldBody, create_custom_field, update_custom_field
from routers.task_util import now_iso


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(
            f"{__name__} deletes rows and is pointed at {actual!r}, not its own "
            f"temp database. Another test module imported `database` first. "
            f"Run it on its own: python -m unittest {__name__}"
        )


_assert_isolated()

EDITOR = {"email": "dean@greensglobal.com", "level": 1}
VIEWER = {"email": "miranda@greensglobal.com", "level": 1}
OUTSIDER = {"email": "charmi@greensglobal.com", "level": 1}
BOSS = {"email": "neil@greensglobal.com", "level": 3}


class CustomFieldAccessTests(unittest.TestCase):
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
        for m in (models.TaskCustomField, models.TaskTeam, models.TaskProject):
            self.db.query(m).execution_options(include_deleted=True).delete()
        # RESTRICTED projects: on an org-visible one everybody is an editor,
        # which would hide whether the role was checked at all.
        for pid in ("p-mine", "p-other"):
            self.db.add(models.TaskProject(
                id=pid, name=pid, access_level="restricted", owner_email=BOSS["email"],
                member_emails=[], created_at=now_iso(), modified_at=now_iso(),
                member_roles={EDITOR["email"]: "editor", VIEWER["email"]: "viewer"} if pid == "p-mine" else {}))
        self.db.add(models.TaskProject(id="p-org", name="p-org", access_level="org", owner_email=BOSS["email"],
                                       member_emails=[], member_roles={},
                                       created_at=now_iso(), modified_at=now_iso()))
        self.db.add(models.TaskCustomField(id="f-scoped", name="Vendor", type="text", project_ids=["p-other"],
                                           applies_to='["task"]'))
        self.db.add(models.TaskCustomField(id="f-global", name="Location", type="text", project_ids=[],
                                           applies_to='["task"]'))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _create(self, user, **body):
        return create_custom_field(CustomFieldBody(**body), user=user, db=self.db)

    def _update(self, user, field_id, **body):
        return update_custom_field(field_id, CustomFieldBody(**body), user=user, db=self.db)

    def _refused(self, fn, *a, **kw):
        with self.assertRaises(HTTPException) as e:
            fn(*a, **kw)
        self.db.rollback()
        return e.exception.status_code

    def _projects(self, field_id):
        self.db.expire_all()
        return self.db.query(models.TaskCustomField).filter(models.TaskCustomField.id == field_id).first().project_ids

    # -- create ------------------------------------------------------------
    def test_an_editor_makes_a_field_for_their_project(self):
        # What + Column sends from a project's list.
        out = self._create(EDITOR, name="Budget", description="", type="select", options=["Low", "High"],
                           project_ids=["p-mine"])
        self.assertEqual(out["projectIds"], ["p-mine"])
        self.assertEqual([o["label"] for o in out["options"]], ["Low", "High"])

    def test_an_org_visible_project_counts_everyone_as_editor(self):
        self.assertEqual(self._create(OUTSIDER, name="Budget", project_ids=["p-org"])["projectIds"], ["p-org"])

    def test_a_field_on_every_project_is_a_managers_to_create(self):
        self.assertEqual(self._refused(self._create, EDITOR, name="Budget"), 403)
        self.assertEqual(self._refused(self._create, EDITOR, name="Budget", project_ids=[""]), 403)
        self.assertEqual(self._create(BOSS, name="Budget")["projectIds"], [])

    def test_not_for_a_project_they_cannot_edit(self):
        self.assertEqual(self._refused(self._create, VIEWER, name="Budget", project_ids=["p-mine"]), 403)
        self.assertEqual(self._refused(self._create, OUTSIDER, name="Budget", project_ids=["p-mine"]), 403)
        # One project they edit does not carry one they do not.
        self.assertEqual(self._refused(self._create, EDITOR, name="Budget", project_ids=["p-mine", "p-other"]), 403)

    def test_a_project_id_that_is_no_project_is_refused(self):
        # require_project_role reads "no project" as unrestricted.
        self.assertEqual(self._refused(self._create, EDITOR, name="Budget", project_ids=["p-nope"]), 403)

    def test_the_wider_settings_are_a_managers_on_create(self):
        for extra in ({"required": True}, {"read_only": True}, {"required_project_ids": ["p-mine"]},
                      {"applies_to": ["project"]}, {"applies_to": ["task", "project"]}):
            self.assertEqual(self._refused(self._create, EDITOR, name="Budget", project_ids=["p-mine"], **extra),
                             403, extra)
        out = self._create(BOSS, name="Budget", project_ids=["p-mine"], required_project_ids=["p-mine"],
                           applies_to=["task", "project"])
        self.assertEqual(out["requiredProjectIds"], ["p-mine"])

    def test_a_name_is_still_required_on_create(self):
        self.assertEqual(self._refused(self._create, BOSS, project_ids=["p-mine"]), 422)

    # -- update ------------------------------------------------------------
    def test_an_editor_puts_an_existing_field_on_their_project(self):
        # Exactly the body + Column > Existing Fields sends: the project list
        # and nothing else (no name).
        out = self._update(EDITOR, "f-scoped", project_ids=["p-other", "p-mine"])
        self.assertEqual(out["projectIds"], ["p-other", "p-mine"])
        self.assertEqual(out["name"], "Vendor")

    def test_and_takes_it_off_again(self):
        self._update(EDITOR, "f-scoped", project_ids=["p-other", "p-mine"])
        self.assertEqual(self._update(EDITOR, "f-scoped", project_ids=["p-other"])["projectIds"], ["p-other"])

    def test_only_on_or_off_a_project_they_can_edit(self):
        self.assertEqual(self._refused(self._update, VIEWER, "f-scoped", project_ids=["p-other", "p-mine"]), 403)
        # Taking it off somebody else's project, alone or under cover of an add.
        self.assertEqual(self._refused(self._update, EDITOR, "f-scoped", project_ids=["p-mine"]), 403)
        self.assertEqual(self._refused(self._update, EDITOR, "f-scoped", project_ids=["p-other", "p-nope"]), 403)
        self.assertEqual(self._projects("f-scoped"), ["p-other"])

    def test_every_project_is_out_of_reach_in_both_directions(self):
        # Scoping a company-wide field takes it off every other project.
        self.assertEqual(self._refused(self._update, EDITOR, "f-global", project_ids=["p-mine"]), 403)
        # Emptying a scoped one puts it on every project.
        self.db.query(models.TaskCustomField).filter(models.TaskCustomField.id == "f-scoped").update(
            {"project_ids": ["p-mine"]})
        self.db.commit()
        self.assertEqual(self._refused(self._update, EDITOR, "f-scoped", project_ids=[]), 403)
        self.assertEqual(self._projects("f-scoped"), ["p-mine"])
        self.assertEqual(self._projects("f-global"), [])

    def test_the_definition_is_a_managers(self):
        for patch in ({"name": "Supplier"}, {"type": "number"}, {"options": ["A"]}, {"required": True},
                      {"read_only": True}, {"required_project_ids": ["p-mine"]}, {"applies_to": ["project"]},
                      {"description": "x"},
                      # ... and not alongside a project change that would pass alone.
                      {"name": "Supplier", "project_ids": ["p-other", "p-mine"]}):
            self.assertEqual(self._refused(self._update, EDITOR, "f-scoped", **patch), 403, patch)
        f = self.db.query(models.TaskCustomField).filter(models.TaskCustomField.id == "f-scoped").first()
        self.assertEqual((f.name, f.type, f.project_ids), ("Vendor", "text", ["p-other"]))

    def test_a_manager_changes_anything(self):
        out = self._update(BOSS, "f-scoped", name="Supplier", type="select", options=["A"], project_ids=[],
                           required=True)
        self.assertEqual((out["name"], out["type"], out["projectIds"], out["required"]),
                         ("Supplier", "select", [], True))
        self.assertEqual(self._refused(self._update, BOSS, "f-scoped", name=" "), 422)

    def test_a_missing_field_is_404(self):
        self.assertEqual(self._refused(self._update, BOSS, "f-nope", project_ids=["p-mine"]), 404)

    # -- delete ------------------------------------------------------------
    def test_delete_is_manager_only(self):
        route = next(r for r in C.router.routes
                     if getattr(r, "path", "") == "/task-custom-fields/{field_id}" and "DELETE" in r.methods)
        self.assertIn(auth.require_manager, [d.call for d in route.dependant.dependencies])
        with self.assertRaises(HTTPException):
            auth.require_manager(user=EDITOR)
        self.assertEqual(auth.require_manager(user=BOSS), BOSS)


if __name__ == "__main__":
    unittest.main()
