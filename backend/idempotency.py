"""Idempotency-Key for field writes (full offline, Neil 11/03/2026; guide
docs/Offline.md).

The phone keeps every change made in the field in ONE outbox
(frontend/src/lib/offline/outbox.js) and sends it when there is signal. Each
queued change carries the id the phone made when it was saved, sent as the
`Idempotency-Key` header on every try. A try whose answer was lost (the
signal died after the server committed) is sent again with the same key;
this module answers that resend with the stored first answer instead of
writing a second row.

Why a table and not a client id per route: most field writes have no
natural key of their own (a photo registered on a log, an edit to a log), so
a per-route column would mean a migration and a unique index on every table
the outbox touches. One small table keyed on (person, key) covers every
route the same way, and a route that already has its own key keeps it -
Forms entries dedupe on `entryKey` (routers/forms.py), so the outbox sends
the entryKey there and Forms does not read this header.

How a route uses it (routers/construction.py is the reference):

    def register_media(..., db = Depends(get_db), idem: Idem = Depends(idempotency)):
        hit = idem.replay(db, user)          # the stored answer, or None
        if hit is not None:
            return hit
        ... make the row ...
        db.flush()
        idem.remember(db, user, media_to_dict(m), 201)   # same transaction
        lost = idem.commit(db, user)         # None, or the winner's answer
        if lost is not None:
            return lost

Rules:
  * no header = exactly the route as before (nothing stored, nothing read);
  * only a 2xx answer is stored - a refusal (403, 409, 422) is never
    replayed, so a retry is judged again on what the server holds now;
  * the key is the caller's: two people can never collide, and a key used
    again for a DIFFERENT request (another route or another body) is a 422,
    never the other request's answer;
  * the stored row is written in the route's own transaction, so either the
    write and its answer both land or neither does; two tries racing each
    other hit the unique (user_email, idem_key) index and the loser gets
    the winner's answer (`commit`);
  * kept 7 days, removed by `purge_expired` in reminders_loop (in a
    thread, never on the event loop).

The dependency only reads a header and the request body (both already in
memory); every database call happens in the route's own sync code, so nothing
here blocks the event loop. Rate limiting is unchanged: a resend is an
ordinary request and counts like one.
"""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

HEADER = "Idempotency-Key"
KEEP_DAYS = 7
_KEY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,100}$")
# A stored answer bigger than this is not kept (nothing a field write returns
# comes close); the write itself still lands, a resend is then judged again.
_MAX_BODY_CHARS = 512 * 1024


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _who(user: Optional[dict]) -> str:
    return ((user or {}).get("email") or "").strip().lower()


class Idem:
    """The key a request carried (or none) and what it was for."""

    def __init__(self, key: str = "", route: str = "", request_hash: str = ""):
        self.key = key
        self.route = route
        self.request_hash = request_hash
        self._pending = None

    def __bool__(self) -> bool:
        return bool(self.key)

    def _row(self, db: Session, user: dict):
        import models
        return (db.query(models.NexusIdempotencyKey)
                .filter(models.NexusIdempotencyKey.user_email == _who(user),
                        models.NexusIdempotencyKey.idem_key == self.key).first())

    def _answer(self, row) -> JSONResponse:
        if row.route != self.route or (row.request_hash and row.request_hash != self.request_hash):
            raise HTTPException(422, "That Idempotency-Key was already used for a different request.")
        try:
            body = json.loads(row.response_json) if row.response_json else None
        except ValueError:
            body = None
        resp = JSONResponse(content=body, status_code=row.response_status or 200)
        resp.headers["Idempotent-Replay"] = "true"
        return resp

    def replay(self, db: Session, user: dict) -> Optional[JSONResponse]:
        """The answer stored for this key, or None (no key, or not seen yet)."""
        if not self.key:
            return None
        row = self._row(db, user)
        return self._answer(row) if row is not None else None

    def remember(self, db: Session, user: dict, body: Any, status: int = 200) -> None:
        """Keep `body` as this key's answer - added to the route's own
        session, so it commits with the write it describes."""
        if not self.key or not (200 <= int(status) < 300):
            return
        import models
        text = json.dumps(body, default=str)
        if len(text) > _MAX_BODY_CHARS:
            return
        self._pending = models.NexusIdempotencyKey(
            id=str(uuid.uuid4()), idem_key=self.key, user_email=_who(user), route=self.route,
            request_hash=self.request_hash, response_status=int(status), response_json=text,
            created_at=_now(),
        )
        db.add(self._pending)

    def commit(self, db: Session, user: dict) -> Optional[JSONResponse]:
        """Commit the route's transaction. Returns None when it landed, or -
        when a racing try with the same key committed first - that try's
        answer (this one's write is rolled back with it). Any other
        integrity failure is raised as before."""
        try:
            db.commit()
            return None
        except IntegrityError:
            db.rollback()
            if not self.key:
                raise
            row = self._row(db, user)
            if row is None:
                raise
            return self._answer(row)


def _hash(method: str, path: str, body: bytes) -> str:
    h = hashlib.sha256()
    h.update(method.upper().encode())
    h.update(b"\n")
    h.update(path.encode())
    h.update(b"\n")
    h.update(body or b"")
    return h.hexdigest()


async def idempotency(request: Request) -> Idem:
    """FastAPI dependency: the request's Idempotency-Key, checked for shape.
    Reads the body Starlette already holds for the route (it is cached on the
    request), so the route's own body parsing is unaffected."""
    key = (request.headers.get(HEADER) or "").strip()
    if not key:
        return Idem()
    if not _KEY_RE.match(key):
        raise HTTPException(400, f"{HEADER} must be 8 to 100 letters, digits, '.', '_', ':' or '-'.")
    route = request.scope.get("route")
    template = getattr(route, "path", "") or request.url.path
    body = await request.body()
    return Idem(key=key, route=f"{request.method.upper()} {template}",
                request_hash=_hash(request.method, request.url.path, body))


def purge_expired(db: Optional[Session] = None, days: int = KEEP_DAYS) -> int:
    """Delete stored answers older than `days`. Sync - call it in a thread."""
    import models
    own = db is None
    if own:
        from database import SessionLocal
        db = SessionLocal()
    try:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        n = (db.query(models.NexusIdempotencyKey)
             .filter(models.NexusIdempotencyKey.created_at < cutoff)
             .delete(synchronize_session=False))
        db.commit()
        return int(n or 0)
    finally:
        if own:
            db.close()
