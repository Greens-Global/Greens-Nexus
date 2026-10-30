"""Has this password leaked? (Credentials, Oct 29 2026)

Have I Been Pwned's range API, with k-anonymity: only the first five
characters of the password's SHA-1 leave the server; the answer is every
suffix in that range and we match ours locally. The password itself never
goes anywhere, and HIBP cannot tell which one we asked about.

`breached` on the credential row existed since the port and nothing ever
set it. Now: checked when a password is saved (create, rotate, import), and
once a day for every live credential (reminders_loop, next to the rotation
reminders) so a password that leaks later is caught too. A newly breached
credential puts one bell on its owner and backup owner. Network trouble
never blocks a save - the check fails open and says so in the log.
"""
import hashlib
import uuid
from datetime import datetime, timezone

import httpx

RANGE_URL = "https://api.pwnedpasswords.com/range/"
TIMEOUT = 5.0


def pwned_count(secret: str) -> int | None:
    """How many times the password appears in known breaches; None when HIBP
    could not be reached (the caller leaves the flag as it was)."""
    if not secret:
        return 0
    digest = hashlib.sha1(secret.encode()).hexdigest().upper()
    prefix, suffix = digest[:5], digest[5:]
    try:
        r = httpx.get(RANGE_URL + prefix, headers={"Add-Padding": "true", "User-Agent": "Greens-Nexus-Credentials"}, timeout=TIMEOUT)
        if r.status_code != 200:
            return None
    except Exception:
        return None
    for line in r.text.splitlines():
        sfx, _, count = line.strip().partition(":")
        if sfx == suffix:
            try:
                return int(count)
            except ValueError:
                return 1
    return 0


def is_breached(secret: str) -> bool | None:
    n = pwned_count(secret)
    return None if n is None else n > 0


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def scan(db, decrypt, notify) -> dict:
    """Daily pass over every live company credential: re-check each password,
    update `breached`, and tell the owners of a credential that just turned
    breached (one bell each). `decrypt(ciphertext)` and
    `notify(recipient, cred)` come from routers/credvault.py. Commits."""
    import models
    out = {"checked": 0, "breached": 0, "newly": 0, "unreachable": 0}
    for c in db.query(models.VaultCredential).filter(models.VaultCredential.deleted_at == "").all():
        if not c.secret_enc:
            continue
        try:
            secret = decrypt(c.secret_enc)
        except Exception:
            continue
        hit = is_breached(secret)
        out["checked"] += 1
        if hit is None:
            out["unreachable"] += 1
            continue
        if hit:
            out["breached"] += 1
        if hit and not c.breached:
            out["newly"] += 1
            for who in {(c.owner_email or "").lower(), (c.backup_owner_email or "").lower()} - {""}:
                notify(who, c)
        c.breached = bool(hit)
    db.commit()
    return out


def new_id() -> str:
    return str(uuid.uuid4())
