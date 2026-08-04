"""
Audit middleware - logs every state-changing request (non-GET) to audit_logs.
Generates a descriptive action string that includes the resource ID from the URL
so logs read as "Approved requisition REQ-ABC" rather than just "Approved requisition".
"""
import json
import os
from datetime import datetime
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from database import SessionLocal
import models
from act_as import resolve_target as _resolve_act_as_target


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
        # Bulk + sub-action POSTs were ALL mislabeled "Added item" - name them.
        if rid == "bulk-update":   return "Edited multiple items", ""
        if rid == "bulk-delete":   return "Deleted multiple items", ""
        if rid == "bulk-restore":  return "Restored multiple items", ""
        if rid == "auto-photos":   return "AI-filled item photos", ""
        if rid == "custom-fields":
            if method == "POST":   return "Added a custom field", ""
            if method == "PATCH":  return "Updated a custom field", sub
            if method == "DELETE": return "Deleted a custom field", sub
        if sub == "assign":          return _fmt("Assigned item"), rid
        if sub == "reassign":        return _fmt("Reassigned item"), rid
        if sub == "assign-location": return _fmt("Assigned item to a location"), rid
        if sub == "restore":         return _fmt("Restored item"), rid
        if method == "POST":       return "Added item", ""
        if method == "PATCH":      return f"Updated item {rid}".strip(), rid
        if method == "DELETE":     return f"Deleted item {rid}".strip(), rid

    # ── Inventory requests ────────────────────────────────────────────────────
    if resource == "inventory-requests":
        if rid == "items":
            # /inventory-requests/items[/{item_id}[/import]] - catalogue management,
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

    # ── Time clock ────────────────────────────────────────────────────────────
    if resource == "timeclock":
        if rid == "punch" and sub == "manual":  return "Fixed a missed punch", ""
        if rid == "punch":                      return "Punched the time clock", ""
        if rid == "punches" and method == "POST":  return "Added a punch for someone (manual)", ""
        if rid == "punches" and method == "PATCH": return "Adjusted a punch", sub
        if rid == "screenshot":                 return "Desktop agent saved a screenshot", ""
        if rid == "bod":                        return "Posted a start/end-of-day update", ""
        if rid == "timeoff" and method == "POST":  return "Requested time off", ""
        if rid == "timeoff" and method == "PATCH": return "Decided a time-off request", sub
        if rid == "approvals":                  return "Approved a timesheet", ""
        if rid == "shifts":
            if method == "POST":                return "Created a shift", ""
            if method == "PATCH":               return "Updated a shift", sub
            if method == "DELETE":              return "Deleted a shift", sub
        if rid == "shift-groups":               return "Updated shift groups", ""
        if rid == "agent" and sub == "enroll":  return "Enrolled a monitoring device", ""
        if rid == "agent" and sub == "devices": return "Revoked a monitoring device", ""

    # ── My HR (employee self-service) ────────────────────────────────────────
    if resource == "myhr":
        if rid == "profile":                    return "Updated their own profile (My HR)", ""
        if rid == "requests" and sub == "attachment": return "Attached a document for HR", ""
        if rid == "requests":                   return "Sent a request to HR", ""

    # ── HR module ────────────────────────────────────────────────────────────
    if resource == "hr":
        if rid == "employees":
            emp = sub
            deep = parts[3] if len(parts) > 3 else ""
            if sub == "" and method == "POST":  return "Added an employee", ""
            if deep == "":
                if method == "PATCH":           return "Updated an employee profile", emp
                if method == "DELETE":          return "Deleted an employee", emp
            if deep == "documents":             return "Uploaded an HR document", emp
            if deep == "paystubs":              return "Uploaded a paystub", emp
            if deep == "photo":                 return "Updated an employee photo", emp
            if deep == "provision":             return "Provisioned an M365 account", emp
            if deep == "compensation":          return "Updated compensation (restricted)", emp
            if deep == "status":                return "Changed employment status", emp
        if rid == "documents" and method == "DELETE": return "Deleted an HR document", sub
        if rid == "requests" and len(parts) > 3 and parts[3] == "attach-to-employee":
            return "Filed an employee's document", sub
        if rid == "requests" and method == "PATCH": return "Resolved an employee HR request", sub
        if rid == "sync":                       return "Synced people from M365", ""
        if rid == "entities":                   return "Updated companies / legal entities", ""
        if rid == "work-sites":                 return "Updated work sites", ""
        if rid == "candidates" and len(parts) > 3 and parts[3] == "resume":
            return "Uploaded a candidate resume", sub
        if rid == "candidates":                 return "Updated the hiring pipeline", ""
        if rid == "leave":                      return "Updated leave records", ""

    # ── E-sign ────────────────────────────────────────────────────────────────
    if resource == "esign":
        deep = parts[3] if len(parts) > 3 else ""
        if rid == "templates" and method == "POST":   return "Created an e-sign template", ""
        if rid == "templates" and method == "PUT":    return "Updated an e-sign template", sub
        if rid == "templates" and method == "DELETE": return "Deleted an e-sign template", sub
        if rid == "requests" and deep == "void":      return "Voided a signature request", sub
        if rid == "requests" and deep == "remind":    return "Sent a signing reminder", sub
        if rid == "requests" and deep == "fix-party": return "Fixed a signer on a request", sub
        if rid == "requests" and method == "POST" and not sub: return "Sent a document for signature", ""
        if sub == "sign" or deep == "sign":     return "Signed a document", ""
        if sub == "decline" or deep == "decline": return "Declined to sign", ""
        if rid == "upload-pdf":                 return "Uploaded a PDF for signing", ""
        if rid == "sign":                       return "Signed a document (public link)", ""

    # ── Dashboards (custom views) ────────────────────────────────────────────
    if resource == "dashboards":
        if rid == "views" and method == "POST":   return "Created a dashboard view", ""
        if rid == "views" and method == "PUT" and parts[3:] == ["default"]: return "Set default dashboard view", sub
        if rid == "views" and len(parts) > 3 and parts[3] == "default": return "Set default dashboard view", sub
        if rid == "views" and method == "PUT":    return "Updated a dashboard view", sub
        if rid == "views" and method == "DELETE": return "Deleted a dashboard view", sub

    # ── Knowledge base / groups / assets / help ──────────────────────────────
    if resource == "knowledge-base":
        if rid == "documents" and method == "POST": return "Added a KB document", ""
        if rid == "documents":                  return "Updated a KB document", sub
        if rid == "courses" and method == "POST":   return "Created a course", ""
        if rid == "courses":                    return "Updated a course", sub
    if resource == "groups":
        if method == "POST" and not rid:        return "Created an access group", ""
        if sub == "members":                    return "Changed access group members", rid
        if method in ("PUT", "PATCH"):          return "Updated an access group", rid
        if method == "DELETE":                  return "Deleted an access group", rid
    if resource == "property-assets":
        if rid == "workspace":                  return "Saved the asset portfolio", ""
        if rid == "reminders":                  return "Scanned asset expiry reminders", ""
    if resource == "help":                      return "Updated page help", ""

    # ── Fallback: plain verbs instead of raw HTTP ─────────────────────────────
    verb = {"POST": "Created", "PUT": "Updated", "PATCH": "Updated", "DELETE": "Deleted"}.get(method, method)
    pretty = resource.replace("-", " ") or "record"
    return f"{verb} {pretty}".strip(), rid


