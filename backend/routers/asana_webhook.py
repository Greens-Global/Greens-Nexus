"""Public Asana webhook receiver (NO auth - Asana calls it; requests are verified
by the X-Hook-Signature HMAC instead). Kept in its own router because the Task
routers require a logged-in user, which Asana obviously isn't.

Flow:
  - Registration handshake: Asana POSTs an X-Hook-Secret header; we store it and
    echo it back (200) so Asana activates the webhook.
  - Events: Asana POSTs {events:[...]} signed with X-Hook-Signature. We verify the
    HMAC against our stored secret(s) and, if valid, kick off a background pull -
    plus a project-access refresh when the batch mentions membership, which the
    pull would otherwise only pick up on its 30-minute full sweep.
"""
import json

from fastapi import APIRouter, Request, Response, Depends
from sqlalchemy.orm import Session

from database import get_db

router = APIRouter(tags=["Asana"])


@router.post("/asana-sync/webhook")
async def asana_webhook(request: Request, db: Session = Depends(get_db)):
    import asana_sync
    # Severed (Aug 27): the endpoint stays mounted so Asana gets a clean answer
    # rather than a 404 storm, but nothing is applied and no handshake is
    # accepted, so a webhook left registered at Asana's end cannot quietly
    # resume the link. NEXUS_ASANA_ENABLED=true restores it.
    if not asana_sync.is_asana_enabled():
        return Response(status_code=200)
    body = await request.body()
    secret = request.headers.get("X-Hook-Secret")
    if secret:
        # Handshake - store the secret and echo it back to activate the webhook.
        asana_sync.store_handshake_secret(db, secret)
        return Response(status_code=200, headers={"X-Hook-Secret": secret})

    if not asana_sync.verify_signature(db, body, request.headers.get("X-Hook-Signature", "")):
        return Response(status_code=401)

    # A deleted task never reappears in pull()'s project task-list poll - it's
    # simply gone - so the 'deleted' event is the only chance to notice and
    # unlink it. Handle that inline; everything else still goes through the
    # regular pull.
    try:
        events = json.loads(body or b"{}").get("events", [])
    except ValueError:
        events = []
    for ev in events:
        resource = ev.get("resource") or {}
        if ev.get("action") == "deleted" and resource.get("resource_type") == "task":
            asana_sync.unlink_deleted_task(db, resource.get("gid", ""))

    # Membership changes carry no task, so the pull below never notices one: it
    # only refreshes access on its 30-minute FULL sweep. Sync it off the event
    # instead, so someone added to a project in Asana can open it in Nexus now
    # rather than up to half an hour later. A no-op for ordinary task events.
    asana_sync.trigger_access_sync_async(events)

    asana_sync.trigger_pull_async()
    return {"ok": True}
