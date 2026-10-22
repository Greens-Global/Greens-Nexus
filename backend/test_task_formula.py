"""Formula columns and column totals (Neil, Oct 22 2026).

Two halves:
  * task_formula - the safe tokenizer/parser that checks an expression before
    it is saved (valid/invalid, unknown fields and functions, circular
    references, injection-shaped input, length and nesting limits). The
    parse-level cases are shared with the browser through
    frontend/src/tasks/formula.cases.json so the two grammars cannot drift.
  * the custom-field routes - a formula field validates on create and edit,
    is read-only and never stored per task, never required, follows a rename
    of a field it names, keeps the custom-field permission rules (viewer
    refused, editor limited to their project, another company walled off),
    and the per-user totals preference is stored in shape.

Run with: python -m pytest test_task_formula.py -q
"""
import json
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException

import cache
import database
import models
import task_formula as F
from routers import task_config as C
from routers import task_prefs as PR
from routers.task_config import CustomFieldBody, create_custom_field, update_custom_field
from routers.task_util import gen_id, now_iso


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}, not its own temp "
                           f"database. Run it on its own: python -m pytest {__name__}.py")


_assert_isolated()

CASES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend", "src", "tasks",
                     "formula.cases.json")

EDITOR = {"email": "dean@greensglobal.com", "level": 1}
VIEWER = {"email": "miranda@greensglobal.com", "level": 1}
BOSS = {"email": "neil@greensglobal.com", "level": 3}
COA, COB = "co-a", "co-b"
AMGR = {"email": "amgr@greensglobal.com", "level": 3}   # company A manager, not a Global Admin


