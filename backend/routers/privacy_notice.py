"""The Privacy Policy, built from ONE inventory (privacy_inventory.py,
11/02/2026, the legal compliance pass).

  GET /policy/privacy-notice      PUBLIC (the /privacy page is linked from the
                                  login screen and the sign-in policy, read by
                                  people with no Nexus login). The notice and
                                  the live AI status; nothing about any person
                                  or about which optional services this server
                                  has switched on.
  GET /policy/privacy-notice/me   signed in (Legal > Privacy Policy). Adds the
                                  viewer's company and HR contact (the "how to
                                  make a request" line), which services are in
                                  use, and for administrators the counsel-review
                                  note and what they still need to fill in.

Under the /policy prefix on purpose: it is already open to external users
(auth._EXTERNAL_BASE_PREFIXES), like Legal itself.
"""
from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

import auth
import models
import privacy_inventory
from auth import get_current_user
from database import get_db

router = APIRouter(prefix="/policy", tags=["policy"])


@router.get("/privacy-notice")
def public_notice():
    return privacy_inventory.notice()


def _viewer(db: Session, email: str) -> dict:
    """The viewer's company (legal name) and its HR contact, or blanks."""
    emp = (db.query(models.NexusEmployee)
           .filter(func.lower(models.NexusEmployee.work_email) == (email or "").strip().lower())
           .first())
    ent = None
    if emp and emp.company:
        ent = db.query(models.HrEntity).filter(models.HrEntity.id == emp.company).first()
    contact = None
    hr = ((ent.hr_contact_email if ent else "") or "").split(",")[0].strip().lower()
    if hr:
        person = (db.query(models.NexusEmployee)
                  .filter(func.lower(models.NexusEmployee.work_email) == hr).first())
        name = ""
        if person:
            name = (person.display_name or f"{person.first_name or ''} {person.last_name or ''}").strip()
        contact = {"name": name, "email": hr}
    company = ((ent.legal_name or ent.name) if ent else "") or ""
    return {"company": company, "contact": contact}


def _needs_input(db: Session, user: dict) -> list:
    """What an administrator must fill for the notice to be complete: every
    company in their reach with no HR contact (the privacy request contact)."""
    scope = auth.company_scope(user, db)
    out = []
    for ent in db.query(models.HrEntity).order_by(models.HrEntity.name).all():
        if not auth.company_ok(ent.id, scope):
            continue
        if not (ent.hr_contact_email or "").strip():
            out.append({"company": ent.name or ent.legal_name or "", "field": "HR Contact",
                        "where": "Settings > Companies > Profile"})
    return out


@router.get("/privacy-notice/me")
def my_notice(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    out = privacy_inventory.notice(viewer=_viewer(db, user["email"]))
    if user.get("level", 0) >= auth._LEVELS["administrator"]:
        from routers import policy
        out["admin"] = {
            # The text is a draft for counsel review - said to administrators only.
            "counselReview": True,
            "needsInput": _needs_input(db, user),
            "signInPolicyOutOfDate": policy.out_of_date(policy.get_config(db)),
        }
    return out
