"""My HR - employee self-service (baseline: every signed-in employee).

Shows ONLY the caller's own record. The HR module stays the admin console for
the HR team; this router is the scoped-to-self counterpart:
  - my profile (safe fields - never compensation/bank/notes/status_log)
  - self-service edits to contact + emergency-contact fields
  - my signed documents (sealed e-sign PDFs where I was a party)
Leave (time off) reuses the existing /timeclock/timeoff endpoints.
"""
import html as html_lib
import re
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
from services.countries import COUNTRY_DIAL, NANP_COUNTRIES

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


def _format_signature_phone(raw: str, country_code: str) -> str:
    """Prefix the employee's signature phone with their COMPANY's country's
    dial code (Pranshu, Sep 19: "NEXUS should be smart enough to fetch what
    is the country selected for the employee... show the number" in the
    right format) - +91 7595898853 for India, +1 (949) 201-9160 for the US.
    US/Canada (NANP) get the familiar "(area) exchange-line" grouping;
    everywhere else just gets "<dial code> <digits>", since no other
    country's local grouping convention is assumed. A raw value already
    starting with "+" (an employee who typed their own international
    prefix) is trusted as-is and left untouched."""
    raw = (raw or "").strip()
    if not raw or raw.startswith("+"):
        return raw
    digits = re.sub(r"\D", "", raw)
    if not digits:
        return raw
    dial = COUNTRY_DIAL.get((country_code or "").upper(), "")
    if not dial:
        return raw
    if (country_code or "").upper() in NANP_COUNTRIES and len(digits) >= 10:
        d = digits[-10:]
        return f"{dial} ({d[0:3]}) {d[3:6]}-{d[6:10]}"
    return f"{dial} {digits}"


def _signature_fields(e: NexusEmployee, db: Session) -> dict:
    company = db.query(HrEntity).filter(HrEntity.id == e.company).first() if e.company else None
    full_name = (e.display_name or f"{e.first_name} {e.last_name}").strip()
    preferred = (e.signature_display_name or "").strip()
    # Preferred name is shown ALONGSIDE the real name, never in place of it -
    # "Pranshu Pandey "PP"", not just "PP" - so the signature still reads as
    # who someone actually is (Pranshu, Sep 16: was fully replacing the name;
    # Sep 19: switched from parens to quotes around the preferred name).
    name = f'{full_name} "{preferred}"' if preferred and preferred.lower() != full_name.lower() else full_name
    role = (e.designation or e.job_title or "").strip()
    # THIS employee's own country, not their company's (Sep 19: "phone number
    # in sign should be pulled from HR directory not from company setup" - a
    # company's registered country doesn't always match where a given
    # employee actually is, e.g. a US-registered company with staff in
    # India). Falls back to the company's country for anyone who hasn't set
    # their own yet, so existing signatures don't regress to no dial code.
    phone_country = (e.country or "").strip() or (company.country if company else "") or ""
    phone = _format_signature_phone((e.signature_phone or e.phone or "").strip(), phone_country)
    return {
        "name": name, "role": role, "phone": phone, "email": e.work_email or "",
        "photoUrl": e.photo_url or "",
        # Sign-off is personal now (Sep 19, Pranshu: "Admin should not have
        # the control of Sign off... it should be employee specific") - was
        # a company-wide admin choice (Sep 16); each employee sets their own
        # from My Profile, free text, not just a preset pick.
        "closing": (e.signature_closing or "").strip(),
        # This employee's own logo wins over the company's (Sep 19, Pranshu:
        # "i want to have employee the ability to upload the logo for their
        # signature... rest format of sign remain same") - everything else
        # in this dict is untouched, so swapping the logo alone can't change
        # name/role/email/address/socials/template.
        "logoUrl": (e.signature_logo_url or "").strip() or (company.logo_url if company else "") or "",
        "website": (company.website if company else "") or "",
        "address": ((company.physical_address or company.registered_address) if company else "") or "",
        "companyPhone": (company.main_phone if company else "") or "",
        "companyName": (company.name if company else "") or "",
        "facebookUrl": (company.facebook_url if company else "") or "",
        # Personal, not the company's (Sep 19) - see NexusEmployee.linkedin_url.
        "linkedinUrl": (e.linkedin_url or "").strip(),
        "twitterUrl": (company.twitter_url if company else "") or "",
        "instagramUrl": (company.instagram_url if company else "") or "",
    }


