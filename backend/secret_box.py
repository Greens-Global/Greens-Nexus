"""Fernet encryption for secrets stored at rest, outside a request context.

routers/credvault.py already has this logic, but its `_dec` raises
HTTPException - meaningless on the background daemon thread that pushes
comments to Asana (asana_sync.on_comment_added), where nothing is there to
turn it into a response. This module is the same scheme with no FastAPI
dependency: decrypt() raises ValueError and the caller decides.

Deliberately does NOT refactor credvault to import from here - that module is
working, security-sensitive, and has its own reuse-detection hashing; leaving
it alone keeps this change off its blast radius.

Key: NEXUS_VAULT_KEY (a Fernet.generate_key() value), the same env var the
vault uses, so there is one secret to manage on Azure rather than two.
"""
import base64
import hashlib
import os

from cryptography.fernet import Fernet, InvalidToken

_KEY = os.getenv("NEXUS_VAULT_KEY", "").strip()
# Read by /health so a deployment running on the fallback key is visible from
# outside (Sep 22). Deliberately NOT fail-closed like credvault: every BFF
# session row is encrypted with this key, so refusing to start would lock every
# user out - the fix for a missing key is to set it, which is what /health
# makes obvious, and then everyone signs in once more.
KEY_CONFIGURED = bool(_KEY)
if _KEY:
    _fernet = Fernet(_KEY.encode())
else:
    if os.getenv("WEBSITE_SITE_NAME"):
        print("[secret_box] SECURITY: NEXUS_VAULT_KEY is NOT set on a DEPLOYED API - sessions and "
              "OAuth tokens are encrypted with the dev fallback key. Set it in App Service configuration.")
    # DEV-ONLY fallback so local SQLite dev works without setup. Anything
    # encrypted with this is NOT protected by a real secret - on Azure set
    # NEXUS_VAULT_KEY. Distinct seed from credvault's so the two stores can't
    # be cross-decrypted by accident in dev.
    _fernet = Fernet(base64.urlsafe_b64encode(
        hashlib.sha256(b"nexus-secret-box-DEV-ONLY-key-set-NEXUS_VAULT_KEY").digest()
    ))
    print("[secret_box] WARNING: NEXUS_VAULT_KEY not set - using dev-only fallback key")


def encrypt(plaintext: str) -> str:
    return _fernet.encrypt((plaintext or "").encode()).decode()


def decrypt(ciphertext: str) -> str:
    """Raises ValueError when the ciphertext doesn't match this key - a token
    encrypted under a different NEXUS_VAULT_KEY (or the dev fallback) can't be
    recovered, and callers treat that the same as "not connected"."""
    if not ciphertext:
        return ""
    try:
        return _fernet.decrypt(ciphertext.encode()).decode()
    except InvalidToken as e:
        raise ValueError("secret cannot be decrypted (vault key mismatch)") from e
