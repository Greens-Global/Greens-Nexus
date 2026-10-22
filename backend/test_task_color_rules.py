"""Tasks conditional row colors (Neil, Oct 22 2026).

PUT /task-projects/{id}/color-rules stores a project's ordered color rules.
The browser evaluates them; the server owns their shape and who may write:

- only known fields, operators that fit the field, values of the right kind,
  a palette color, at most 20 rules of at most 5 conditions;
- custom field references: the field exists, applies to the project and is
  on the caller's side of the company wall, the option exists - checked for
  NEW conditions only, so a rule left pointing at a deleted field stays and
  does not block the rest of the list;
- people only from the Nexus directory (a leaver is fine, another company
  behind a wall is not);
- editors (and managers) write, a viewer / commenter / outsider is refused,
  the company wall holds even for a manager;
- a save over a list someone else changed since it was read is a 409 that
  carries the latest project.

Throwaway SQLite, no network.  python -m pytest test_task_color_rules.py
"""
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
import task_color_rules as R
from routers import task_projects as P
from routers.task_util import gen_id, now_iso


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}, not its own temp "
                           f"database. Run it on its own: python -m pytest {__name__}.py")


_assert_isolated()

COA, COB = "co-a", "co-b"
OWNER = {"email": "owner@greensglobal.com", "level": 1}
EDITOR = {"email": "editor@greensglobal.com", "level": 1}
VIEWER = {"email": "viewer@greensglobal.com", "level": 1}
COMMENTER = {"email": "commenter@greensglobal.com", "level": 1}
OUTSIDER = {"email": "outsider@greensglobal.com", "level": 1}
MANAGER = {"email": "manager@greensglobal.com", "level": 3}
BMGR = {"email": "bmgr@greensglobal.com", "level": 3}
DIRECTORY = [OWNER, EDITOR, VIEWER, COMMENTER, OUTSIDER, MANAGER]

_CLEAR = (models.Task, models.TaskProject, models.TaskCustomField, models.NexusEmployee,
          models.NexusSetting, models.NexusAccessScope)


def rule(**kw):
    out = {"id": kw.pop("id", "r1"), "name": kw.pop("name", "Overdue"), "color": kw.pop("color", "red"),
           "match": kw.pop("match", "all"),
           "conditions": kw.pop("conditions", [{"field": "due", "op": "overdue"}])}
    out.update(kw)
    return out


class Base(unittest.TestCase):
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
        for m in _CLEAR:
            self.db.query(m).execution_options(include_deleted=True).delete()
        for u in DIRECTORY:
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=u["email"], first_name=u["email"].split("@")[0],
                                             status="active", company=COA))
        self.db.add(models.NexusEmployee(id=gen_id(), work_email="leaver@greensglobal.com", first_name="Leaver",
                                         status="offboarded", company=COA))
        self.db.add(models.NexusEmployee(id=gen_id(), work_email="b@greensglobal.com", first_name="B",
                                         status="active", company=COB))
        self.db.add(models.NexusEmployee(id=gen_id(), work_email=BMGR["email"], first_name="Bm",
                                         status="active", company=COB))
        self.db.commit()
        cache.settings_config.invalidate()

    def tearDown(self):
        self.db.close()
        cache.settings_config.invalidate()

    def arm(self, on=True):
        self.db.query(models.NexusSetting).filter(models.NexusSetting.key == "company_walls").delete()
        if on:
            self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()

    def project(self, **kw):
        kw.setdefault("access_level", "restricted")
        kw.setdefault("owner_email", OWNER["email"])
        kw.setdefault("company_id", COA)
        kw.setdefault("member_roles", {EDITOR["email"]: "editor", VIEWER["email"]: "viewer",
                                       COMMENTER["email"]: "commenter"})
        kw.setdefault("member_emails", [EDITOR["email"], VIEWER["email"], COMMENTER["email"]])
        p = models.TaskProject(id=gen_id(), name=kw.pop("name", "Ops"), created_at=now_iso(), **kw)
        self.db.add(p)
        self.db.commit()
        return p

    def field(self, type_="select", **kw):
        f = models.TaskCustomField(id=kw.pop("id", gen_id()), name=kw.pop("name", "Stage"), type=type_,
                                   options=kw.pop("options", [{"id": "opt-a", "label": "A"}, {"id": "opt-b", "label": "B"}]),
                                   project_ids=kw.pop("project_ids", []), **kw)
        self.db.add(f)
        self.db.commit()
        return f

    def put(self, p, user, rules, rev=None):
        return P.put_color_rules(p.id, P.ColorRulesBody(rules=rules, rev=rev), user=user, db=self.db)

    def code(self, call):
        with self.assertRaises(HTTPException) as e:
            call()
        self.db.rollback()
        return e.exception.status_code, e.exception.detail


