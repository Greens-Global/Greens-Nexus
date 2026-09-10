"""PAdES sealing (Phase 2 slice) - the incremental-update trap and honesty.

The build note's warning about this stage is specific: loading a PDF, stamping
a signature and re-saving destroys every prior signature and produces a
document whose seal proves nothing, and it fails SILENTLY. So the central test
here signs twice and checks the FIRST signature still validates.

The other half is honesty. The only signer implemented is a self-signed
development certificate. It produces a real PAdES signature, but it chains to
no trusted root, and nothing in the system - certificate, verification
endpoint or seal record - may describe it as trusted.

    python -m unittest test_esign_seal
"""
import io
import logging
import os
import unittest

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_ESIGN_SEAL_KEY_DIR",
                      os.path.join(os.environ.get("TEMP", "."), "nexus-seal-test"))

from services import seal


def _pdf(text="packet") -> bytes:
    from reportlab.pdfgen import canvas
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    c.drawString(100, 700, text)
    c.showPage()
    c.save()
    return buf.getvalue()


class SealModeTests(unittest.TestCase):
    """Sealing is off unless switched on, and an unconfigured deployment says
    so rather than pretending."""

    def setUp(self):
        self._mode = os.environ.get("NEXUS_ESIGN_SEAL")

    def tearDown(self):
        if self._mode is None:
            os.environ.pop("NEXUS_ESIGN_SEAL", None)
        else:
            os.environ["NEXUS_ESIGN_SEAL"] = self._mode

    def test_sealing_is_off_by_default_and_records_that_it_was_skipped(self):
        os.environ["NEXUS_ESIGN_SEAL"] = "off"
        pdf = _pdf()
        out, rec = seal.seal_pdf(pdf)
        self.assertEqual(out, pdf, "an unsealed document must come back untouched")
        self.assertEqual(rec["status"], "skipped")
        self.assertIn("not enabled", rec["detail"])

    def test_the_cloud_signer_refuses_to_pretend_until_it_is_bought(self):
        os.environ["NEXUS_ESIGN_SEAL"] = "cloud"
        out, rec = seal.seal_pdf(_pdf())
        self.assertEqual(rec["status"], "skipped")
        self.assertIn("AATL", rec["detail"])
        self.assertIn("cannot live in an application secret", rec["detail"])

    def test_the_policy_sentence_matches_the_mode(self):
        os.environ["NEXUS_ESIGN_SEAL"] = "off"
        self.assertIn("no embedded PKI signature", seal.policy_sentence())
        os.environ["NEXUS_ESIGN_SEAL"] = "dev"
        dev = seal.policy_sentence()
        self.assertIn("SELF-SIGNED DEVELOPMENT", dev)
        self.assertIn("not publicly trusted", dev)


