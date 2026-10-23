"""HR packets: the Ready To Send checklist (Oct 14).

Every check a packet needs before a hire can go out - templates published,
the company holds the roles that sign and verify, the verifier can see pay,
the company has signed once, the pay prints somewhere, every variable has a
source - each with the fix the screen offers. Builds on the review tests'
fixture (one temporary database for this run).

    python -m pytest test_hr_packet_ready.py
"""
import unittest

import database
import hr_packet_docs as hpd
import models
from test_hr_packet_review import CO, PLAIN, ReviewCase, _doc, _p, _sig


def _ready(client, sid="s-hire"):
    r = client.get(f"/hr/packets/{sid}/readiness")
    assert r.status_code == 200, r.text
    return {c["key"]: c for c in r.json()["readiness"]}


def _publish(db, tid, content, version=2):
    t = db.query(models.DocTemplate).filter_by(id=tid).first()
    t.content, t.version, t.published_version = content, version, version
    db.add(models.DocTemplateVersion(id=f"v-{tid}-{version}", template_id=tid, version_no=version, content=content))


class ReadyTests(ReviewCase):
    def _edit(self, fn):
        db = database.SessionLocal()
        fn(db)
        db.commit()
        db.close()

    def test_a_complete_packet_is_ready(self):
        checks = _ready(self.client)
        self.assertTrue(all(c["ok"] for c in checks.values()), [c for c in checks.values() if not c["ok"]])
        self.assertEqual(set(checks), {"documents", "signing", "role:hr", "payAccess", "payPrints", "variables", "blanks"})
        self.assertEqual(checks["role:hr"]["detail"], "Charmi Shah")
        # and the packet list carries it
        hire = next(s for s in self.client.get("/hr/packets").json()["settings"] if s["id"] == "s-hire")
        self.assertEqual(len(hire["readiness"]), 7)

    def test_a_company_with_no_hr_contact_is_flagged_with_its_fix(self):
        self._edit(lambda db: db.query(models.HrEntity).filter_by(id=CO).update({"hr_contact_email": ""}))
        c = _ready(self.client)["role:hr"]
        self.assertFalse(c["ok"])
        self.assertIn("Nobody holds HR Contact", c["detail"])
        self.assertEqual(c["fix"], {"kind": "entityField", "field": "hr_contact_email", "entityId": CO, "role": "hr"})
        # setting it (as the Companies screen does) clears it
        r = self.client.patch(f"/hr/entities/{CO}", json={"hr_contact_email": "charmi.hr@greensglobal.com"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(_ready(self.client)["role:hr"]["ok"])

    def test_a_verifier_without_pay_access_is_flagged(self):
        self._edit(lambda db: db.query(models.HrEntity).filter_by(id=CO).update({"hr_contact_email": PLAIN}))
        c = _ready(self.client)["payAccess"]
        self.assertFalse(c["ok"])
        self.assertIn("Pay & Benefits", c["detail"])

    def test_pay_that_prints_nowhere_is_a_warning(self):
        self._edit(lambda db: _publish(db, "t-offer", _doc(_p("Dear ", "{{first_name}}", "."), _sig("company"), _sig("employee"))))
        c = _ready(self.client)["payPrints"]
        self.assertEqual((c["ok"], c["severity"]), (False, "warn"))
        self.assertEqual(c["fix"], {"kind": "template", "templateId": "t-offer"})

    def test_fill_in_blanks_nothing_fills_are_a_warning_naming_the_document(self):
        # Neil, 10/22 56:42: page 3 showed blanks "that should be stuff you fill in".
        self._edit(lambda db: _publish(db, "t-nda", _doc(_p("Emergency Contact:"), _p("Bank: ______ branch [    ]"),
                                                         _p("Notary Seal: ________"), _sig("employee"))))
        c = _ready(self.client)["blanks"]
        self.assertEqual((c["ok"], c["severity"]), (False, "warn"))
        self.assertIn('"NDA" has 3 fill-in blanks nothing fills (Emergency Contact, Bank:, Bank: branch)', c["detail"])
        self.assertEqual(c["fix"], {"kind": "template", "templateId": "t-nda"})

    def test_variables_nothing_fills_are_listed_until_the_form_asks_for_them(self):
        self._edit(lambda db: _publish(db, "t-nda", _doc(_p("PAN ", "{{pan_number}}", " bank ", "{{bank_name}}"), _sig("employee"))))
        c = _ready(self.client)["variables"]
        self.assertFalse(c["ok"])
        self.assertEqual(c["fix"]["kind"], "addToForm")
        self.assertEqual([v["token"] for v in c["fix"]["variables"]], ["bank_name", "pan_number"])

        def form(db):
            s = db.query(models.HrPacketSetting).filter_by(id="s-hire").first()
            s.details_form = hpd.clean_form([{"label": "PAN Number", "type": "text"}, {"label": "Bank Name", "type": "text"}])
        self._edit(form)
        self.assertTrue(_ready(self.client)["variables"]["ok"])

    def test_an_unpublished_template_points_at_itself(self):
        def unpublish(db):
            db.query(models.DocTemplate).filter_by(id="t-nda").update({"published_version": 0})
        self._edit(unpublish)
        c = _ready(self.client)["documents"]
        self.assertFalse(c["ok"])
        self.assertEqual(c["fix"], {"kind": "template", "templateId": "t-nda"})

    def test_signs_once_not_signed_yet(self):
        def once(db):
            s = db.query(models.HrPacketSetting).filter_by(id="s-hire").first()
            s.flow = [{"key": "company", "role": "hr", "action": "sign", "once": True},
                      {"key": "employee", "role": "employee", "action": "sign"}]
        self._edit(once)
        c = _ready(self.client)["once:company"]
        self.assertFalse(c["ok"])
        self.assertEqual(c["fix"]["kind"], "signOnce")

    def test_a_company_address_the_documents_print_must_exist(self):
        self._edit(lambda db: _publish(db, "t-nda", _doc(_p("At ", "{{company_address}}"), _sig("employee"))))
        c = _ready(self.client)["company:company_address"]
        self.assertFalse(c["ok"])
        self._edit(lambda db: db.query(models.HrEntity).filter_by(id=CO).update({"physical_address": "1 Main St"}))
        self.assertTrue(_ready(self.client)["company:company_address"]["ok"])


if __name__ == "__main__":
    unittest.main()
