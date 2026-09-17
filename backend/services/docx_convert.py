"""Word -> PDF, without rewriting the document.

Sagar, Sep 16, on the importer: "it must preserve the structure of the
document, font style and size, page size should be same as the document that's
being imported, I want 0 alterations means 0."

That rules out the approach this app used to take. The old client-side path ran
mammoth (.docx -> simplified HTML) and then re-laid the HTML out onto hardcoded
US-Letter pages with 56pt margins using pdf-lib's two standard fonts. Every one
of those is an alteration:

  * an A4 or Legal document came out US Letter;
  * the document's real margins were replaced with 56pt;
  * Calibri, Segoe UI, any embedded face became Helvetica or Times;
  * characters outside Latin-1 were replaced with "?";
  * columns, text boxes, headers and footers were flattened to flowed text.

For a document someone then SIGNS, that is not a rendering nit - the signed
artifact stops being the document that was sent. So conversion now happens with
a real Word layout engine, and where none is available the answer is an honest
refusal rather than an approximation.

Converters, in the order they are tried:
  1. LibreOffice (`soffice --convert-to pdf`) - honors page size, margins,
     styles and embedded fonts, and needs no account or network. Present on a
     developer laptop (and on any image that installs the package), so local
     work never depends on a cloud round trip.
  2. NEXUS_DOCX_CONVERT_URL - an HTTP endpoint that takes the bytes and returns
     a PDF, for deployments that run conversion as its own service. Set it and
     it wins over Graph, since configuring it is a deliberate choice.
  3. Microsoft Graph - stage the file on a drive and GET it back as
     `?format=pdf`. This is Office's own renderer, so it is the most faithful
     of the three, and it is what the DEPLOYED API uses: Azure App Service runs
     the blessed Python image, where there is no way to apt-install LibreOffice
     that survives a restart. Needs the Entra app to hold Files.ReadWrite.All
     and one drive to stage in (NEXUS_GRAPH_CONVERT_DRIVE_ID, or
     NEXUS_GRAPH_CONVERT_USER whose OneDrive is used). The staged file is
     deleted as soon as the PDF is in hand.

All three are optional. `available()` says which (if any) is live, so the UI can
tell someone to save as PDF themselves instead of failing at the point of send.

Laptops deliberately prefer LibreOffice even when Graph credentials are present
in a local .env - the same instinct as is_sync_worker() in asana_sync.py: a
developer's machine should not be writing files into the company tenant as a
side effect of a test.
"""
import os
import shutil
import subprocess
import tempfile
import uuid

import httpx

import graph_mail

GRAPH_BASE = "https://graph.microsoft.com/v1.0"

# Generous: a 200-page contract with images is a real thing, and a conversion
# that times out mid-send is worse than one that takes a moment.
CONVERT_TIMEOUT_SEC = 120


def _soffice_bin() -> str:
    """The LibreOffice binary, or ''. NEXUS_SOFFICE_BIN wins so an image can
    point at a non-standard path without code changes."""
    explicit = (os.getenv("NEXUS_SOFFICE_BIN", "") or "").strip()
    if explicit:
        return explicit if os.path.exists(explicit) else ""
    for name in ("soffice", "libreoffice"):
        found = shutil.which(name)
        if found:
            return found
    return ""


def _service_url() -> str:
    return (os.getenv("NEXUS_DOCX_CONVERT_URL", "") or "").strip()


def _graph_drive_hint() -> str:
    """The configured staging drive, WITHOUT resolving it over the network -
    available() is called on every send-wizard open and must stay cheap."""
    return ((os.getenv("NEXUS_GRAPH_CONVERT_DRIVE_ID", "") or "").strip()
            or (os.getenv("NEXUS_GRAPH_CONVERT_USER", "") or "").strip())


def _graph_ready() -> bool:
    return bool(graph_mail.graph_configured() and _graph_drive_hint())


def available() -> dict:
    """What conversion this deployment can actually do. Read by the endpoint so
    the refusal can name the fix rather than just failing."""
    if _soffice_bin():
        return {"ok": True, "engine": "libreoffice"}
    if _service_url():
        return {"ok": True, "engine": "service"}
    if _graph_ready():
        return {"ok": True, "engine": "graph"}
    return {"ok": False, "engine": ""}


def _via_soffice(blob: bytes, filename: str) -> bytes:
    """Convert in a throwaway profile directory.

    The private -env:UserInstallation profile is what makes this safe under
    gunicorn: without it, concurrent soffice runs share ~/.config/libreoffice
    and the second one silently attaches to the first instance and exits 0
    having written nothing.
    """
    bin_path = _soffice_bin()
    with tempfile.TemporaryDirectory() as work:
        src = os.path.join(work, "input.docx")
        profile = os.path.join(work, "profile")
        with open(src, "wb") as fh:
            fh.write(blob)
        proc = subprocess.run(
            [bin_path, f"-env:UserInstallation=file:///{profile.replace(os.sep, '/')}",
             "--headless", "--norestore", "--nolockcheck",
             "--convert-to", "pdf:writer_pdf_Export", "--outdir", work, src],
            capture_output=True, timeout=CONVERT_TIMEOUT_SEC)
        out = os.path.join(work, "input.pdf")
        if not os.path.exists(out):
            err = (proc.stderr or b"").decode("utf-8", "replace")[:300]
            raise RuntimeError(f"LibreOffice produced no PDF: {err or 'no output'}")
        with open(out, "rb") as fh:
            pdf = fh.read()
    if not pdf.startswith(b"%PDF-"):
        raise RuntimeError("LibreOffice returned something that is not a PDF")
    return pdf


