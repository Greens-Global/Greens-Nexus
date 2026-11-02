"""Forms & Checklists (Neil, 11/02/2026) - plan Task 2: the Workflows
documents pack (workflows/packs/documents.py) and the two emit choke points
in routers/forms.py.

- `form_entry` is registered on DocFormEntry under the `documents` module
  with title / status / submitted_by / site / category; the events are
  `form.submitted` and `form.reviewed`, and their samples validate against
  the entity's fields and render.
- A submit writes exactly ONE `form.submitted` outbox row inside the
  request's transaction; its `extra` is the answers FLAT plus `form` (the
  title), so `{{ event.<token> }}` resolves through workflows/context.py.
- The same entryKey again (a retry) writes no second row.
- A review writes one `form.reviewed` row with `changes.status` from / to
  and the decision and note in `extra`.
- `visible_to` is form_audience's reach; building on the events takes a
  manager, the Documents grant or an administrator.
- The committed catalog lock matches the registry with the pack loaded.

Run alone (one file per process): python -m pytest test_workflows_pack_documents.py
"""
import json
import os
import tempfile
import unittest
import uuid

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ["SUPABASE_URL"] = "https://example.supabase.co"

import atexit  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from workflows import catalog  # noqa: E402
from workflows.context import RunContext, render  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


CO_A, CO_B = "wfdoc-co-a", "wfdoc-co-b"
SITE_A = "wfdoc-site-a"
ADMIN = "wfdoc.admin@greensglobal.com"      # administrator, co-a
MGR = "wfdoc.mgr@greensglobal.com"          # manager, co-a; REP reports to them
REP = "wfdoc.rep@greensglobal.com"          # employee, reports to MGR, site A
OTHER = "wfdoc.other@greensglobal.com"      # employee, co-b
HR_A = "wfdoc.hr@greensglobal.com"          # the HR contact of co-a
MGR2 = "wfdoc.mgr2@greensglobal.com"        # manager, co-a; nobody reports to them, no team site

PEOPLE = {
    ADMIN: dict(company=CO_A, department="Operations"),
    MGR: dict(company=CO_A, department="Operations"),
    REP: dict(company=CO_A, department="Operations", manager_email=MGR, work_site_ids=json.dumps([SITE_A])),
    OTHER: dict(company=CO_B, department="Operations"),
    HR_A: dict(company=CO_A, department="People"),
    MGR2: dict(company=CO_A, department="Operations"),
}
ROLES = {ADMIN: "administrator", MGR: "manager", MGR2: "manager"}

FIELDS = [
    {"token": "odometer", "label": "Odometer", "type": "number", "required": True, "section": "Vehicle"},
    {"token": "injury", "label": "Injury", "type": "yesno", "required": True, "section": "Safety"},
    {"token": "injury_detail", "label": "Injury Detail", "type": "multiline", "required": True, "section": "Safety",
     "showIf": {"token": "injury", "op": "eq", "value": True}},
    {"token": "tire_psi", "label": "Tire PSI", "type": "number", "required": True, "section": "Tires",
     "repeat": {"group": "tires", "max": 4}},
    {"token": "qty", "label": "Qty", "type": "number", "section": "Fuel"},
    {"token": "price", "label": "Price", "type": "currency", "section": "Fuel"},
    {"token": "total", "label": "Total", "type": "number", "section": "Fuel", "formula": "{Qty} * {Price}"},
]
ANSWERS = {"odometer": 48210, "injury": False, "injury_detail": "stale - hidden, must be dropped",
           "tires": [{"tire_psi": 32}, {"tire_psi": 34}], "qty": 3, "price": 4}


class DocumentsPackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        catalog.load_packs()
        cls.client = TestClient(main.app)

    def setUp(self):
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.HrEntity(id=CO_A, name="Greens A", hr_contact_email=HR_A))
            db.add(models.HrEntity(id=CO_B, name="Greens B"))
            db.add(models.HrWorkSite(id=SITE_A, name="North Yard"))
            db.add(models.HrCompanyWorkSite(id=f"{CO_A}:{SITE_A}", company_id=CO_A, site_id=SITE_A))
            for em, extra in PEOPLE.items():
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=em.split(".")[1].split("@")[0].title(),
                                            last_name="Wfdoc", work_email=em, status="active", deleted_at="",
                                            **extra))
            for em, role in ROLES.items():
                db.add(models.NexusRole(email=em, role=role, assigned_by="test"))
            db.commit()
        finally:
            db.close()
        self._flush()
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)
        self._flush()

    def _flush(self):
        auth.invalidate_role_cache()
        cache.settings_config.invalidate()
        cache.people_directory.invalidate()
        cache.module_grants.invalidate()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email.like("wfdoc.%")).delete(synchronize_session=False))
            db.query(models.NexusRole).filter(models.NexusRole.email.like("wfdoc.%")).delete(synchronize_session=False)
            db.query(models.HrEntity).filter(models.HrEntity.id.in_([CO_A, CO_B])).delete(synchronize_session=False)
            db.query(models.HrWorkSite).filter(models.HrWorkSite.id == SITE_A).delete(synchronize_session=False)
            db.query(models.HrCompanyWorkSite).filter(models.HrCompanyWorkSite.company_id == CO_A).delete(synchronize_session=False)
            db.query(models.DocFormEntry).delete(synchronize_session=False)
            db.query(models.DocTemplateVersion).delete(synchronize_session=False)
            db.query(models.DocTemplate).delete(synchronize_session=False)
            db.query(models.WorkflowEvent).delete(synchronize_session=False)
            db.query(models.WorkflowRun).filter(models.WorkflowRun.id.like("wfdoc-%")).delete(synchronize_session=False)
            db.query(models.NexusNotification).filter(models.NexusNotification.recipient.like("wfdoc.%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache()

    def _template(self, name="Vehicle Check", **over):
        self._as(ADMIN)
        body = {"name": name, "docType": "form", "category": "vehicle", "status": "active",
                "fieldDefs": FIELDS, "audience": "company"}
        body.update(over)
        r = self.client.post("/documents/templates", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _submit(self, tid, who=REP, key=None, **extra):
        self._as(who)
        body = {"entryKey": key or str(uuid.uuid4()), "answers": dict(ANSWERS), "source": "phone",
                "workSiteId": SITE_A}
        body.update(extra)
        r = self.client.post(f"/forms/{tid}/entries", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _events(self, key):
        self.db.expire_all()
        return (self.db.query(models.WorkflowEvent).filter(models.WorkflowEvent.key == key)
                .order_by(models.WorkflowEvent.at.asc()).all())

    def _ctx(self, payload, user=None):
        return RunContext(db=self.db, entity=catalog.ENTITIES["form_entry"], subject=None, payload=payload,
                          run_as=user or {"email": MGR, "role": "manager", "level": 3})

    # ── the registry ─────────────────────────────────────────────────────────

    def test_form_entry_entity_and_its_two_events_are_registered(self):
        ent = catalog.ENTITIES.get("form_entry")
        self.assertIsNotNone(ent, "form_entry is not registered")
        self.assertIs(ent.model, models.DocFormEntry)
        self.assertEqual(ent.module, "documents")
        for key in ("title", "status", "submitted_by", "site", "category"):
            self.assertIsNotNone(ent.field(key), key)
        self.assertEqual(ent.field("submitted_by").type, "person")
        self.assertEqual(ent.field("status").type, "select")
        self.assertEqual({v for v, _ in ent.field("status").options},
                         {"submitted", "reviewed", "follow_up", "closed"})
        self.assertTrue({"self", "manager", "reviewer", "hr_contact"} <= set(ent.people))
        for key in ("form.submitted", "form.reviewed"):
            ev = catalog.EVENTS.get(key)
            self.assertIsNotNone(ev, key)
            self.assertEqual(ev.entity, "form_entry")
            self.assertEqual(ev.module, "documents")
        self.assertEqual(catalog.EVENTS["form.reviewed"].changes, ("status",))

    def test_every_documents_event_sample_validates_and_renders(self):
        ent = catalog.ENTITIES["form_entry"]
        checked = 0
        for key, ev in catalog.EVENTS.items():
            if ev.module != "documents":
                continue
            checked += 1
            payload = catalog.sample_payload(ev)
            self.assertTrue(payload["subject"], key)
            for fkey in payload["subject"]:
                self.assertIsNotNone(ent.field(fkey), f"{key}: sample key {fkey!r} is not a field")
            for ckey, change in payload["changes"].items():
                self.assertIsNotNone(ent.field(ckey), f"{key}: change {ckey}")
                self.assertEqual(set(change), {"from", "to"})
            self.assertEqual(payload["extra"].get("form"), payload["subject"]["title"], key)
            ctx = RunContext(db=self.db, entity=ent, subject=None, payload=payload,
                             run_as={"email": ADMIN, "role": "administrator", "level": 4})
            text, missing = render("{{ subject.title }} / {{ subject }} / {{ event.form }}", ctx)
            self.assertEqual(missing, [], f"{key}: {missing}")
            self.assertTrue(text.strip("/ "), key)
        self.assertEqual(checked, 2)

    def test_lock_matches_the_registry_with_the_pack_loaded(self):
        self.assertTrue(catalog.lock_matches("workflows/catalog.lock.json"),
                        "regenerate: python -c 'import workflows.catalog as c; c.load_packs(); "
                        "c.write_lock(\"workflows/catalog.lock.json\")'")

    # ── the emits ────────────────────────────────────────────────────────────

    def test_submit_writes_one_outbox_row_whose_extra_resolves_each_answer_as_event_token(self):
        tpl = self._template()
        entry = self._submit(tpl["id"])
        rows = self._events("form.submitted")
        self.assertEqual(len(rows), 1, f"{len(rows)} outbox rows")
        ev = rows[0]
        self.assertEqual(ev.entity, "form_entry")
        self.assertEqual(ev.subject_id, entry["id"])
        self.assertEqual(ev.company_id, CO_A)
        self.assertEqual(ev.actor, REP)
        payload = ev.payload
        self.assertEqual(payload["subject"]["title"], "Vehicle Check")
        self.assertEqual(payload["subject"]["status"], "submitted")
        self.assertEqual(payload["subject"]["submitted_by"], REP)
        self.assertEqual(payload["subject"]["site"], "North Yard")
        self.assertEqual(payload["subject"]["category"], "vehicle")
        # flat: each answer at the top of extra, plus the form's title
        extra = payload["extra"]
        self.assertEqual(extra["form"], "Vehicle Check")
        self.assertEqual(extra["odometer"], 48210)
        self.assertIs(extra["injury"], False)
        self.assertEqual(extra["total"], 12)                     # the server's own formula result
        self.assertEqual(extra["tires"], [{"tire_psi": 32}, {"tire_psi": 34}])
        self.assertNotIn("injury_detail", extra)                 # hidden by showIf, dropped at submit
        self.assertNotIn("answers", extra)                       # never nested
        ctx = self._ctx(payload)
        text, missing = render("{{ event.form }}: {{ event.odometer }} mi, injury {{ event.injury }}, "
                               "{{ subject.submitted_by }} at {{ subject.site }}", ctx)
        self.assertEqual(missing, [])
        self.assertIn("Vehicle Check: 48210 mi", text)
        self.assertIn(REP, text)
        self.assertIn("North Yard", text)
        self.assertEqual(self._events("form.reviewed"), [])

    def test_the_same_entry_key_again_writes_no_second_row(self):
        tpl = self._template()
        key = str(uuid.uuid4())
        first = self._submit(tpl["id"], key=key)
        again = self._submit(tpl["id"], key=key)
        self.assertEqual(first["id"], again["id"])
        self.assertEqual(len(self._events("form.submitted")), 1)

    def test_review_writes_one_form_reviewed_row_with_the_status_change_and_note(self):
        tpl = self._template()
        entry = self._submit(tpl["id"])
        self._as(MGR)
        r = self.client.post(f"/forms/entries/{entry['id']}/review",
                             json={"status": "follow_up", "note": "Check the rear tires"})
        self.assertEqual(r.status_code, 200, r.text)
        rows = self._events("form.reviewed")
        self.assertEqual(len(rows), 1, f"{len(rows)} outbox rows")
        ev = rows[0]
        self.assertEqual(ev.subject_id, entry["id"])
        self.assertEqual(ev.actor, MGR)
        payload = ev.payload
        self.assertEqual(payload["changes"], {"status": {"from": "submitted", "to": "follow_up"}})
        self.assertEqual(payload["subject"]["status"], "follow_up")
        self.assertEqual(payload["subject"]["reviewer_email"], MGR)
        self.assertEqual(payload["extra"]["form"], "Vehicle Check")
        self.assertEqual(payload["extra"]["decision"], "follow_up")
        self.assertEqual(payload["extra"]["note"], "Check the rear tires")
        self.assertEqual(payload["extra"]["odometer"], 48210)   # the answers ride along for the template
        text, missing = render("{{ event.form }} is {{ event.decision }}: {{ event.note }}", self._ctx(payload))
        self.assertEqual(missing, [])
        self.assertEqual(text, "Vehicle Check is follow_up: Check the rear tires")
        self.assertEqual(len(self._events("form.submitted")), 1)   # the review did not re-emit the submit

    def test_a_refused_review_writes_nothing(self):
        tpl = self._template()
        entry = self._submit(tpl["id"])
        self._as(REP)                                            # never your own
        r = self.client.post(f"/forms/entries/{entry['id']}/review", json={"status": "reviewed"})
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(self._events("form.reviewed"), [])

    # ── access ───────────────────────────────────────────────────────────────

    def test_visible_to_is_the_forms_reach(self):
        tpl = self._template()
        entry = self._submit(tpl["id"])
        row = self.db.query(models.DocFormEntry).filter(models.DocFormEntry.id == entry["id"]).first()
        ent = catalog.ENTITIES["form_entry"]
        self.assertTrue(ent.visible_to(self.db, {"email": REP, "role": "employee", "level": 1}, row))
        self.assertTrue(ent.visible_to(self.db, {"email": MGR, "role": "manager", "level": 3}, row))
        self.assertTrue(ent.visible_to(self.db, {"email": HR_A, "role": "employee", "level": 1}, row))
        self.assertFalse(ent.visible_to(self.db, {"email": OTHER, "role": "employee", "level": 1}, row))
        self.assertFalse(ent.visible_to(self.db, None, row))
        self.assertEqual(ent.company_of(row), CO_A)
        link = ent.link(row)
        self.assertEqual((link["view"], link["sub"], link["entryId"]), ("documents", "documents-forms", row.id))

    def test_a_run_shows_the_answers_only_to_someone_who_may_see_the_entry(self):
        from workflows import store
        tpl = self._template()
        entry = self._submit(tpl["id"])
        ev = self._events("form.submitted")[0]
        run = models.WorkflowRun(id="wfdoc-run-1", workflow_id="wfdoc-wf", workflow_name="Check", version=1,
                                 event_id=ev.id, trigger_kind="event", entity="form_entry",
                                 subject_id=entry["id"], company_id=CO_A, status="succeeded",
                                 started_at="2026-11-02T10:00:00+00:00")
        self.db.add(run)
        self.db.commit()

        def extra_for(user):
            out = store.serialize_run(self.db, run, steps=True, viewer=user)
            return out["event"]["payload"]["extra"]

        outsider = extra_for({"email": MGR2, "role": "manager", "level": 3})
        self.assertEqual(outsider, {"form": "Vehicle Check"})        # no answer tokens
        for token in ("odometer", "injury", "total", "tires"):
            self.assertNotIn(token, outsider)
        reviewer = extra_for({"email": MGR, "role": "manager", "level": 3})
        self.assertEqual(reviewer["odometer"], 48210)
        self.assertEqual(reviewer["total"], 12)
        self.assertEqual(reviewer["form"], "Vehicle Check")

    def test_building_on_form_events_takes_a_manager_or_the_documents_grant(self):
        keys = {"form.submitted", "form.reviewed"}

        def events_for(user):
            return {e["key"] for e in catalog.serialize(self.db, user)["events"]} & keys

        self.assertEqual(events_for({"email": REP, "role": "employee", "level": 1}), set())
        self.assertEqual(events_for({"email": MGR, "role": "manager", "level": 3}), keys)
        self.assertEqual(events_for({"email": ADMIN, "role": "administrator", "level": 4}), keys)
        self.db.add(models.NexusGroup(id="wfdoc-g-docs", name="Docs", allowed_modules="documents:viewer"))
        self.db.add(models.NexusGroupMember(group_id="wfdoc-g-docs", email=OTHER))
        self.db.commit()
        cache.module_grants.invalidate()
        try:
            self.assertEqual(events_for({"email": OTHER, "role": "employee", "level": 1}), keys)
        finally:
            self.db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == "wfdoc-g-docs").delete()
            self.db.query(models.NexusGroup).filter(models.NexusGroup.id == "wfdoc-g-docs").delete()
            self.db.commit()
            cache.module_grants.invalidate()


if __name__ == "__main__":
    unittest.main()
