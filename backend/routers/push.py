"""Web Push subscriptions (Frontline Reach, Neil 11/02/2026) - the device
half of push.py. A signed-in person registers the browser's push
subscription for the device they are on ("Push to This Device" in My
Profile > Phone Notifications), lists their devices, or removes one. The
config call tells the browser whether the server has keys at all and which
public key to subscribe with. Everything is scoped to the caller's own email;
nobody manages another person's devices.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import push
from auth import get_current_user
from database import get_db
from models import NexusPushSubscription

router = APIRouter(prefix="/push", tags=["push"])

# The browsers' push services, and nothing else: the leader POSTs to every
# endpoint it holds, so an arbitrary https URL here would be a blind request
# from our server to wherever a signed-in person pointed it.
PUSH_SERVICE_HOSTS = ("fcm.googleapis.com", "updates.push.services.mozilla.com")
PUSH_SERVICE_SUFFIXES = (".push.apple.com", ".notify.windows.com", ".push.services.mozilla.com")


def known_push_service(endpoint: str) -> bool:
    try:
        host = (urlsplit(endpoint).hostname or "").lower()
    except ValueError:
        return False
    return bool(host) and (host in PUSH_SERVICE_HOSTS or host.endswith(PUSH_SERVICE_SUFFIXES))


class Keys(BaseModel):
    p256dh: str
    auth: str


class SubscribeIn(BaseModel):
    endpoint: str
    keys: Keys
    userAgent: Optional[str] = ""


class UnsubscribeIn(BaseModel):
    endpoint: str


def _me(user: dict) -> str:
    return (user.get("email") or "").strip().lower()


def _row(s: NexusPushSubscription) -> dict:
    return {"id": s.id, "endpoint": s.endpoint, "userAgent": s.user_agent or "", "createdAt": s.created_at or "",
            "lastOkAt": s.last_ok_at or "", "disabled": bool(s.disabled)}


@router.get("/config")
def config(user: dict = Depends(get_current_user)):   # noqa: ARG001 - signed in only
    """Is push set up on this server, and the public key to subscribe with."""
    return {"enabled": push.configured(), "publicKey": push.public_key() if push.configured() else ""}


@router.post("/subscribe", status_code=201)
def subscribe(body: SubscribeIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if not push.configured():
        raise HTTPException(409, "Push is not set up on this server yet.")
    ep = (body.endpoint or "").strip()
    if not ep.startswith("https://") or len(ep) > 2000:
        raise HTTPException(400, "That does not look like a push subscription.")
    if not known_push_service(ep):
        raise HTTPException(400, "Unknown push service")
    if not body.keys.p256dh or not body.keys.auth:
        raise HTTPException(400, "The subscription has no keys.")
    now = datetime.now(timezone.utc).isoformat()
    me = _me(user)
    # One row per endpoint: a browser that subscribes again (new keys, or a
    # second person on a shared device) replaces what was there.
    s = db.query(NexusPushSubscription).filter(NexusPushSubscription.endpoint == ep).first()
    if s is None:
        s = NexusPushSubscription(id=f"ps_{uuid.uuid4().hex}", endpoint=ep, created_at=now)
        db.add(s)
    s.email = me
    s.p256dh = body.keys.p256dh
    s.auth = body.keys.auth
    s.user_agent = (body.userAgent or "")[:300]
    s.failures = 0
    s.disabled = False
    db.commit()
    db.refresh(s)
    return _row(s)


@router.delete("/subscribe", status_code=204)
def unsubscribe(body: UnsubscribeIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    s = db.query(NexusPushSubscription).filter(NexusPushSubscription.endpoint == (body.endpoint or "").strip(),
                                               NexusPushSubscription.email == me).first()
    if s is not None:
        db.delete(s)
        db.commit()
    return None


@router.get("/subscriptions")
def my_subscriptions(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (db.query(NexusPushSubscription).filter(NexusPushSubscription.email == _me(user))
            .order_by(NexusPushSubscription.created_at).all())
    return [_row(s) for s in rows]