def _extract_email(request: Request) -> str:
    # Local dev (NEXUS_SKIP_AUTH) has no bearer token, which left every local
    # audit row as "Not signed in" AND silently disabled the acting-as
    # resolution (it matches on the real actor's email) - so Act As could
    # never be exercised end-to-end on a laptop. Mirror auth.py's bypass.
    # Never active on Azure: main.py refuses to boot with SKIP_AUTH there.
    if os.getenv("NEXUS_SKIP_AUTH", "").lower() == "true":
        return os.getenv("NEXUS_DEV_EMAIL", "dev@localhost").lower()
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        # BFF cookie mode has NO Authorization header - resolve the actor directly
        # from the session row (a lightweight PK lookup, no token refresh) so audit
        # entries attribute the real user instead of "anonymous" / "Not signed in".
        try:
            import bff_session
            sid = request.cookies.get(bff_session.SESSION_COOKIE, "")
            if sid:
                db = SessionLocal()
                try:
                    row = db.query(models.ServerSession.user_email).filter(
                        models.ServerSession.id == sid).first()
                    if row and row[0]:
                        return row[0].lower()
                finally:
                    db.close()
        except Exception:
            pass
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


def _acting_as_target(request: Request, real_email: str, db) -> str:
    """If this request was made during an active Act As session, return who
    was being impersonated - so a mutation shows up as e.g.
    "pranshu@x.com approved requisition REQ-12" with details.acting_as =
    "jane@x.com", never just silently as jane. real_email always comes from
    the raw bearer token (see _extract_email), independent of the identity
    get_current_user hands the route - so this is never lost even though the
    overlay changes what the route itself sees."""
    session_id = request.headers.get("x-act-as-session", "")
    if not session_id:
        return ""
    try:
        target = _resolve_act_as_target(session_id, real_email, db)
    except Exception:
        return ""
    return target["email"] if target else ""


