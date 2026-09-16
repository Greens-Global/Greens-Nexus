"""My HR - employee self-service (baseline: every signed-in employee).

Shows ONLY the caller's own record. The HR module stays the admin console for
the HR team; this router is the scoped-to-self counterpart:
  - my profile (safe fields - never compensation/bank/notes/status_log)
  - self-service edits to contact + emergency-contact fields
  - my signed documents (sealed e-sign PDFs where I was a party)
Leave (time off) reuses the existing /timeclock/timeoff endpoints.
"""
import html as html_lib
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from database import get_db
from auth import get_current_user
from models import (NexusEmployee, HrEntity, HrSignRequest, HrSignParty, HrDocument,
                    HrSelfRequest, ItemAssignment, ItemCheckout,
                    NexusGroup, NexusGroupMember, NexusNotification)
from routers.hr import (_SUPABASE_URL, _storage_headers, _DOC_BUCKET,
                        _AVATAR_BUCKET, _IMAGE_TYPES, _MAX_AVATAR_BYTES)
from routers.esign import _log

router = APIRouter(prefix="/myhr", tags=["My HR"], dependencies=[Depends(get_current_user)])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _me(db: Session, email: str) -> NexusEmployee:
    row = (db.query(NexusEmployee)
           .filter(func.lower(NexusEmployee.work_email) == email.lower()).first())
    if not row:
        raise HTTPException(404, "No HR record is linked to your account yet - ask HR to add you.")
    return row


def _profile_dict(e: NexusEmployee, db: Session) -> dict:
    """Own-record view: everything about *me* except restricted HR-side data."""
    manager = None
    if e.manager_email:
        m = (db.query(NexusEmployee)
             .filter(func.lower(NexusEmployee.work_email) == e.manager_email.lower()).first())
        if m:
            manager = f"{m.first_name} {m.last_name}".strip()
    personal = dict(e.personal or {})
    personal.pop("nationalId", None)          # masked IDs stay HR-side
    return {
        "employeeCode": e.employee_code, "firstName": e.first_name, "lastName": e.last_name,
        "workEmail": e.work_email, "personalEmail": e.personal_email, "phone": e.phone,
        "jobTitle": e.job_title, "department": e.department, "employmentType": e.employment_type,
        "startDate": e.start_date, "manager": manager or "", "photoUrl": e.photo_url,
        "location": e.location, "status": e.status, "personal": personal,
    }


