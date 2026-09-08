"""Keep the accounting app's user list in step with Nexus grants.

Nexus is the single point of access control for accounting.greensglobal.com
(Visesh, Sep 8). Launch (routers/accounting.py) provisions people on demand;
this loop handles the other direction - somebody removed from the Accounting
access group, or demoted below administrator, must stop being able to open the
app even if they never click Launch again. Every SYNC_EVERY_SEC it posts the
full set of emails that still qualify, and the accounting app deactivates any
Nexus-managed user not in the set (and reactivates anyone who is).

Deployed-worker gated: a laptop pointed at the shared dev database must never
push its idea of the grant list into the real accounting app. All DB work and
the outbound HTTP run in a thread (see the Aug 2 freeze note in CLAUDE.md).
"""
import asyncio
import os

SYNC_EVERY_SEC = 10 * 60


def qualifying_emails() -> list[str]:
    """Everyone who may open the accounting app: any group grant on the
    'accounting-app' module at any level, plus administrator/owner roles (they
    bypass module grants everywhere, so they must also be able to launch)."""
    from database import SessionLocal
    from auth import _LEVELS
    import models

    db = SessionLocal()
    try:
        emails: set[str] = set()
        rows = (
            db.query(models.NexusGroupMember.email)
            .join(models.NexusGroup, models.NexusGroup.id == models.NexusGroupMember.group_id)
            .filter(models.NexusGroup.allowed_modules.like("%accounting-app:%"))
            .all()
        )
        emails.update(e.lower() for (e,) in rows if e)
        admin_roles = [name for name, lvl in _LEVELS.items() if lvl >= _LEVELS["administrator"]]
        rows = db.query(models.NexusRole.email).filter(models.NexusRole.role.in_(admin_roles)).all()
        emails.update(e.lower() for (e,) in rows if e)
        return sorted(emails)
    finally:
        db.close()


def sync_once() -> dict:
    import httpx

    base = os.environ.get("ACCOUNTING_BASE_URL", "").rstrip("/")
    key = os.environ.get("ACCOUNTING_INTERNAL_KEY", "")
    if not base or not key:
        return {"skipped": "not configured"}
    emails = qualifying_emails()
    if not emails:
        # An empty list would deactivate everyone; treat it as a read failure.
        return {"skipped": "no qualifying emails - refusing to sync an empty list"}
    r = httpx.post(
        f"{base}/api/internal/sso/sync",
        json={"emails": emails},
        headers={"x-internal-api-key": key},
        timeout=60,
    )
    r.raise_for_status()
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(data.get("error") or "accounting sync error")
    return {"sent": len(emails), "revoked": data.get("revoked", []), "restored": data.get("restored", [])}


async def accounting_sso_sync_loop():
    from leader import is_deployed_worker

    if not is_deployed_worker():
        print("[accounting-sso] sync skipped (not the deployed worker)")
        return
    await asyncio.sleep(120)  # let startup settle
    while True:
        try:
            out = await asyncio.to_thread(sync_once)
            if out.get("revoked") or out.get("restored"):
                print(f"[accounting-sso] {out}")
        except Exception as e:
            print(f"[accounting-sso] sync failed: {e}")
        await asyncio.sleep(SYNC_EVERY_SEC)
