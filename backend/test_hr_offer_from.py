"""Offer Comes From (Neil, Oct 22): "defaults to the head of HR, but there is
an option to select the department supervisor". The pick decides the name the
offer letter closes with ({{signatory}}) and who the offer email is from.

    python -m pytest test_hr_offer_from.py
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database  # noqa: E402
import models  # noqa: E402
import hr_life_events as hle  # noqa: E402
import hr_life_email  # noqa: E402
import hr_packet_docs as hpd  # noqa: E402

CO = "co-from"
HR_HEAD, CONTACT, ACCT_HEAD, GONE = "hana@x.com", "carl@x.com", "ada@x.com", "gone@x.com"


class OfferFromTests(unittest.TestCase):
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
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.HrEntity, models.HrDepartment, models.NexusEmployee, models.HrCandidate, models.HrLifeEvent):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=CO, name="From Co", hr_contact_email=CONTACT))
        for i, (email, first, title, status) in enumerate((
                (HR_HEAD, "Hana", "Head of HR", "active"), (CONTACT, "Carl", "", "active"),
                (ACCT_HEAD, "Ada", "Controller", "active"), (GONE, "Gus", "", "terminated"))):
            self.db.add(models.NexusEmployee(id=f"e{i}", work_email=email, first_name=first, last_name="Lee",
                                             job_title=title, company=CO, status=status))
        self.db.add(models.HrDepartment(id="d-hr", company_id=CO, name="Human Resources", lead_email=HR_HEAD))
        self.db.add(models.HrDepartment(id="d-acct", company_id=CO, name="Accounting", lead_email=ACCT_HEAD))
        self.db.add(models.HrDepartment(id="d-it", company_id=CO, name="IT", lead_email=GONE))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_head_of_hr_then_the_hr_contact_and_the_department_head_by_any_case(self):
        self.assertEqual(hle.offer_from_people(self.db, CO, " accounting "),
                         {"hr": HR_HEAD, "department_head": ACCT_HEAD})
        self.db.query(models.HrDepartment).filter_by(id="d-hr").delete()
        self.db.commit()
        self.assertEqual(hle.offer_from_people(self.db, CO, "IT"), {"hr": CONTACT, "department_head": ""})  # left
        self.assertEqual(hle.offer_from_people(self.db, CO, "")["department_head"], "")

    def _cand(self, department="Accounting"):
        c = models.HrCandidate(id="c1", first_name="Jane", last_name="Doe", email="jane@gmail.com", company=CO,
                               role_title="Analyst", department=department, stage="decision")
        self.db.add(c)
        self.db.commit()
        return c

    def _details(self, cand, **kw):
        return hle.offer_details(self.db, cand, {"worker_type": "employee", "start_date": "2030-11-02",
                                                 "offer_expires": "2030-10-28", **kw})

    def test_the_offer_keeps_who_it_comes_from_head_of_hr_by_default(self):
        cand = self._cand()
        d = self._details(cand)
        self.assertEqual((d["offer_from"], d["offer_from_email"]), ("hr", HR_HEAD))
        d = self._details(cand, offer_from="department_head")
        self.assertEqual((d["offer_from"], d["offer_from_email"]), ("department_head", ACCT_HEAD))

    def test_department_head_with_no_head_is_refused(self):
        with self.assertRaises(hle.PacketError) as e:
            self._details(self._cand("IT"), offer_from="department_head")
        self.assertIn("The IT department has no head", str(e.exception))

    def test_the_letter_closes_with_their_name_and_title_offer_only(self):
        d = {"job_title": "Analyst", "offer_from_email": ACCT_HEAD}
        self.assertEqual(hpd.event_values(self.db, "offer", d)["signatory"], "Ada Lee, Controller")
        self.assertEqual(hpd.event_values(self.db, "offer", {**d, "offer_from_email": CONTACT})["signatory"], "Carl Lee")
        self.assertNotIn("signatory", hpd.event_values(self.db, "hire", d))       # the packet is not the offer
        self.assertNotIn("signatory", hpd.event_values(self.db, "offer", {"job_title": "Analyst"}))   # as before

    def test_the_offer_email_is_from_them(self):
        self.db.add(models.HrLifeEvent(id="ev1", kind="offer", entity_id=CO, inputs={"offer_from_email": ACCT_HEAD}))
        self.db.add(models.HrLifeEvent(id="ev2", kind="offer", entity_id=CO, inputs={}))
        self.db.commit()
        req = models.HrSignRequest(id="r1", link_kind="life_event", link_id="ev1", entity_id=CO, created_by=CONTACT)
        s = hr_life_email.offer_sender(self.db, req)
        self.assertEqual((s["name"], s["email"], s["title"]), ("Ada Lee", ACCT_HEAD, "Controller"))
        req.link_id = "ev2"
        self.assertIsNone(hr_life_email.offer_sender(self.db, req))         # nobody picked: the envelope's sender


if __name__ == "__main__":
    unittest.main()
