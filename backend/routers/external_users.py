"""External users (Entra B2B guests) - admin CRUD behind the Roles & Access
People tab (Aug 18 rework, Visesh: "external users should be in the people tab
... and they can have access to anything so this has to go through roles and
access just like any normal employee").

The allowlist model: a guest invited into the Entra tenant can sign in to
Microsoft, but Nexus only accepts them if an ACTIVE identity_type='guest' row
exists in nexus_employees for their invited email (enforced centrally in
auth.apply_external_policy - default-deny). This router manages those rows and
the Microsoft invitation email; it does NOT manage their access. Access is
assigned through the normal Roles & Access machinery (job roles / groups),
exactly like an employee - any module is grantable, and the API surface each
grant opens for an external is auth.MODULE_API_PREFIXES. With no grants they
are fail-closed to the app shell only.

Rails that stay regardless of grants: excluded from /myhr/directory (people
pickers), hard-capped at employee level (never manager broadcasts), and
tasks/tickets stay participation-scoped at item level.

Inviting: enrolling a person ALSO sends the Entra B2B invitation via Microsoft
Graph, through the SAME app-only credentials the rest of the backend uses
(graph_mail.py - one token fetch, never a second Graph client). Needs the
User.Invite.All APPLICATION permission with admin consent; without it Graph
returns 403 and we degrade gracefully (row still created, status 'failed',
panel says exactly what to fix). These endpoints are sync `def`s, so FastAPI
runs them on a threadpool worker - the outbound Graph call never sits on the
async event loop.

Deactivate (status='inactive') is reversible and keeps the record. Remove is
permanent: it hard-deletes the person row plus their memberships/scopes, and
they would have to be re-invited from scratch. Neither touches the Entra guest
account - deleting that is optional manual cleanup.
"""
import os
import re
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from sqlalchemy import func
from sqlalchemy.orm import Session

from database import get_db
from auth import (require_administrator, invalidate_external_cache,
                  invalidate_role_cache, INTERNAL_DOMAINS)
from models import NexusEmployee, NexusGroupMember, NexusRole, NexusAccessScope
import cache

router = APIRouter(prefix="/external-users", tags=["External Users"])

_EXTERNAL_TYPES = ("guest", "external")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _serialize(e: NexusEmployee) -> dict:
    email = (e.work_email or "").lower()
    return {
        "id": e.id,
        "email": email,
        "firstName": e.first_name or "",
        "lastName": e.last_name or "",
        "name": (e.display_name or "").strip() or f"{e.first_name} {e.last_name}".strip() or email,
        "company": getattr(e, "external_company", "") or "",
        "status": e.status or "active",
        "identityType": e.identity_type or "guest",
        "invitedBy": getattr(e, "invited_by", "") or "",
        "inviteStatus": getattr(e, "invite_status", "") or "",
        "expiresAt": getattr(e, "expires_at", "") or "",
        "createdAt": e.created_at or "",
        "phone": e.phone or "",
        "phoneVerifiedAt": getattr(e, "phone_verified_at", "") or "",
    }


def _invalidate(email: str) -> None:
    invalidate_external_cache(email)
    invalidate_role_cache(email)
    cache.module_grants.invalidate(email)
    cache.people_directory.invalidate()


# ── Invitations ──────────────────────────────────────────────────────────────
# PRIMARY (Aug 18, Visesh-approved): our own branded Nexus email with a
# single-use activation link - the passwordless flow in
# routers/external_auth.py (issue_invite). The Microsoft Graph B2B invitation
# below is kept ONLY as a transition fallback behind
# NEXUS_EXTERNAL_GRAPH_INVITE=true (default off for new invites).

def _use_graph_invite() -> bool:
    return os.getenv("NEXUS_EXTERNAL_GRAPH_INVITE", "").lower() in ("1", "true", "yes")


def _send_invite(db: Session, row: NexusEmployee, inviter: dict) -> tuple[str, str]:
    """One entry point for both invite paths; returns (invite_status, message)
    with the same semantics either way: 'sent' = our email went out."""
    if _use_graph_invite():
        return _send_entra_invite((row.work_email or "").lower(),
                                  f"{row.first_name} {row.last_name}".strip())
    from routers.external_auth import issue_invite, _inviter_name
    return issue_invite(db, row, _inviter_name(db, inviter["email"]))


# ── Entra B2B invitation via Microsoft Graph (legacy fallback) ───────────────

_GRAPH_INVITES_URL = "https://graph.microsoft.com/v1.0/invitations"

_CONSENT_HINT = ("The app registration is missing the 'User.Invite.All' application "
                 "permission (Entra > App registrations > API permissions > Add a "
                 "permission > Microsoft Graph > Application permissions > "
                 "User.Invite.All > Grant admin consent), or invite them manually in "
                 "Entra > Users > Invite external user.")