# ── The parser ───────────────────────────────────────────────────────────────
class ParserTests(unittest.TestCase):
    def test_shared_cases(self):
        with open(CASES, encoding="utf-8") as fh:
            cases = json.load(fh)
        for src in cases["valid"]:
            with self.subTest(src=src):
                F.parse(src)
        for src, fragment in cases["invalid"]:
            with self.subTest(src=src):
                with self.assertRaises(F.FormulaError) as e:
                    F.parse(src)
                self.assertIn(fragment, str(e.exception))

    def test_precedence_shape(self):
        self.assertEqual(F.parse("1 + 2 * 3"), ("bin", "+", ("num", 1.0), ("bin", "*", ("num", 2.0), ("num", 3.0))))
        self.assertEqual(F.parse("1 & 2 = 3")[1], "=")          # comparison binds loosest
        self.assertEqual(F.parse("-2 * 3")[0], "bin")            # unary binds tightest
        self.assertEqual(F.parse("1 <> 2")[1], "!=")

    def test_field_refs_and_names(self):
        self.assertEqual(F.field_refs('{Budget} - { budget } + {Spent} & "{Not A Field}"'), ["Budget", "Spent"])
        self.assertTrue(F.is_builtin("due date"))
        self.assertTrue(F.is_builtin("  Estimate   Hours "))
        self.assertFalse(F.is_builtin("Budget"))

    def test_rename_only_touches_field_tokens(self):
        src = 'IF({Budget} > 0, "{Budget}", { budget })'
        self.assertEqual(F.rename_refs(src, "Budget", "Cost"), 'IF({Cost} > 0, "{Budget}", {Cost})')
        self.assertEqual(F.rename_refs("{Budget", "Budget", "Cost"), "{Budget")   # unparseable: untouched

    def test_validate_unknown_field_and_self_reference(self):
        F.validate("{Budget} * 2", self_name="Double", field_names=["Budget"], formula_fields={})
        F.validate("{Due Date} - TODAY()", self_name="Left", field_names=[], formula_fields={})
        with self.assertRaisesRegex(F.FormulaError, r"Unknown field \{Nope\}"):
            F.validate("{Nope} + 1", self_name="X", field_names=["Budget"], formula_fields={})
        with self.assertRaisesRegex(F.FormulaError, "refer to itself"):
            F.validate("{X} + 1", self_name="X", field_names=["X", "Budget"], formula_fields={})

    def test_circular_references(self):
        others = {"A": "{B} + 1", "B": "{C} * 2"}
        with self.assertRaisesRegex(F.FormulaError, "Circular reference"):
            F.validate("{A} - 1", self_name="C", field_names=["A", "B"], formula_fields=others)
        # A chain that does not come back is fine.
        F.validate("{A} - 1", self_name="D", field_names=["A", "B", "C"], formula_fields=others)

    def test_injection_shaped_input_is_just_an_unknown_name(self):
        for src in ("{__proto__}", "{constructor}", "{prototype}", "{toString}"):
            with self.subTest(src=src):
                with self.assertRaisesRegex(F.FormulaError, "Unknown field"):
                    F.validate(src, self_name="X", field_names=["Budget"], formula_fields={})
        for src in ("__import__('os')", "constructor.constructor('x')()", "globals()", "a[0]"):
            with self.subTest(src=src):
                with self.assertRaises(F.FormulaError):
                    F.parse(src)

    def test_limits(self):
        with self.assertRaisesRegex(F.FormulaError, "at most 2000"):
            F.parse("1+" * 1001 + "1")
        with self.assertRaisesRegex(F.FormulaError, "too long"):
            F.parse("+".join(["1"] * 400))   # under the length cap, over the token cap
        with self.assertRaisesRegex(F.FormulaError, "field name can be at most"):
            F.parse("{" + "x" * 200 + "}")
        with self.assertRaisesRegex(F.FormulaError, "text value can be at most"):
            F.parse('"' + "x" * 600 + '"')
        with self.assertRaisesRegex(F.FormulaError, "nested too deeply"):
            F.parse("-" * 60 + "1")
        with self.assertRaises(F.FormulaError):
            F.parse(5)   # not text

    def test_normalize_format(self):
        self.assertEqual(F.normalize_format(None), {"format": "number", "decimals": 2})
        self.assertEqual(F.normalize_format({"format": "date"}), {"format": "date", "decimals": 0})
        # Other scripts' digits are not numbers (the browser agrees).
        with self.assertRaises(F.FormulaError):
            F.parse("٣ + 1")
        self.assertEqual(F.normalize_format({"format": "currency"}), {"format": "currency", "decimals": 2})
        self.assertEqual(F.normalize_format({"format": "evil", "decimals": 99}), {"format": "number", "decimals": 6})
        self.assertEqual(F.normalize_format({"format": "percent", "decimals": "-3"}), {"format": "percent", "decimals": 0})


# ── The routes ───────────────────────────────────────────────────────────────
class RouteBase(unittest.TestCase):
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
        for m in (models.TaskCustomField, models.TaskProject, models.Task, models.NexusSetting,
                  models.NexusEmployee, models.TaskTablePref):
            self.db.query(m).execution_options(include_deleted=True).delete()
        for pid in ("p-mine", "p-other"):
            self.db.add(models.TaskProject(
                id=pid, name=pid, access_level="restricted", owner_email=BOSS["email"],
                member_emails=[], created_at=now_iso(), modified_at=now_iso(),
                member_roles={EDITOR["email"]: "editor", VIEWER["email"]: "viewer"} if pid == "p-mine" else {}))
        self.db.add(models.TaskCustomField(id="f-budget", name="Budget", type="number", project_ids=[],
                                           applies_to='["task"]'))
        self.db.add(models.TaskCustomField(id="f-spent", name="Spent", type="number", project_ids=[],
                                           applies_to='["task"]'))
        self.db.commit()
        cache.settings_config.invalidate()

    def tearDown(self):
        self.db.close()
        cache.settings_config.invalidate()

    def create(self, user, **body):
        return create_custom_field(CustomFieldBody(**body), user=user, db=self.db)

    def update(self, user, field_id, **body):
        return update_custom_field(field_id, CustomFieldBody(**body), user=user, db=self.db)

    def refused(self, fn, *a, **kw):
        with self.assertRaises(HTTPException) as e:
            fn(*a, **kw)
        self.db.rollback()
        return e.exception.status_code, str(e.exception.detail)

    def row(self, fid):
        self.db.expire_all()
        return self.db.query(models.TaskCustomField).filter(models.TaskCustomField.id == fid).first()


