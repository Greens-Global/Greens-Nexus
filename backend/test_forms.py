"""Forms & Checklists - the backend (Neil, 11/02/2026; spec
docs/superpowers/specs/2026-11-02-forms-design.md, plan Task 1).

A form is a DocTemplate with doc_type 'form'; its entries are doc_form_entries.

- A form template keeps the form-only field keys (section / showIf / formula /
  repeat) and types (photo / gps / scan / rating / yesno); a document template
  drops them.
- /forms/mine and GET /forms/{tid} follow the audience rule (company /
  department / site): an outsider gets 404 and never sees the template.
- A showIf field hidden at submit time is not required and its stale value is
  dropped; a required repeat group refuses zero rows and stores three in order.
- The same entry_key twice returns the first entry - never a second row.
- A manager sees an entry by a report at another site AND an entry by a
  stranger at their team's site, not a stranger's entry at another site; HR++
  sees the company's; the submitter sees their own.
- Review bells the submitter once per entry (rewritten in place); PDF bytes
  start with %PDF; the CSV has one column per token.

Run alone (one file per process): python -m pytest test_forms.py
"""
import csv
import io
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

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


CO_A, CO_B = "forms-co-a", "forms-co-b"
SITE_A, SITE_B = "forms-site-a", "forms-site-b"
ADMIN = "forms.admin@greensglobal.com"      # administrator, co-a, Operations
MGR = "forms.mgr@greensglobal.com"          # manager, co-a, Operations; schedules nothing, REP reports to them
REP = "forms.rep@greensglobal.com"          # employee, reports to MGR, site A
STR = "forms.stranger@greensglobal.com"     # employee, co-a, Operations, site A, no manager
STR_B = "forms.strangerb@greensglobal.com"  # employee, co-a, Finance, site B
OTHER = "forms.other@greensglobal.com"      # employee, co-b
HR_A = "forms.hr@greensglobal.com"          # employee, the HR contact of co-a
STORAGE = "https://example.supabase.co/storage/v1/object/public/task-files/forms/k1/"

PEOPLE = {
    ADMIN: dict(company=CO_A, department="Operations"),
    MGR: dict(company=CO_A, department="Operations"),
    REP: dict(company=CO_A, department="Operations", manager_email=MGR, work_site_ids=json.dumps([SITE_A])),
    STR: dict(company=CO_A, department="Operations", work_site_ids=json.dumps([SITE_A])),
    STR_B: dict(company=CO_A, department="Finance", work_site_ids=json.dumps([SITE_B])),
    OTHER: dict(company=CO_B, department="Operations"),
    HR_A: dict(company=CO_A, department="People"),
}
ROLES = {ADMIN: "administrator", MGR: "manager"}

FIELDS = [
    {"token": "odometer", "label": "Odometer", "type": "number", "required": True, "section": "Vehicle"},
    {"token": "photos", "label": "Photos", "type": "photo", "section": "Vehicle"},
    {"token": "injury", "label": "Injury", "type": "yesno", "required": True, "section": "Safety"},
    {"token": "injury_detail", "label": "Injury Detail", "type": "multiline", "required": True, "section": "Safety",
     "showIf": {"token": "injury", "op": "eq", "value": True}},
    {"token": "tire_psi", "label": "Tire PSI", "type": "number", "required": True, "section": "Tires",
     "repeat": {"group": "tires", "max": 4}},
    {"token": "qty", "label": "Qty", "type": "number", "section": "Fuel"},
    {"token": "price", "label": "Price", "type": "currency", "section": "Fuel"},
    {"token": "total", "label": "Total", "type": "number", "section": "Fuel", "formula": "{Qty} * {Price}"},
    {"token": "location", "label": "Location", "type": "gps", "section": "Vehicle"},
    {"token": "rating", "label": "Rating", "type": "rating", "section": "Vehicle"},
    {"token": "tag", "label": "Tag", "type": "scan", "section": "Vehicle"},
    {"token": "sig", "label": "Signature", "type": "signature", "section": "Sign"},
]


def _answers(**over):
    base = {"odometer": 1200, "injury": False,
            "tires": [{"tire_psi": 32}, {"tire_psi": 34}, {"tire_psi": 35}],
            "qty": 3, "price": 4}
    base.update(over)
    return base


class FormsTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.HrEntity(id=CO_A, name="Greens A", hr_contact_email=HR_A))
            db.add(models.HrEntity(id=CO_B, name="Greens B"))
            db.add(models.HrWorkSite(id=SITE_A, name="North Yard"))
            db.add(models.HrWorkSite(id=SITE_B, name="South Yard"))
            db.add(models.HrCompanyWorkSite(id=f"{CO_A}:{SITE_A}", company_id=CO_A, site_id=SITE_A))
            db.add(models.HrCompanyWorkSite(id=f"{CO_A}:{SITE_B}", company_id=CO_A, site_id=SITE_B))
            for em, extra in PEOPLE.items():
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=em.split(".")[1].split("@")[0].title(),
                                            last_name="Forms", work_email=em, status="active", deleted_at="",
                                            **extra))
            for em, role in ROLES.items():
                db.add(models.NexusRole(email=em, role=role, assigned_by="test"))
            # MGR's team: REP is in a shift group that works at site A.
            db.add(models.ShiftGroup(id="forms-g1", name="Yard Crew", work_site_id=SITE_A, company_id=CO_A))
            db.add(models.ShiftGroupMember(id="forms-g1-rep", group_id="forms-g1", employee_email=REP))
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
               .filter(models.NexusEmployee.work_email.like("forms.%")).delete(synchronize_session=False))
            db.query(models.NexusRole).filter(models.NexusRole.email.like("forms.%")).delete(synchronize_session=False)
            db.query(models.HrEntity).filter(models.HrEntity.id.in_([CO_A, CO_B])).delete(synchronize_session=False)
            db.query(models.HrWorkSite).filter(models.HrWorkSite.id.in_([SITE_A, SITE_B])).delete(synchronize_session=False)
            db.query(models.HrCompanyWorkSite).filter(models.HrCompanyWorkSite.company_id == CO_A).delete(synchronize_session=False)
            db.query(models.ShiftGroupMember).filter(models.ShiftGroupMember.group_id == "forms-g1").delete(synchronize_session=False)
            db.query(models.ShiftGroup).filter(models.ShiftGroup.id == "forms-g1").delete(synchronize_session=False)
            db.query(models.DocFormEntry).delete(synchronize_session=False)
            db.query(models.DocTemplateVersion).delete(synchronize_session=False)
            db.query(models.DocTemplate).delete(synchronize_session=False)
            db.query(models.NexusNotification).filter(models.NexusNotification.recipient.like("forms.%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache()

    def _template(self, name="Vehicle Check", fields=None, **over):
        self._as(ADMIN)
        body = {"name": name, "docType": "form", "category": "vehicle", "status": "active",
                "fieldDefs": fields if fields is not None else FIELDS, "audience": "company"}
        body.update(over)
        r = self.client.post("/documents/templates", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _submit(self, tid, who, answers=None, status=200, **extra):
        self._as(who)
        body = {"entryKey": str(uuid.uuid4()), "answers": answers if answers is not None else _answers(),
                "source": "phone"}
        body.update(extra)
        r = self.client.post(f"/forms/{tid}/entries", json=body)
        self.assertEqual(r.status_code, status, r.text)
        return r.json()

    # ── Templates ────────────────────────────────────────────────────────────

    def test_form_template_keeps_form_keys_and_types_and_a_document_template_drops_them(self):
        tpl = self._template()
        by_token = {d["token"]: d for d in tpl["fieldDefs"]}
        self.assertEqual(by_token["injury"]["type"], "yesno")
        self.assertEqual({d["type"] for d in tpl["fieldDefs"]} >= {"photo", "gps", "scan", "rating", "yesno"}, True)
        self.assertEqual(by_token["injury_detail"]["showIf"], {"token": "injury", "op": "eq", "value": True})
        self.assertEqual(by_token["tire_psi"]["repeat"], {"group": "tires", "max": 4})
        self.assertEqual(by_token["total"]["formula"], "{Qty} * {Price}")
        self.assertEqual(by_token["odometer"]["section"], "Vehicle")
        self.assertEqual(tpl["docType"], "form")
        self.assertEqual(tpl["audience"], "company")
        self.assertEqual(tpl["showOnShifts"], False)
        self.assertEqual(tpl["state"], "published")

        self._as(ADMIN)
        r = self.client.post("/documents/templates", json={"name": "Letter", "docType": "document",
                                                             "category": "hr", "fieldDefs": FIELDS})
        self.assertEqual(r.status_code, 200, r.text)
        doc = r.json()
        types = {d["type"] for d in doc["fieldDefs"]}
        self.assertFalse(types & {"photo", "gps", "scan", "rating", "yesno"})
        for d in doc["fieldDefs"]:
            for key in ("section", "showIf", "formula", "repeat"):
                self.assertNotIn(key, d, d)

    def test_a_form_audience_needs_its_department_or_site(self):
        self._as(ADMIN)
        r = self.client.post("/documents/templates", json={"name": "X", "docType": "form", "category": "vehicle",
                                                             "audience": "everyone"})
        self.assertEqual(r.status_code, 400, r.text)
        r = self.client.post("/documents/templates", json={"name": "X", "docType": "form", "category": "vehicle",
                                                             "audience": "department"})
        self.assertEqual(r.status_code, 400, r.text)   # a department form needs a department
        r = self.client.post("/documents/templates", json={"name": "X", "docType": "form", "category": "vehicle",
                                                             "audience": "site"})
        self.assertEqual(r.status_code, 400, r.text)   # a site form needs a work site

    # ── Audience (Review Focus 3) ───────────────────────────────────────────

    def test_mine_and_fill_payload_follow_the_audience_rule(self):
        company = self._template("Vehicle Check")
        dept = self._template("Finance Close", audience="department", department="Finance", category="checklist")
        site = self._template("North Yard Walk", audience="site", workSiteId=SITE_A, category="safety",
                              showOnShifts=True)
        draft = self._template("Not Yet", status="draft")

        def mine(who):
            self._as(who)
            r = self.client.get("/forms/mine")
            self.assertEqual(r.status_code, 200, r.text)
            return {t["title"]: t for t in r.json()}

        self.assertEqual(set(mine(REP)), {"Vehicle Check", "North Yard Walk"})
        self.assertEqual(set(mine(STR_B)), {"Vehicle Check", "Finance Close"})
        self.assertEqual(set(mine(OTHER)), set())           # another company
        self.assertEqual(mine(REP)["North Yard Walk"]["workSiteId"], SITE_A)
        self.assertTrue(mine(REP)["North Yard Walk"]["showOnShifts"])
        self.assertNotIn("Not Yet", mine(ADMIN))             # a draft is nobody's to fill

        self._as(REP)
        r = self.client.get(f"/forms/{site['id']}")
        self.assertEqual(r.status_code, 200, r.text)
        payload = r.json()
        self.assertEqual(payload["title"], "North Yard Walk")
        self.assertEqual(payload["sections"], ["Vehicle", "Safety", "Tires", "Fuel", "Sign"])
        self.assertEqual([s["id"] for s in payload["workSites"]], [SITE_A, SITE_B])
        self.assertEqual(len(payload["fieldDefs"]), len(FIELDS))
        self.assertEqual(self.client.get(f"/forms/{dept['id']}").status_code, 404)
        self._as(STR_B)
        self.assertEqual(self.client.get(f"/forms/{site['id']}").status_code, 404)
        self._as(OTHER)
        self.assertEqual(self.client.get(f"/forms/{company['id']}").status_code, 404)
        self.assertEqual(self.client.get(f"/forms/{draft['id']}").status_code, 404)
        # Fill is refused the same way, and no row is written.
        self._submit(company["id"], OTHER, status=404)
        self._submit(site["id"], STR_B, status=404)
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.DocFormEntry).count(), 0)
        finally:
            db.close()

    # ── Submit rules (Review Focus 1, 2, 4) ─────────────────────────────────

    def test_hidden_showif_field_is_not_required_and_its_stale_value_is_dropped(self):
        tpl = self._template()
        e = self._submit(tpl["id"], REP, _answers(injury=False, injury_detail="stale text"))
        self.assertNotIn("injury_detail", e["answers"])
        self.assertIs(e["answers"]["injury"], False)
        # Shown, it is required.
        r_body = {"entryKey": str(uuid.uuid4()), "answers": _answers(injury=True), "source": "phone"}
        r = self.client.post(f"/forms/{tpl['id']}/entries", json=r_body)
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("injury_detail", [x["token"] for x in r.json()["detail"]["errors"]])
        e2 = self._submit(tpl["id"], REP, _answers(injury=True, injury_detail="Cut on the left hand"))
        self.assertEqual(e2["answers"]["injury_detail"], "Cut on the left hand")

    def test_required_repeat_group_refuses_zero_rows_and_stores_three_in_order(self):
        tpl = self._template()
        self._as(REP)
        r = self.client.post(f"/forms/{tpl['id']}/entries",
                             json={"entryKey": str(uuid.uuid4()), "answers": _answers(tires=[]), "source": "web"})
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("tires", [x["token"] for x in r.json()["detail"]["errors"]])
        e = self._submit(tpl["id"], REP, _answers(tires=[{"tire_psi": 30}, {"tire_psi": 31}, {"tire_psi": 32}]))
        self.assertEqual(e["answers"]["tires"], [{"tire_psi": 30}, {"tire_psi": 31}, {"tire_psi": 32}])
        # A row with the required field blank is refused too, and the cap holds.
        r = self.client.post(f"/forms/{tpl['id']}/entries",
                             json={"entryKey": str(uuid.uuid4()), "source": "web",
                                   "answers": _answers(tires=[{"tire_psi": 30}, {}])})
        self.assertEqual(r.status_code, 400, r.text)
        r = self.client.post(f"/forms/{tpl['id']}/entries",
                             json={"entryKey": str(uuid.uuid4()), "source": "web",
                                   "answers": _answers(tires=[{"tire_psi": 30}] * 5)})
        self.assertEqual(r.status_code, 400, r.text)

    def test_same_entry_key_returns_the_first_entry_never_a_second_row(self):
        tpl = self._template()
        self._as(REP)
        key = str(uuid.uuid4())
        first = self.client.post(f"/forms/{tpl['id']}/entries",
                                 json={"entryKey": key, "answers": _answers(), "source": "phone"})
        self.assertEqual(first.status_code, 200, first.text)
        again = self.client.post(f"/forms/{tpl['id']}/entries",
                                 json={"entryKey": key, "answers": _answers(odometer=9999), "source": "phone"})
        self.assertEqual(again.status_code, 200, again.text)
        self.assertEqual(again.json()["id"], first.json()["id"])
        self.assertEqual(again.json()["answers"]["odometer"], 1200)
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.DocFormEntry).filter(models.DocFormEntry.entry_key == key).count(), 1)
        finally:
            db.close()

    def test_submit_validates_formats_photos_and_runs_formulas(self):
        tpl = self._template()
        e = self._submit(tpl["id"], REP, _answers(
            photos=[STORAGE + "a.jpg", STORAGE + "b.jpg"], sig=STORAGE + "sig.png", rating=4,
            tag="QR-0042", location={"lat": 33.1, "lng": -117.1, "accuracyM": 8, "siteName": "North Yard"}),
            workSiteId=SITE_A)
        self.assertEqual(e["answers"]["total"], 12)
        self.assertEqual(e["answers"]["photos"], [STORAGE + "a.jpg", STORAGE + "b.jpg"])
        self.assertEqual(e["answers"]["location"]["lat"], 33.1)
        self.assertEqual(e["workSiteId"], SITE_A)
        self.assertEqual(e["workSiteName"], "North Yard")
        self.assertEqual(e["company"], CO_A)
        self.assertEqual(e["title"], "Vehicle Check")
        self.assertEqual(e["templateVersion"], tpl["publishedVersion"])
        self.assertEqual(e["status"], "submitted")
        self.assertEqual(e["source"], "phone")
        self.assertEqual(e["submittedBy"], REP)
        self.assertEqual(e["submittedByName"], "Rep Forms")
        self.assertFalse(e["canReview"])                    # your own is never yours to review
        self._as(REP)
        for bad in (_answers(photos=["https://evil.example/x.jpg"]),
                    _answers(sig="https://evil.example/sig.png"),
                    _answers(rating=7),
                    _answers(odometer="twelve"),
                    _answers(injury="maybe")):
            r = self.client.post(f"/forms/{tpl['id']}/entries",
                                 json={"entryKey": str(uuid.uuid4()), "answers": bad, "source": "web"})
            self.assertEqual(r.status_code, 400, (bad, r.text))
        # An unknown token is dropped, never stored.
        e3 = self._submit(tpl["id"], REP, _answers(not_a_field="x"))
        self.assertNotIn("not_a_field", e3["answers"])

    # ── Reach (Review Focus 5) ───────────────────────────────────────────────

    def test_manager_reach_reports_anywhere_and_team_sites_not_strangers_elsewhere(self):
        tpl = self._template()
        by_rep_b = self._submit(tpl["id"], REP, workSiteId=SITE_B)      # a report, at another site
        by_str_a = self._submit(tpl["id"], STR, workSiteId=SITE_A)      # a stranger, at the team's site
        by_str_b = self._submit(tpl["id"], STR_B, workSiteId=SITE_B)    # a stranger, at another site

        def seen(who, **params):
            self._as(who)
            r = self.client.get("/forms/entries", params=params)
            self.assertEqual(r.status_code, 200, r.text)
            return {e["id"] for e in r.json()["items"]}

        self.assertEqual(seen(MGR), {by_rep_b["id"], by_str_a["id"]})
        self.assertEqual(seen(REP), {by_rep_b["id"]})                 # your own only
        self.assertEqual(seen(STR_B), {by_str_b["id"]})
        self.assertEqual(seen(ADMIN), {by_rep_b["id"], by_str_a["id"], by_str_b["id"]})
        self.assertEqual(seen(HR_A), {by_rep_b["id"], by_str_a["id"], by_str_b["id"]})   # HR++ for co-a
        self.assertEqual(seen(OTHER), set())
        self.assertEqual(seen(MGR, site=SITE_B), {by_rep_b["id"]})
        self.assertEqual(seen(ADMIN, person=STR), {by_str_a["id"]})
        self.assertEqual(seen(ADMIN, status="reviewed"), set())
        self._as(MGR)
        self.assertEqual(self.client.get(f"/forms/entries/{by_str_a['id']}").status_code, 200)
        self.assertEqual(self.client.get(f"/forms/entries/{by_str_b['id']}").status_code, 404)
        self.assertTrue(self.client.get(f"/forms/entries/{by_str_a['id']}").json()["canReview"])

    # ── Review, links, PDF, CSV ─────────────────────────────────────────────

    def test_review_sets_the_state_and_bells_the_submitter_once(self):
        tpl = self._template()
        e = self._submit(tpl["id"], REP, workSiteId=SITE_A)
        self._as(STR)   # no reach
        self.assertEqual(self.client.post(f"/forms/entries/{e['id']}/review",
                                          json={"status": "reviewed", "note": ""}).status_code, 404)
        self._as(REP)   # your own
        self.assertEqual(self.client.post(f"/forms/entries/{e['id']}/review",
                                          json={"status": "reviewed", "note": ""}).status_code, 403)
        self._as(MGR)
        r = self.client.post(f"/forms/entries/{e['id']}/review", json={"status": "reviewed", "note": "Looks good"})
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual(out["status"], "reviewed")
        self.assertEqual(out["reviewerEmail"], MGR)
        self.assertEqual(out["reviewerName"], "Mgr Forms")   # the panel shows who, by name
        self.assertEqual(out["reviewNote"], "Looks good")
        self.assertTrue(out["reviewedAt"])
        r = self.client.post(f"/forms/entries/{e['id']}/review", json={"status": "follow_up", "note": "Check tire 2"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.client.post(f"/forms/entries/{e['id']}/review",
                                          json={"status": "bogus"}).status_code, 400)
        db = database.SessionLocal()
        try:
            bells = db.query(models.NexusNotification).filter(models.NexusNotification.recipient == REP).all()
            self.assertEqual(len(bells), 1)
            self.assertEqual(bells[0].title, "Vehicle Check Needs Follow-Up")
            self.assertIn("Check tire 2", bells[0].body)
            self.assertNotIn("—", bells[0].body)
            self.assertNotRegex(bells[0].body, r"\d{4}-\d{2}-\d{2}")   # never a raw ISO date
            action = json.loads(bells[0].action)
            self.assertEqual(action["entryId"], e["id"])
            # The sub opens that entry, not just the Forms tab.
            self.assertEqual((action["view"], action["sub"]), ("documents", f"documents-forms:entry:{e['id']}"))
        finally:
            db.close()

    def test_times_read_in_the_readers_zone(self):
        """The bell in the recipient's zone, the PDF in the submitter's (with
        its short name), the CSV in the exporter's - an India crew member
        reads India time, never UTC."""
        import form_entry_pdf
        # 08:44 UTC on 11/02/2026 is 2:14 PM in India and 12:44 AM in California (PST).
        self.assertEqual(form_entry_pdf.us_datetime("2026-11-02T08:44:00Z", "Asia/Kolkata"), "11/02/2026 2:14 PM")
        self.assertEqual(form_entry_pdf.us_datetime("2026-11-02T08:44:00", "Asia/Kolkata", named=True),
                         "11/02/2026 2:14 PM IST")
        self.assertEqual(form_entry_pdf.us_datetime("2026-11-02T08:44:00Z", "America/Los_Angeles", named=True),
                         "11/02/2026 12:44 AM PT")
        self.assertEqual(form_entry_pdf.us_datetime("2026-11-02T08:44:00Z"), "11/02/2026 8:44 AM")
        self.assertEqual(form_entry_pdf.us_datetime("2026-11-02T08:44:00Z", "Not/AZone"), "11/02/2026 8:44 AM")

        tpl = self._template()
        e = self._submit(tpl["id"], REP)
        db = database.SessionLocal()
        try:
            # REP works an India shift preset; MGR has none (the company default, Pacific).
            db.add(models.Shift(id="forms-ist", name="India Day", timezone="Asia/Kolkata"))
            db.add(models.ShiftAssignment(id="forms-ist-rep", employee_email=REP, shift_id="forms-ist"))
            row = db.query(models.DocFormEntry).filter(models.DocFormEntry.id == e["id"]).first()
            row.submitted_at = "2026-11-02T08:44:00"
            db.commit()
        finally:
            db.close()
        try:
            self._as(MGR)
            self.assertEqual(self.client.post(f"/forms/entries/{e['id']}/review",
                                              json={"status": "reviewed"}).status_code, 200)
            db = database.SessionLocal()
            try:
                bell = db.query(models.NexusNotification).filter(models.NexusNotification.recipient == REP).one()
                self.assertIn("from 11/02/2026 2:14 PM as Reviewed", bell.body)
                row = db.query(models.DocFormEntry).filter(models.DocFormEntry.id == e["id"]).first()
                tpl_row = db.query(models.DocTemplate).filter(models.DocTemplate.id == tpl["id"]).first()
                text = json.dumps(form_entry_pdf.build_blocks(db, row, tpl_row, tpl_row.field_defs or []))
                self.assertIn("on 11/02/2026 2:14 PM IST", text)
            finally:
                db.close()
            rows = list(csv.reader(io.StringIO(self.client.get(f"/forms/templates/{tpl['id']}/export.csv").text)))
            header = rows[0]
            self.assertEqual(rows[1][header.index("submittedAt")], "11/02/2026 12:44 AM")
        finally:
            db = database.SessionLocal()
            try:
                db.query(models.ShiftAssignment).filter(models.ShiftAssignment.id == "forms-ist-rep").delete()
                db.query(models.Shift).filter(models.Shift.id == "forms-ist").delete()
                db.commit()
            finally:
                db.close()

    def test_a_form_with_entries_cannot_be_deleted_only_archived(self):
        tpl = self._template()
        empty = self._template(name="Unused Check")
        self._submit(tpl["id"], REP)
        self._as(ADMIN)
        r = self.client.delete(f"/documents/templates/{tpl['id']}")
        self.assertEqual(r.status_code, 409, r.text)
        self.assertEqual(r.json()["detail"], "This form has entries - archive it instead")
        self.assertEqual(self.client.delete(f"/documents/templates/{empty['id']}").status_code, 200)

    def test_a_repeat_group_is_named_by_the_one_rule(self):
        """The screens' groupLabel (forms/formsModel.js): the first member's
        section, else the group key humanized."""
        import form_entry_pdf
        self.assertEqual(form_entry_pdf.group_label("tires", [{"token": "psi", "section": "Tire Checks"}]), "Tire Checks")
        self.assertEqual(form_entry_pdf.group_label("tires", [{"token": "psi"}]), "Tires")
        self.assertEqual(form_entry_pdf.group_label("tire_rows", []), "Tire Rows")

    def test_links_are_stored_on_the_entry(self):
        tpl = self._template()
        e = self._submit(tpl["id"], REP)
        self._as(MGR)
        r = self.client.post(f"/forms/entries/{e['id']}/link", json={"ticketId": "tk-1"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["linkedTicketId"], "tk-1")
        r = self.client.post(f"/forms/entries/{e['id']}/link", json={"taskId": "task-9", "assetId": "asset-3"})
        self.assertEqual(r.json()["linkedTaskId"], "task-9")
        self.assertEqual(r.json()["linkedAssetId"], "asset-3")
        self.assertEqual(r.json()["linkedTicketId"], "tk-1")
        self._as(STR_B)
        self.assertEqual(self.client.post(f"/forms/entries/{e['id']}/link", json={"ticketId": "x"}).status_code, 404)

    def test_pdf_and_csv(self):
        tpl = self._template()
        e = self._submit(tpl["id"], REP, _answers(photos=[STORAGE + "a.jpg", STORAGE + "b.jpg"], rating=5,
                                                  location={"lat": 33.1, "lng": -117.1}), workSiteId=SITE_A)
        self._submit(tpl["id"], STR, _answers(injury=True, injury_detail="Scraped knee"), workSiteId=SITE_A)
        self._as(MGR)
        r = self.client.get(f"/forms/entries/{e['id']}/pdf")
        self.assertEqual(r.status_code, 200, r.text[:200])
        self.assertTrue(r.content.startswith(b"%PDF"))
        self.assertIn("application/pdf", r.headers["content-type"])
        self._as(STR_B)
        self.assertEqual(self.client.get(f"/forms/entries/{e['id']}/pdf").status_code, 404)

        self._as(MGR)
        r = self.client.get(f"/forms/templates/{tpl['id']}/export.csv")
        self.assertEqual(r.status_code, 200, r.text[:200])
        self.assertIn("text/csv", r.headers["content-type"])
        rows = list(csv.reader(io.StringIO(r.text)))
        header = rows[0]
        for token in ("odometer", "photos", "injury", "injury_detail", "tire_psi", "qty", "price", "total",
                      "location", "rating", "tag", "sig"):
            self.assertIn(token, header, header)
        self.assertEqual(len(rows), 3)                       # header + the two entries MGR may see
        by_person = {row[header.index("submittedBy")]: row for row in rows[1:]}
        rep = by_person[REP]
        self.assertEqual(rep[header.index("photos")], f"{STORAGE}a.jpg {STORAGE}b.jpg")
        self.assertEqual(rep[header.index("tire_psi")], "32 | 34 | 35")
        self.assertEqual(rep[header.index("total")], "12")
        self.assertEqual(rep[header.index("injury")], "No")
        self.assertEqual(rep[header.index("workSiteName")], "North Yard")
        self.assertRegex(rep[header.index("submittedAt")], r"^\d{2}/\d{2}/\d{4} \d{1,2}:\d{2} [AP]M$")
        self.assertEqual(by_person[STR][header.index("injury_detail")], "Scraped knee")
        # The CSV only carries what the caller may see.
        self._as(REP)
        rows = list(csv.reader(io.StringIO(self.client.get(f"/forms/templates/{tpl['id']}/export.csv").text)))
        self.assertEqual(len(rows), 2)


if __name__ == "__main__":
    unittest.main()