def _invite_message(display_name: str) -> str:
    first = (display_name or "").split(" ")[0] or "there"
    return (f"Hi {first}, Greens Global is giving you access to Greens Global Nexus, "
            "our company portal. Accept this invitation with this email address, then "
            "sign in at the link to collaborate on the tasks and tickets shared with you.")


def _send_entra_invite(email: str, display_name: str) -> tuple[str, str]:
    """POST /v1.0/invitations for one guest. Returns (status, message) where
    status is 'sent' | 'failed' | 'manual' - never raises, the caller stores
    the outcome on the row either way. Re-inviting an existing guest is fine:
    Graph accepts it and simply re-sends the redemption email (idempotent);
    a genuine conflict (the address already exists as a MEMBER user, or the
    tenant refuses the redemption) comes back as 'manual' with the reason."""
    import graph_mail
    from app_url import app_url

    if not graph_mail.graph_configured():
        return "failed", ("Microsoft Graph is not configured on this server "
                          "(AZURE_CLIENT_SECRET missing) - invite them manually in Entra.")
    try:
        token = graph_mail.access_token()
    except Exception as exc:
        return "failed", f"Could not get a Microsoft Graph token: {exc}"

    try:
        resp = httpx.post(
            _GRAPH_INVITES_URL,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={
                "invitedUserEmailAddress": email,
                "invitedUserDisplayName": display_name or email,
                "inviteRedirectUrl": app_url(),
                "sendInvitationMessage": True,
                "invitedUserMessageInfo": {
                    "customizedMessageBody": _invite_message(display_name),
                },
            },
            timeout=20,
        )
    except Exception as exc:
        return "failed", f"Could not reach Microsoft Graph: {exc}"

    if resp.status_code in (200, 201):
        return "sent", "Invitation email sent by Microsoft."
    if resp.status_code in (401, 403):
        return "failed", "Microsoft refused the invitation. " + _CONSENT_HINT
    body = ""
    try:
        body = (resp.json().get("error") or {}).get("message") or ""
    except Exception:
        body = (resp.text or "")[:200]
    if resp.status_code == 409 or "conflict" in body.lower() or "already exists" in body.lower():
        return "manual", ("This address already exists in the Microsoft tenant - no "
                          "invitation is needed. " + body).strip()
    return "failed", (f"Microsoft Graph returned {resp.status_code}: {body} - " + _CONSENT_HINT)


# ── Schemas ──────────────────────────────────────────────────────────────────

class ExternalUserCreate(BaseModel):
    email:      str
    first_name: str
    last_name:  Optional[str] = ""
    company:    Optional[str] = ""
    expires_at: Optional[str] = ""      # ISO date; empty = no expiry
    phone:      Optional[str] = ""      # optional; enables SMS codes once verified

class ExternalUserUpdate(BaseModel):
    first_name: Optional[str] = None
    last_name:  Optional[str] = None
    company:    Optional[str] = None
    status:     Optional[str] = None    # active | inactive
    expires_at: Optional[str] = None
    phone:      Optional[str] = None


def _clean_phone(raw: str) -> str:
    return re.sub(r"[^\d+]", "", raw or "")


# ── Routes (admin-gated - this is access management) ─────────────────────────