def _via_service(blob: bytes, filename: str) -> bytes:
    resp = httpx.post(_service_url(),
                      files={"file": (filename or "input.docx", blob,
                                      "application/vnd.openxmlformats-officedocument."
                                      "wordprocessingml.document")},
                      timeout=CONVERT_TIMEOUT_SEC)
    if not resp.is_success:
        raise RuntimeError(f"Conversion service answered {resp.status_code}")
    if not resp.content.startswith(b"%PDF-"):
        raise RuntimeError("Conversion service did not return a PDF")
    return resp.content


_drive_cache: str = ""


def _resolve_drive_id(token: str) -> str:
    """The drive id to stage in. NEXUS_GRAPH_CONVERT_DRIVE_ID is used as given;
    NEXUS_GRAPH_CONVERT_USER is resolved to that user's OneDrive once and
    remembered - a drive id does not change, and this runs per conversion."""
    global _drive_cache
    explicit = (os.getenv("NEXUS_GRAPH_CONVERT_DRIVE_ID", "") or "").strip()
    if explicit:
        return explicit
    if _drive_cache:
        return _drive_cache
    user = (os.getenv("NEXUS_GRAPH_CONVERT_USER", "") or "").strip()
    if not user:
        raise RuntimeError("No Graph staging drive configured "
                           "(NEXUS_GRAPH_CONVERT_DRIVE_ID or NEXUS_GRAPH_CONVERT_USER).")
    resp = httpx.get(f"{GRAPH_BASE}/users/{user}/drive",
                     headers={"Authorization": f"Bearer {token}"}, timeout=30)
    if not resp.is_success:
        raise RuntimeError(f"Could not find the OneDrive for {user}: Graph answered {resp.status_code}")
    _drive_cache = resp.json().get("id", "")
    if not _drive_cache:
        raise RuntimeError(f"Graph returned no drive id for {user}")
    return _drive_cache


def _via_graph(blob: bytes, filename: str) -> bytes:
    """Word -> PDF through Office's own renderer.

    Three calls: stage the .docx on a drive, ask for it back as PDF, delete it.
    The staged copy is removed in a `finally` - a conversion that fails halfway
    must not leave someone's contract sitting in a tenant folder.
    """
    token = graph_mail.access_token()
    drive = _resolve_drive_id(token)
    folder = ((os.getenv("NEXUS_GRAPH_CONVERT_FOLDER", "") or "NexusSignConversions")
              .strip().strip("/"))
    # Our own name, not the caller's: the uploaded name reaches a real drive
    # path, and the original may carry anything a user typed. The real filename
    # has no bearing on how Word renders the document.
    staged = f"{uuid.uuid4()}.docx"
    auth = {"Authorization": f"Bearer {token}"}
    put = httpx.put(
        f"{GRAPH_BASE}/drives/{drive}/root:/{folder}/{staged}:/content",
        content=blob, timeout=CONVERT_TIMEOUT_SEC,
        headers={**auth, "Content-Type": "application/vnd.openxmlformats-officedocument."
                                         "wordprocessingml.document"})
    if not put.is_success:
        raise RuntimeError(f"Could not stage the document for conversion: Graph answered {put.status_code}")
    item_id = put.json().get("id", "")
    if not item_id:
        raise RuntimeError("Graph accepted the upload but returned no item id")
    try:
        # Graph answers this with a 302 to a short-lived, pre-authenticated URL.
        # The redirect is followed by hand so the Authorization header is NOT
        # replayed onto that second host, which rejects it.
        resp = httpx.get(f"{GRAPH_BASE}/drives/{drive}/items/{item_id}/content",
                         params={"format": "pdf"}, headers=auth,
                         follow_redirects=False, timeout=CONVERT_TIMEOUT_SEC)
        if resp.status_code in (301, 302, 303, 307, 308):
            location = resp.headers.get("location", "")
            if not location:
                raise RuntimeError("Graph redirected the PDF download without a location")
            resp = httpx.get(location, follow_redirects=True, timeout=CONVERT_TIMEOUT_SEC)
        if not resp.is_success:
            raise RuntimeError(f"Graph could not convert the document: answered {resp.status_code}")
        pdf = resp.content
    finally:
        try:
            httpx.delete(f"{GRAPH_BASE}/drives/{drive}/items/{item_id}", headers=auth, timeout=30)
        except Exception as e:      # noqa: BLE001 - cleanup must never mask the conversion result
            print(f"[nexus-sign] could not delete staged conversion {item_id}: {e}")
    if not pdf.startswith(b"%PDF-"):
        raise RuntimeError("Graph returned something that is not a PDF")
    return pdf


def convert(blob: bytes, filename: str = "input.docx") -> bytes:
    """Word bytes in, PDF bytes out, laid out by a real engine.

    Raises RuntimeError when no converter is configured - the caller turns that
    into a 501 telling the user to save as PDF themselves, which is the one
    other way to get a faithful document.
    """
    if not blob:
        raise RuntimeError("That file was empty")
    if _soffice_bin():
        return _via_soffice(blob, filename)
    if _service_url():
        return _via_service(blob, filename)
    if _graph_ready():
        return _via_graph(blob, filename)
    raise RuntimeError(
        "No Word converter is configured on this deployment. Install LibreOffice "
        "on the API image, set NEXUS_DOCX_CONVERT_URL, or give the Entra app "
        "Files.ReadWrite.All plus NEXUS_GRAPH_CONVERT_DRIVE_ID / "
        "NEXUS_GRAPH_CONVERT_USER - until then a .docx cannot be converted "
        "without altering it.")
