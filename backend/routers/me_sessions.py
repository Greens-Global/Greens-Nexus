"""My Profile > Security (Neil, 11/02/2026): where you are signed in, and the
way to sign the other devices out.

Everything here is the caller's own rows and nothing else. A session is named
to the browser by the sha256 of its id - the id IS the cookie, so it never
leaves the server in a response body. "Current" is the row whose id matches
the request's own session cookie (none on the localhost bearer path).

  GET    /me/sessions          {sessions: [{id, device, location, ip, lastSeen, createdAt, current}]}
                               (rows still inside Settings > Security's idle window, this device first)
  DELETE /me/sessions/{id}     {signedOut: 1, current: bool}   404 unless it is one of yours
  POST   /me/sessions/others   {signedOut: n}                   every row of yours but this device's
  GET    /me/sign-ins          {signIns: [{id, at, device, location, ip, isNew}]}   the last 20
"""
import hashlib
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

import bff_session as bff
from auth import get_current_user
from database import get_db
from models import NexusSignIn, ServerSession

router = APIRouter(prefix="/me", tags=["My Profile"])


def _me(user: dict) -> str:
    return (user.get("email") or "").strip().lower()


def _hash(sid: str) -> str:
    return hashlib.sha256((sid or "").encode()).hexdigest()


def _current_sid(request: Request) -> str:
    return request.cookies.get(bff.SESSION_COOKIE, "") or ""


def _live(rows: list, db: Session) -> list:
    """Rows whose last activity is inside the idle window (an idle row is dead
    to get_session already; it just has not been swept yet)."""
    cut = datetime.now(timezone.utc) - timedelta(days=bff.session_idle_days(db))
    out = []
    for r in rows:
        try:
            seen = datetime.fromisoformat(r.last_seen or r.created_at)
            if seen.tzinfo is None:
                seen = seen.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            out.append(r)        # unreadable stamp: show it rather than hide a live device
            continue
        if seen >= cut:
            out.append(r)
    return out


def _ser_session(r: ServerSession, current: bool) -> dict:
    return {"id": _hash(r.id), "device": r.ua_summary or "", "location": r.location or "", "ip": r.ip or "",
            "lastSeen": r.last_seen or "", "createdAt": r.created_at or "", "current": current}


@router.get("/sessions")
def list_sessions(request: Request, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    sid = _current_sid(request)
    rows = _live(db.query(ServerSession).filter(ServerSession.user_email == me).all(), db)
    # Most recently seen first, this device above them all (stable sorts).
    rows.sort(key=lambda r: r.last_seen or "", reverse=True)
    rows.sort(key=lambda r: 0 if r.id == sid else 1)
    return {"sessions": [_ser_session(r, r.id == sid) for r in rows]}


@router.post("/sessions/others")
def sign_out_others(request: Request, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    sid = _current_sid(request)
    q = db.query(ServerSession).filter(ServerSession.user_email == me)
    if sid:
        q = q.filter(ServerSession.id != sid)
    n = q.delete(synchronize_session=False)
    db.commit()
    return {"signedOut": int(n or 0)}


@router.delete("/sessions/{session_hash}")
def sign_out_one(session_hash: str, request: Request, user: dict = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    me = _me(user)
    row = next((r for r in db.query(ServerSession).filter(ServerSession.user_email == me).all()
                if _hash(r.id) == session_hash), None)
    if row is None:
        raise HTTPException(status_code=404, detail="That session is not one of yours, or it is already gone.")
    current = row.id == _current_sid(request)
    bff.delete_session(db, row.id)
    return {"signedOut": 1, "current": current}


@router.get("/sign-ins")
def recent_sign_ins(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (db.query(NexusSignIn).filter(NexusSignIn.email == _me(user))
            .order_by(NexusSignIn.at.desc()).limit(20).all())
    return {"signIns": [{"id": r.id, "at": r.at or "", "device": r.ua_summary or "", "location": r.location or "",
                         "ip": r.ip or "", "isNew": bool(r.is_new)} for r in rows]}