class DevSealTests(unittest.TestCase):
    def setUp(self):
        logging.disable(logging.CRITICAL)     # expected chain failures are not incidents
        self._mode = os.environ.get("NEXUS_ESIGN_SEAL")
        os.environ["NEXUS_ESIGN_SEAL"] = "dev"

    def tearDown(self):
        logging.disable(logging.NOTSET)
        if self._mode is None:
            os.environ.pop("NEXUS_ESIGN_SEAL", None)
        else:
            os.environ["NEXUS_ESIGN_SEAL"] = self._mode

    # ── the trap ────────────────────────────────────────────────────────────
    def test_a_second_seal_does_not_invalidate_the_first(self):
        """THE test for this stage. With a rewrite-on-save library, signature 1
        is silently destroyed here and nobody notices until discovery."""
        one, r1 = seal.seal_pdf(_pdf(), field_name="NexusSeal")
        self.assertEqual(r1["status"], "applied", r1.get("detail"))
        two, r2 = seal.seal_pdf(one, field_name="CounterSeal")
        self.assertEqual(r2["status"], "applied", r2.get("detail"))

        sigs = {s["field"]: s for s in seal.describe_seals(two)}
        self.assertIn("NexusSeal", sigs)
        self.assertIn("CounterSeal", sigs)
        self.assertTrue(sigs["NexusSeal"]["intact"], "the first signature was destroyed")
        self.assertTrue(sigs["NexusSeal"]["valid"])
        self.assertTrue(sigs["CounterSeal"]["intact"])
        # Only the latest signature covers the whole file; the first covers its
        # own revision. That is correct PAdES, not a defect.
        self.assertTrue(sigs["CounterSeal"]["covers_whole_document"])

    def test_the_second_revision_is_appended_not_rewritten(self):
        """Incremental update, checked at the byte level: the once-sealed file
        must be a literal prefix of the twice-sealed one."""
        one, _ = seal.seal_pdf(_pdf(), field_name="NexusSeal")
        two, _ = seal.seal_pdf(one, field_name="CounterSeal")
        self.assertTrue(two.startswith(one), "prior bytes were rewritten")
        self.assertGreater(len(two), len(one))

    def test_tampering_with_a_sealed_file_breaks_the_signature(self):
        """Either the signature reports non-intact, or the file no longer
        parses at all. Both are detection; neither may raise out of the
        verification path."""
        sealed, _ = seal.seal_pdf(_pdf(), field_name="NexusSeal")
        broken = bytearray(sealed)
        broken[len(broken) // 2] ^= 0xFF
        result = seal.describe_seals(bytes(broken))
        self.assertTrue(result, "verification returned nothing at all")
        self.assertFalse(any(s["intact"] for s in result))

    # ── honesty ─────────────────────────────────────────────────────────────
    def test_a_self_signed_seal_is_never_reported_as_trusted(self):
        sealed, rec = seal.seal_pdf(_pdf())
        self.assertFalse(rec["publicly_trusted"])
        self.assertEqual(rec["key_custody"], "software")
        for s in seal.describe_seals(sealed):
            self.assertFalse(s["trusted"], "a self-signed seal was reported as trusted")

    def test_the_record_says_what_was_applied(self):
        _, rec = seal.seal_pdf(_pdf())
        self.assertEqual(rec["profile"], "PAdES B-B")
        self.assertEqual(rec["signature_algorithm"], "sha256_rsa")
        self.assertIn("DEVELOPMENT", rec["cert_subject"])
        self.assertEqual(rec["cert_subject"], rec["cert_issuer"], "self-signed: subject == issuer")
        self.assertTrue(rec["sealed_sha256"])

    def test_no_timestamp_is_claimed_when_no_authority_is_configured(self):
        prev = os.environ.pop("NEXUS_ESIGN_TSA_URL", None)
        try:
            _, rec = seal.seal_pdf(_pdf())
            self.assertEqual(rec["timestamp_authority"], "")
            self.assertEqual(rec["timestamped_at"], "")
        finally:
            if prev is not None:
                os.environ["NEXUS_ESIGN_TSA_URL"] = prev

    # ── key isolation ───────────────────────────────────────────────────────
    def test_the_signer_only_accepts_a_digest(self):
        """The constraint that lets us say no application bug could produce an
        unauthorized seal: the key interface cannot be handed a document."""
        signer = seal.get_signer()
        self.assertIsNotNone(signer)
        self.assertEqual(len(signer.sign_digest(b"\x11" * 32)), 384)   # RSA-3072
        for bad in (b"not a digest", b"", b"\x00" * 31, _pdf()):
            with self.assertRaises(ValueError):
                signer.sign_digest(bad)

    def test_the_key_is_reused_across_calls_not_regenerated(self):
        a = seal.get_signer().describe()
        b = seal.get_signer().describe()
        self.assertEqual(a["cert_serial"], b["cert_serial"])

    # ── failure is recorded, never silent ───────────────────────────────────
    def test_a_seal_failure_returns_the_document_and_says_so(self):
        out, rec = seal.seal_pdf(b"this is not a PDF at all")
        self.assertEqual(rec["status"], "failed")
        self.assertTrue(rec["detail"])
        self.assertEqual(out, b"this is not a PDF at all",
                         "a seal failure must never lose the document")


class CertificateSealClaimTests(unittest.TestCase):
    """The certificate must not describe a dev seal as a trusted one."""

    def setUp(self):
        self._mode = os.environ.get("NEXUS_ESIGN_SEAL")

    def tearDown(self):
        if self._mode is None:
            os.environ.pop("NEXUS_ESIGN_SEAL", None)
        else:
            os.environ["NEXUS_ESIGN_SEAL"] = self._mode

    def _html(self, policy):
        from services import certificate as C
        snap = C.demo_snapshot(2)
        snap["seal_policy"] = policy
        return C.render_html(snap)

    def test_a_dev_seal_is_labelled_as_untrusted_on_the_certificate(self):
        os.environ["NEXUS_ESIGN_SEAL"] = "dev"
        html = self._html(seal.policy_sentence())
        self.assertIn("SELF-SIGNED DEVELOPMENT", html)
        self.assertIn("not publicly trusted", html)
        self.assertIn("signer as unknown", html)

    def test_a_dev_seal_never_claims_aatl_or_hsm_or_b_lta(self):
        os.environ["NEXUS_ESIGN_SEAL"] = "dev"
        html = self._html(seal.policy_sentence()).lower()
        for claim in ("aatl", "adobe approved trust list", "b-lta", "fips 140",
                      "hardware security module", "trusted root"):
            self.assertNotIn(claim, html, f"a development seal claimed {claim}")

    def test_with_sealing_off_the_certificate_says_there_is_no_pki_signature(self):
        os.environ["NEXUS_ESIGN_SEAL"] = "off"
        self.assertIn("carries no embedded PKI signature", self._html(seal.policy_sentence()))


if __name__ == "__main__":
    unittest.main()
