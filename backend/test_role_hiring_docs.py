"""A role's own hiring paperwork (Neil, Oct 22 2026).

"The role gets filled into the hiring packet, not the hiring packet gets put
into the role... the only thing that changes is a different confidentiality
agreement based on different roles, a different job description based on
roles." One packet per place serves every role; the role brings its duties
text and its own documents, each added to the packet or replacing one of its
documents.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_role_hiring_docs.py -q
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import hr_life_events as hle  # noqa: E402
import hr_packet_docs as hpd  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)
ADMIN = "admin.roledocs.test@greensglobal.com"


class RoleDocsTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        os.environ["NEXUS_DEV_EMAIL"] = ADMIN
        db = database.SessionLocal()
        for m in (models.NexusGroup, models.NexusRole, models.DocTemplate):
            db.query(m).delete()
        db.add(models.NexusRole(email=ADMIN, role="owner"))
        for tid, name in (("t-agreement", "Employment Agreement"), ("t-nda", "Standard Confidentiality Agreement"),
                          ("t-nda-con", "Confidentiality Agreement - Construction"), ("t-safety", "Site Safety Acknowledgement")):
            db.add(models.DocTemplate(id=tid, name=name, category="hr", status="active", content={}))
        db.add(models.NexusGroup(id="jr-con", name="Construction Associate", is_job_role=1, tier="employee",
                                 description="Builds things.", job_description="Frames walls; reads plans; keeps the site safe.",
                                 hiring_docs=[{"templateId": "t-nda-con", "replaces": "t-nda"},
                                              {"templateId": "t-safety", "replaces": ""}]))
        db.add(models.NexusGroup(id="jr-acct", name="Accounting Associate", is_job_role=1, tier="employee",
                                 description="Keeps the books."))
        db.commit()
        db.close()
        self.db = database.SessionLocal()
        self.packet = models.HrPacketSetting(id="p", event="hire", doc_template_ids=["t-agreement", "t-nda"])

    def tearDown(self):
        self.db.close()
        auth.SKIP_AUTH = self._skip

    def test_the_role_fills_itself_into_the_place_packet(self):
        con = hle.role_paperwork(self.db.get(models.NexusGroup, "jr-con"))
        ids = hpd.template_ids_for(self.packet, {"role_docs": con["role_docs"]}, "hire")
        # Its confidentiality agreement takes the standard one's place; its safety form is added after.
        self.assertEqual(ids, ["t-agreement", "t-nda-con", "t-safety"])
        acct = hle.role_paperwork(self.db.get(models.NexusGroup, "jr-acct"))
        self.assertEqual(hpd.template_ids_for(self.packet, {"role_docs": acct["role_docs"]}, "hire"), ["t-agreement", "t-nda"])
        # The offer letter is only "do you accept?" - no role documents on it.
        self.assertEqual(hpd.template_ids_for(self.packet, {"role_docs": con["role_docs"]}, "offer"), ["t-agreement", "t-nda"])

    def test_the_duties_print_as_role_description(self):
        con = hle.role_paperwork(self.db.get(models.NexusGroup, "jr-con"))
        self.assertEqual(con["role_description"], "Frames walls; reads plans; keeps the site safe.")
        acct = hle.role_paperwork(self.db.get(models.NexusGroup, "jr-acct"))
        self.assertEqual(acct["role_description"], "")             # the plain description is never printed as duties
        import hiring_setup
        self.db.query(models.NexusSetting).filter_by(key=hiring_setup.COPIED_KEY).delete()
        self.db.commit()
        self.assertEqual(hiring_setup.copy_duties_once(self.db), 1)      # ...it is kept as the duties once
        self.db.expire_all()
        acct = hle.role_paperwork(self.db.get(models.NexusGroup, "jr-acct"))
        self.assertEqual(acct["role_description"], "Keeps the books.")
        vals = hpd.event_values(self.db, "hire", {"job_title": "Construction Associate", **con})
        self.assertEqual(vals["role_description"], "Frames walls; reads plans; keeps the site safe.")
        from services.merge_fields import BUILTIN_VARIABLES
        self.assertIn("role_description", {t for t, *_ in BUILTIN_VARIABLES})

    def test_saving_a_roles_documents_checks_them(self):
        r = self.client.put("/jobroles/jr-acct", json={"job_description": "  Posts journal entries.  ",
                                                       "hiring_docs": [{"templateId": "t-nda-con", "replaces": "t-nda"},
                                                                       {"templateId": "t-nda-con", "replaces": ""},
                                                                       {"templateId": "t-safety", "replaces": "t-safety"}]})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["job_description"], "Posts journal entries.")
        self.assertEqual([(d["templateId"], d["replaces"]) for d in body["hiring_docs"]],
                         [("t-nda-con", "t-nda"), ("t-safety", "")])     # no duplicate, no self-replace
        self.assertEqual(body["hiring_docs"][0]["replacesName"], "Standard Confidentiality Agreement")
        r = self.client.put("/jobroles/jr-acct", json={"hiring_docs": [{"templateId": "gone", "replaces": ""}]})
        self.assertEqual(r.status_code, 400)


if __name__ == "__main__":
    unittest.main()
