"""Sharing a company login with someone OUTSIDE Nexus (Pranshu, 11/13/2026).

The person has no Nexus login. Share sends them an email with a link to
/vault-share/<token> (routers/vault_share.py, outside the sign-in like the
e-sign page). The link alone shows only the login's name and who shared it;
the username, link and password come back only after a one-time code sent to
their email - or by SMS when the sharer gave a mobile number - and only until
the share ends (7 days at most, or the owner's End Access). Only a SHA-256 of
the token is stored, so a database copy cannot open a share.

When a share ends, the password it showed is still the login's password
until someone changes it: the owner, backup owner and department head get one
email and bell to change it (expiry_pass, claimed with a conditional UPDATE so
two workers never send it twice), and the login carries "Shared Outside" in
Needs Attention until the password changes (exposed_ids).
"""
import asyncio
import hashlib
import secrets
from datetime import datetime, timezone

import models

MAX_MS = 7 * 86400000          # an outside share lasts 7 days at most
CHECK_EVERY_SEC = 60


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def hash_token(token: str) -> str:
    return hashlib.sha256((token or "").encode()).hexdigest()


def new_token() -> tuple:
    token = secrets.token_urlsafe(32)
    return token, hash_token(token)


def find(db, token: str):
    if not token or len(token) > 200:
        return None
    return db.query(models.VaultExternalShare).filter(models.VaultExternalShare.token_hash == hash_token(token)).first()


def state(share, now: str | None = None) -> str:
    """'active' | 'ended' (the owner ended it) | 'expired'."""
    if share.ended_at:
        return "ended"
    return "active" if (share.expires_at or "") > (now or _now()) else "expired"


def exposed_ids(db) -> set:
    """Logins whose CURRENT password was shown to someone outside Nexus: an
    outside share made after the last password change."""
    shares = db.query(models.VaultExternalShare.cred_id, models.VaultExternalShare.created_at).all()
    if not shares:
        return set()
    rotated = {c.id: c.rotated_at or "" for c in db.query(models.VaultCredential.id, models.VaultCredential.rotated_at).all()}
    return {cid for cid, made in shares if cid in rotated and (made or "") >= rotated[cid]}


def expiry_pass(db, alert) -> int:
    """Tell the owners once per ended / expired share. `alert(share, cred)`
    sends the email and bells; a password already changed since the share
    needs no alert (the share is just marked). The caller commits."""
    now = _now()
    sent = 0
    due = (db.query(models.VaultExternalShare)
           .filter(models.VaultExternalShare.change_alerted_at == "")
           .filter((models.VaultExternalShare.ended_at != "") | (models.VaultExternalShare.expires_at <= now)).all())
    for share in due:
        claimed = (db.query(models.VaultExternalShare)
                   .filter(models.VaultExternalShare.id == share.id, models.VaultExternalShare.change_alerted_at == "")
                   .update({models.VaultExternalShare.change_alerted_at: now}, synchronize_session=False))
        if not claimed:
            continue                      # another worker has it
        cred = db.get(models.VaultCredential, share.cred_id)
        if cred is None or cred.deleted_at or (cred.rotated_at or "") > (share.created_at or ""):
            continue
        alert(share, cred)
        sent += 1
    return sent


def run_expiry_pass() -> int:
    """Own session + commit, in a thread (vault_external_loop)."""
    import database
    from routers import credvault
    db = database.SessionLocal()
    try:
        n = expiry_pass(db, lambda share, cred: credvault.external_ended_alert(db, share, cred))
        db.commit()
        if n:
            print(f"[credvault] {n} outside share(s) ended - owners told to change the password")
        return n
    except Exception as e:
        db.rollback()
        print(f"[credvault] outside share expiry pass failed: {e}")
        return 0
    finally:
        db.close()


async def vault_external_loop():
    """Started from main.py's lifespan: once a minute, off the event loop."""
    await asyncio.sleep(120)
    while True:
        await asyncio.to_thread(run_expiry_pass)
        await asyncio.sleep(CHECK_EVERY_SEC)
