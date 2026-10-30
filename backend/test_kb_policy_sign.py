"""Knowledge Base policies signed through Nexus Sign (Release 3, Oct 29 2026):
kb_policy_sign.py with the REAL Nexus Sign engine (consent, one-time code,
sealing) on a throwaway database.

  * the daily run sends ONE envelope per person per version, the person its
    only signer, and a second run sends nothing more;
  * signing writes a KbSignature (method nexus_sign) with the version and the
    exact text of that version;
  * a decline shows on the page, in Compliance and on the signature list, rings
    the page owner, is never re-sent by the daily run, and Resend sends a new one;
  * a new major version voids the open envelopes; the next run asks again.

ONE FILE PER PROCESS."""
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
import database  # noqa: E402
import kb_blocks  # noqa: E402
import kb_core  # noqa: E402
import kb_policy_sign as kps  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import esign  # noqa: E402

CO = "co-kbps"
OWNER, ANN, BEN = "owner.kbps@greensglobal.com", "ann.kbps@greensglobal.com", "ben.kbps@greensglobal.com"
DOC = "kb_policy_kbps"


def _blocks(text):
    return kb_blocks.doc([kb_blocks.heading("Rules"), kb_blocks.paragraph(text)])


class PolicySignCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.assertTrue(kb_core.NEXUS_SIGN_FOR_POLICIES)
        auth._role_cache.clear()
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        db = self.db = database.SessionLocal()
        for m in (models.HrSignParty, models.HrSignRequest, models.HrSignConsent, models.HrSignDocument, models.HrSignSeal,
                  models.HrSignOtpChallenge, models.HrSignEvent, models.KbSignature, models.KbEvent, models.KbPageVersion,
                  models.KbDocument, models.NexusEmployee, models.NexusRole, models.HrEntity, models.NexusNotification):
            db.query(m).delete()
        db.add(models.HrEntity(id=CO, name="Policy Co"))
        for email, first, role in ((OWNER, "Olga", "manager"), (ANN, "Ann", "employee"), (BEN, "Ben", "employee")):
            db.add(models.NexusEmployee(id=f"e-{first}", work_email=email, first_name=first, last_name="Test", company=CO,
                                        status="active", deleted_at="", department="Operations"))
            db.add(models.NexusRole(email=email, role=role, display_name=f"{first} Test"))
        text = "Wear a hard hat on every site."
        db.add(models.KbDocument(id=DOC, title="Site Safety Policy", page_type="policy", status="approved", require_ack=True,
                                 signing="nexus_sign", version="1.0", major=1, minor=0, owner_email=OWNER, doc_code="POL-001",
                                 blocks=kb_blocks.dumps(_blocks(text)), content_text=text, published_at="2026-10-01T00:00:00+00:00",
                                 audience="", migrated_at="2026-10-01"))
        db.add(models.KbPageVersion(id="ver-kbps-1", doc_id=DOC, major=1, minor=0, version="1.0", title="Site Safety Policy",
                                    blocks=kb_blocks.dumps(_blocks(text))))
        db.commit()
        esign._ensure_document_classes(db)
        self.codes = {}
        self._patched = [(esign.sign_otp, "_send_email", esign.sign_otp._send_email),
                         (esign, "_send_sign_email", esign._send_sign_email),
                         (esign, "_send_sealed_email", esign._send_sealed_email),
                         (esign, "_egnyte_push", esign._egnyte_push)]
        esign.sign_otp._send_email = lambda to, code, title, sender: self.codes.__setitem__(to, code) or ""
        esign._send_sign_email = lambda *a, **k: (True, "")
        esign._send_sealed_email = lambda *a, **k: (True, "")
        esign._egnyte_push = lambda *a, **k: (False, "")

    def tearDown(self):
        for obj, name, real in self._patched:
            setattr(obj, name, real)
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)
        self.db.close()

    # ── helpers ──────────────────────────────────────────────────────────────
    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache()

    def _doc(self):
        self.db.expire_all()
        return self.db.query(models.KbDocument).filter(models.KbDocument.id == DOC).first()

    def _party(self, email):
        req = kps.current(self.db, self._doc(), email)
        return self.db.query(models.HrSignParty).filter(models.HrSignParty.request_id == req.id).first()

    def _open(self, party):
        c = self.client
        self.assertEqual(c.post(f"/esign/public/{party.token}/consent", json={"agreed": True}).status_code, 200)

    def _sign(self, email):
        party = self._party(email)
        self._open(party)
        c = self.client
        self.assertEqual(c.post(f"/esign/public/{party.token}/otp/request", json={"channel": "email"}).status_code, 200)
        r = c.post(f"/esign/public/{party.token}/otp/verify", json={"code": self.codes[party.email]})
        self.assertEqual(r.status_code, 200, r.text)
        r = c.post(f"/esign/public/{party.token}/sign", json={
            "consent": True, "signature_kind": "typed", "signature_data": party.name,
            "format_demonstrated": "pdf_rendered_in_session", "pages_viewed": 1, "pages_total": 1})
        self.assertEqual(r.status_code, 200, r.text)

    def _decline(self, email, reason):
        party = self._party(email)
        self._open(party)
        r = self.client.post(f"/esign/public/{party.token}/decline", json={"reason": reason})
        self.assertEqual(r.status_code, 200, r.text)

    # ── the tests ────────────────────────────────────────────────────────────
    def test_one_envelope_per_person_and_never_twice(self):
        self.assertEqual(kps.run(self.db), 3)                     # Olga, Ann, Ben: the whole audience
        self.assertEqual(kps.run(self.db), 0)
        reqs = self.db.query(models.HrSignRequest).filter(models.HrSignRequest.link_kind == "kb_policy").all()
        self.assertEqual(sorted(r.link_id for r in reqs), sorted(f"{DOC}:1.0:{e}" for e in (OWNER, ANN, BEN)))
        for r in reqs:
            parties = self.db.query(models.HrSignParty).filter(models.HrSignParty.request_id == r.id).all()
            self.assertEqual([p.email for p in parties], [kps._parse(r.link_id)[2]])   # the person is the only signer
        self._as(ANN)
        so = self.client.get(f"/kb/pages/{DOC}").json()["signoff"]
        self.assertEqual(so["nexus_sign"]["status"], "pending")
        self.assertIn("/workday/sign:", so["nexus_sign"]["sign_url"])

    def test_signing_records_the_version_and_its_text(self):
        kps.run(self.db)
        self._sign(ANN)
        sig = self.db.query(models.KbSignature).filter(models.KbSignature.user_email == ANN).one()
        self.assertEqual((sig.method, sig.version, sig.major), ("nexus_sign", "1.0", 1))
        self.assertIn("hard hat", sig.content_text)
        self.assertEqual(sig.content_hash, kb_core.content_hash(sig.content_text))
        self._as(ANN)
        so = self.client.get(f"/kb/pages/{DOC}").json()["signoff"]
        self.assertTrue(so["signed"])
        self.assertEqual(kps.run(self.db), 0)                     # nothing more for Ann

    def test_a_decline_shows_waits_and_can_be_resent(self):
        kps.run(self.db)
        self._decline(BEN, "I need the site list first")
        self.assertEqual(kps.state_for(self.db, self._doc(), BEN)["status"], "declined")
        bell = self.db.query(models.NexusNotification).filter(models.NexusNotification.recipient == OWNER,
                                                              models.NexusNotification.type == "kb_sign_declined").all()
        self.assertEqual(len(bell), 1)
        self.assertEqual(kps.run(self.db), 0)                     # never re-sent by itself
        self._as(OWNER)
        sigs = self.client.get(f"/kb/pages/{DOC}/signatures").json()
        self.assertEqual(sigs["signing"], "nexus_sign")
        ben = next(u for u in sigs["unsigned"] if u["email"] == BEN)
        self.assertEqual((ben["envelope"], ben["declined_reason"]), ("declined", "I need the site list first"))
        grid = self.client.get("/kb/compliance", params={"scope": "company"}).json()
        cell = next(p for p in grid["people"] if p["email"] == BEN)["cells"][f"policy:{DOC}"]
        self.assertEqual((cell["status"], cell["color"], cell["method"]), ("Declined", "red", "nexus_sign"))
        r = self.client.post(f"/kb/pages/{DOC}/nudge", json={"emails": [BEN]})
        self.assertEqual(r.json(), {"nudged": 1, "resent": True})
        self.assertEqual(kps.state_for(self.db, self._doc(), BEN)["status"], "pending")
        self.assertEqual(self.client.post(f"/kb/pages/{DOC}/nudge", json={"emails": ["someone.else@example.com"]}).json()["nudged"], 0)

    def test_a_new_major_version_voids_and_asks_again(self):
        kps.run(self.db)
        self._sign(ANN)
        d = self._doc()
        d.version, d.major, d.minor = "2.0", 2, 0
        self.db.commit()
        self.assertEqual(kps.run(self.db), 3)                     # Ann signed 1.0 only: everyone is asked for 2.0
        old = [r for r in kps.envelopes(self.db, self._doc()) if kps._parse(r.link_id)[1] == "1.0"]
        self.assertEqual(sorted(r.status for r in old), ["completed", "voided", "voided"])
        self.assertEqual(kps.state_for(self.db, self._doc(), ANN)["status"], "pending")

    def test_a_policy_not_live_yet_asks_nobody(self):
        d = self._doc()
        d.live_from = kb_core.add_days(kb_core.today(), 5)      # WP 5.8
        self.db.commit()
        self.assertEqual(kps.run(self.db), 0)
        self.assertFalse(kb_core.signoff_state(self.db, self._doc(), ANN)["required"])

    def test_off_sends_nothing(self):
        from unittest import mock
        with mock.patch.object(kb_core, "NEXUS_SIGN_FOR_POLICIES", False):
            self.assertEqual(kps.run(self.db), 0)


if __name__ == "__main__":
    unittest.main()