class FormulaFieldRouteTests(RouteBase):
    def test_create_valid_formula(self):
        out = self.create(BOSS, name="Remaining", type="formula", formula="  {Budget} - {Spent}  ",
                          formula_format={"format": "currency"})
        self.assertEqual(out["type"], "formula")
        self.assertEqual(out["formula"], "{Budget} - {Spent}")
        self.assertEqual(out["formulaFormat"], {"format": "currency", "decimals": 2})
        self.assertTrue(out["readOnly"])            # every editor skips it
        self.assertFalse(out["required"])
        self.assertEqual(out["appliesTo"], ["task"])
        self.assertEqual(out["options"], [])

    def test_create_refuses_bad_formulas_with_the_reason(self):
        code, msg = self.refused(self.create, BOSS, name="X", type="formula", formula="{Nope} + 1")
        self.assertEqual(code, 422)
        self.assertIn("Unknown field {Nope}", msg)
        code, msg = self.refused(self.create, BOSS, name="X", type="formula", formula="1 +")
        self.assertEqual(code, 422)
        code, msg = self.refused(self.create, BOSS, name="X", type="formula", formula="")
        self.assertIn("Enter a formula", msg)
        code, msg = self.refused(self.create, BOSS, name="X", type="formula", formula="{X} * 2")
        self.assertIn("itself", msg)
        code, msg = self.refused(self.create, BOSS, name="X", type="formula", formula="x" * 2500)
        self.assertEqual(code, 422)
        self.assertEqual(self.db.query(models.TaskCustomField).filter(models.TaskCustomField.name == "X").count(), 0)

    def test_formula_cannot_be_made_required_or_project_side(self):
        out = self.create(BOSS, name="Left", type="formula", formula="{Budget}", required=True,
                          required_project_ids=["p-mine"], applies_to=["project"], options=["a"])
        self.assertFalse(out["required"])
        self.assertEqual(out["requiredProjectIds"], [])
        self.assertEqual(out["appliesTo"], ["task"])
        f = self.row(out["id"])
        self.assertFalse(C.field_required_in(f, "p-mine"))

    def test_circular_reference_between_formula_fields(self):
        a = self.create(BOSS, name="A", type="formula", formula="{Budget} + 1")
        self.create(BOSS, name="B", type="formula", formula="{A} * 2")
        code, msg = self.refused(self.update, BOSS, a["id"], formula="{B} - 1")
        self.assertEqual(code, 422)
        self.assertIn("Circular reference", msg)
        self.assertEqual(self.row(a["id"]).formula, "{Budget} + 1")   # unchanged

    def test_values_are_never_stored_on_a_task(self):
        out = self.create(BOSS, name="Left", type="formula", formula="{Budget} - {Spent}")
        stored = C.coerce_custom_field_values(self.db, {out["id"]: 42, "f-budget": "10"})
        self.assertEqual(stored, {"f-budget": 10})

    def test_rename_follows_into_formulas(self):
        out = self.create(BOSS, name="Left", type="formula", formula='{Budget} - {spent} & "{Spent}"')
        self.update(BOSS, "f-spent", name="Actual Cost")
        self.assertEqual(self.row(out["id"]).formula, '{Budget} - {Actual Cost} & "{Spent}"')
        # Renaming a formula field itself keeps formulas that name it working.
        other = self.create(BOSS, name="Twice", type="formula", formula="{Left} * 2")
        self.update(BOSS, out["id"], name="Remaining")
        self.assertEqual(self.row(other["id"]).formula, "{Remaining} * 2")

    def test_edit_formula_and_format(self):
        out = self.create(BOSS, name="Left", type="formula", formula="{Budget}")
        got = self.update(BOSS, out["id"], formula="ROUND({Budget} / 3, 1)",
                          formula_format={"format": "percent", "decimals": 1})
        self.assertEqual(got["formula"], "ROUND({Budget} / 3, 1)")
        self.assertEqual(got["formulaFormat"], {"format": "percent", "decimals": 1})
        # The Manage form sends the whole field back; unchanged keys are no edit.
        again = self.update(BOSS, out["id"], name="Left", type="formula", formula="ROUND({Budget} / 3, 1)",
                            formula_format={"format": "percent", "decimals": 1})
        self.assertEqual(again["formula"], got["formula"])

    def test_converting_to_formula_validates(self):
        code, _ = self.refused(self.update, BOSS, "f-spent", type="formula")
        self.assertEqual(code, 422)
        got = self.update(BOSS, "f-spent", type="formula", formula="{Budget} / 2")
        self.assertEqual(got["type"], "formula")
        # And back: the expression is not offered on a plain field.
        back = self.update(BOSS, "f-spent", type="number")
        self.assertNotIn("formula", back)
        self.assertFalse(back["readOnly"])

    def test_editor_viewer_and_manager_rules(self):
        # An editor may add a formula column to their own project...
        out = self.create(EDITOR, name="Left", type="formula", formula="{Budget} - {Spent}", project_ids=["p-mine"])
        self.assertEqual(out["projectIds"], ["p-mine"])
        # ...but a viewer may not, nor may anyone below manager put one on every project.
        self.assertEqual(self.refused(self.create, VIEWER, name="L2", type="formula", formula="1",
                                      project_ids=["p-mine"])[0], 403)
        self.assertEqual(self.refused(self.create, EDITOR, name="L3", type="formula", formula="1")[0], 403)
        self.assertEqual(self.refused(self.create, EDITOR, name="L4", type="formula", formula="1",
                                      project_ids=["p-other"])[0], 403)
        # The expression is the field's definition - a manager's to change.
        self.assertEqual(self.refused(self.update, EDITOR, out["id"], formula="{Budget}")[0], 403)
        self.assertEqual(self.row(out["id"]).formula, "{Budget} - {Spent}")


