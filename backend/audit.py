"""
Audit middleware — logs every state-changing request (non-GET) to audit_logs.
Generates a descriptive action string that includes the resource ID from the URL
so logs read as "Approved requisition REQ-ABC" rather than just "Approved requisition".
"""
import json
from datetime import datetime
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from database import SessionLocal
import models


def _describe(method: str, path: str) -> tuple[str, str]:
    """Return (human_readable_action, resource_id) from method + path."""
    parts = [p for p in path.split("/") if p]
    # parts[0] = resource type, parts[1] = id or sub-action, parts[2] = sub-action

    resource = parts[0] if parts else ""
    rid      = parts[1] if len(parts) > 1 else ""
    sub      = parts[2] if len(parts) > 2 else ""

    # Ignore non-meaningful sub-path segments used as IDs
    _SKIP_AS_ID = {"sync", "read", "action", "export", "excel", "reply", "approve",
                   "reject", "allocate", "initiate-return", "confirm-return", "mark-lost",
                   "click", "me", "summary"}

    display_id = rid if rid and rid not in _SKIP_AS_ID else ""

    def _fmt(label: str) -> str:
        return f"{label} {display_id}".strip() if display_id else label

    # ── Requisitions ──────────────────────────────────────────────────────────
    if resource == "requisitions":
        if method == "POST":                    return "Created requisition", ""
        if sub == "approve":                    return _fmt("Approved requisition"), display_id
        if sub == "reject":                     return _fmt("Rejected requisition"), display_id
        if sub == "allocate":                   return _fmt("Allocated asset →"), display_id
        if sub == "initiate-return":            return _fmt("Initiated return"), display_id
        if sub == "confirm-return":             return _fmt("Confirmed return"), display_id
        if sub == "mark-lost":                  return _fmt("Marked asset lost"), display_id

    # ── Items (individual-unit system) ───────────────────────────────────────
    if resource == "items":
        if rid == "checkouts":
            checkout_id = sub if sub else ""
            if method == "POST":   return "Checked out item", ""
            if method == "PATCH":  return f"Updated checkout {checkout_id}".strip(), checkout_id
        if rid == "import":        return "Imported items (CSV)", ""
        if method == "POST":       return "Added item", ""
        if method == "PATCH":      return f"Updated item {rid}".strip(), rid
        if method == "DELETE":     return f"Deleted item {rid}".strip(), rid

    # ── Inventory requests ────────────────────────────────────────────────────
    if resource == "inventory-requests":
        if rid == "items":
            # /inventory-requests/items[/{item_id}[/import]] — catalogue management,
            # distinct from the request-lifecycle paths below (rid would otherwise
            # be mistaken for the resource id, e.g. "Updated inventory request items")
            item_id = sub if sub and sub != "import" else ""
            if method == "POST" and sub == "import": return "Imported inventory items", ""
            if method == "POST":                      return "Added inventory item", ""
            if method == "PATCH":                     return f"Updated inventory item {item_id}".strip(), item_id
            if method == "DELETE":                    return f"Deleted inventory item {item_id}".strip(), item_id
        if method == "POST":                    return "Created inventory request", ""
        if method == "PATCH":                   return _fmt("Updated inventory request"), display_id

    # ── Hardware assets ───────────────────────────────────────────────────────
    if resource == "hardware-assets":
        if method == "POST":                    return "Added hardware asset", ""
        if method == "PATCH":                   return _fmt("Updated hardware asset"), display_id
        if method == "DELETE":                  return _fmt("Deleted hardware asset"), display_id

    # ── Roles ─────────────────────────────────────────────────────────────────
    if resource == "roles":
        if method == "POST" and rid == "sync":  return "Synced user roles from M365", ""
        if method == "PUT":                     return f"Assigned role → {rid}", rid
        if method == "DELETE":                  return f"Removed user {rid}", rid

    # ── Reviews ───────────────────────────────────────────────────────────────
    if resource == "reviews":
        if sub == "reply":                      return _fmt("Replied to review"), display_id

    # ── Notifications ─────────────────────────────────────────────────────────
    if resource == "notifications":
        if method == "POST":                    return "Sent notification", ""
        if sub == "read":                       return "Marked notification read", ""
        if sub == "action":                     return "Actioned notification", ""
        if method == "DELETE":                  return "Deleted notification", ""

    # ── Tasks ─────────────────────────────────────────────────────────────────
    if resource == "tasks":
        if method == "POST":                    return "Created task", ""
        if method == "PATCH":                   return _fmt("Updated task"), display_id
        if method == "DELETE":                  return _fmt("Deleted task"), display_id

    # ── Purchases ─────────────────────────────────────────────────────────────
    if resource == "purchase-requests":
        if method == "POST":                    return "Created purchase request", ""
        if method == "PATCH":                   return _fmt("Updated purchase request"), display_id

    # ── Assets ───────────────────────────────────────────────────────────────
    if resource == "assets":
        if method == "POST":                    return "Added asset", ""
        if method == "PATCH":                   return _fmt("Updated asset"), display_id
        if method == "DELETE":                  return _fmt("Deleted asset"), display_id

    # ── Reviews ───────────────────────────────────────────────────────────────
    if resource == "sop-updates":
        if method == "POST":                    return "Created SOP entry", ""
        if method == "PATCH":                   return _fmt("Updated SOP entry"), display_id

    # ── Operations / dev ─────────────────────────────────────────────────────
    if resource == "ops-projects":
        if method == "POST":                    return "Created ops project", ""
        if method == "PATCH":                   return _fmt("Updated ops project"), display_id

    # ── External links ────────────────────────────────────────────────────────
    if resource == "external-links":
        if method == "POST":                    return "Added external link", ""
        if sub == "click":                      return "Clicked external link", ""

    # ── Fallback ──────────────────────────────────────────────────────────────
    return f"{method} /{resource}", rid


