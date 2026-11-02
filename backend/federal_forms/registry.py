"""The federal onboarding forms Nexus Sign can send (Neil, 11/02/2026).

Three forms, each pinned to ONE edition in code: the IRS Form W-4 (2026) and
the USCIS Form I-9 (edition 01/20/25) are the official PDFs bundled as
published - US government works, public domain - and the Direct Deposit
Authorization is our own one-page ACH form drawn by `make_direct_deposit.py`.
Each entry records where the file came from and its SHA-256, so a swapped or
damaged file fails `test_federal_forms.py` instead of shipping.

Updating an edition: replace the PDF under `pdf/`, rebuild the map under
`maps/` from the new widget names (`prepare.widgets(kind)` lists them), bump
`edition` / `editionLabel` / `expires` / `sha256` here, and run the test file.
The W-9 is not here on purpose - it stays the contractor path.
"""
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
PDF_DIR = HERE / "pdf"
MAP_DIR = HERE / "maps"

# What a `source: "merge"` field prints. The packet builder (hr_packet_docs)
# resolves each key from the HrEntity (legal_name, tax_id, registered_address)
# and the hire's start date; the signer never types these.
MERGE_KEYS = {
    "employer.legal_name": "The company's legal name (HrEntity.legal_name)",
    "employer.address": "The company's registered address (HrEntity.registered_address)",
    "employer.name_address": "Legal name and registered address together, one box "
                             "(the W-4's Employers Only block)",
    "employer.ein": "The company's employer identification number (HrEntity.tax_id)",
    "person.first_day": "The person's first day of employment (the start date), MM/DD/YYYY",
}

FORMS = {
    "w4": {
        "title": "Form W-4",
        "edition": "2026",
        "editionLabel": "2026",
        # A W-4 is good for its calendar year; editions.py works the dates out
        # from `edition` (the year) - nothing to keep here.
        "expires": "",
        "pdf": "fw4-2026.pdf",
        "map": "w4_2026.json",
        "roles": ["employee"],
        "us_only": True,
        "worker_types": ["employee"],
        "source_url": "https://www.irs.gov/pub/irs-pdf/fw4.pdf",
        "sha256": "92444d8856ce55d9e25dca8b6d1420634fc68b11e1ab1f760916ea29ddd312b2",
        "pages": 5,
    },
    "i9": {
        "title": "Form I-9",
        "edition": "2025-01-20",
        "editionLabel": "01/20/25",
        # Printed on the form's foot: "Expires 05/31/2027".
        "expires": "2027-05-31",
        "pdf": "i-9-2025-01-20.pdf",
        "map": "i9_2025-01-20.json",
        "roles": ["employee", "hr"],
        "us_only": True,
        "worker_types": ["employee"],
        "source_url": "https://www.uscis.gov/sites/default/files/document/forms/i-9.pdf",
        "sha256": "780f348c34df694bb0b4dbbfaf9f22b99b9757b80d16a37ba89aadf069597281",
        "pages": 4,
    },
    "direct_deposit": {
        "title": "Direct Deposit Authorization",
        "edition": "v1",
        "editionLabel": "v1",
        "expires": "",
        "pdf": "direct-deposit-v1.pdf",
        "map": "direct_deposit_v1.json",
        "roles": ["employee"],
        "us_only": True,
        "worker_types": ["employee"],
        # Ours: drawn by federal_forms/make_direct_deposit.py (reportlab).
        "source_url": "nexus:federal_forms/make_direct_deposit.py",
        "sha256": "e37fb31f502d3550a45a5298f0e69849362c151e364e4a1fd79017a2cc3f2a67",
        "pages": 1,
    },
}


def spec(kind: str) -> dict:
    try:
        return FORMS[kind]
    except KeyError:
        raise KeyError(f"Unknown federal form: {kind!r}")


def pdf_path(kind: str) -> Path:
    return PDF_DIR / spec(kind)["pdf"]


def pdf_bytes(kind: str) -> bytes:
    return pdf_path(kind).read_bytes()


def sha256(kind: str) -> str:
    return hashlib.sha256(pdf_bytes(kind)).hexdigest()


def load_map(kind: str) -> dict:
    """The widget-name -> field map for a form. Keys are the PDF's own
    fully-qualified widget names; a key starting with "@" is a box the form
    has no widget for (the W-4's Step 5 signature line, every box on our
    direct deposit form) and carries its own `page` and normalized `rect`."""
    with open(MAP_DIR / spec(kind)["map"], encoding="utf-8") as fh:
        return json.load(fh)
