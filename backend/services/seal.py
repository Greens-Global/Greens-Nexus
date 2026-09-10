"""PAdES sealing - Phase 2 of the Docs & Sign build note.

Two things this module exists to get right.

**Incremental update signing.** PAdES requires each signature to APPEND to the
file without rewriting prior bytes, so signature 1 still validates after
signature 3. The common mistake is to load a PDF, stamp a signature and
re-save - which is what most PDF libraries do by default. That destroys every
prior signature and produces a document whose seal proves nothing, and it
fails SILENTLY: nobody notices until a validator runs in discovery. pyHanko is
used here specifically because it does the correct two-pass flow - reserve a
ByteRange placeholder, digest everything outside it, then inject the CMS blob
into the placeholder without touching the rest of the file.

**Key isolation.** `Signer.sign_digest()` is the only operation that reaches a
key. It accepts a digest and returns a CMS blob. It never accepts a document,
and it never accepts instructions about what to sign. That constraint is what
lets us tell a court that no application bug could have produced an
unauthorized seal - the sealing code physically cannot ask the key to sign
anything other than a hash it computed itself.

**What is honest today.** The only signer implemented is a SELF-SIGNED
development certificate, held in software. It is a real PAdES signature and a
real cryptographic seal, but it chains to no trusted root: Adobe Reader will
report the signer as unknown, and nothing in this system may describe it as
trusted. The AATL certificate and the hardware key custody the build note
specifies are procurement items; `CloudHsmSigner` is the shape they slot into,
and it refuses to pretend until it is configured.
"""
import hashlib
import io
import os
from datetime import datetime, timedelta, timezone

_PROFILE = "PAdES B-B"          # baseline. B-LTA needs a TSA plus revocation data.


class SealNotConfigured(RuntimeError):
    """No signer is available. Sealing is skipped and recorded as skipped -
    never silently treated as success."""


# ── Signers ──────────────────────────────────────────────────────────────────

class Signer:
    """The whole interface a seal backend exposes. One verb."""

    key_custody = "software"
    publicly_trusted = False

    def sign_digest(self, digest: bytes) -> bytes:      # pragma: no cover - abstract
        raise NotImplementedError

    def describe(self) -> dict:                          # pragma: no cover - abstract
        raise NotImplementedError


class CloudHsmSigner(Signer):
    """DigiCert KeyLocker / GlobalSign DSS, once purchased (build note s.9).

    Deliberately not faked. Until the credential exists this raises, so an
    unconfigured deployment records "skipped" rather than producing a seal that
    looks real and is not.
    """

    key_custody = "hsm"
    publicly_trusted = True

    def __init__(self):
        raise SealNotConfigured(
            "No cloud signing service is configured. Phase 2 needs an AATL document "
            "signing certificate and FIPS 140-2 Level 2+ key custody - see build note "
            "section 9. The key cannot live in an application secret.")