_SCRIPT_FONT = "'Brush Script MT','Segoe Script',cursive"
# The typewriter @keyframes travel WITH the copied HTML (Pranshu, Sep 16:
# "still it is not live" after pasting) - a signature copied via the
# Clipboard API carries its own <style> block into whatever it's pasted
# into, and modern compose surfaces (Outlook Web, New Outlook/WebView2,
# Gmail) are just Chromium pages, so the reveal genuinely plays there, not
# only in our own preview. Classic Win32 Outlook's Word rendering engine
# doesn't run CSS animations - there the line still renders, just as
# static text with no animation, because the base/fallback state below is
# NOT clipped (width kept at 100% for that reason; only the parent
# scoping class is inert if unsupported).
_TYPEWRITER_CSS = (
    '<style>@keyframes sigTypewriter{from{width:0}to{width:100%}}'
    '.sig-closing{display:inline-block;overflow:hidden;white-space:nowrap;'
    'width:100%;animation:sigTypewriter 1.1s steps(24,end) 1}</style>'
)


def _normalize_url(url: str) -> str:
    """A social URL saved without a scheme (e.g. "linkedin.com/in/x", or an
    employee pasting the wrong thing entirely) renders as a RELATIVE link -
    the browser/mail client resolves it against whatever page the signature
    happens to be copied from, not the real external site (Sep 19: reported
    as the LinkedIn icon in a copied signature pointing at
    "https://dev.nexus.../admin-console/www.linkedin.com/..." instead of
    LinkedIn itself). Defaults a missing scheme to https:// rather than
    silently producing a broken href."""
    url = (url or "").strip()
    if not url or re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", url):
        return url
    return f"https://{url}"


_ICON_PHONE = "☎"   # BLACK TELEPHONE
_ICON_EMAIL = "✉"   # ENVELOPE
# Unicode glyphs, not an <img>/inline <svg> (Sep 19, Pranshu: "icon for phone
# and email instead of 'phone' and 'email'") - a real character renders
# everywhere a signature gets pasted, including classic Win32 Outlook's Word
# engine, which silently drops inline SVG and blocks a remote image by
# default. `color: inherit` so it always matches whatever color the
# surrounding row/line already uses in that template, no per-template icon
# color to keep in sync.


def _phone_text(f: dict) -> str:
    if not f["phone"]:
        return ""
    return f'<span style="color:inherit;">{_ICON_PHONE}</span>&nbsp;{f["phone"]}'


def _email_text(f: dict) -> str:
    """A live mailto: link (Sep 19: "the email should be responsive...
    if we click on them we should redirect") - text-decoration:none/
    color:inherit so it reads as plain signature text, not a blue web link,
    while still being clickable."""
    if not f["email"]:
        return ""
    return (f'<a href="mailto:{f["email"]}" style="color:inherit;text-decoration:none;">'
            f'<span style="color:inherit;">{_ICON_EMAIL}</span>&nbsp;{f["email"]}</a>')


def _website_text(f: dict) -> str:
    """Same live-link treatment for the company URL (Sep 19: "the company
    url also... if we click on them we should redirect") - _normalize_url
    is the same defaulting-to-https:// guard the social icons already use,
    so a URL saved without a scheme still resolves to the real external
    site instead of relative to wherever the signature was pasted."""
    if not f["website"]:
        return ""
    return f'<a href="{_normalize_url(f["website"])}" style="color:inherit;text-decoration:none;">{f["website"]}</a>'