# Resources where the request body carries the meaningful business event (item,
# quantity, reason, condition, etc.) that a path-only log entry would discard.
# These fields, when present in the JSON body, are copied into `details` so an
# auditor can see *what* changed, not just that *something* changed.
_BODY_FIELDS_BY_RESOURCE = {
    "items": (
        "name", "item_type", "make", "model", "year", "department", "location",
        "default_owner", "ownership_type", "status", "serial_number", "op_status",
        "op_status_person_name", "item_name", "reason", "days",
        "requested_by", "condition_note", "return_photo_name",
        "asset_value",  # checkout/add value - "who took out how much worth"
        "photo_url",     # so adding/changing an item photo shows in the audit log
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
        # Bulk edits nest the changed columns under "fields" - surface those too,
        # and note how many items the batch touched.
        src = {**body, **(body["fields"] if isinstance(body.get("fields"), dict) else {})}
        out = {k: src[k] for k in fields if k in src and src[k] not in (None, "")}
        if isinstance(body.get("ids"), list) and body["ids"]:
            out["items"] = len(body["ids"])
        return out
    except Exception:
        return {}


class AuditMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path     = request.url.path
        method   = request.method
        resource = path.split("/")[1] if len(path.split("/")) > 1 else ""

        # Body must be read before call_next consumes the stream - Starlette
        # caches it internally so the downstream route still sees it intact.
        body_fields = {}
        if method not in ("GET", "HEAD", "OPTIONS"):
            body_fields = await _read_body_fields(request, resource)

        response = await call_next(request)

        if request.method in ("GET", "HEAD", "OPTIONS"):
            return response

        # The audit-undo endpoint writes its own canonical entries (the reverse
        # change + marking the original undone) - let it, don't double-log the
        # POST here (the generic describer would mislabel it "Added item").
        if path == "/items/audit-undo":
            return response

        # Resolve IP once - used for both security logs and normal audit rows.
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            hops = [h.strip() for h in forwarded.split(",") if h.strip()]
            ip = hops[-1] if hops else ""
        else:
            ip = request.client.host if request.client else ""

        # Log failed auth attempts (401 / 403) as security events so they
        # appear in the audit trail and can trigger alerts.
        if response.status_code in (401, 403):
            try:
                user_email = _extract_email(request)
                sec_action = "Authentication failed" if response.status_code == 401 else "Authorization denied"
                db = SessionLocal()
                try:
                    sec_details = {"path": path, "method": method, "status": response.status_code}
                    acting_as = _acting_as_target(request, user_email, db)
                    if acting_as:
                        sec_details["acting_as"] = acting_as
                    db.add(models.AuditLog(
                        timestamp=datetime.utcnow().isoformat(),
                        user_email=user_email,
                        user_role="",
                        action=sec_action,
                        resource_type=resource,
                        resource_id="",
                        details=json.dumps(sec_details),
                        ip_address=ip,
                    ))
                    db.commit()
                finally:
                    db.close()
            except Exception:
                pass
            return response

        if response.status_code >= 400:
            return response

        try:
            action, resource_id = _describe(method, path)
            # Create endpoints have no id in the URL - they stamp the new id on the
            # response (X-Created-Id) so the row records WHICH record was added.
            if not resource_id:
                resource_id = response.headers.get("x-created-id", "")
            user_email = _extract_email(request)

            details = {"path": path, "status": response.status_code}
            details.update(body_fields)

            db = SessionLocal()
            try:
                acting_as = _acting_as_target(request, user_email, db)
                if acting_as:
                    details["acting_as"] = acting_as
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