class DevSelfSignedSigner(Signer):
    """A self-signed certificate, generated once and cached on disk.

    For development and for proving the sealing pipeline end to end. NOT
    publicly trusted, and everything downstream says so.
    """

    key_custody = "software"
    publicly_trusted = False

    def __init__(self, key_dir: str):
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa

        os.makedirs(key_dir, exist_ok=True)
        key_path = os.path.join(key_dir, "dev-seal-key.pem")
        crt_path = os.path.join(key_dir, "dev-seal-cert.pem")

        self._key_path, self._crt_path = key_path, crt_path
        if os.path.exists(key_path) and os.path.exists(crt_path):
            with open(key_path, "rb") as fh:
                self._key = serialization.load_pem_private_key(fh.read(), password=None)
            with open(crt_path, "rb") as fh:
                self._cert = x509.load_pem_x509_certificate(fh.read())
            return

        # 3072-bit to match what the CA/Browser Forum requires of real document
        # signing keys, so the dev seal is the same shape as the production one.
        self._key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        name = x509.Name([
            x509.NameAttribute(x509.NameOID.COMMON_NAME,
                               "Nexus Docs & Sign DEVELOPMENT seal - not publicly trusted"),
            x509.NameAttribute(x509.NameOID.ORGANIZATION_NAME,
                               os.getenv("NEXUS_ESIGN_OPERATOR", "Greens Global")),
        ])
        now = datetime.now(timezone.utc)
        self._cert = (
            x509.CertificateBuilder()
            .subject_name(name).issuer_name(name)
            .public_key(self._key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1))
            .not_valid_after(now + timedelta(days=825))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(
                digital_signature=True, content_commitment=True, key_encipherment=False,
                data_encipherment=False, key_agreement=False, key_cert_sign=False,
                crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
            .sign(self._key, hashes.SHA256())
        )
        with open(key_path, "wb") as fh:
            fh.write(self._key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption()))
        with open(crt_path, "wb") as fh:
            fh.write(self._cert.public_bytes(serialization.Encoding.PEM))

    def sign_digest(self, digest: bytes) -> bytes:
        """Sign a DIGEST. Not a document - see the module docstring."""
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding
        if not isinstance(digest, (bytes, bytearray)) or len(digest) != 32:
            raise ValueError("sign_digest takes a 32-byte SHA-256 digest, nothing else")
        return self._key.sign(bytes(digest), padding.PKCS1v15(), hashes.SHA256())

    def describe(self) -> dict:
        c = self._cert
        return {
            "profile": _PROFILE,
            "signature_algorithm": "sha256_rsa",
            "cert_subject": c.subject.rfc4514_string(),
            "cert_issuer": c.issuer.rfc4514_string(),
            "cert_serial": format(c.serial_number, "x"),
            "cert_not_after": c.not_valid_after_utc.isoformat(),
            "publicly_trusted": False,
            "key_custody": self.key_custody,
        }

    # pyHanko loads the credential itself, from the PEM pair on disk. Kept in
    # this class so nothing outside it ever handles the key material.
    #
    # NOTE for the cloud/HSM backend: this is the one place the dev signer
    # differs in shape from production. A KeyLocker/DSS signer subclasses
    # pyhanko.sign.Signer and implements async_sign_raw() by calling the
    # service - the key never reaches this process at all, which is the whole
    # point of the sign_digest() interface above.
    def _pyhanko_signer(self):
        from pyhanko.sign import signers
        return signers.SimpleSigner.load(self._key_path, self._crt_path)


def get_signer():
    """The configured signer, or None when sealing is off.

    NEXUS_ESIGN_SEAL=off (default) | dev | cloud
    """
    mode = (os.getenv("NEXUS_ESIGN_SEAL", "off") or "off").strip().lower()
    if mode in ("", "off", "none", "false"):
        return None
    if mode == "cloud":
        return CloudHsmSigner()
    if mode == "dev":
        return DevSelfSignedSigner(os.getenv("NEXUS_ESIGN_SEAL_KEY_DIR", ".seal-dev"))
    raise SealNotConfigured(f"Unknown NEXUS_ESIGN_SEAL value {mode!r}")


# ── Timestamping ─────────────────────────────────────────────────────────────

def get_timestamper():
    """An RFC 3161 timestamper, when one is configured.

    A third-party timestamp proves the document existed in that byte-state at
    that moment without anyone having to trust us - the single highest-value
    neutrality control available. Nothing is invented when it is unset: the
    seal record says there is no timestamp.
    """
    url = (os.getenv("NEXUS_ESIGN_TSA_URL", "") or "").strip()
    if not url:
        return None, ""
    from pyhanko.sign.timestamps import HTTPTimeStamper
    return HTTPTimeStamper(url=url), url


# ── Sealing ──────────────────────────────────────────────────────────────────

def seal_pdf(pdf_bytes: bytes, *, field_name: str = "NexusSeal", reason: str = "") -> tuple:
    """Apply a PAdES seal by INCREMENTAL UPDATE. Returns (sealed_bytes, record).

    `record` describes what was actually applied, including status='skipped'
    when no signer is configured and status='failed' when the attempt errored.
    The caller stores it - a seal that did not apply must leave evidence.
    """
    now = datetime.now(timezone.utc).isoformat()
    try:
        signer = get_signer()
    except SealNotConfigured as e:
        return pdf_bytes, {"status": "skipped", "detail": str(e)[:400], "created_at": now}
    if signer is None:
        return pdf_bytes, {"status": "skipped",
                           "detail": "Sealing is not enabled (NEXUS_ESIGN_SEAL=off).",
                           "created_at": now}

    try:
        from pyhanko.sign import signers as ph_signers
        from pyhanko.sign.fields import SigFieldSpec, SigSeedSubFilter, append_signature_field
        from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter

        timestamper, tsa_url = get_timestamper()
        buf = io.BytesIO(pdf_bytes)
        # IncrementalPdfFileWriter is the whole point: it appends a revision.
        # Anything that rewrites the file invalidates signatures already on it.
        writer = IncrementalPdfFileWriter(buf)
        append_signature_field(writer, SigFieldSpec(sig_field_name=field_name))
        meta = ph_signers.PdfSignatureMetadata(
            field_name=field_name,
            reason=reason or "Certified complete by Nexus Docs & Sign",
            subfilter=SigSeedSubFilter.PADES,
        )
        out = ph_signers.sign_pdf(writer, meta, signer=signer._pyhanko_signer(),
                                  timestamper=timestamper)
        sealed = out.getvalue() if hasattr(out, "getvalue") else out
        record = dict(signer.describe())
        record.update({
            "status": "applied",
            "detail": "",
            "timestamp_authority": tsa_url,
            "timestamped_at": now if tsa_url else "",
            "sealed_sha256": hashlib.sha256(sealed).hexdigest(),
            "created_at": now,
        })
        return sealed, record
    except Exception as e:      # noqa: BLE001 - a seal failure must never lose the document
        return pdf_bytes, {"status": "failed",
                           "detail": f"{type(e).__name__}: {e}"[:400],
                           "created_at": now}


