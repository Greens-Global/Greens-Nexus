"""Server-Timing on every API answer, and one log line for a slow one.

    Server-Timing: app;dur=2612, db;dur=1904;desc="131 queries"

`app` is the time to the response's first byte (every middleware included),
`db` the time spent in SQL and how many statements ran for this request (the
pool's pre-ping is not counted). DevTools shows it under Network > Timing, so
"slow API" can be split into "many round trips" (each ~15-20 ms from Azure to
the Supabase pooler, measured 11/05/2026), "heavy SQL" or "Python / waiting".
A request over SLOW_MS also prints `[slow] GET /path 2612ms db=131q/1904ms`
(the path only - never the query string).

Pure ASGI and added outermost, so the counter is set before the
BaseHTTPMiddleware layers start their tasks and the route's threadpool call
inherits it (a copied context shares the same list). Background loops have no
counter and are not measured.
"""
import contextvars
import time

from sqlalchemy import event

SLOW_MS = 2000
_db = contextvars.ContextVar("nexus_request_db", default=None)   # [statements, seconds]


def wire(engine) -> None:
    @event.listens_for(engine, "before_cursor_execute")
    def _start(conn, cursor, statement, parameters, context, executemany):
        if _db.get() is not None:
            conn.info["nx_sql_t0"] = time.perf_counter()

    @event.listens_for(engine, "after_cursor_execute")
    def _stop(conn, cursor, statement, parameters, context, executemany):
        st, t0 = _db.get(), conn.info.pop("nx_sql_t0", None)
        if st is not None and t0 is not None:
            st[0] += 1
            st[1] += time.perf_counter() - t0


class RequestTiming:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        st = [0, 0.0]
        token = _db.set(st)
        t0 = time.perf_counter()

        async def timed_send(message):
            if message["type"] == "http.response.start":
                ms = (time.perf_counter() - t0) * 1000
                value = f'app;dur={ms:.0f}, db;dur={st[1] * 1000:.0f};desc="{st[0]} queries"'
                message = {**message, "headers": [*message.get("headers", []), (b"server-timing", value.encode())]}
                if ms >= SLOW_MS:
                    print(f"[slow] {scope.get('method', '')} {scope.get('path', '')} {ms:.0f}ms "
                          f"db={st[0]}q/{st[1] * 1000:.0f}ms")
            await send(message)

        try:
            await self.app(scope, receive, timed_send)
        finally:
            _db.reset(token)
