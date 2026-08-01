"""Edge hardening for the API (Aug 1, 2026): HTTP revalidation, auth-failure
throttling, and a security event trail.

ETagMiddleware - transfer-layer caching for every JSON GET. The server hashes
the response body and replies 304 (no body) when the browser's copy is
current. The endpoint still runs (this saves wire transfer, not compute - the
compute side is cache.py's job), but a 300 KB item list that hasn't changed
becomes a ~200-byte round trip, and the browser's HTTP cache serves the body.
No client changes needed: fetch() speaks conditional requests natively.

AuthFailureThrottle - counts 401s per client IP. Ordinary users produce almost
none (one at most when a token expires mid-flight, and api.js silently
retries), so a stream of them is credential probing. The whole office can sit
behind one NAT IP, which is why only FAILURES count and the threshold is
generous - a tripped throttle blocks that IP briefly and writes a security
event, converting silent brute force into a visible, rate-limited one.

security_log - security-relevant moments (throttle trips, lockouts) go to the
audit_logs table AND stdout, so they survive log rotation and show up in the
in-app Activity Log where someone will actually see them.

All state is in-process per gunicorn worker (no Redis in this stack) - an
attacker rotating across all 8 workers gets 8x the thresholds, which still
collapses abuse by orders of magnitude. See cache.py for the same tradeoff.
"""
import hashlib
import json
import threading
import time
from datetime import datetime, timezone

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response


def security_log(action: str, detail: str, ip: str = "", email: str = "") -> None:
    """Best-effort: a security event must never break the request it rode in on."""
    print(f"[security] {action}: {detail} ip={ip} user={email}")
    try:
        from database import SessionLocal
        from models import AuditLog
        db = SessionLocal()
        try:
            db.add(AuditLog(
                timestamp=datetime.now(timezone.utc).isoformat(),
                user_email=email or "anonymous",
                action=f"security_{action}",
                resource_type="security",
                details=json.dumps({"detail": detail}),
                ip_address=ip,
            ))
            db.commit()
        finally:
            db.close()
    except Exception as e:              # noqa: BLE001
        print(f"[security] audit write skipped: {e}")


def _client_ip(request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else ""


class ETagMiddleware(BaseHTTPMiddleware):
    _MAX_BODY = 4 * 1024 * 1024        # don't buffer file downloads

    async def dispatch(self, request, call_next):
        response = await call_next(request)
        if (request.method != "GET"
                or response.status_code != 200
                or "etag" in response.headers
                or not response.headers.get("content-type", "").startswith("application/json")):
            return response
        # Materialize the streamed body to hash it (JSON payloads are already
        # fully in memory upstream; the size cap keeps blobs out).
        body = b""
        async for chunk in response.body_iterator:
            body += chunk
            if len(body) > self._MAX_BODY:
                async def _rest(head=body, it=response.body_iterator):
                    yield head
                    async for c in it:
                        yield c
                response.body_iterator = _rest()
                return response
        etag = f'W/"{hashlib.sha256(body).hexdigest()[:32]}"'
        headers = dict(response.headers)
        headers.pop("content-length", None)
        headers["etag"] = etag
        # no-cache = store but REVALIDATE every use; the 304 is what makes the
        # stored copy usable. private keeps corporate proxies out of it.
        headers["cache-control"] = "private, no-cache"
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers=headers)
        return Response(content=body, status_code=200, headers=headers,
                        media_type=response.media_type)


class AuthFailureThrottle(BaseHTTPMiddleware):
    WINDOW_SEC = 300
    MAX_FAILURES = 150                 # per IP per window - generous headroom for a shared office NAT
    BLOCK_SEC = 120

    def __init__(self, app):
        super().__init__(app)
        self._lock = threading.Lock()
        self._failures: dict = {}      # ip -> [timestamps]
        self._blocked: dict = {}       # ip -> unblock_at

    async def dispatch(self, request, call_next):
        ip = _client_ip(request)
        now = time.time()
        with self._lock:
            unblock = self._blocked.get(ip, 0)
            if unblock > now:
                blocked = True
            else:
                blocked = False
                self._blocked.pop(ip, None)
        if blocked:
            return Response(content=json.dumps({"detail": "Too many failed requests - try again shortly."}),
                            status_code=429, media_type="application/json")
        response = await call_next(request)
        # Only ANONYMOUS 401s count. A request carrying a Bearer token is a real
        # user whose token merely expired (api.js refreshes and retries silently)
        # - never brute force. This makes it impossible for a signed-in user to
        # be throttled by a neighbor's failures on a shared office IP. The
        # backstop still catches the thing it's for: floods of credential-less
        # requests hammering the API.
        had_bearer = request.headers.get("authorization", "").startswith("Bearer ")
        if response.status_code == 401 and not had_bearer:
            with self._lock:
                hits = [t for t in self._failures.get(ip, []) if now - t < self.WINDOW_SEC]
                hits.append(now)
                self._failures[ip] = hits
                if len(self._failures) > 10000:      # bound memory under spoofed floods
                    self._failures.clear()
                tripped = len(hits) > self.MAX_FAILURES and ip not in self._blocked
                if tripped:
                    self._blocked[ip] = now + self.BLOCK_SEC
            if tripped:
                security_log("auth_throttle_tripped",
                             f"{len(hits)} auth failures in {self.WINDOW_SEC}s - blocked {self.BLOCK_SEC}s",
                             ip=ip)
        return response