def _logo_img(f: dict, img_style: str) -> str:
    """The logo <img>, wrapped in a link to the company URL when there is one
    (Sep 19, Pranshu: "keep the relation between the logo and the company
    URL... if any person click on the logo from email it should redirect to
    company URL"). No wrapper at all when there's no website to send anyone
    to - a bare image, same as before this request."""
    if not f["logoUrl"]:
        return ""
    img = f'<img src="{f["logoUrl"]}" alt="" style="{img_style}" />'
    if f["website"]:
        return f'<a href="{_normalize_url(f["website"])}" style="border:none;">{img}</a>'
    return img


def _social_icons(f: dict) -> str:
    """Small monochrome-brand circular badges (text glyphs, not hosted images -
    stays a real text-based signature, no image blocking). Shown on every
    template, not just the script-style ones (Pranshu, Sep 16).

    The background lives on the <td>, never the <a> - mail/webmail paste
    sanitizers (Outlook Web's included) routinely strip background-color off
    anchor tags to stop spoofed-looking links, which was exactly why the
    badges disappeared once copied into a real compose window even though
    they looked fine in our own preview. Table cells keep their background
    everywhere, so this is the standard "bulletproof" email-HTML pattern."""
    links = [(f["facebookUrl"], "f"), (f["linkedinUrl"], "in"), (f["twitterUrl"], "X"), (f["instagramUrl"], "ig")]
    active = [(_normalize_url(url), label) for url, label in links if url]
    if not active:
        return ""
    cells = "".join(
        f'<td style="background:{_BRAND_GREEN};border-radius:50%;text-align:center;" width="22" height="22">'
        f'<a href="{url}" style="color:#ffffff;font-size:10px;font-weight:bold;text-decoration:none;'
        f'display:block;line-height:22px;">{label}</a></td>'
        f'<td style="width:6px;font-size:1px;line-height:1px;">&nbsp;</td>'
        for url, label in active
    )
    return f'<table role="presentation" style="border-collapse:collapse;"><tr>{cells}</tr></table>'


def _role_company_line(f: dict) -> str:
    if f["role"] and f["companyName"]:
        return f'{f["role"]}, {f["companyName"]}'
    return f["role"] or f["companyName"]


def _extra_rows(f: dict, color: str = "#333333") -> str:
    """Manual (non-directory) signatures can carry arbitrary label/value pairs
    (Sep 19: "custom addable field") - rendered as extra table rows in the
    same style as phone/email/website/address. Directory-backed employee
    signatures never set "extraFields", so this is a no-op for them."""
    return "".join(
        f'<tr><td style="padding:2px 0;color:{color};">{item["label"]}: {item["value"]}</td></tr>'
        for item in (f.get("extraFields") or []) if item.get("value")
    )


def _extra_inline(f: dict) -> str:
    """Same as `_extra_rows`, for the single-line templates (Modern/Minimal)
    that join their fields with a separator instead of a table."""
    return " &nbsp;|&nbsp; ".join(
        f'{item["label"]}: {item["value"]}'
        for item in (f.get("extraFields") or []) if item.get("value")
    )


def _closing_line(f: dict, style: str) -> str:
    """Plain (non-script) sign-off line for Classic/Modern/Minimal/Bold -
    those four never rendered `closing` at all (only Sincerely/Kind Regards
    did, in their own script font), so an employee's sign-off silently
    vanished on every other template (Sep 19: "Neither the Sign off value is
    getting copied"). Purely optional here - no fallback default text,
    unlike Sincerely/Kind Regards, since these templates have no closing-word
    identity of their own to fall back to."""
    closing = (f.get("closing") or "").strip()
    return f'<div style="{style}">{closing},</div>' if closing else ""