@router.get("")
def list_external_users(user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    rows = (db.query(NexusEmployee)
            .filter(NexusEmployee.identity_type.in_(_EXTERNAL_TYPES))
            .order_by(NexusEmployee.created_at.desc()).all())
    return [_serialize(e) for e in rows]


@router.post("", status_code=201)
def enroll_external_user(body: ExternalUserCreate,
                         user: dict = Depends(require_administrator),
                         db: Session = Depends(get_db)):
    email = (body.email or "").lower().strip()
    if "@" not in email or " " in email:
        raise HTTPException(400, "A valid email address is required")
    domain = email.rpartition("@")[2]
    if domain in INTERNAL_DOMAINS:
        raise HTTPException(400, "That is a company email - employees sign in with their Microsoft account and are managed in People, not here")
    if not (body.first_name or "").strip():
        raise HTTPException(400, "first_name is required")

    existing = (db.query(NexusEmployee)
                .filter(func.lower(NexusEmployee.work_email) == email).first())
    if existing:
        if (existing.identity_type or "internal") in _EXTERNAL_TYPES:
            raise HTTPException(409, "This email is already enrolled as an external user - edit or reactivate it instead")
        raise HTTPException(400, "This email already belongs to a person in People")

    now = _now()
    row = NexusEmployee(
        id=str(uuid.uuid4()),
        employee_code="",            # externals never get a GG-xxx code
        first_name=body.first_name.strip(),
        last_name=(body.last_name or "").strip(),
        work_email=email,
        identity_type="guest",       # external partner login (Tier B in the July plan)
        status="active",
        external_company=(body.company or "").strip(),
        invited_by=user["email"],
        expires_at=(body.expires_at or "").strip(),
        phone=_clean_phone(body.phone or ""),
        created_by=user["email"],
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.commit()   # the allowlist row exists no matter what the invite does next
    _invalidate(email)

    # No access is granted here: assign a job role / groups in Roles & Access
    # like any employee. Until then the guest is fail-closed to the app shell.

    status, message = _send_invite(db, row, user)
    row.invite_status = status
    db.commit()

    out = _serialize(row)
    out["inviteMessage"] = message
    return out


@router.patch("/{email}")
def update_external_user(email: str, body: ExternalUserUpdate,
                         user: dict = Depends(require_administrator),
                         db: Session = Depends(get_db)):
    email = email.lower().strip()
    row = (db.query(NexusEmployee)
           .filter(func.lower(NexusEmployee.work_email) == email,
                   NexusEmployee.identity_type.in_(_EXTERNAL_TYPES)).first())
    if not row:
        raise HTTPException(404, "External user not found")

    if body.status is not None:
        if body.status not in ("active", "inactive"):
            raise HTTPException(400, "status must be 'active' or 'inactive'")
        row.status = body.status
    if body.first_name is not None:
        if not body.first_name.strip():
            raise HTTPException(400, "first_name cannot be empty")
        row.first_name = body.first_name.strip()
    if body.last_name is not None:
        row.last_name = body.last_name.strip()
    if body.company is not None:
        row.external_company = body.company.strip()
    if body.expires_at is not None:
        row.expires_at = body.expires_at.strip()
    if body.phone is not None:
        new_phone = _clean_phone(body.phone)
        if new_phone != (row.phone or ""):
            row.phone = new_phone
            row.phone_verified_at = ""   # a changed number is unverified again

    row.updated_at = _now()
    db.commit()
    _invalidate(email)
    if body.status == "inactive":
        # Log them out everywhere and void outstanding codes, immediately -
        # don't wait for the policy cache TTL.
        from routers.external_auth import revoke_credentials
        revoke_credentials(db, email)
    return _serialize(row)


@router.post("/{email}/invite")
def resend_invite(email: str, user: dict = Depends(require_administrator),
                  db: Session = Depends(get_db)):
    """Re-send the invitation for an enrolled external user. Idempotent: the
    primary path mints a FRESH single-use activation link (killing prior ones)
    and emails it; the legacy Graph path just re-sends the B2B redemption.
    Updates the stored invite status either way."""
    email = email.lower().strip()
    row = (db.query(NexusEmployee)
           .filter(func.lower(NexusEmployee.work_email) == email,
                   NexusEmployee.identity_type.in_(_EXTERNAL_TYPES)).first())
    if not row:
        raise HTTPException(404, "External user not found")

    status, message = _send_invite(db, row, user)
    row.invite_status = status
    row.updated_at = _now()
    db.commit()

    out = _serialize(row)
    out["inviteMessage"] = message
    return out


@router.delete("/{email}")
def remove_external_user(email: str, user: dict = Depends(require_administrator),
                         db: Session = Depends(get_db)):
    """Permanent Remove (Visesh, Aug 18): hard-delete the guest's person row
    plus their group memberships, role row, and access scopes. Unlike
    Deactivate (reversible, keeps the record) this erases them from Nexus -
    they would have to be re-invited from scratch. ONLY guest/external rows:
    employees are never deletable here. Their historical footprint (tasks they
    were assigned, comments, audit entries) stays untouched - the email simply
    no longer resolves to a person, and name resolution falls back to the
    email-derived form the same way it already does for any unknown address.
    The Entra guest account is NOT touched - deleting it is optional cleanup."""
    email = email.lower().strip()
    row = (db.query(NexusEmployee)
           .filter(func.lower(NexusEmployee.work_email) == email,
                   NexusEmployee.identity_type.in_(_EXTERNAL_TYPES)).first())
    if not row:
        raise HTTPException(404, "External user not found")

    db.query(NexusGroupMember).filter(NexusGroupMember.email == email).delete(synchronize_session=False)
    db.query(NexusRole).filter(NexusRole.email == email).delete(synchronize_session=False)
    db.query(NexusAccessScope).filter(NexusAccessScope.email == email).delete(synchronize_session=False)
    db.delete(row)
    db.commit()
    _invalidate(email)
    # Void outstanding codes/invite links and kill live sessions immediately.
    from routers.external_auth import revoke_credentials
    revoke_credentials(db, email)
    return {"removed": email}