def _extract_email(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        return "anonymous"
    try:
        import base64
        token = auth[7:]
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


# Resources where the request body carries the meaningful business event (item,
# quantity, reason, condition, etc.) that a path-only log entry would discard.
# These fields, when present in the JSON body, are copied into `details` so an
# auditor can see *what* changed, not just that *something* changed.
_BODY_FIELDS_BY_RESOURCE = {
    "items": (
        "name", "item_type", "make", "model", "department", "location",
        "ownership_type", "status", "item_name", "reason", "days",
        "requested_by", "condition_note", "return_photo_name",
    ),
    "inventory-requests": (
        "status", "item_id", "item_name", "quantity", "days", "reason",
        "resolved_by", "reject_reason", "allocated_by", "condition_note",
        "return_photo_name",
        # catalogue item create/edit fields (POST|PATCH /inventory-requests/items/*)
        "name", "category", "department", "location", "total_qty",
    ),
    "requisitions": (
        "status", "item_id", "item_name", "quantity", "reason",
        "reject_reason", "condition", "condition_note",
    ),
    "hardware-assets": ("name", "category", "status", "assigned_to", "dept"),
}


async def _read_body_fields(request: Request, resource: str) -> dict:
    fields = _BODY_FIELDS_BY_RESOURCE.get(resource)
    if not fields:
        return {}
    try:
        raw = await request.body()
        if not raw:
            return {}
        body = json.loads(raw)
        if not isinstance(body, dict):
            return {}
        return {k: body[k] for k in fields if k in body and body[k] not in (None, "")}
    except Exception:
        return {}


class AuditMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path     = request.url.path
        method   = request.method
        resource = path.split("/")[1] if len(path.split("/")) > 1 else ""

        # Body must be read before call_next consumes the stream — Starlette
        # caches it internally so the downstream route still sees it intact.
        body_fields = {}
        if method not in ("GET", "HEAD", "OPTIONS"):
            body_fields = await _read_body_fields(request, resource)

        response = await call_next(request)

        if request.method in ("GET", "HEAD", "OPTIONS"):
            return response
        if response.status_code >= 400:
            return response

        try:
            action, resource_id = _describe(method, path)
            user_email = _extract_email(request)

            forwarded  = request.headers.get("x-forwarded-for")
            ip = (
                forwarded.split(",")[0].strip()
                if forwarded
                else (request.client.host if request.client else "")
            )

            details = {"path": path, "status": response.status_code}
            details.update(body_fields)

            db = SessionLocal()
            try:
                db.add(models.AuditLog(
                    timestamp=datetime.utcnow().isoformat(),
                    user_email=user_email,
                    user_role="",
                    action=action,
                    resource_type=resource,
                    resource_id=resource_id,
                    details=json.dumps(details),
                    ip_address=ip,
                ))
                db.commit()
            finally:
                db.close()
        except Exception:
            pass

        return response
