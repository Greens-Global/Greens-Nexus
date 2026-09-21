"""Client-side error intake (Aug 1, 2026) - self-hosted error tracking.

The frontend reports uncaught JS errors and crashed React views here; they land
in audit_logs (action=security_client_error) and stdout, so a broken deploy or
a crashing view shows up in the Activity Log and the Azure log stream within
seconds instead of waiting for a user to complain. If NEXUS_SENTRY_DSN is set
(see main.py), the same events also flow to Sentry automatically via its
global hooks - this endpoint is the zero-dependency baseline, not a rival.

Abuse posture: authenticated-only, payload capped, and per-user rate-limited
in process so a crash loop (or a hostile client) can't flood the audit table.
"""
import threading
import time

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from auth import get_current_user
from middleware_hardening import security_log, _client_ip

router = APIRouter(prefix="/client-errors", tags=["Diagnostics"])

_RL_LOCK = threading.Lock()
_RL_WINDOW = 3600
_RL_MAX = 20                     # reports per user per hour - a crash loop dedupes client-side too
_reports: dict = {}              # email -> [timestamps]


class ClientErrorIn(BaseModel):
    message: str
    stack: str = ""
    url: str = ""
    build: str = ""


@router.post("", status_code=204)
def report_client_error(body: ClientErrorIn, request: Request,
                        user: dict = Depends(get_current_user)):
    now = time.time()
    with _RL_LOCK:
        hits = [t for t in _reports.get(user["email"], []) if now - t < _RL_WINDOW]
        if len(hits) >= _RL_MAX:
            return None              # silently drop - never make a crashing client crash harder
        hits.append(now)
        _reports[user["email"]] = hits
        if len(_reports) > 5000:
            _reports.clear()
    detail = (f"{body.message[:500]} | url={body.url[:200]} | build={body.build[:40]}"
              f" | {body.stack[:1500]}")
    security_log("client_error", detail, ip=_client_ip(request), email=user["email"])
    return None


# ── Boot failures (Sep 22) ───────────────────────────────────────────────────
# public/guard.js posts here when a same-origin script, stylesheet or lazy chunk
# fails to load and it is about to reload (stage=retry) or has given up
# (stage=gave-up). The user usually has NO session at that point - Neil was
# locked out on every browser with nothing in any log - so this is deliberately
# unauthenticated: per-IP rate limit, hard-capped fields, one audit row per hit.
# Lands as action=security_boot_failure so it reads in the Activity Log next to
# the authenticated client_error rows.
_BOOT_LOCK = threading.Lock()
_BOOT_MAX = 30                   # per IP per hour: 3 retries + gave-up per page load, a few pages
_boot_reports: dict = {}         # ip -> [timestamps]


class BootFailureIn(BaseModel):
    stage: str = ""
    url: str = ""
    page: str = ""
    build: str = ""
    attempt: int = 0
    reason: str = ""
    ua: str = ""


@router.post("/boot", status_code=204)
def report_boot_failure(body: BootFailureIn, request: Request):
    ip = _client_ip(request) or "?"
    now = time.time()
    with _BOOT_LOCK:
        hits = [t for t in _boot_reports.get(ip, []) if now - t < _RL_WINDOW]
        if len(hits) >= _BOOT_MAX:
            return None
        hits.append(now)
        _boot_reports[ip] = hits
        if len(_boot_reports) > 5000:
            _boot_reports.clear()
    detail = (f"stage={body.stage[:16]} attempt={int(body.attempt)} | asset={body.url[:300]}"
              f" | page={body.page[:200]} | build={body.build[:40]} | {body.reason[:300]}"
              f" | ua={body.ua[:200]}")
    security_log("boot_failure", detail, ip=ip, email="anonymous")
    return None