class SaveTests(Base):
    def test_an_editor_saves_and_everyone_who_can_see_reads_them(self):
        p = self.project()
        out = self.put(p, EDITOR, [rule(bold=True), rule(id="r2", name="Due This Week", color="amber",
                                                         conditions=[{"field": "due", "op": "within", "value": "7"}])])
        self.assertEqual([r["id"] for r in out["colorRules"]], ["r1", "r2"])
        self.assertEqual(out["colorRules"][0], {"id": "r1", "name": "Overdue", "color": "red", "bold": True,
                                                "enabled": True, "match": "all",
                                                "conditions": [{"field": "due", "op": "overdue"}]})
        # Values are stored in their own shape: days as a whole number.
        self.assertEqual(out["colorRules"][1]["conditions"][0]["value"], 7)
        self.assertEqual(out["colorRulesRev"], R.rules_rev(out["colorRules"]))
        self.db.expire_all()
        self.assertEqual(P.project_to_dict(self.db.get(models.TaskProject, p.id))["colorRules"], out["colorRules"])

    def test_owner_and_manager_may_write(self):
        p = self.project()
        self.put(p, OWNER, [rule()])
        out = self.put(p, MANAGER, [rule(enabled=False)])
        self.assertFalse(out["colorRules"][0]["enabled"])

    def test_viewer_commenter_and_outsider_are_refused(self):
        p = self.project()
        self.put(p, OWNER, [rule()])
        for who in (VIEWER, COMMENTER, OUTSIDER):
            status, _ = self.code(lambda: self.put(p, who, []))
            self.assertEqual(status, 403, who["email"])
        self.db.expire_all()
        self.assertEqual(len(self.db.get(models.TaskProject, p.id).color_rules), 1)

    def test_missing_project_is_404(self):
        status, _ = self.code(lambda: P.put_color_rules("nope", P.ColorRulesBody(rules=[]), user=OWNER, db=self.db))
        self.assertEqual(status, 404)

    def test_a_stale_rev_is_a_conflict_that_carries_the_latest(self):
        p = self.project()
        first = self.put(p, EDITOR, [rule()], rev=P.project_to_dict(p)["colorRulesRev"])
        stale = R.rules_rev([])
        status, detail = self.code(lambda: self.put(p, OWNER, [], rev=stale))
        self.assertEqual(status, 409)
        self.assertEqual(detail["project"]["colorRules"], first["colorRules"])
        self.assertIn("Someone else changed", detail["message"])
        # The current rev goes through.
        out = self.put(p, OWNER, [], rev=first["colorRulesRev"])
        self.assertEqual(out["colorRules"], [])

    def test_patch_cannot_write_rules_around_the_endpoint(self):
        p = self.project()
        P.update_project(p.id, P.ProjectBody(**{"color_rules": [{"junk": True}]}), user=OWNER, db=self.db)
        self.db.expire_all()
        self.assertEqual(self.db.get(models.TaskProject, p.id).color_rules or [], [])


