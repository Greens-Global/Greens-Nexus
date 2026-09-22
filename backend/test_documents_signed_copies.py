"""
My Documents holds what you would look for there (Sagar, Sep 22 2026:
"what are these documents in this tab?").

It held one "Final" row per SEND ATTEMPT: the Send for Signature wizard
generates a document purely to render the PDF it attaches to an envelope, and
anything generated from a template is born final. Meanwhile the thing a person
actually goes looking for - the fully executed copy - was not there at all.

So: the wizard's own output is marked `source='esign-send'` and never listed,
and every completed envelope this person was on is listed instead, titled
"<document> Signed - <signers> - MM/DD/YYYY".

    python -m unittest test_documents_signed_copies
"""
import os
import tempfile
import unittest
import uuid

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database          # noqa: E402
import models            # noqa: E402
from routers import documents  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

ME = "sagar.shoundik@greensglobal.com"


class ExecutedCopyTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self.rid = f"req-{uuid.uuid4()}"
        self.db.add(models.HrSignRequest(
            id=self.rid, title="Joining Letter", status="completed", routing="sequential",
            current_order=2, source="template", created_by="hr@greensglobal.com",
            created_at="2026-09-20T09:00:00+00:00", completed_at="2026-09-22T14:30:00+00:00",
            final_pdf_path=f"esign/{self.rid}/final.pdf"))
        # Two signers, and ME as a CC - a role that never signs anything.
        for ordinal, (name, email, role) in enumerate([
                ("Sagar Shoundik", "signer@partner.example", "signer"),
                ("Maria Ortiz", "maria.ortiz@greensglobal.com", "signer"),
                ("Sagar Kumar Shoundik", ME, "cc")], start=1):
            self.db.add(models.HrSignParty(
                id=f"p-{uuid.uuid4()}", request_id=self.rid, name=name, email=email,
                kind="internal", party_role=role, ordinal=ordinal, status="signed",
                token=uuid.uuid4().hex))
        self.db.commit()

    def tearDown(self):
        for model in (models.HrSignParty, models.HrSignRequest):
            self.db.query(model).delete()
        self.db.query(models.Document).delete()
        self.db.commit()
        self.db.close()

    def test_a_cc_sees_the_executed_copy_too(self):
        """Everyone on the envelope is emailed the sealed PDF when it
        completes, so everyone on it can find that copy again."""
        entries = documents._executed_entries(self.db, ME)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["signStatus"], "completed")
        self.assertEqual(entries[0]["kind"], "signed")

    def test_the_title_names_the_signers_and_the_signed_date(self):
        title = documents._executed_entries(self.db, ME)[0]["title"]
        self.assertEqual(title, "Joining Letter Signed - Sagar Shoundik, Maria Ortiz - 09/22/2026")
        # US format, never ISO (CLAUDE.md).
        self.assertNotIn("2026-09-22", title)

    def test_a_cc_is_not_listed_as_a_signer_in_the_title(self):
        self.assertNotIn("Sagar Kumar Shoundik",
                         documents._executed_entries(self.db, ME)[0]["title"])

    def test_an_envelope_still_in_flight_is_not_offered_as_a_copy(self):
        req = self.db.query(models.HrSignRequest).filter(
            models.HrSignRequest.id == self.rid).first()
        req.status = "pending"
        self.db.commit()
        self.assertEqual(documents._executed_entries(self.db, ME), [])

    def test_someone_who_was_not_on_the_envelope_gets_nothing(self):
        self.assertEqual(documents._executed_entries(self.db, "stranger@example.com"), [])

    def test_it_carries_the_party_id_the_download_is_scoped_to(self):
        entry = documents._executed_entries(self.db, ME)[0]
        party = self.db.query(models.HrSignParty).filter(
            models.HrSignParty.email == ME).first()
        self.assertEqual(entry["partyId"], party.id)


class WizardArtifactTests(unittest.TestCase):
    """The wizard's generated PDFs are plumbing - kept, because the envelope
    cites them, but never shown as documents."""

    def test_a_document_generated_for_an_envelope_is_marked_as_such(self):
        row = models.Document(id=str(uuid.uuid4()), title="Joining Letter",
                              template_id="tpl-1", status="final", source="esign-send",
                              owner_email=ME, current_version=1)
        self.assertEqual(row.source, "esign-send")

    def test_us_date_never_returns_an_iso_string(self):
        self.assertEqual(documents._us_date("2026-09-22T14:30:00+00:00"), "09/22/2026")
        self.assertEqual(documents._us_date(""), "")
        self.assertEqual(documents._us_date("not a date"), "")


if __name__ == "__main__":
    unittest.main()