@router.get("/profile")
def my_profile(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _profile_dict(_me(db, user["email"]), db)


class ProfileIn(BaseModel):
    personal_email: Optional[str] = None
    phone: Optional[str] = None
    emergency_name: Optional[str] = None
    emergency_relationship: Optional[str] = None
    emergency_phone: Optional[str] = None


@router.put("/profile")
def save_profile(body: ProfileIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Self-service subset only: contact details + emergency contact. Anything
    else (name, job, department, bank, …) goes through HR."""
    e = _me(db, user["email"])
    if body.personal_email is not None:
        e.personal_email = body.personal_email.strip()[:200]
    if body.phone is not None:
        e.phone = body.phone.strip()[:50]
    if any(v is not None for v in (body.emergency_name, body.emergency_relationship, body.emergency_phone)):
        personal = dict(e.personal or {})
        emergency = dict(personal.get("emergency") or {})
        if body.emergency_name is not None:
            emergency["name"] = body.emergency_name.strip()[:120]
        if body.emergency_relationship is not None:
            emergency["relationship"] = body.emergency_relationship.strip()[:60]
        if body.emergency_phone is not None:
            emergency["phone"] = body.emergency_phone.strip()[:50]
        personal["emergency"] = emergency
        e.personal = personal
    e.updated_at = _now()
    db.commit()
    return _profile_dict(e, db)


# ── My profile photo - every employee can add/change/remove their own,
#    without the "hr" Access Group grant hr.py's admin upload_photo needs
#    (Neil: "My Profile" in the header dropdown was a dead button - no
#    self-service path to a photo existed at all). ─────────────────────────

@router.post("/profile/photo")
async def upload_my_photo(file: UploadFile = File(...),
                          user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    e = _me(db, user["email"])
    ext = _IMAGE_TYPES.get(file.content_type or "")
    if not ext:
        raise HTTPException(400, "Photo must be JPEG, PNG, WebP or GIF")
    data = await file.read()
    if len(data) > _MAX_AVATAR_BYTES:
        raise HTTPException(400, "Photo must be under 5 MB")
    path = f"{e.id}/{uuid.uuid4()}.{ext}"
    resp = httpx.post(
        f"{_SUPABASE_URL}/storage/v1/object/{_AVATAR_BUCKET}/{path}",
        headers={**_storage_headers(), "Content-Type": file.content_type,
                 "cache-control": "max-age=31536000"},
        content=data, timeout=60,
    )
    if not resp.is_success:
        raise HTTPException(502, f"Storage upload failed: {resp.text[:200]}")
    e.photo_url = f"{_SUPABASE_URL}/storage/v1/object/public/{_AVATAR_BUCKET}/{path}"
    e.updated_at = _now()
    db.commit()
    return _profile_dict(e, db)


@router.delete("/profile/photo")
def remove_my_photo(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    e = _me(db, user["email"])
    e.photo_url = ""
    e.updated_at = _now()
    db.commit()
    return _profile_dict(e, db)


# ── Email signature (Sep 16, Neil): text-based (not an image, so it isn't
# blocked by clients that don't trust images from a new sender) signature
# built from the company's branding + this person's directory record. Name,
# role and company e-mail always come straight from the directory - the only
# self-service fields are a preferred display name, phone override and a
# choice of visual template, so the signature can't be used to impersonate a
# different role/title/e-mail ("keeps everybody honest" - Neil). Delivery
# into Outlook itself is a separate, not-yet-decided piece (Exchange
# transport rule vs. Outlook add-in) - for now this gives the employee HTML
# they can copy in.

_BRAND_GREEN = "#1f8a4d"

# Preset sign-off lines for the script-style templates (Sincerely/Kind Regards) -
# a short pick-list, not free text, so it stays professional and consistent
# (Pranshu, Sep 16). '' = no closing line / template's own default.
SIGNATURE_CLOSINGS = ["", "Sincerely", "Best regards", "Kind regards", "Warm regards"]

def _signature_fields(e: NexusEmployee, db: Session) -> dict:
    company = db.query(HrEntity).filter(HrEntity.id == e.company).first() if e.company else None
    full_name = (e.display_name or f"{e.first_name} {e.last_name}").strip()
    preferred = (e.signature_display_name or "").strip()
    # Preferred name is shown ALONGSIDE the real name, never in place of it -
    # "Pranshu Pandey (PP)", not just "PP" - so the signature still reads as
    # who someone actually is (Pranshu, Sep 16: was fully replacing the name).
    name = f"{full_name} ({preferred})" if preferred and preferred.lower() != full_name.lower() else full_name
    role = (e.designation or e.job_title or "").strip()
    phone = (e.signature_phone or e.phone or "").strip()
    return {
        "name": name, "role": role, "phone": phone, "email": e.work_email or "",
        "photoUrl": e.photo_url or "",
        "closing": (e.signature_closing or "").strip(),
        "logoUrl": (company.logo_url if company else "") or "",
        "website": (company.website if company else "") or "",
        "address": (company.registered_address if company else "") or "",
        "companyPhone": (company.main_phone if company else "") or "",
        "companyName": (company.name if company else "") or "",
        "facebookUrl": (company.facebook_url if company else "") or "",
        "linkedinUrl": (company.linkedin_url if company else "") or "",
        "twitterUrl": (company.twitter_url if company else "") or "",
        "instagramUrl": (company.instagram_url if company else "") or "",
    }


_SCRIPT_FONT = "'Brush Script MT','Segoe Script',cursive"


def _social_icons(f: dict) -> str:
    """Small monochrome-brand circular badges (text glyphs, not hosted images -
    stays a real text-based signature, no image blocking)."""
    links = [(f["facebookUrl"], "f"), (f["linkedinUrl"], "in"), (f["twitterUrl"], "X"), (f["instagramUrl"], "ig")]
    badges = "".join(
        f'<a href="{url}" style="text-decoration:none;display:inline-block;width:22px;height:22px;'
        f'border-radius:50%;background:{_BRAND_GREEN};color:#ffffff;font-size:10px;font-weight:bold;'
        f'text-align:center;line-height:22px;margin-right:6px;">{label}</a>'
        for url, label in links if url
    )
    return badges


def _role_company_line(f: dict) -> str:
    if f["role"] and f["companyName"]:
        return f'{f["role"]}, {f["companyName"]}'
    return f["role"] or f["companyName"]


def _render_classic(f: dict) -> str:
    rows = "".join(
        f'<tr><td style="padding:2px 0;color:#333333;">{v}</td></tr>'
        for v in (f["role"], f"Phone: {f['phone']}" if f["phone"] else "",
                  f"Email: {f['email']}" if f["email"] else "", f["website"], f["address"])
        if v
    )
    logo_cell = (f'<td style="padding-right:14px;vertical-align:top;">'
                 f'<img src="{f["logoUrl"]}" alt="" style="max-height:60px;max-width:160px;" /></td>'
                 if f["logoUrl"] else "")
    return (
        '<table style="font-family:Arial,Helvetica,sans-serif;font-size:13px;border-collapse:collapse;">'
        f'<tr>{logo_cell}<td style="vertical-align:top;">'
        f'<table style="border-collapse:collapse;"><tr><td style="font-weight:bold;color:#111111;padding-bottom:2px;">{f["name"]}</td></tr>'
        f'{rows}</table></td></tr></table>'
    )


def _render_modern(f: dict) -> str:
    contact = " &nbsp;|&nbsp; ".join(v for v in (
        f"Phone: {f['phone']}" if f["phone"] else "",
        f"Email: {f['email']}" if f["email"] else "", f["website"],
    ) if v)
    logo_row = (f'<tr><td colspan="2" style="padding-top:8px;"><img src="{f["logoUrl"]}" alt="" '
                f'style="max-height:44px;max-width:150px;" /></td></tr>' if f["logoUrl"] else "")
    return (
        f'<table style="font-family:Arial,Helvetica,sans-serif;font-size:13px;border-collapse:collapse;">'
        f'<tr><td style="border-left:3px solid {_BRAND_GREEN};padding-left:12px;">'
        f'<div style="font-size:15px;font-weight:bold;color:#111111;">{f["name"]}</div>'
        f'<div style="color:{_BRAND_GREEN};font-weight:600;margin:2px 0 6px;">{f["role"]}</div>'
        f'<div style="color:#555555;">{contact}</div>'
        f'</td></tr>{logo_row}</table>'
    )


def _render_minimal(f: dict) -> str:
    line = " &middot; ".join(v for v in (
        f["role"], f"Phone: {f['phone']}" if f["phone"] else "",
        f"Email: {f['email']}" if f["email"] else "",
    ) if v)
    tail = f" &nbsp;&mdash;&nbsp; {line}" if line else ""
    return (
        '<div style="font-family:Arial,Helvetica,sans-serif;font-size:12.5px;color:#333333;">'
        f'<span style="font-weight:bold;color:#111111;">{f["name"]}</span>'
        f'{tail}'
        '</div>'
    )


def _render_bold(f: dict) -> str:
    logo_cell = (f'<td style="padding-right:16px;"><img src="{f["logoUrl"]}" alt="" '
                 f'style="max-height:52px;max-width:150px;" /></td>' if f["logoUrl"] else "")
    rows = "".join(
        f'<tr><td style="padding:1px 0;color:#444444;font-size:12.5px;">{v}</td></tr>'
        for v in (f"Phone: {f['phone']}" if f["phone"] else "",
                  f"Email: {f['email']}" if f["email"] else "", f["website"], f["address"])
        if v
    )
    role_span = (f'<span style="color:#eafff2;font-size:12.5px;"> &nbsp;&middot;&nbsp; {f["role"]}</span>'
                 if f["role"] else "")
    return (
        '<table style="font-family:Arial,Helvetica,sans-serif;border-collapse:collapse;">'
        f'<tr><td style="background:{_BRAND_GREEN};padding:10px 14px;border-radius:4px 4px 0 0;" colspan="2">'
        f'<span style="color:#ffffff;font-size:15px;font-weight:bold;">{f["name"]}</span>'
        f'{role_span}'
        '</td></tr>'
        f'<tr><td style="border:1px solid #e2e2e2;border-top:none;padding:10px 14px;" colspan="2">'
        f'<table style="border-collapse:collapse;"><tr>{logo_cell}<td style="vertical-align:top;">'
        f'<table style="border-collapse:collapse;">{rows}</table></td></tr></table>'
        '</td></tr></table>'
    )


def _render_sincerely(f: dict) -> str:
    closing = f["closing"] or "Sincerely"
    photo_cell = (f'<td style="padding-right:14px;vertical-align:top;">'
                  f'<img src="{f["photoUrl"]}" alt="" width="64" height="64" '
                  f'style="border-radius:50%;object-fit:cover;" /></td>' if f["photoUrl"] else "")
    rows = "".join(
        f'<tr><td style="padding:2px 0;color:#333333;">{v}</td></tr>'
        for v in (f"Phone: {f['phone']}" if f["phone"] else "",
                  f"Email: {f['email']}" if f["email"] else "", f["website"])
        if v
    )
    social = _social_icons(f)
    social_row = f'<tr><td colspan="2" style="padding-top:10px;">{social}</td></tr>' if social else ""
    role_line = _role_company_line(f)
    return (
        '<table style="font-family:Arial,Helvetica,sans-serif;font-size:13px;border-collapse:collapse;">'
        f'<tr><td colspan="2" style="font-family:{_SCRIPT_FONT};font-size:22px;color:#333333;padding-bottom:8px;">{closing},</td></tr>'
        f'<tr>{photo_cell}<td style="vertical-align:top;">'
        f'<div style="font-weight:bold;color:#111111;font-size:14px;">{f["name"]}</div>'
        f'<div style="color:{_BRAND_GREEN};font-weight:600;margin-bottom:4px;">{role_line}</div>'
        f'<table style="border-collapse:collapse;">{rows}</table>'
        '</td></tr>'
        f'{social_row}'
        '</table>'
    )


def _render_kind_regards(f: dict) -> str:
    closing = f["closing"] or "Kind regards"
    photo_cell = (f'<td style="padding-right:12px;vertical-align:top;">'
                  f'<img src="{f["photoUrl"]}" alt="" width="56" height="56" '
                  f'style="border-radius:8px;object-fit:cover;" />'
                  + (f'<div style="padding-top:8px;">{_social_icons(f)}</div>' if _social_icons(f) else "")
                  + '</td>' if f["photoUrl"] else "")
    rows = "".join(
        f'<tr><td style="padding:2px 0;color:#333333;">{v}</td></tr>'
        for v in (f"Phone: {f['phone']}" if f["phone"] else "",
                  f"Email: {f['email']}" if f["email"] else "", f["website"])
        if v
    )
    # No photo -> the social row still needs somewhere to live.
    social = _social_icons(f)
    fallback_social = f'<tr><td colspan="2" style="padding-top:8px;">{social}</td></tr>' if not f["photoUrl"] and social else ""
    role_line = _role_company_line(f)
    return (
        '<table style="font-family:Arial,Helvetica,sans-serif;font-size:13px;border-collapse:collapse;">'
        f'<tr><td colspan="2" style="font-family:{_SCRIPT_FONT};font-size:22px;color:#333333;padding-bottom:8px;">{closing},</td></tr>'
        f'<tr>{photo_cell}<td style="border-left:2px solid {_BRAND_GREEN};padding-left:12px;vertical-align:top;">'
        f'<div style="font-weight:bold;color:{_BRAND_GREEN};font-size:14px;">{f["name"]}</div>'
        f'<div style="color:#333333;margin-bottom:4px;">{role_line}</div>'
        f'<table style="border-collapse:collapse;">{rows}</table>'
        '</td></tr>'
        f'{fallback_social}'
        '</table>'
    )


# id -> (label, render fn). Order here is the gallery order shown to employees.
SIGNATURE_TEMPLATES = {
    "classic":   ("Classic", _render_classic),
    "modern":    ("Modern", _render_modern),
    "minimal":   ("Minimal", _render_minimal),
    "bold":      ("Bold", _render_bold),
    "sincerely": ("Sincerely", _render_sincerely),
    "regards":   ("Kind Regards", _render_kind_regards),
}
_DEFAULT_TEMPLATE = "classic"


def _render_signature(e: NexusEmployee, db: Session, template: str = None) -> dict:
    fields = _signature_fields(e, db)
    esc = {k: html_lib.escape(v) if isinstance(v, str) else v for k, v in fields.items()}
    tid = template or e.signature_template or _DEFAULT_TEMPLATE
    if tid not in SIGNATURE_TEMPLATES:
        tid = _DEFAULT_TEMPLATE
    return {"fields": fields, "html": SIGNATURE_TEMPLATES[tid][1](esc), "template": tid}


def _signature_dict(e: NexusEmployee, db: Session) -> dict:
    rendered = _render_signature(e, db)
    return {
        **rendered,
        "templates": [{"id": tid, "label": label} for tid, (label, _) in SIGNATURE_TEMPLATES.items()],
        "closings": SIGNATURE_CLOSINGS,
        "canEditDisplayName": True, "canEditPhone": True,
        "displayNameOverride": e.signature_display_name or "",
        "phoneOverride": e.signature_phone or "",
        "closingOverride": e.signature_closing or "",
    }


@router.get("/signature")
def my_signature(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _signature_dict(_me(db, user["email"]), db)


@router.get("/signature/templates")
def my_signature_templates(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """A rendered preview of every template using the caller's own real data,
    for the template-picker gallery (My Profile)."""
    e = _me(db, user["email"])
    return [
        {"id": tid, "label": label, "html": _render_signature(e, db, template=tid)["html"]}
        for tid, (label, _) in SIGNATURE_TEMPLATES.items()
    ]


class SignatureIn(BaseModel):
    display_name: Optional[str] = None   # e.g. "Sahil" -> "Sam" - name/role/e-mail otherwise always come from the directory
    phone:        Optional[str] = None   # e.g. desk line instead of cell
    template:     Optional[str] = None   # one of SIGNATURE_TEMPLATES
    closing:      Optional[str] = None   # one of SIGNATURE_CLOSINGS - only meaningful on the script-style templates


@router.put("/signature")
def save_my_signature(body: SignatureIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    e = _me(db, user["email"])
    if body.display_name is not None:
        e.signature_display_name = body.display_name.strip()[:120]
    if body.phone is not None:
        e.signature_phone = body.phone.strip()[:50]
    if body.closing is not None:
        if body.closing not in SIGNATURE_CLOSINGS:
            raise HTTPException(400, "Unknown closing")
        e.signature_closing = body.closing
    if body.template is not None:
        if body.template not in SIGNATURE_TEMPLATES:
            raise HTTPException(400, "Unknown template")
        e.signature_template = body.template
    e.updated_at = _now()
    db.commit()
    return _signature_dict(e, db)


# ── My documents - sealed e-sign PDFs where I was a party ─────────────────────

@router.get("/documents")
def my_documents(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = user["email"].lower()
    parties = db.query(HrSignParty).filter(HrSignParty.email == email).all()
    out, seen = [], set()
    for p in parties:
        if p.request_id in seen:
            continue
        seen.add(p.request_id)
        req = db.query(HrSignRequest).filter(HrSignRequest.id == p.request_id).first()
        if not req or req.status != "completed" or not req.final_pdf_path:
            continue
        out.append({"requestId": req.id, "title": req.title, "from": req.created_by,
                    "completedAt": req.completed_at, "signedByMe": p.status == "signed"})
    return sorted(out, key=lambda x: x["completedAt"] or "", reverse=True)


# ── Directory card (hover profiles) - safe subset, any signed-in user ────────

def _person_name(e) -> str:
    """How a person is named across the app. Prefers the Entra/Teams
    displayName, which is what colleagues recognize - first+last silently drops
    middle names, so "Sagar Kumar Shoundik" in Teams read as "Sagar Shoundik"
    here. Empty until an M365 sync has run, hence the fallback."""
    return (e.display_name or "").strip() or f"{e.first_name} {e.last_name}".strip() or e.work_email


@router.get("/directory")
def people_directory(include_external: bool = False,
                     user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The curated Nexus People list (nexus_employees) as a name+email picker -
    NOT the ~150-account M365 GAL. Any signed-in user can call it (same shape as
    /roles/directory), so modules like Item Management can assign to real Nexus
    people. Only people with a work email are included (assignment/notification
    needs a mailbox); offboarded staff are excluded.

    Cached (cache.py): every picker app-wide loads this list on mount, and it
    only changes on HR edits/M365 sync - the single hottest read for its rate
    of change.

    COMPANY WALL (Aug 2026): this is the one picker every module uses, so it is
    the primary tenant choke point - once the walls are armed, a caller sees only
    people in their own companies (auth.company_scope), which is what stops
    cross-company task assignment, @mentions, followers and watchers at the
    source. The cache key carries the caller's company set; employee/entity edits
    flush the whole namespace (cache._WATCHED), and a scope change moves the caller
    to a different key, so per-wall caching stays correct. Walls off (or a Global
    Admin) → scope None → the old single 'all' list, unchanged.

    `include_external=true` adds guest/external identities, each flagged
    `external: true`. Off by default, because this list is what every picker in
    the app loads: an external belongs in a task's Assignee and Collaborators
    (Sagar, Sept 2 2026 - they do the work), not in an approver list, a service
    desk agent list or an HR picker. Callers opt in one at a time."""
    import cache, auth
    scope = auth.company_scope(user, db)
    key = "all" if scope is None else ("co:" + ",".join(sorted(scope)) if scope else "co:none")
    # Separate cache entry: the two lists differ in content, and the default one
    # must never be served an externals-included payload.
    if include_external:
        key += "+ext"
    cached = cache.people_directory.get(key)
    if cached is not None:
        return cached
    # External users (Aug 17) are excluded by default: guest/external identities
    # stay out of people pickers, assignment lists and every org-wide people
    # surface built on this directory unless the caller asks for them.
    # NULL-safe: legacy rows have no identity_type, and `notin_` alone would
    # silently drop them too.
    from sqlalchemy import or_, false
    q = (db.query(NexusEmployee)
              .filter(NexusEmployee.status != "offboarded")
              .filter(NexusEmployee.work_email != ""))
    if not include_external:
        q = q.filter(or_(NexusEmployee.identity_type.is_(None),
                         NexusEmployee.identity_type.notin_(("guest", "external"))))
    if scope is not None:
        # Company wall: only people in the caller's companies; fail closed if none.
        q = q.filter(NexusEmployee.company.in_(list(scope))) if scope else q.filter(false())
    rows = q.order_by(NexusEmployee.first_name, NexusEmployee.last_name).all()
    # company is the ENTITY ID on the employee row; resolve the display name once
    # so pickers can offer company/department filters without an HR-gated call.
    ent_names = {en.id: en.name for en in db.query(HrEntity).all()}
    out = [{"email": e.work_email, "name": _person_name(e), "photoUrl": e.photo_url or "",
            "company": e.company or "", "companyName": ent_names.get(e.company or "", ""),
            "department": e.department or "",
            # Flagged, not silently mixed in - a picker that offers externals
            # should be able to say which ones they are.
            "external": (e.identity_type or "") in ("guest", "external")}
           for e in rows]
    cache.people_directory.set(key, out)
    return out


@router.get("/person")
def person_card(q: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Outlook-style contact card by name or email: name, title, department,
    photo - never personal/comp data. Powers hover cards on notifications etc."""
    q = (q or "").strip().lower()
    if len(q) < 2:
        raise HTTPException(400, "q too short")
    match = None
    for e in db.query(NexusEmployee).filter(NexusEmployee.status != "offboarded").all():
        # Both spellings are searchable: people type the Teams name they see,
        # but older links and emails still carry the first+last form.
        names = {f"{e.first_name} {e.last_name}".strip().lower(), _person_name(e).lower()} - {""}
        if q == (e.work_email or "").lower() or q in names:
            match = e
            break
        if match is None and (any(q in n for n in names) or q in (e.work_email or "").lower()):
            match = e
    if not match:
        raise HTTPException(404, "No matching person")
    return {"name": _person_name(match),
            "jobTitle": match.job_title, "department": match.department,
            "photoUrl": match.photo_url, "workEmail": match.work_email,
            "location": match.location, "status": match.status}


# ── My equipment - items assigned / checked out to me ────────────────────────

@router.get("/assets")
def my_assets(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = user["email"].lower()
    assignments = (db.query(ItemAssignment)
                   .filter(func.lower(ItemAssignment.assignee_email) == email,
                           ItemAssignment.status == "active")
                   .order_by(ItemAssignment.accepted_at.desc()).all())
    checkouts = (db.query(ItemCheckout)
                 .filter(func.lower(ItemCheckout.requested_by_email) == email,
                         ItemCheckout.status.in_(["approved", "allocated", "pending_receipt"]))
                 .order_by(ItemCheckout.created_at.desc()).all())
    def due_of(c):
        start = c.allocated_at or c.created_at
        if not start or c.status != "allocated":
            return ""
        try:
            return (datetime.fromisoformat(start.replace("Z", "+00:00"))
                    + timedelta(days=c.days or 1)).strftime("%Y-%m-%d")
        except Exception:
            return ""
    return {
        "assignments": [{"item": a.item_name, "since": (a.accepted_at or "")[:10]} for a in assignments],
        "checkouts": [{"item": c.item_name, "status": c.status, "due": due_of(c)} for c in checkouts],
    }


# ── Ask HR - employee requests (document updates, profile changes, questions) ─

_REQ_TYPES = ("document", "profile", "question", "other")
_REQ_LABEL = {"document": "Document update", "profile": "Profile change",
              "question": "Question", "other": "Request"}


def _hr_team_emails(db: Session) -> list:
    """Everyone in an Access Group that grants the hr module - the audience for
    'Ask HR' notifications. Falls back to empty (request still lands in the HR
    module's Requests panel)."""
    out = set()
    for g in db.query(NexusGroup).all():
        if "hr:" in (g.allowed_modules or ""):
            for m in db.query(NexusGroupMember).filter(NexusGroupMember.group_id == g.id).all():
                out.add(m.email.lower())
    return sorted(out)


def _ser_req(r: HrSelfRequest) -> dict:
    return {"id": r.id, "email": r.employee_email, "name": r.employee_name,
            "type": r.type, "message": r.message, "status": r.status,
            "attachmentName": r.attachment_name or "",
            "response": r.response or "", "resolvedBy": r.resolved_by or "",
            "resolvedAt": r.resolved_at or "", "createdAt": r.created_at}


class AskHrIn(BaseModel):
    type: str = "document"
    message: str
    attachment_path: Optional[str] = ""
    attachment_name: Optional[str] = ""


@router.post("/requests/attachment")
async def upload_request_attachment(file: UploadFile = File(...),
                                    user: dict = Depends(get_current_user)):
    """Stage the document an employee wants HR to file - uploaded to the private
    hr-docs bucket, referenced by the request created right after."""
    data = await file.read()
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(400, "File too large (max 15 MB)")
    import re as _re
    safe = _re.sub(r"[^a-zA-Z0-9._-]", "_", file.filename or "document")
    path = f"self-requests/{user['email'].lower()}/{uuid.uuid4()}-{safe}"
    resp = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/{_DOC_BUCKET}/{path}",
                      headers={**_storage_headers(), "Content-Type": file.content_type or "application/octet-stream"},
                      content=data, timeout=60)
    if not resp.is_success:
        raise HTTPException(502, f"Storage upload failed: {resp.text[:200]}")
    return {"path": path, "name": file.filename or safe}


@router.post("/requests")
def create_request(body: AskHrIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if body.type not in _REQ_TYPES:
        raise HTTPException(400, f"type must be one of {_REQ_TYPES}")
    msg = (body.message or "").strip()
    if not msg:
        raise HTTPException(400, "Say what you need from HR")
    # Only accept attachment paths this user staged themselves.
    apath = (body.attachment_path or "").strip()
    if apath and not apath.startswith(f"self-requests/{user['email'].lower()}/"):
        raise HTTPException(400, "Bad attachment")
    e = _me(db, user["email"])
    name = f"{e.first_name} {e.last_name}".strip() or user["email"]
    row = HrSelfRequest(id=str(uuid.uuid4()), employee_email=user["email"].lower(),
                        employee_name=name, type=body.type, message=msg[:2000],
                        attachment_path=apath, attachment_name=(body.attachment_name or "")[:200],
                        status="open", created_at=_now())
    db.add(row)
    # One targeted notification per HR-team member (server-side only).
    for email in _hr_team_emails(db):
        db.add(NexusNotification(
            id=str(uuid.uuid4()), type="hr_request", recipient=email,
            title=f"{_REQ_LABEL[body.type]} - {name}",
            body=msg[:300], ref_id=row.id, requested_by=name,
            action="", actioned=False, read_by="", created_at=_now()))
    db.commit()
    return _ser_req(row)


@router.get("/requests")
def my_requests(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (db.query(HrSelfRequest)
            .filter(HrSelfRequest.employee_email == user["email"].lower())
            .order_by(HrSelfRequest.created_at.desc()).limit(30).all())
    return [_ser_req(r) for r in rows]


# ── My paystubs - comp documents HR uploaded for me (kind="paystub") ─────────

@router.get("/paystubs")
def my_paystubs(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    e = _me(db, user["email"])
    rows = (db.query(HrDocument)
            .filter(HrDocument.employee_id == e.id, HrDocument.kind == "paystub")
            .order_by(HrDocument.created_at.desc()).all())
    return [{"id": d.id, "name": d.file_name, "createdAt": d.created_at} for d in rows]


@router.get("/paystubs/{did}/download")
def download_my_paystub(did: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    e = _me(db, user["email"])
    row = (db.query(HrDocument)
           .filter(HrDocument.id == did, HrDocument.employee_id == e.id,
                   HrDocument.kind == "paystub").first())
    if not row:
        raise HTTPException(404, "Paystub not found")
    resp = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/sign/{_DOC_BUCKET}/{row.storage_path}",
                      headers=_storage_headers(), json={"expiresIn": 300}, timeout=20)
    if not resp.is_success:
        raise HTTPException(502, "Could not create download link")
    return {"url": f"{_SUPABASE_URL}/storage/v1{resp.json()['signedURL']}", "expiresIn": 300}


@router.get("/documents/{rid}/download")
def download_my_document(rid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Party-scoped download: you get the sealed PDF only for envelopes you were
    part of - no hr grant needed (it's your own document)."""
    email = user["email"].lower()
    party = (db.query(HrSignParty)
             .filter(HrSignParty.request_id == rid, HrSignParty.email == email).first())
    if not party:
        raise HTTPException(403, "This document isn't yours")
    req = db.query(HrSignRequest).filter(HrSignRequest.id == rid).first()
    if not req or req.status != "completed" or not req.final_pdf_path:
        raise HTTPException(404, "No completed document")
    resp = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/sign/{_DOC_BUCKET}/{req.final_pdf_path}",
                      headers=_storage_headers(), json={"expiresIn": 300}, timeout=20)
    if not resp.is_success:
        raise HTTPException(502, "Could not create download link")
    _log(db, rid, "downloaded", f"by {user['email']} (self-service)")
    db.commit()
    return {"url": f"{_SUPABASE_URL}/storage/v1{resp.json()['signedURL']}", "expiresIn": 300}


# ── my Egnyte documents (Aug 10 - Neil's "wire Contractor Documents to their
# My Documents"; Sep 10 - widened to every folder under the person, keeping
# Egnyte's own folder shape rather than one flattened list). Read-only: the
# employee sees and downloads everything under their OWN person folder
# (people.person-folder), grouped by subfolder exactly as Egnyte has it,
# except the subfolders named in people.my-documents-excluded-subfolder-names
# (Confidential etc) - see egnyte_wiring.list_person_document_groups /
# is_excluded_path. Download goes through here rather than /egnyte/file so
# the server checks the path is inside the caller's own resolved folder and
# not inside a hidden one.

@router.get("/egnyte-documents")
def my_egnyte_documents(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    import egnyte_wiring as wiring
    from services import egnyte as svc
    if not svc.configured():
        return {"available": False}
    try:
        emp = _me(db, user["email"])
    except HTTPException:
        return {"available": False}
    res = wiring.resolve_person_folder("people.person-folder", emp, db)
    if not res["folder"]:
        return {"available": False}
    groups = wiring.list_person_document_groups(res["folder"])
    if groups is None:
        return {"available": False}     # folder not created yet - show nothing
    return {"available": True, "folder": res["folder"], **groups}


@router.get("/egnyte-documents/file")
def my_egnyte_document_file(path: str, inline: bool = False, user: dict = Depends(get_current_user),
                            db: Session = Depends(get_db)):
    import egnyte_wiring as wiring
    from services import egnyte as svc
    from fastapi import Response
    from routers.egnyte import preview_type
    if not svc.configured():
        raise HTTPException(503, "Egnyte is not connected")
    emp = _me(db, user["email"])
    res = wiring.resolve_person_folder("people.person-folder", emp, db)
    folder = res["folder"]
    want = svc.norm(path)
    if not folder or not want.startswith(svc.norm(folder) + "/") or wiring.is_excluded_path(folder, want):
        raise HTTPException(403, "That file is not in your documents folder")
    content = svc.read_file(want)
    name = want.rsplit("/", 1)[-1] or "download"
    # inline=true asks to VIEW rather than download - same allowlist as
    # /egnyte/file (PDFs, images, text) so a non-allowlisted type still
    # forces a download instead of the browser guessing at content type.
    kind = preview_type(name) if inline else None
    disposition = "inline" if kind else "attachment"
    return Response(
        content=content,
        media_type=kind or "application/octet-stream",
        headers={"Content-Disposition": f'{disposition}; filename="{name}"',
                 "X-Content-Type-Options": "nosniff",
                 "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"},
    )
