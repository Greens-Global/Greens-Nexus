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
import sys

from cryptography.fernet import Fernet, InvalidToken

_KEY = os.getenv("NEXUS_VAULT_KEY", "").strip()
# Read by /health so a deployment's key state is visible from outside (Sep 22).
KEY_CONFIGURED = bool(_KEY)
# Same test main.py's NEXUS_SKIP_AUTH refusal uses: App Service sets
# WEBSITE_SITE_NAME on every deployed instance (dev, prod, the staging slot).
ON_AZURE = bool(os.getenv("WEBSITE_SITE_NAME"))

# Sep 30 review: the fallback key below is in the repo, so anything encrypted
# with it - BFF session refresh/access/id tokens, the nx_login cookie (PKCE
# verifier + OAuth state), Egnyte tokens - is readable and forgeable by anyone
# with the source. It is now LOCAL-ONLY: on Azure there is no fallback at all
# (encrypt/decrypt raise) and main.py's lifespan refuses to start, the same way
# it refuses NEXUS_SKIP_AUTH. A deployment missing the key fails its health
# check instead of quietly running on a public key.
_DEV_FALLBACK_SEED = b"nexus-secret-box-DEV-ONLY-key-set-NEXUS_VAULT_KEY"

if _KEY:
    _fernet = Fernet(_KEY.encode())
elif ON_AZURE:
    _fernet = None
    print("[secret_box] FATAL: NEXUS_VAULT_KEY is not set on a deployed API. There is no fallback "
          "on Azure - set it in the App Service configuration.", file=sys.stderr)
else:
    # DEV-ONLY fallback so local SQLite dev works without setup. Distinct seed
    # from credvault's so the two stores can't be cross-decrypted by accident.
    _fernet = Fernet(base64.urlsafe_b64encode(hashlib.sha256(_DEV_FALLBACK_SEED).digest()))
    print("\n" + "!" * 78 + "\n"
          "[secret_box] WARNING: NEXUS_VAULT_KEY is not set - using the DEV-ONLY fallback key.\n"
          "  That key is in the repo: sessions and tokens encrypted with it are NOT secret.\n"
          "  Fine for local dev; a deployed API refuses to start without the real key.\n"
          + "!" * 78, file=sys.stderr)


def require_key_on_azure() -> None:
    """Called from main.py's lifespan: exit when deployed without the key."""
    if ON_AZURE and not KEY_CONFIGURED:
        print("FATAL: NEXUS_VAULT_KEY must be set on Azure App Service (sessions and OAuth "
              "tokens are encrypted with it). Add it to the application settings and restart.",
              file=sys.stderr)
        sys.exit(1)


def _box() -> Fernet:
    if _fernet is None:
        raise RuntimeError("NEXUS_VAULT_KEY is not set on this deployed API")
    return _fernet


def encrypt(plaintext: str) -> str:
    return _box().encrypt((plaintext or "").encode()).decode()


def decrypt(ciphertext: str) -> str:
    """Raises ValueError when the ciphertext doesn't match this key - a token
    encrypted under a different NEXUS_VAULT_KEY (or the dev fallback) can't be
    recovered, and callers treat that the same as "not connected"."""
    if not ciphertext:
        return ""
    try:
        return _box().decrypt(ciphertext.encode()).decode()
    except InvalidToken as e:
        raise ValueError("secret cannot be decrypted (vault key mismatch)") from e