class FormulaTemplateTests(RouteBase):
    def test_a_project_template_carries_the_formula(self):
        from routers import task_projects as P
        self.db.add(models.TaskCustomField(id="f-left", name="Left", type="formula", project_ids=["p-mine"],
                                           formula="{Budget} - {Spent}",
                                           formula_format={"format": "currency", "decimals": 2},
                                           applies_to='["task"]'))
        self.db.commit()
        p = self.db.query(models.TaskProject).filter(models.TaskProject.id == "p-mine").first()
        payload = P._snapshot_project(self.db, p, blueprint=True)
        spec = next(s for s in payload["customFields"] if s["name"] == "Left")
        self.assertEqual(spec["formula"], "{Budget} - {Spent}")
        # Rebuilt where no "Left" formula exists yet: minted with its expression.
        self.db.query(models.TaskCustomField).filter(models.TaskCustomField.id == "f-left").delete()
        self.db.commit()
        keys = P._resolve_custom_fields(self.db, payload, "p-other")
        self.db.commit()
        made = self.row(keys[str(spec["key"])])
        self.assertEqual((made.type, made.formula), ("formula", "{Budget} - {Spent}"))
        self.assertEqual(made.formula_format, {"format": "currency", "decimals": 2})


class FormulaWallTests(RouteBase):
    def setUp(self):
        super().setUp()
        for email, co in ((AMGR["email"], COA), ("bmgr@greensglobal.com", COB)):
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=email, first_name=email.split("@")[0],
                                             status="active", company=co))
        self.db.add(models.TaskCustomField(id="f-b-secret", name="Margin", type="number", company_id=COB,
                                           applies_to='["task"]'))
        self.db.add(models.TaskCustomField(id="f-b-formula", name="B Formula", type="formula", company_id=COB,
                                           formula="{Margin} * 2", applies_to='["task"]'))
        self.db.add(models.TaskProject(id="p-a", name="A", access_level="org", company_id=COA,
                                       created_at=now_iso(), modified_at=now_iso()))
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()

    def test_another_companys_field_is_unknown_behind_the_wall(self):
        code, msg = self.refused(self.create, AMGR, name="Mine", type="formula", formula="{Margin} + 1",
                                 project_ids=["p-a"])
        self.assertEqual(code, 422)
        self.assertIn("Unknown field {Margin}", msg)
        # Shared fields still resolve.
        out = self.create(AMGR, name="Mine", type="formula", formula="{Budget} + 1", project_ids=["p-a"])
        self.assertEqual(self.row(out["id"]).company_id, COA)

    def test_another_companys_formula_is_404_to_edit(self):
        self.assertEqual(self.refused(self.update, AMGR, "f-b-formula", formula="1")[0], 404)
        self.assertEqual(self.row("f-b-formula").formula, "{Margin} * 2")

    def test_a_rename_does_not_reach_into_another_companys_formulas(self):
        # Company A renames its own "Margin"-named field; B's formula keeps its text.
        self.db.add(models.TaskCustomField(id="f-a-margin", name="Margin", type="number", company_id=COA,
                                           applies_to='["task"]'))
        self.db.add(models.TaskCustomField(id="f-shared-formula", name="Shared F", type="formula", company_id="",
                                           formula="{Margin} + 1", applies_to='["task"]'))
        self.db.add(models.TaskCustomField(id="f-a-formula", name="A F", type="formula", company_id=COA,
                                           formula="{Margin} + 2", applies_to='["task"]'))
        self.db.commit()
        self.update(AMGR, "f-a-margin", name="Markup")
        self.assertEqual(self.row("f-b-formula").formula, "{Margin} * 2")
        # A shared formula reaches every company - company A cannot rewrite it.
        self.assertEqual(self.row("f-shared-formula").formula, "{Margin} + 1")
        self.assertEqual(self.row("f-a-formula").formula, "{Markup} + 2")