class ShapeTests(Base):
    def bad(self, rules):
        p = self.project()
        status, detail = self.code(lambda: self.put(p, OWNER, rules))
        self.assertEqual(status, 422, rules)
        return detail

    def test_unknown_field_and_wrong_operator(self):
        self.bad([rule(conditions=[{"field": "salary", "op": "is", "value": "x"}])])
        self.bad([rule(conditions=[{"field": "status", "op": "overdue"}])])
        self.bad([rule(conditions=[{"field": "due", "op": "contains", "value": "x"}])])
        self.bad([rule(conditions=[{"field": "completed", "op": "is", "value": "yes"}])])

    def test_bad_values(self):
        self.bad([rule(conditions=[{"field": "status", "op": "is"}])])
        self.bad([rule(conditions=[{"field": "status", "op": "is_any_of", "value": []}])])
        self.bad([rule(conditions=[{"field": "priority", "op": "is", "value": "critical"}])])
        self.bad([rule(conditions=[{"field": "due", "op": "within", "value": -1}])])
        self.bad([rule(conditions=[{"field": "due", "op": "within", "value": 1.5}])])
        self.bad([rule(conditions=[{"field": "due", "op": "within", "value": 9999}])])
        self.bad([rule(conditions=[{"field": "due", "op": "before", "value": "10/22/2026"}])])
        self.bad([rule(conditions=[{"field": "tags", "op": "contains", "value": "x" * 500}])])
        self.bad([rule(conditions=[{"field": "assignee", "op": "person_is", "value": "not-an-email"}])])

    def test_color_must_be_from_the_palette(self):
        self.bad([rule(color="#ff0000")])
        self.bad([rule(color="chartreuse")])
        # Not blue: a faint blue row is what a selected row looks like.
        self.bad([rule(color="blue")])

    def test_name_id_match_and_limits(self):
        self.bad([rule(name="  ")])
        self.bad([rule(name="x" * 61)])
        self.bad([rule(id="")])
        self.bad([rule(match="most")])
        self.bad([rule(conditions=[])])
        self.bad([rule(conditions=[{"field": "due", "op": "overdue"}] * 6)])
        self.bad([rule(id=f"r{i}") for i in range(21)])
        self.bad([rule(), rule()])   # repeated id
        self.bad(["not a rule"])

    def test_the_whole_list_has_a_size_cap(self):
        big = [rule(id=f"r{i}", name="n" * 60, conditions=[
            {"field": "status", "op": "is_any_of", "value": [f"{j:03d}" + "s" * 100 for j in range(50)]}])
            for i in range(10)]
        detail = self.bad(big)
        self.assertIn("too large", detail)

    def test_twenty_rules_of_five_conditions_is_fine(self):
        p = self.project()
        out = self.put(p, OWNER, [rule(id=f"r{i}", conditions=[{"field": "due", "op": "overdue"}] * 5)
                                  for i in range(20)])
        self.assertEqual(len(out["colorRules"]), 20)

    def test_every_builtin_operator_is_accepted(self):
        p = self.project()
        samples = {"none": None, "text": "in_progress", "person": OWNER["email"], "list": ["a", "b"],
                   "days": 3, "date": "2026-10-22", "number": 5, "range": [1, 9]}
        conds = []
        for field, ops in R.BUILTIN_OPS.items():
            for op in ops:
                value = samples[R.OP_KIND[op]]
                if field == "priority":
                    value = ["urgent", "high"] if op == "is_any_of" else "urgent"
                c = {"field": field, "op": op}
                if value is not None:
                    c["value"] = value
                conds.append(c)
        rules = [rule(id=f"r{i}", conditions=conds[i:i + 5]) for i in range(0, len(conds), 5)]
        self.assertLessEqual(len(rules), 20)
        out = self.put(p, OWNER, rules)
        self.assertEqual(sum(len(r["conditions"]) for r in out["colorRules"]), len(conds))

    def test_range_is_ordered(self):
        f = self.field("number", options=[])
        p = self.project()
        out = self.put(p, OWNER, [rule(conditions=[{"field": f"cf:{f.id}", "op": "between", "value": [9, 2]}])])
        self.assertEqual(out["colorRules"][0]["conditions"][0]["value"], [2, 9])


