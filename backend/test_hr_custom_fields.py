"""More Details: custom fields on employee records (Neil, Oct 27 2026).

HR defines fields (Settings > People & Access); People shows them on the
profile and the list, My HR shows the employee's own. HR Only values never
leave the server for anyone who is not HR for the person; values are typed
and validated; a field for one company never shows on another's people;
archiving hides a field and keeps every value; an employee edits only the
Employee Can Edit fields. Documents merge them as {{custom.<field_key>}}.

    python -m unittest test_hr_custom_fields -v
"""
import json
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_RATE_LIMIT", "off")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from services.merge_fields import resolve_merge_data  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
HR = "hana.hr" + D            # employee tier + Full People grant: HR for everyone
SCOPED = "sam.scoped" + D     # Full People grant limited to company B
MGR = "max.mgr" + D           # manager tier + People grant: own team only
EMP = "erin.emp" + D          # reports to Max, company A
OTHER = "omar.other" + D      # company B
VIEWER = "vic.viewer" + D     # People viewer grant: reads, never writes, never HR Only
EDITOR = "ed.editor" + D      # People editor grant: works the other fields, never HR Only
CO_A, CO_B = "co-a", "co-b"


class CustomFieldTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        db = database.SessionLocal()
        for m in (models.NexusEmployee, models.NexusGroup, models.NexusGroupMember, models.NexusAccessScope,
                  models.NexusRole, models.HrEntity, models.EmployeeCustomField, models.AuditLog):
            db.query(m).execution_options(include_deleted=True).delete()
        db.add(models.HrEntity(id=CO_A, name="Company A"))
        db.add(models.HrEntity(id=CO_B, name="Company B"))
        people = ((HR, "", CO_A), (SCOPED, "", CO_B), (MGR, "", CO_A), (EMP, MGR, CO_A), (OTHER, "", CO_B))
        for i, (em, mgr, co) in enumerate(people):
            db.add(models.NexusEmployee(id=f"e{i}", first_name=em.split(".")[0].title(), last_name="T",
                                        work_email=em, manager_email=mgr, company=co, status="active",
                                        deleted_at=""))
        db.add(models.NexusRole(email=MGR, role="manager", display_name="Max"))
        db.add(models.NexusGroup(id="g-hr", name="People HR", allowed_modules="hr:full"))
        for em in (HR, SCOPED, MGR):
            db.add(models.NexusGroupMember(group_id="g-hr", email=em))
        db.add(models.NexusAccessScope(id="s1", email=SCOPED, module_id="hr", scope_type="entity", scope_id=CO_B))
        db.add(models.NexusGroup(id="g-view", name="People Viewers", allowed_modules="hr:viewer"))
        db.add(models.NexusGroupMember(group_id="g-view", email=VIEWER))
        db.add(models.NexusGroup(id="g-ed", name="People Editors", allowed_modules="hr:editor"))
        db.add(models.NexusGroupMember(group_id="g-ed", email=EDITOR))
        db.commit()
        db.close()
        cache.module_grants.invalidate()
        auth._role_cache.clear()
        self.ids = {em: f"e{i}" for i, (em, _m, _c) in enumerate(people)}

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    # ── helpers ────────────────────────────────────────────────────────────
    def _as(self, who):
        os.environ["NEXUS_DEV_EMAIL"] = who
        return self.client

    def _field(self, label, who=HR, **kw):
        body = {"label": label, "field_type": kw.pop("field_type", "text"), **kw}
        r = self._as(who).post("/hr/custom-fields", json=body)
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    def _set(self, eid, values, who=HR):
        return self._as(who).put(f"/hr/employees/{eid}/custom-fields", json={"values": values})

    def _stored(self, em):
        db = database.SessionLocal()
        try:
            return dict(db.query(models.NexusEmployee).filter_by(work_email=em).first().custom_fields or {})
        finally:
            db.close()

    def _standard(self):
        """One field of each visibility, all for every company, with values on Erin."""
        secret = self._field("Disciplinary Note", visibility="hr_only")
        badge = self._field("Badge Number", visibility="employee_view")
        shirt = self._field("Shirt Size", field_type="dropdown", options=["S", "M", "L"], visibility="employee_edit")
        r = self._set(self.ids[EMP], {secret["fieldKey"]: "Late twice", badge["fieldKey"]: "B-77",
                                      shirt["fieldKey"]: "m"})
        self.assertEqual(r.status_code, 200, r.text)
        return secret, badge, shirt

    # ── privacy ────────────────────────────────────────────────────────────
    def test_hr_sees_every_value_on_the_profile_and_the_list(self):
        secret, badge, shirt = self._standard()
        r = self._as(HR).get(f"/hr/employees/{self.ids[EMP]}/custom-fields")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["values"], {secret["fieldKey"]: "Late twice", badge["fieldKey"]: "B-77",
                                              shirt["fieldKey"]: "M"})       # the option's own spelling
        row = next(x for x in self._as(HR).get("/hr/employees").json() if x["workEmail"] == EMP)
        self.assertEqual(row["customFields"][secret["fieldKey"]], "Late twice")

    def test_a_manager_never_receives_an_hr_only_value_or_field(self):
        secret, badge, _shirt = self._standard()
        prof = self._as(MGR).get(f"/hr/employees/{self.ids[EMP]}/custom-fields")
        self.assertEqual(prof.status_code, 200, prof.text)
        self.assertNotIn("Late twice", prof.text)
        self.assertNotIn(secret["fieldKey"], prof.text)
        self.assertEqual(prof.json()["values"][badge["fieldKey"]], "B-77")
        self.assertFalse(prof.json()["canEdit"])
        listing = self._as(MGR).get("/hr/employees")
        self.assertEqual(listing.status_code, 200, listing.text)
        self.assertNotIn("Late twice", listing.text)
        defs = self._as(MGR).get("/hr/custom-fields")
        self.assertEqual(defs.status_code, 200, defs.text)
        self.assertNotIn(secret["fieldKey"], [f["fieldKey"] for f in defs.json()])
        # ...and cannot write, whatever the field.
        self.assertEqual(self._set(self.ids[EMP], {badge["fieldKey"]: "X"}, who=MGR).status_code, 403)

    def test_the_employee_sees_only_their_own_visible_fields(self):
        secret, badge, shirt = self._standard()
        r = self._as(EMP).get("/myhr/custom-fields")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("Late twice", r.text)
        self.assertNotIn(secret["fieldKey"], r.text)
        body = r.json()
        self.assertEqual(body["values"], {badge["fieldKey"]: "B-77", shirt["fieldKey"]: "M"})
        editable = {f["fieldKey"]: f["editable"] for f in body["fields"]}
        self.assertEqual(editable, {badge["fieldKey"]: False, shirt["fieldKey"]: True})
        # An employee without the People grant cannot reach the HR routes at all.
        self.assertEqual(self._as(EMP).get(f"/hr/employees/{self.ids[EMP]}/custom-fields").status_code, 403)

    def test_a_people_viewer_never_receives_hr_only_and_changes_none(self):
        secret, badge, _shirt = self._standard()
        r = self._as(VIEWER).get(f"/hr/employees/{self.ids[EMP]}/custom-fields")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn(secret["fieldKey"], r.json()["values"])
        self.assertNotIn("Late twice", r.text)
        self.assertEqual(r.json()["values"][badge["fieldKey"]], "B-77")
        row = next(x for x in self._as(VIEWER).get("/hr/employees").json() if x["workEmail"] == EMP)
        self.assertNotIn(secret["fieldKey"], row["customFields"])
        self.assertEqual(self._set(self.ids[EMP], {secret["fieldKey"]: "X"}, who=VIEWER).status_code, 403)
        self.assertEqual(self._as(VIEWER).post("/hr/custom-fields", json={"label": "Nope"}).status_code, 403)

    def test_a_people_editor_works_other_fields_never_hr_only(self):
        secret, badge, _shirt = self._standard()
        r = self._as(EDITOR).get(f"/hr/employees/{self.ids[EMP]}/custom-fields")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn(secret["fieldKey"], r.json()["values"])
        self.assertNotIn("Late twice", r.text)
        editable = {f["fieldKey"]: f["editable"] for f in r.json()["fields"]}
        self.assertNotIn(secret["fieldKey"], editable)
        self.assertTrue(editable[badge["fieldKey"]])
        self.assertNotEqual(self._set(self.ids[EMP], {secret["fieldKey"]: "X"}, who=EDITOR).status_code, 200)

    def test_hr_on_their_own_record_is_the_employee(self):
        secret = self._field("Disciplinary Note", visibility="hr_only")
        db = database.SessionLocal()
        db.query(models.NexusEmployee).filter_by(work_email=HR).update({"custom_fields": {secret["fieldKey"]: "Hidden"}})
        db.commit()
        db.close()
        r = self._as(HR).get(f"/hr/employees/{self.ids[HR]}/custom-fields")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("Hidden", r.text)
        row = next(x for x in self._as(HR).get("/hr/employees").json() if x["workEmail"] == HR)
        self.assertEqual(row["customFields"], {})

    # ── employee edit rights ───────────────────────────────────────────────
    def test_the_employee_edits_only_employee_can_edit_fields(self):
        secret, badge, shirt = self._standard()
        ok = self._as(EMP).put("/myhr/custom-fields", json={"values": {shirt["fieldKey"]: "L"}})
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(self._stored(EMP)[shirt["fieldKey"]], "L")
        view_only = self._as(EMP).put("/myhr/custom-fields", json={"values": {badge["fieldKey"]: "B-1"}})
        self.assertEqual(view_only.status_code, 403, view_only.text)
        hidden = self._as(EMP).put("/myhr/custom-fields", json={"values": {secret["fieldKey"]: "Fine"}})
        self.assertEqual(hidden.status_code, 400, hidden.text)     # same answer as a field that does not exist
        self.assertNotIn("Disciplinary", hidden.text)
        stored = self._stored(EMP)
        self.assertEqual((stored[badge["fieldKey"]], stored[secret["fieldKey"]]), ("B-77", "Late twice"))

    # ── validation ─────────────────────────────────────────────────────────
    def test_values_are_checked_by_type(self):
        num = self._field("Locker", field_type="number")
        day = self._field("Badge Expiry", field_type="date")
        pick = self._field("Shift", field_type="dropdown", options=["Day", "Night"])
        box = self._field("Has Parking", field_type="checkbox", required=True)
        self.assertFalse(box["required"])                           # a checkbox is never required
        eid = self.ids[EMP]
        for bad in ({num["fieldKey"]: "twelve"}, {num["fieldKey"]: True}, {day["fieldKey"]: "10/27/2026"},
                    {day["fieldKey"]: "2026-02-30"}, {pick["fieldKey"]: "Evening"}, {box["fieldKey"]: "maybe"},
                    {num["fieldKey"]: {"a": 1}}):
            self.assertEqual(self._set(eid, bad).status_code, 400, bad)
        r = self._set(eid, {num["fieldKey"]: "1,200", day["fieldKey"]: "2026-10-27",
                            pick["fieldKey"]: "night", box["fieldKey"]: True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["values"], {num["fieldKey"]: 1200, day["fieldKey"]: "2026-10-27",
                                              pick["fieldKey"]: "Night", box["fieldKey"]: True})

    def test_a_required_field_cannot_be_left_empty(self):
        req = self._field("Cost Center", required=True)
        other = self._field("Desk")
        eid = self.ids[EMP]
        self.assertEqual(self._set(eid, {other["fieldKey"]: "4A"}).status_code, 400)   # Cost Center still empty
        self.assertEqual(self._set(eid, {req["fieldKey"]: "CC-1", other["fieldKey"]: "4A"}).status_code, 200)
        self.assertEqual(self._set(eid, {req["fieldKey"]: ""}).status_code, 400)
        self.assertEqual(self._stored(EMP)[req["fieldKey"]], "CC-1")

    def test_definitions_are_checked(self):
        r = self._as(HR).post("/hr/custom-fields", json={"label": "Tier", "field_type": "dropdown", "options": []})
        self.assertEqual(r.status_code, 400)
        r = self._as(HR).post("/hr/custom-fields", json={"label": "X", "field_type": "color"})
        self.assertEqual(r.status_code, 400)
        r = self._as(HR).post("/hr/custom-fields", json={"label": "X", "visibility": "everyone"})
        self.assertEqual(r.status_code, 400)
        a = self._field("Badge Number")
        b = self._field("Badge Number")
        self.assertNotEqual(a["fieldKey"], b["fieldKey"])               # keys never collide
        self.assertEqual(a["token"], f"custom.{a['fieldKey']}")

    def test_changes_are_recorded_in_the_hr_audit_trail(self):
        f = self._field("Desk")
        self.assertEqual(self._set(self.ids[EMP], {f["fieldKey"]: "4A"}).status_code, 200)
        db = database.SessionLocal()
        try:
            rows = db.query(models.AuditLog).filter_by(resource_type="employee", resource_id=self.ids[EMP]).all()
        finally:
            db.close()
        self.assertEqual(len(rows), 1)
        details = json.loads(rows[0].details)
        self.assertEqual(rows[0].action, "Changed employee fields")
        self.assertEqual(details["changes"][f"custom.{f['fieldKey']}"], [None, "4A"])
        self.assertEqual(rows[0].user_email, HR)

    # ── company scoping ────────────────────────────────────────────────────
    def test_a_company_field_shows_only_on_that_companys_people(self):
        a_only = self._field("Union Local", company_id=CO_A)
        r = self._as(HR).get(f"/hr/employees/{self.ids[OTHER]}/custom-fields")
        self.assertNotIn(a_only["fieldKey"], [f["fieldKey"] for f in r.json()["fields"]])
        self.assertEqual(self._set(self.ids[OTHER], {a_only["fieldKey"]: "12"}).status_code, 400)
        self.assertEqual(self._set(self.ids[EMP], {a_only["fieldKey"]: "12"}).status_code, 200)

    def test_a_scoped_admin_works_only_inside_their_companies(self):
        a_only = self._field("Union Local", company_id=CO_A)
        every = self._field("Nickname")
        defs = [f["fieldKey"] for f in self._as(SCOPED).get("/hr/custom-fields").json()]
        self.assertIn(every["fieldKey"], defs)
        self.assertNotIn(a_only["fieldKey"], defs)
        c = self._as(SCOPED)
        self.assertEqual(c.post("/hr/custom-fields", json={"label": "Org Wide"}).status_code, 403)
        self.assertEqual(c.post("/hr/custom-fields", json={"label": "A", "company_id": CO_A}).status_code, 403)
        self.assertEqual(c.post("/hr/custom-fields", json={"label": "B", "company_id": CO_B}).status_code, 201)
        self.assertEqual(c.patch(f"/hr/custom-fields/{a_only['id']}", json={"label": "Mine"}).status_code, 404)
        self.assertEqual(c.patch(f"/hr/custom-fields/{every['id']}", json={"label": "Mine"}).status_code, 403)
        # People outside their companies answer 404, values and all.
        self.assertEqual(c.get(f"/hr/employees/{self.ids[EMP]}/custom-fields").status_code, 404)
        self.assertEqual(self._set(self.ids[EMP], {every["fieldKey"]: "E"}, who=SCOPED).status_code, 404)
        self.assertEqual(self._set(self.ids[OTHER], {every["fieldKey"]: "O"}, who=SCOPED).status_code, 200)

    # ── archive ────────────────────────────────────────────────────────────
    def test_archiving_hides_a_field_and_keeps_its_values(self):
        f = self._field("Locker")
        self.assertEqual(self._set(self.ids[EMP], {f["fieldKey"]: "L-9"}).status_code, 200)
        self.assertEqual(self._as(HR).patch(f"/hr/custom-fields/{f['id']}", json={"archived": True}).status_code, 200)
        prof = self._as(HR).get(f"/hr/employees/{self.ids[EMP]}/custom-fields").json()
        self.assertEqual(prof["fields"], [])
        self.assertEqual(prof["values"], {})
        self.assertEqual(self._stored(EMP)[f["fieldKey"]], "L-9")          # still stored
        self.assertEqual(self._set(self.ids[EMP], {f["fieldKey"]: "L-1"}).status_code, 400)
        archived = self._as(HR).get("/hr/custom-fields?include_archived=true").json()
        self.assertTrue(next(x for x in archived if x["id"] == f["id"])["archived"])
        self._as(HR).patch(f"/hr/custom-fields/{f['id']}", json={"archived": False})
        prof = self._as(HR).get(f"/hr/employees/{self.ids[EMP]}/custom-fields").json()
        self.assertEqual(prof["values"], {f["fieldKey"]: "L-9"})

    def test_changing_a_fields_type_never_rewrites_values(self):
        f = self._field("Locker")
        self._set(self.ids[EMP], {f["fieldKey"]: "Blue"})
        r = self._as(HR).patch(f"/hr/custom-fields/{f['id']}", json={"field_type": "number"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._stored(EMP)[f["fieldKey"]], "Blue")

    def test_reorder_keeps_the_order_given(self):
        a, b, c = self._field("A"), self._field("B"), self._field("C")
        r = self._as(HR).post("/hr/custom-fields/reorder", json={"ids": [c["id"], a["id"], b["id"]]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([x["label"] for x in r.json()], ["C", "A", "B"])

    # ── documents ──────────────────────────────────────────────────────────
    def test_fields_merge_into_documents_with_hr_only_for_hr(self):
        secret = self._field("Disciplinary Note", visibility="hr_only")
        day = self._field("Badge Expiry", field_type="date", visibility="employee_view")
        box = self._field("Has Parking", field_type="checkbox", visibility="employee_view")
        self._set(self.ids[EMP], {secret["fieldKey"]: "Late", day["fieldKey"]: "2026-10-27", box["fieldKey"]: False})
        db = database.SessionLocal()
        try:
            full = resolve_merge_data(db, employee_id=self.ids[EMP])
            safe = resolve_merge_data(db, employee_id=self.ids[EMP], custom_hr_only=False)
        finally:
            db.close()
        self.assertEqual(full[f"custom.{secret['fieldKey']}"], "Late")
        self.assertEqual(full[f"custom.{day['fieldKey']}"], "10/27/2026")     # US date, never ISO
        self.assertEqual(full[f"custom.{box['fieldKey']}"], "No")
        self.assertNotIn(f"custom.{secret['fieldKey']}", safe)
        self.assertEqual(safe[f"custom.{day['fieldKey']}"], "10/27/2026")
        tokens = [v["token"] for v in self._as(HR).get("/documents/variables").json()]
        self.assertIn(f"custom.{day['fieldKey']}", tokens)
        # Who a Documents export counts as HR for Erin (the ONE scoped HR rule,
        # release review Oct 27): a Full People grant or the company's HR
        # contact - never an Editor or Viewer grant, her manager, her, or HR
        # scoped to another company.
        import hr_custom_fields
        full, contact = "fay.full" + D, "cora.contact" + D
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id="g-full", name="People Full", allowed_modules="hr:full"))
            db.add(models.NexusGroupMember(group_id="g-full", email=full))
            db.add(models.NexusEmployee(id="e-full", first_name="Fay", last_name="T", work_email=full,
                                        company=CO_A, status="active", deleted_at=""))
            db.query(models.HrEntity).filter_by(id=CO_A).update({"hr_contact_email": contact})
            db.commit()
            cache.module_grants.invalidate()
            erin = db.query(models.NexusEmployee).filter_by(work_email=EMP).first()
            who = {em: hr_custom_fields.caller_is_hr_for({"email": em, "level": auth.level_for(em, db)}, db, erin)
                   for em in (full, contact, EDITOR, VIEWER, MGR, EMP, SCOPED)}
        finally:
            db.close()
        self.assertEqual(who, {full: True, contact: True, EDITOR: False, VIEWER: False, MGR: False,
                               EMP: False, SCOPED: False})


if __name__ == "__main__":
    unittest.main()