def _render_classic(f: dict) -> str:
    rows = "".join(
        f'<tr><td style="padding:2px 0;color:#333333;">{v}</td></tr>'
        for v in (f["role"], _phone_text(f), _email_text(f), _website_text(f), f["address"])
        if v
    ) + _extra_rows(f)
    logo_cell = (f'<td style="padding-right:14px;vertical-align:top;">'
                 f'{_logo_img(f, "max-height:60px;max-width:160px;")}</td>'
                 if f["logoUrl"] else "")
    social = _social_icons(f)
    social_row = f'<tr><td colspan="2" style="padding-top:8px;">{social}</td></tr>' if social else ""
    closing = _closing_line(f, "color:#333333;padding-bottom:4px;")
    return (
        '<table style="font-family:Arial,Helvetica,sans-serif;font-size:13px;border-collapse:collapse;">'
        f'<tr>{logo_cell}<td style="vertical-align:top;">'
        f'{closing}'
        f'<table style="border-collapse:collapse;"><tr><td style="font-weight:bold;color:#111111;padding-bottom:2px;">{f["name"]}</td></tr>'
        f'{rows}</table></td></tr>'
        f'{social_row}'
        '</table>'
    )


def _render_modern(f: dict) -> str:
    contact = " &nbsp;|&nbsp; ".join(v for v in (_phone_text(f), _email_text(f), _website_text(f)) if v)
    extra_inline = _extra_inline(f)
    if extra_inline:
        contact = f"{contact} &nbsp;|&nbsp; {extra_inline}" if contact else extra_inline
    logo_row = (f'<tr><td colspan="2" style="padding-top:8px;">{_logo_img(f, "max-height:44px;max-width:150px;")}</td></tr>'
                if f["logoUrl"] else "")
    social = _social_icons(f)
    social_row = f'<tr><td colspan="2" style="padding-top:8px;">{social}</td></tr>' if social else ""
    closing = _closing_line(f, "color:#555555;margin-bottom:4px;")
    return (
        f'<table style="font-family:Arial,Helvetica,sans-serif;font-size:13px;border-collapse:collapse;">'
        f'<tr><td style="border-left:3px solid {_BRAND_GREEN};padding-left:12px;">'
        f'{closing}'
        f'<div style="font-size:15px;font-weight:bold;color:#111111;">{f["name"]}</div>'
        f'<div style="color:{_BRAND_GREEN};font-weight:600;margin:2px 0 6px;">{f["role"]}</div>'
        f'<div style="color:#555555;">{contact}</div>'
        f'</td></tr>{logo_row}{social_row}</table>'
    )


def _render_minimal(f: dict) -> str:
    line = " &middot; ".join(v for v in (f["role"], _phone_text(f), _email_text(f)) if v)
    extra_inline = _extra_inline(f)
    if extra_inline:
        line = f"{line} &middot; {extra_inline}" if line else extra_inline
    tail = f" &nbsp;&mdash;&nbsp; {line}" if line else ""
    social = _social_icons(f)
    social_block = f'<div style="margin-top:4px;">{social}</div>' if social else ""
    closing = _closing_line(f, "color:#666666;margin-bottom:3px;")
    return (
        f'{closing}'
        '<div style="font-family:Arial,Helvetica,sans-serif;font-size:12.5px;color:#333333;">'
        f'<span style="font-weight:bold;color:#111111;">{f["name"]}</span>'
        f'{tail}'
        '</div>'
        f'{social_block}'
    )