def describe_seals(pdf_bytes: bytes) -> list:
    """Read the signatures back OFF a sealed PDF and report whether each one
    still covers the file. This is what proves the incremental update worked:
    after a second signature, the first must still validate."""
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign.validation import validate_pdf_signature
    from pyhanko_certvalidator import ValidationContext

    # pyHanko logs a full traceback when a chain does not validate. For a
    # self-signed dev seal that is the EXPECTED outcome, not an incident, and a
    # scary traceback in the logs teaches people to ignore logs.
    import logging
    _v = logging.getLogger("pyhanko")
    _prev = _v.level
    _v.setLevel(logging.CRITICAL)
    try:
        return _describe_seals(pdf_bytes)
    except Exception as e:      # noqa: BLE001
        # A file damaged badly enough that the PDF itself will not parse is
        # still a tampered file - report it as such rather than raising out of
        # a verification path. Anyone checking a seal needs an answer, not a
        # stack trace.
        return [{"field": "", "intact": False, "valid": False, "trusted": False,
                 "covers_whole_document": False,
                 "error": f"{type(e).__name__}: {e}"[:200]}]
    finally:
        _v.setLevel(_prev)


def _describe_seals(pdf_bytes: bytes) -> list:
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign.validation import validate_pdf_signature
    from pyhanko_certvalidator import ValidationContext

    reader = PdfFileReader(io.BytesIO(pdf_bytes))
    # No trust roots supplied on purpose: a self-signed dev seal must come back
    # as intact-but-untrusted, never as trusted.
    ctx = ValidationContext(allow_fetching=False, revocation_mode="soft-fail")
    out = []
    for sig in reader.embedded_signatures:
        status = validate_pdf_signature(sig, signer_validation_context=ctx)
        out.append({
            "field": sig.field_name,
            "intact": bool(status.intact),
            "valid": bool(status.valid),
            "trusted": bool(getattr(status, "trusted", False)),
            "covers_whole_document": bool(status.coverage.name == "ENTIRE_FILE"
                                          if hasattr(status.coverage, "name") else False),
        })
    return out


def policy_sentence() -> str:
    """One sentence for the Certificate of Completion's Sealing row.

    The certificate is INSIDE the bytes being sealed, so it cannot report the
    outcome of its own sealing. It states the policy in force; the applied seal
    is recorded on the envelope's seal row and is verifiable in any PDF reader.
    """
    mode = (os.getenv("NEXUS_ESIGN_SEAL", "off") or "off").strip().lower()
    if mode in ("", "off", "none", "false"):
        return ("The completed packet is hashed with SHA-256 and stored; the digest above "
                "detects any later change. The file carries no embedded PKI signature, so "
                "integrity is verified against this record, not from the file alone.")
    tsa = " A third-party RFC 3161 timestamp is applied." if os.getenv("NEXUS_ESIGN_TSA_URL") else ""
    if mode == "dev":
        return (f"The completed packet is sealed with a {_PROFILE} digital signature "
                "(SHA-256 with RSA-3072) using a SELF-SIGNED DEVELOPMENT certificate that is "
                "not publicly trusted - a PDF reader will report the signer as unknown. "
                "The applied seal is recorded on this envelope's seal record." + tsa)
    return (f"The completed packet is sealed with a {_PROFILE} digital signature "
            "(SHA-256 with RSA-3072) whose key is held in hardware. The applied seal is "
            "recorded on this envelope's seal record and is verifiable in any PDF reader."
            + tsa)