class ReferenceTests(Base):
    def test_custom_field_ops_follow_the_field_type(self):
        p = self.project()
        sel = self.field("select")
        num = self.field("number", options=[])
        ok = self.put(p, OWNER, [rule(conditions=[
            {"field": f"cf:{sel.id}", "op": "is_any_of", "value": ["opt-a", "opt-b"]},
            {"field": f"cf:{num.id}", "op": "gte", "value": "4.5"},
        ])])
        self.assertEqual(ok["colorRules"][0]["conditions"][1]["value"], 4.5)
        status, _ = self.code(lambda: self.put(p, OWNER, [rule(conditions=[
            {"field": f"cf:{num.id}", "op": "is_any_of", "value": ["x"]}])]))
        self.assertEqual(status, 422)
        status, _ = self.code(lambda: self.put(p, OWNER, [rule(conditions=[
            {"field": f"cf:{sel.id}", "op": "gt", "value": 3}])]))
        self.assertEqual(status, 422)

    def test_unknown_option_unknown_field_or_field_of_another_project(self):
        p = self.project()
        sel = self.field("select")
        other = self.field("select", project_ids=["some-other-project"])
        for c in ({"field": f"cf:{sel.id}", "op": "is", "value": "opt-zzz"},
                  {"field": "cf:no-such-field", "op": "is_empty"},
                  {"field": f"cf:{other.id}", "op": "is_empty"}):
            status, _ = self.code(lambda: self.put(p, OWNER, [rule(conditions=[c])]))
            self.assertEqual(status, 422, c)

    def test_a_rule_left_on_a_deleted_field_is_kept_and_does_not_block_saves(self):
        p = self.project()
        sel = self.field("select")
        stale = rule(conditions=[{"field": f"cf:{sel.id}", "op": "is", "value": "opt-a"}])
        out = self.put(p, OWNER, [stale])
        self.db.delete(self.db.get(models.TaskCustomField, sel.id))
        self.db.commit()
        # Someone adds another rule; the stale one travels unchanged and stays.
        out = self.put(p, OWNER, [stale, rule(id="r2")], rev=out["colorRulesRev"])
        self.assertEqual([r["id"] for r in out["colorRules"]], ["r1", "r2"])
        # But a NEW condition on the deleted field is refused.
        status, _ = self.code(lambda: self.put(p, OWNER, [stale, rule(id="r3", conditions=[
            {"field": f"cf:{sel.id}", "op": "is", "value": "opt-b"}])]))
        self.assertEqual(status, 422)

    def test_people_come_from_the_directory_a_leaver_is_fine(self):
        p = self.project()
        out = self.put(p, OWNER, [rule(conditions=[{"field": "assignee", "op": "person_is",
                                                    "value": "Leaver@GreensGlobal.com"}])])
        self.assertEqual(out["colorRules"][0]["conditions"][0]["value"], "leaver@greensglobal.com")
        status, _ = self.code(lambda: self.put(p, OWNER, [rule(conditions=[
            {"field": "created_by", "op": "person_is", "value": "stranger@example.com"}])]))
        self.assertEqual(status, 422)


class WallTests(Base):
    def test_a_manager_cannot_write_over_the_wall(self):
        p = self.project(company_id=COA)
        self.arm()
        status, _ = self.code(lambda: self.put(p, BMGR, [rule()]))
        self.assertEqual(status, 404)
        self.db.expire_all()
        self.assertEqual(self.db.get(models.TaskProject, p.id).color_rules or [], [])
        # Their own side of the wall is fine; with the walls off, as before.
        mine = self.project(company_id=COB, owner_email=BMGR["email"], name="B ops")
        self.assertEqual(len(self.put(mine, BMGR, [rule()])["colorRules"]), 1)
        self.arm(False)
        self.assertEqual(len(self.put(p, BMGR, [rule()])["colorRules"]), 1)

    def test_behind_the_wall_no_other_company_people_or_fields(self):
        p = self.project(company_id=COA)
        b_field = self.field("select", company_id=COB)
        self.arm()
        status, _ = self.code(lambda: self.put(p, OWNER, [rule(conditions=[
            {"field": "assignee", "op": "person_is", "value": "b@greensglobal.com"}])]))
        self.assertEqual(status, 422)
        status, _ = self.code(lambda: self.put(p, OWNER, [rule(conditions=[
            {"field": f"cf:{b_field.id}", "op": "is_empty"}])]))
        self.assertEqual(status, 422)


if __name__ == "__main__":
    unittest.main()
