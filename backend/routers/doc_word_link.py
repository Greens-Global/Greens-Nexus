"""Open in Word (Pranshu, Nov 5 2026): the Documents editor hands the document
to Word on the person's computer to carry on editing there.

The browser opens `ms-word:ofe|u|<url>` and WORD fetches the file itself -
without the browser's sign-in - so the link carries a short-lived signed token
(the document, the person, an expiry) instead. Every fetch re-runs the Export
DOCX read gate as that person, so a lost access or a deleted document stops the
link at once. Nothing is stored; the file is the same render as Export DOCX.
Changes made in Word stay on the person's computer (Word saves a copy) - there
is no save back into Nexus.
"""
import base64
import hashlib
import hmac
import json
import re
import time

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

import auth
import secret_box
from auth import get_current_user
from database import get_db
from routers.documents import _export_prep, _get_readable
from services.doc_export import render_docx

router = APIRouter(prefix="/documents", tags=["documents"])

_SECRET = secret_box.signing_secret("nexus-doc-word-link-DEV-ONLY-key-set-NEXUS_VAULT_KEY")
_CONTEXT = b"doc-word-link:v1:"
_SIG_LEN = 16
LINK_TTL_S = 15 * 60   # long enough for Word to start and fetch, short enough that a pasted link dies
DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def make_token(doc_id: str, email: str, now: float | None = None) -> str:
    payload = json.dumps({"d": doc_id, "e": email.lower(), "x": int((now or time.time()) + LINK_TTL_S)},
                         separators=(",", ":")).encode()
    return _b64(payload + hmac.new(_SECRET, _CONTEXT + payload, hashlib.sha256).digest()[:_SIG_LEN])


def parse_token(token: str, now: float | None = None) -> dict | None:
    """{"d", "e", "x"} for a well-signed, unexpired token - else None."""
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
        payload, sig = raw[:-_SIG_LEN], raw[-_SIG_LEN:]
        want = hmac.new(_SECRET, _CONTEXT + payload, hashlib.sha256).digest()[:_SIG_LEN]
        if len(sig) != _SIG_LEN or not hmac.compare_digest(want, sig):
            return None
        data = json.loads(payload)
        if not data.get("d") or not data.get("e") or int(data.get("x", 0)) < (now or time.time()):
            return None
        return data
    except Exception:
        return None


def _file_name(title: str) -> str:
    # Word shows the URL's last segment as the file name.
    name = re.sub(r'[\\/:*?"<>|#%&{}~]+', " ", title or "").strip()[:80]
    return "-".join(name.encode("ascii", "ignore").decode().split() or ["Document"]) + ".docx"


@router.post("/word-link/{did}")
def word_link(did: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The path of a file Word can open for this document, as the caller (Act As
    included). A path, not a URL: the browser puts its own API base in front,
    so Word fetches from the same API the person is using."""
    row = _get_readable(db, did, user)
    return {"path": f"/documents/word-file/{make_token(row.id, user['email'])}/{_file_name(row.title)}",
            "expiresInSeconds": LINK_TTL_S}


@router.api_route("/word-file/{token}/{filename}", methods=["GET", "HEAD"])
def word_file(token: str, filename: str, db: Session = Depends(get_db)):
    data = parse_token(token)
    if not data:
        raise HTTPException(404, "This link has expired - open the document in Word from Nexus again")
    email = data["e"]
    ext = auth._external_record(email)
    if ext and ext.get("external"):   # guests and externals never get a sign-in-free file
        raise HTTPException(404, "Document not found")
    user = {"email": email, "role": "", "level": auth.level_for(email, db)}
    row, header_blocks, pages_blocks, footer_blocks, letterhead, page_setup = _export_prep(db, data["d"], user)
    docx_bytes = render_docx(row.title, header_blocks, pages_blocks, footer_blocks, letterhead, page_setup)
    return Response(content=docx_bytes, media_type=DOCX_TYPE, headers={"Cache-Control": "no-store"})