def _render_bold(f: dict) -> str:
    logo_cell = (f'<td style="padding-right:16px;">{_logo_img(f, "max-height:52px;max-width:150px;")}</td>'
                 if f["logoUrl"] else "")
    rows = "".join(
        f'<tr><td style="padding:1px 0;color:#444444;font-size:12.5px;">{v}</td></tr>'
        for v in (_phone_text(f), _email_text(f), _website_text(f), f["address"])
        if v
    ) + _extra_rows(f, "#444444")
    role_span = (f'<span style="color:#eafff2;font-size:12.5px;"> &nbsp;&middot;&nbsp; {f["role"]}</span>'
                 if f["role"] else "")
    social = _social_icons(f)
    social_block = f'<div style="padding-top:8px;">{social}</div>' if social else ""
    closing = _closing_line(f, "color:#666666;font-size:12.5px;padding-bottom:6px;")
    return (
        '<table style="font-family:Arial,Helvetica,sans-serif;border-collapse:collapse;">'
        f'<tr><td style="background:{_BRAND_GREEN};padding:10px 14px;border-radius:4px 4px 0 0;" colspan="2">'
        f'<span style="color:#ffffff;font-size:15px;font-weight:bold;">{f["name"]}</span>'
        f'{role_span}'
        '</td></tr>'
        f'<tr><td style="border:1px solid #e2e2e2;border-top:none;padding:10px 14px;" colspan="2">'
        f'{closing}'
        f'<table style="border-collapse:collapse;"><tr>{logo_cell}<td style="vertical-align:top;">'
        f'<table style="border-collapse:collapse;">{rows}</table></td></tr></table>'
        f'{social_block}'
        '</td></tr></table>'
    )


def _render_sincerely(f: dict) -> str:
    closing = f["closing"] or "Sincerely"
    logo_cell = (f'<td style="padding-right:14px;vertical-align:top;">'
                 f'{_logo_img(f, "max-height:56px;max-width:120px;")}</td>'
                 if f["logoUrl"] else "")
    rows = "".join(
        f'<tr><td style="padding:2px 0;color:#333333;">{v}</td></tr>'
        for v in (_phone_text(f), _email_text(f), _website_text(f))
        if v
    ) + _extra_rows(f)
    social = _social_icons(f)
    social_row = f'<tr><td colspan="2" style="padding-top:10px;">{social}</td></tr>' if social else ""
    role_line = _role_company_line(f)
    return (
        _TYPEWRITER_CSS +
        '<table style="font-family:Arial,Helvetica,sans-serif;font-size:13px;border-collapse:collapse;">'
        f'<tr><td colspan="2" style="font-family:{_SCRIPT_FONT};font-size:22px;color:#333333;padding-bottom:8px;"><span class="sig-closing">{closing},</span></td></tr>'
        f'<tr>{logo_cell}<td style="vertical-align:top;">'
        f'<div style="font-weight:bold;color:#111111;font-size:14px;">{f["name"]}</div>'
        f'<div style="color:{_BRAND_GREEN};font-weight:600;margin-bottom:4px;">{role_line}</div>'
        f'<table style="border-collapse:collapse;">{rows}</table>'
        '</td></tr>'
        f'{social_row}'
        '</table>'
    )


