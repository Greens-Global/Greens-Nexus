"""Branding settings (Jul 2026) - the login screen's accent color, exposed as
a Global Admin-configurable setting rather than hardcoded (Pranshu, Jul 28:
"make this a setting that can be changed in global settings"). Stored in the
same NexusSetting key/value pattern every other module's small admin config
uses (ticket_notify_config, task_notify_config, etc).

GET is public/unauthenticated on purpose: the login screen itself needs the
current accent BEFORE anyone has signed in, so it can't sit behind
get_current_user. Nothing in the payload is sensitive - same threat model as
/stepup/config.
"""
from datetime import datetime, timezone
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import require_administrator
from database import get_db
import models

router = APIRouter(prefix="/branding", tags=["Branding"])

_SETTINGS_KEY = "branding_config"
_VALID_ACCENTS = ("green", "blue")
_DEFAULT_ACCENT = "green"


def _get_config(db: Session) -> dict:
    # Cached (cache.py): this endpoint is UNAUTHENTICATED (the login screen
    # needs it pre-sign-in), so without a cache anyone can make the DB do work
    # from outside the auth wall. Accent changes are near-annual.
    import cache
    cached = cache.settings_config.get(_SETTINGS_KEY)
    if cached is not None:
        return cached
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    cfg = {"accent": _DEFAULT_ACCENT}
    if row and row.value:
        try:
            cfg = json.loads(row.value)
        except (TypeError, ValueError):
            cfg = {"accent": _DEFAULT_ACCENT}
        if cfg.get("accent") not in _VALID_ACCENTS:
            cfg["accent"] = _DEFAULT_ACCENT
    cache.settings_config.set(_SETTINGS_KEY, cfg)
    return cfg


class BrandingIn(BaseModel):
    accent: str


@router.get("/config")
def get_config(db: Session = Depends(get_db)):
    return _get_config(db)


@router.put("/config")
def update_config(body: BrandingIn, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    accent = body.accent if body.accent in _VALID_ACCENTS else _DEFAULT_ACCENT
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    if not row:
        row = models.NexusSetting(key=_SETTINGS_KEY)
        db.add(row)
    row.value = json.dumps({"accent": accent})
    row.updated_by = user["email"]
    now = datetime.now(timezone.utc).isoformat()
    row.updated_at = now
    db.add(models.AuditLog(timestamp=now, user_email=user["email"], user_role=user.get("role", ""),
                           action=f"Set the brand color to {accent}", resource_type="branding",
                           resource_id=_SETTINGS_KEY))
    db.commit()
    return {"accent": accent}


# ── Email Appearance (Sep 26, 2026) ──────────────────────────────────────────
# One theme for every Nexus email - see email_theme.py for what it covers and
# why the defaults render today's emails unchanged. Administrator only, like
# the accent above; the theme itself is not secret, but nobody else needs it.

class EmailThemeIn(BaseModel):
    logoUrl: str = ""
    accentColor: str = ""
    footerText: str = ""
    companyAddressLine: str = ""


class EmailThemePreviewIn(EmailThemeIn):
    sample: str = "task"


def _clean_theme(body: EmailThemeIn):
    """Validated Theme from a request, or 400 with a plain reason."""
    import email_theme
    accent = email_theme.normalize_hex(body.accentColor or email_theme.DEFAULT_ACCENT)
    if not accent:
        raise HTTPException(400, "Accent color must be a hex color such as #0f3d2e")
    logo = (body.logoUrl or "").strip()
    if logo:
        from routers.items import _validate_photo_url
        from routers.files import PROTECTED_BUCKETS
        _validate_photo_url(logo, "Logo")
        if not logo.lower().startswith("https://"):
            raise HTTPException(400, "Logo must be an https link to Nexus storage")
        # Email clients open the logo with no sign-in, so it has to live in a
        # public bucket - a private evidence bucket would show a broken image.
        bucket = logo.split("/object/public/", 1)[1].split("/", 1)[0] if "/object/public/" in logo else ""
        if bucket in PROTECTED_BUCKETS:
            raise HTTPException(400, "Logo must be stored in a public bucket")
    footer = (body.footerText or "").strip()
    address = (body.companyAddressLine or "").strip()
    if len(footer) > email_theme.FOOTER_MAX:
        raise HTTPException(400, f"Footer text must be {email_theme.FOOTER_MAX} characters or fewer")
    if len(address) > email_theme.ADDRESS_MAX:
        raise HTTPException(400, f"Address line must be {email_theme.ADDRESS_MAX} characters or fewer")
    return email_theme.Theme(logoUrl=logo, accentColor=accent, footerText=footer,
                             companyAddressLine=address)


@router.get("/email-theme")
def get_email_theme(user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    import email_theme
    from email_theme_samples import SAMPLE_LABELS
    return {"theme": email_theme.get_saved(db).as_dict(),
            "defaults": email_theme.DEFAULT_THEME.as_dict(),
            "samples": [{"id": k, "label": v} for k, v in SAMPLE_LABELS.items()]}


@router.put("/email-theme")
def update_email_theme(body: EmailThemeIn, user: dict = Depends(require_administrator),
                       db: Session = Depends(get_db)):
    import cache
    import email_theme
    theme = _clean_theme(body)
    before = email_theme.get_saved(db).as_dict()
    now = datetime.now(timezone.utc).isoformat()
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == email_theme.SETTINGS_KEY).first()
    if not row:
        row = models.NexusSetting(key=email_theme.SETTINGS_KEY)
        db.add(row)
    row.value = json.dumps(theme.as_dict())
    row.updated_by = user["email"]
    row.updated_at = now
    changed = {k: v for k, v in theme.as_dict().items() if before.get(k) != v}
    db.add(models.AuditLog(timestamp=now, user_email=user["email"], user_role=user.get("role", ""),
                           action="Updated the email appearance", resource_type="branding",
                           resource_id=email_theme.SETTINGS_KEY,
                           details=json.dumps({"changed": changed})))
    db.commit()
    cache.settings_config.invalidate()
    return {"theme": theme.as_dict()}


@router.post("/email-theme/preview")
def preview_email_theme(body: EmailThemePreviewIn, user: dict = Depends(require_administrator)):
    """Renders one sample email with a DRAFT theme (nothing is saved), for the
    settings screen to show in a sandboxed frame."""
    import email_theme_samples
    if body.sample not in email_theme_samples.SAMPLE_LABELS:
        raise HTTPException(400, "Unknown sample")
    return {"html": email_theme_samples.render(body.sample, _clean_theme(body))}
