"""
Audit middleware — logs every state-changing request (non-GET) to audit_logs.
One central place; all current and future routers are covered automatically.
"""
import json
from datetime import datetime
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from database import SessionLocal
import models

# Map (method, path-prefix) → human-readable action label
_ACTION_MAP = [
    ("POST",   "/requisitions",                    "Created requisition"),
    ("PATCH",  "/requisitions",  "/approve",        "Approved requisition"),
    ("PATCH",  "/requisitions",  "/reject",         "Rejected requisition"),
    ("PATCH",  "/requisitions",  "/allocate",       "Allocated asset to requisition"),
    ("PATCH",  "/requisitions",  "/initiate-return","Initiated return"),
    ("PATCH",  "/requisitions",  "/confirm-return", "Confirmed return"),
    ("PATCH",  "/requisitions",  "/mark-lost",      "Marked asset lost"),
    ("POST",   "/hardware-assets",                 "Created hardware asset"),
    ("POST",   "/inventory-requests",              "Created inventory request"),
    ("PATCH",  "/inventory-requests",              "Updated inventory request"),
    ("PUT",    "/roles",                           "Assigned role"),
    ("POST",   "/roles/sync",                      "Synced user roles"),
    ("PATCH",  "/reviews",        "/reply",         "Replied to review"),
    ("POST",   "/tasks",                           "Created task"),
    ("PATCH",  "/tasks",                           "Updated task"),
    ("DELETE", "/tasks",                           "Deleted task"),
    ("POST",   "/purchases",                       "Created purchase request"),
    ("PATCH",  "/purchases",                       "Updated purchase request"),
    ("POST",   "/assets",                          "Created asset"),
    ("PATCH",  "/assets",                          "Updated asset"),
    ("DELETE", "/assets",                          "Deleted asset"),
    ("POST",   "/accounting",                      "Created accounting entry"),
    ("PATCH",  "/accounting",                      "Updated accounting entry"),
    ("DELETE", "/accounting",                      "Deleted accounting entry"),
    ("POST",   "/operations",                      "Created operations entry"),
    ("PATCH",  "/operations",                      "Updated operations entry"),
]


def _resolve_action(method: str, path: str) -> str:
    for entry in _ACTION_MAP:
        if len(entry) == 3:
            m, prefix, _ = entry
            if method == m and path.startswith(prefix):
                return entry[2]
        else:
            m, prefix, suffix, label = entry
            if method == m and prefix in path and path.endswith(suffix):
                return label
    return f"{method} {path}"


def _extract_email(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        return "anonymous"
    try:
        import base64
        token = auth[7:]
        # Decode payload without verification (already verified by auth dependency)
        parts = token.split(".")
        if len(parts) < 2:
            return "unknown"
        padded = parts[1] + "=" * (4 - len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded))
        return (
            payload.get("preferred_username")
            or payload.get("email")
            or payload.get("upn")
            or "unknown"
        ).lower()
    except Exception:
        return "unknown"


class AuditMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)

        # Only log writes that succeeded
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return response
        if response.status_code >= 400:
            return response

        try:
            path = request.url.path
            method = request.method
            action = _resolve_action(method, path)
            user_email = _extract_email(request)

            forwarded = request.headers.get("x-forwarded-for")
            ip = (
                forwarded.split(",")[0].strip()
                if forwarded
                else (request.client.host if request.client else "")
            )

            db = SessionLocal()
            try:
                db.add(models.AuditLog(
                    timestamp=datetime.utcnow().isoformat(),
                    user_email=user_email,
                    user_role="",
                    action=action,
                    resource_type=path.split("/")[1] if "/" in path else "",
                    resource_id=path.split("/")[2] if path.count("/") >= 2 else "",
                    details=json.dumps({"path": path, "status": response.status_code}),
                    ip_address=ip,
                ))
                db.commit()
            finally:
                db.close()
        except Exception:
            pass  # Audit failure must never break the response

        return response