def _render_kind_regards(f: dict) -> str:
    closing = f["closing"] or "Kind regards"
    logo_cell = (f'<td style="padding-right:12px;vertical-align:top;">'
                 f'{_logo_img(f, "max-height:52px;max-width:110px;")}'
                 + (f'<div style="padding-top:8px;">{_social_icons(f)}</div>' if _social_icons(f) else "")
                 + '</td>' if f["logoUrl"] else "")
    rows = "".join(
        f'<tr><td style="padding:2px 0;color:#333333;">{v}</td></tr>'
        for v in (_phone_text(f), _email_text(f), _website_text(f))
        if v
    ) + _extra_rows(f)
    # No logo -> the social row still needs somewhere to live.
    social = _social_icons(f)
    fallback_social = f'<tr><td colspan="2" style="padding-top:8px;">{social}</td></tr>' if not f["logoUrl"] and social else ""
    role_line = _role_company_line(f)
    return (
        _TYPEWRITER_CSS +
        '<table style="font-family:Arial,Helvetica,sans-serif;font-size:13px;border-collapse:collapse;">'
        f'<tr><td colspan="2" style="font-family:{_SCRIPT_FONT};font-size:22px;color:#333333;padding-bottom:8px;"><span class="sig-closing">{closing},</span></td></tr>'
        f'<tr>{logo_cell}<td style="border-left:2px solid {_BRAND_GREEN};padding-left:12px;vertical-align:top;">'
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


def admin_preview_fields(company) -> dict:
    """Sample fields for the company-wide template picker in Settings - real
    branding, placeholder person data (there's no 'current employee' in an
    admin's company-wide preview, since the choice applies to everyone).
    No closing/LinkedIn here (Sep 19) - both are personal now, so the preview
    just shows each template's own hardcoded default closing line and no
    LinkedIn icon; an employee's real signature fills both from My Profile."""
    domain = ((company.domains or "").split(",")[0].strip() if company and company.domains else "") or "example.com"
    return {
        "name": "Jane Doe", "role": "Job Title", "phone": "(000) 000-0000",
        "email": f"jane.doe@{domain}", "photoUrl": "",
        "closing": "",
        "logoUrl": (company.logo_url if company else "") or "",
        "website": (company.website if company else "") or "",
        "address": ((company.physical_address or company.registered_address) if company else "") or "",
        "companyPhone": (company.main_phone if company else "") or "",
        "companyName": (company.name if company else "") or "",
        "facebookUrl": (company.facebook_url if company else "") or "",
        "linkedinUrl": "",
        "twitterUrl": (company.twitter_url if company else "") or "",
        "instagramUrl": (company.instagram_url if company else "") or "",
    }


def admin_preview_templates(company) -> list:
    """Every template pre-rendered with the company's real branding, for the
    Settings picker (backend/routers/hr.py's /entities/{id}/signature-templates)."""
    fields = admin_preview_fields(company)
    esc = {k: html_lib.escape(v) if isinstance(v, str) else v for k, v in fields.items()}
    return [{"id": tid, "label": label, "html": render_fn(esc)}
            for tid, (label, render_fn) in SIGNATURE_TEMPLATES.items()]


def manual_signature_fields(row, company) -> dict:
    """Field dict for a HrManualSignature row - same shape `_signature_fields`
    builds for a directory employee, so it can reuse the exact same
    SIGNATURE_TEMPLATES render functions (Sep 19: "the same sig for that
    sender email"). No phone/email/social slots (nothing in the manual form
    collects them) - anything extra goes through `extraFields` instead."""
    return {
        "name": row.name, "role": row.title or "", "phone": "", "email": "",
        "photoUrl": "", "closing": "",
        "logoUrl": row.logo_url or "",
        "website": row.url or "",
        "address": row.address or "",
        "companyPhone": "",
        "companyName": row.company_name or "",
        "facebookUrl": "", "linkedinUrl": "", "twitterUrl": "", "instagramUrl": "",
        "extraFields": row.custom_fields or [],
    }


def render_manual_signature(row, company) -> dict:
    fields = manual_signature_fields(row, company)
    esc = {
        k: html_lib.escape(v) if isinstance(v, str) else
           [{"label": html_lib.escape(i.get("label", "")), "value": html_lib.escape(i.get("value", ""))} for i in v]
        for k, v in fields.items()
    }
    tid = (company.signature_template if company else "") or _DEFAULT_TEMPLATE
    if tid not in SIGNATURE_TEMPLATES:
        tid = _DEFAULT_TEMPLATE
    return {"fields": fields, "html": SIGNATURE_TEMPLATES[tid][1](esc), "template": tid}


def _render_signature(e: NexusEmployee, db: Session, template: str = None) -> dict:
    company = db.query(HrEntity).filter(HrEntity.id == e.company).first() if e.company else None
    fields = _signature_fields(e, db)
    esc = {k: html_lib.escape(v) if isinstance(v, str) else v for k, v in fields.items()}
    # Template is a company-wide admin choice (Settings), not personal - an
    # employee's own signature always uses their employer's default, never a
    # per-person pick (Pranshu, Sep 16).
    tid = template or (company.signature_template if company else "") or _DEFAULT_TEMPLATE
    if tid not in SIGNATURE_TEMPLATES:
        tid = _DEFAULT_TEMPLATE
    return {"fields": fields, "html": SIGNATURE_TEMPLATES[tid][1](esc), "template": tid}


def _signature_dict(e: NexusEmployee, db: Session) -> dict:
    rendered = _render_signature(e, db)
    return {
        **rendered,
        "canEditDisplayName": True, "canEditPhone": True,
        "displayNameOverride": e.signature_display_name or "",
        "phoneOverride": e.signature_phone or "",
        "closingOverride": e.signature_closing or "",
        "linkedinOverride": e.linkedin_url or "",
        "logoUrlOverride": e.signature_logo_url or "",
        # Quick-pick presets for the sign-off field (Sep 19) - a convenience
        # that fills the free-text box, not a gate; an employee can still
        # type anything else in it.
        "closingPresets": SIGNATURE_CLOSINGS,
    }


@router.get("/signature")
def my_signature(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _signature_dict(_me(db, user["email"]), db)


class SignatureIn(BaseModel):
    display_name: Optional[str] = None   # e.g. "Sahil" -> "Sam" - name/role/e-mail otherwise always come from the directory
    phone:        Optional[str] = None   # e.g. desk line instead of cell
    closing:      Optional[str] = None   # sign-off line, e.g. "Sincerely" - free text (Sep 19: personal, not admin-set)
    linkedin_url: Optional[str] = None   # personal LinkedIn for the signature's icon row (Sep 19)


@router.put("/signature")
def save_my_signature(body: SignatureIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    e = _me(db, user["email"])
    if body.display_name is not None:
        e.signature_display_name = body.display_name.strip()[:120]
    if body.closing is not None:
        e.signature_closing = body.closing.strip()[:60]
    if body.linkedin_url is not None:
        e.linkedin_url = body.linkedin_url.strip()[:300]
    if body.phone is not None:
        e.signature_phone = body.phone.strip()[:50]
    e.updated_at = _now()
    db.commit()
    return _signature_dict(e, db)


# Personal signature logo (Sep 19, Pranshu: "i want to have employee the
# ability to upload the logo for their signature. So, ones they change the
# logo it will just change the logo but rest format of sign remain same") -
# same upload/remove shape as /profile/photo above, same avatar bucket, just
# writing e.signature_logo_url instead of e.photo_url. Nothing else in the
# signature (name/role/email/address/socials/template) is touched by this.
@router.post("/signature/logo")
async def upload_my_signature_logo(file: UploadFile = File(...),
                                   user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    e = _me(db, user["email"])
    ext = _IMAGE_TYPES.get(file.content_type or "")
    if not ext:
        raise HTTPException(400, "Logo must be JPEG, PNG, WebP or GIF")
    data = await file.read()
    if len(data) > _MAX_AVATAR_BYTES:
        raise HTTPException(400, "Logo must be under 5 MB")
    path = f"{e.id}/signature-logo-{uuid.uuid4()}.{ext}"
    resp = httpx.post(
        f"{_SUPABASE_URL}/storage/v1/object/{_AVATAR_BUCKET}/{path}",
        headers={**_storage_headers(), "Content-Type": file.content_type,
                 "cache-control": "max-age=31536000"},
        content=data, timeout=60,
    )
    if not resp.is_success:
        raise HTTPException(502, f"Storage upload failed: {resp.text[:200]}")
    e.signature_logo_url = f"{_SUPABASE_URL}/storage/v1/object/public/{_AVATAR_BUCKET}/{path}"
    e.updated_at = _now()
    db.commit()
    return _signature_dict(e, db)


@router.delete("/signature/logo")
def remove_my_signature_logo(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Back to the company's own logo - not "no logo"."""
    e = _me(db, user["email"])
    e.signature_logo_url = ""
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