class TotalsPrefTests(RouteBase):
    def put(self, user, totals):
        return PR.set_table_prefs("richlist", PR.TablePrefIn(totals=totals), user=user, db=self.db)

    def test_totals_are_stored_per_scope_and_cleaned(self):
        out = self.put(EDITOR, {
            "p-mine": {"show": True, "cols": {"estimate": "sum", "f-budget": "AVG", "status": "filled",
                                              "bad": "drop table", "": "sum", "x" * 80: "sum"}},
            "_": {"show": False, "cols": {}},            # nothing chosen: not kept
            "p-other": "not a dict",
        })
        self.assertEqual(out["prefs"]["richlist"]["totals"], {
            "p-mine": {"show": True, "cols": {"estimate": "sum", "f-budget": "avg", "status": "filled"}}})

    def test_totals_are_per_person(self):
        self.put(EDITOR, {"p-mine": {"show": True, "cols": {"estimate": "max"}}})
        self.assertEqual(PR.get_prefs(user=VIEWER, db=self.db), {"prefs": {}})
        mine = PR.get_prefs(user=EDITOR, db=self.db)["prefs"]["richlist"]["totals"]
        self.assertEqual(mine["p-mine"]["cols"], {"estimate": "max"})

    def test_a_totals_save_keeps_the_column_arrangement(self):
        PR.set_table_prefs("richlist", PR.TablePrefIn(order=["task", "due"]), user=EDITOR, db=self.db)
        self.put(EDITOR, {"p-mine": {"show": True, "cols": {}}})
        prefs = PR.get_prefs(user=EDITOR, db=self.db)["prefs"]["richlist"]
        self.assertEqual(prefs["order"], ["task", "due"])
        self.assertTrue(prefs["totals"]["p-mine"]["show"])


if __name__ == "__main__":
    unittest.main()
