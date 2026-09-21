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
import collections
import hashlib
import json
import os
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


class RequestRateLimit(BaseHTTPMiddleware):
    """Per-caller request budget (Sep 22, 2026 - "no rate limiting" had been on
    the security-debt list since June).

    Budgets, all per rolling minute:
      * a signed-in caller (BFF session cookie or Bearer token) - AUTHED_PER_MIN,
        keyed on a hash of that credential, so one person's runaway tab can never
        throttle a colleague on the same office NAT;
      * an anonymous caller - ANON_PER_MIN per IP;
      * an anonymous caller on a credential-taking route (login, external codes,
        e-sign public links, the boot beacon) - SENSITIVE_PER_MIN per IP, which
        is what turns guessing into a slow, logged affair;
      * everyone - IP_CEILING per IP as a backstop, so rotating fake tokens does
        not buy unlimited budget.

    Sliding window in process memory: gunicorn runs several workers, so the real
    ceiling is a few multiples of these numbers - they are a flood backstop,
    not a fair-use meter. /health and /version are exempt (probes), OPTIONS is
    exempt (preflights carry no credential). NEXUS_RATE_LIMIT=off disables it.
    A trip logs once per caller per five minutes as security_rate_limited."""
    WINDOW = 60
    AUTHED_PER_MIN = int(os.getenv("NEXUS_RL_AUTHED", "900"))
    ANON_PER_MIN = int(os.getenv("NEXUS_RL_ANON", "120"))
    SENSITIVE_PER_MIN = int(os.getenv("NEXUS_RL_SENSITIVE", "30"))
    IP_CEILING = int(os.getenv("NEXUS_RL_IP", "3000"))
    SENSITIVE_PREFIXES = ("/auth/login", "/auth/callback", "/external-auth/", "/esign/public/",
                          "/client-errors/boot", "/stepup/")
    EXEMPT_PREFIXES = ("/health", "/version")
    ENABLED = os.getenv("NEXUS_RATE_LIMIT", "on").strip().lower() not in ("off", "0", "false", "no")

    def __init__(self, app):
        super().__init__(app)
        self._lock = threading.Lock()
        self._hits: dict = {}        # key -> deque[timestamp]
        self._logged: dict = {}      # key -> last security_log timestamp

    @staticmethod
    def _identity(request, ip: str):
        auth = request.headers.get("authorization", "")
        if auth:
            return "a:" + hashlib.sha1(auth.encode()).hexdigest()[:20], True
        sid = request.cookies.get("nx_session", "")
        if sid:
            return "s:" + hashlib.sha1(sid.encode()).hexdigest()[:20], True
        return "ip:" + ip, False

    def _count(self, key: str, limit: int, now: float) -> bool:
        """Record one hit under key; True when the caller is over its budget."""
        dq = self._hits.get(key)
        if dq is None:
            dq = self._hits[key] = collections.deque()
        while dq and now - dq[0] >= self.WINDOW:
            dq.popleft()
        if len(dq) >= limit:
            return True
        dq.append(now)
        return False

    async def dispatch(self, request, call_next):
        if not self.ENABLED or request.method == "OPTIONS":
            return await call_next(request)
        path = request.url.path
        if path.startswith(self.EXEMPT_PREFIXES):
            return await call_next(request)
        ip = _client_ip(request) or "?"
        key, authed = self._identity(request, ip)
        if not authed and path.startswith(self.SENSITIVE_PREFIXES):
            key, limit = "sens:" + ip, self.SENSITIVE_PER_MIN
        else:
            limit = self.AUTHED_PER_MIN if authed else self.ANON_PER_MIN
        now = time.time()
        with self._lock:
            over = self._count(key, limit, now) or self._count("ceil:" + ip, self.IP_CEILING, now)
            if len(self._hits) > 20000:              # bound memory under spoofed floods
                self._hits.clear()
            log_it = over and now - self._logged.get(key, 0) > 300
            if log_it:
                self._logged[key] = now
                if len(self._logged) > 5000:
                    self._logged.clear()
        if over:
            if log_it:
                security_log("rate_limited", f"over {limit}/min on {path[:80]} ({'signed-in' if authed else 'anonymous'})", ip=ip)
            return Response(content=json.dumps({"detail": "Too many requests - slow down and try again in a moment."}),
                            status_code=429, media_type="application/json",
                            headers={"Retry-After": "10"})
        return await call_next(request)
