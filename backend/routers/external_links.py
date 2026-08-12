"""External Links - the company-wide app/link directory (rebuilt Aug 2026 from
the old start.greensglobal.com launchpad, which is company-wide, unstyled, and
department-scoped only by a raw dropdown). This owns models.ExternalLink end
to end.

NOTE for whoever touches backend/routers/assets.py next: that file still has a
leftover stub /external-links GET/POST/click trio from before this module was
built out. This router is the real implementation (full CRUD, department
scoping, ordering, audit trail) and registers its own routes - do not restore
the assets.py stub, and remove it there next time that file is touched (it is
Ankush's file, not this module's, so it's left alone here rather than edited
in place).

Read is baseline for every employee (App.jsx treats external-links as a
baseline module like sop). Managing entries (create/edit/delete/reorder)
requires manager+ globally OR an Access Group grant of "external-links" at
editor+ (full+ to delete), mirroring items.py's require_items_admin pattern.
"""
import json
import re
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

import models
from database import get_db
from auth import get_current_user, require_level_or_module

router = APIRouter(prefix="/external-links", tags=["External Links"], dependencies=[Depends(get_current_user)])

_ROLE_LEVEL = {"employee": 1, "supervisor": 2, "manager": 3, "administrator": 4, "owner": 5}
require_links_admin  = require_level_or_module(_ROLE_LEVEL["manager"],       "external-links", "editor")
require_links_delete = require_level_or_module(_ROLE_LEVEL["administrator"], "external-links", "full")


class ExternalLinkCreate(BaseModel):
    name: str
    url: str
    category: str
    description: str = ""
    department: str = ""      # "" = shown to every department (company-wide)
    company: str = ""         # "" = shown to every company; else an HrEntity.id
    icon: str = "Link2"       # lucide-react icon key, resolved client-side
    is_pinned: bool = False


class ExternalLinkUpdate(BaseModel):
    name: Optional[str] = None
    url: Optional[str] = None
    category: Optional[str] = None
    description: Optional[str] = None
    department: Optional[str] = None
    company: Optional[str] = None
    icon: Optional[str] = None
    is_pinned: Optional[bool] = None


class ReorderEntry(BaseModel):
    id: int
    sort_order: int


class ImportRow(BaseModel):
    name: str = ""
    url: str = ""
    category: str = ""
    department: str = ""
    company: str = ""
    description: str = ""
    icon: str = "Link2"
    is_pinned: bool = False


class ImportRequest(BaseModel):
    rows: list[ImportRow]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _audit(db: Session, user: dict, action: str, link: "models.ExternalLink", extra: dict | None = None):
    details = {"name": link.name, "url": link.url, "category": link.category, "department": link.department}
    if extra:
        details.update(extra)
    db.add(models.AuditLog(
        timestamp=_now(), user_email=user["email"], user_role=user.get("role", ""),
        action=action, resource_type="external_links", resource_id=str(link.id),
        details=json.dumps(details), ip_address="",
    ))


@router.get("")
def list_external_links(db: Session = Depends(get_db)):
    """Every employee can read the full directory - the department/category
    filtering is a client-side UX affordance, not an access boundary (these
    are just launch links, same as the old company-wide start page)."""
    return (
        db.query(models.ExternalLink)
        .order_by(models.ExternalLink.is_pinned.desc(), models.ExternalLink.sort_order.asc(), models.ExternalLink.name.asc())
        .all()
    )


@router.get("/meta")
def external_links_meta(db: Session = Depends(get_db)):
    """Distinct departments/categories currently in use, for the filter
    dropdowns - avoids a second hardcoded list drifting from real data."""
    departments = sorted({d for (d,) in db.query(models.ExternalLink.department).distinct() if d})
    categories  = sorted({c for (c,) in db.query(models.ExternalLink.category).distinct() if c})
    return {"departments": departments, "categories": categories}


@router.post("", status_code=201)
def create_external_link(link: ExternalLinkCreate, user: dict = Depends(require_links_admin), db: Session = Depends(get_db)):
    now = _now()
    db_link = models.ExternalLink(
        **link.model_dump(),
        created_by=user["email"], created_at=now, updated_at=now,
    )
    db.add(db_link)
    db.flush()
    _audit(db, user, "Created external link", db_link)
    db.commit()
    db.refresh(db_link)
    return db_link


@router.patch("/reorder")
def reorder_external_links(entries: list[ReorderEntry], user: dict = Depends(require_links_admin), db: Session = Depends(get_db)):
    """Bulk drag-reorder within a category - one round trip instead of N PATCHes.
    MUST stay registered before PATCH /{link_id} below: Starlette matches
    routes in registration order, and /external-links/{link_id} would
    otherwise greedily match /external-links/reorder (link_id="reorder") and
    422 on the int parse before this route is ever tried."""
    by_id = {e.id: e.sort_order for e in entries}
    rows = db.query(models.ExternalLink).filter(models.ExternalLink.id.in_(by_id.keys())).all()
    for row in rows:
        row.sort_order = by_id[row.id]
    db.commit()
    return {"ok": True, "updated": len(rows)}


@router.patch("/{link_id}")
def update_external_link(link_id: int, patch: ExternalLinkUpdate, user: dict = Depends(require_links_admin), db: Session = Depends(get_db)):
    db_link = db.query(models.ExternalLink).filter(models.ExternalLink.id == link_id).first()
    if not db_link:
        raise HTTPException(status_code=404, detail="Link not found")
    changes = patch.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(db_link, field, value)
    db_link.updated_at = _now()
    _audit(db, user, "Updated external link", db_link, {"changed_fields": list(changes.keys())})
    db.commit()
    db.refresh(db_link)
    return db_link


@router.delete("/{link_id}")
def delete_external_link(link_id: int, user: dict = Depends(require_links_delete), db: Session = Depends(get_db)):
    db_link = db.query(models.ExternalLink).filter(models.ExternalLink.id == link_id).first()
    if not db_link:
        raise HTTPException(status_code=404, detail="Link not found")
    _audit(db, user, "Deleted external link", db_link)
    db.delete(db_link)
    db.commit()
    return {"ok": True}


@router.patch("/{link_id}/click")
def increment_click(link_id: int, db: Session = Depends(get_db)):
    """Every employee can fire this (it's how "Most Used" ordering works) - no
    admin gate, just needs to be signed in."""
    link = db.query(models.ExternalLink).filter(models.ExternalLink.id == link_id).first()
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")
    link.clicks += 1
    db.commit()
    db.refresh(link)
    return link


@router.post("/import")
def import_external_links(payload: ImportRequest, user: dict = Depends(require_links_admin), db: Session = Depends(get_db)):
    """Batch CSV import (Manage > Import) for standing up a department's
    directory in one paste instead of one Add Link modal at a time. Best-
    effort: valid rows are created, invalid ones are reported back by 1-based
    row number and skipped - a typo in row 12 shouldn't lose rows 1-11.

    The template only asks for name/url/department/company/description/pinned
    - category and icon are left off the sheet on purpose (Neil, Aug 12): icon
    has to match an internal key so it's not something to fill in by hand,
    and category is defaulted here so a row without one still groups with
    its siblings instead of failing import. `company` is typed as a company
    NAME (e.g. "Greens India"), not the HrEntity.id a human has no reason to
    know - resolved to the id here, case-insensitively; an unmatched name is
    left blank (company-wide) rather than failing the whole row."""
    now = _now()
    company_by_name = {e.name.strip().lower(): e.id for e in db.query(models.HrEntity).all()}
    created, errors = [], []
    for i, row in enumerate(payload.rows, start=1):
        name, url = row.name.strip(), row.url.strip()
        if not name or not url:
            errors.append({"row": i, "name": name or f"Row {i}", "reason": "Name and URL are required"})
            continue
        if not re.match(r"^https?://", url, re.I):
            url = f"https://{url}"
        db_link = models.ExternalLink(
            name=name, url=url, category=row.category.strip() or "Imported", description=row.description.strip(),
            department=row.department.strip(), company=company_by_name.get(row.company.strip().lower(), ""),
            icon=row.icon or "Link2", is_pinned=row.is_pinned,
            created_by=user["email"], created_at=now, updated_at=now,
        )
        db.add(db_link)
        db.flush()
        created.append(db_link)
    if created:
        db.add(models.AuditLog(
            timestamp=now, user_email=user["email"], user_role=user.get("role", ""),
            action="Bulk-imported external links", resource_type="external_links", resource_id="",
            details=json.dumps({"count": len(created), "names": [c.name for c in created]}), ip_address="",
        ))
    db.commit()
    for c in created:
        db.refresh(c)
    return {"created": created, "errors": errors}


# ─────────────────────────────────────────────────────────────────────────────
# Personal Links (Aug 12) - an employee's own day-to-day shortcuts, separate
# from the curated directory above. Private by construction: every query
# below filters on owner_email == the signed-in user, and update/delete
# additionally re-check ownership before touching a row - there is no
# manager/admin bypass, so even an owner-level account can't see or edit
# someone else's personal links through this API. No require_links_admin
# gate anywhere here on purpose: this is self-service, not a managed module.
# ─────────────────────────────────────────────────────────────────────────────
personal_router = APIRouter(prefix="/personal-links", tags=["Personal Links"], dependencies=[Depends(get_current_user)])


class PersonalLinkCreate(BaseModel):
    name: str
    url: str
    description: str = ""
    icon: str = "Link2"


class PersonalLinkUpdate(BaseModel):
    name: Optional[str] = None
    url: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None


class PersonalReorderEntry(BaseModel):
    id: int
    sort_order: int


def _own_personal_link(link_id: int, user: dict, db: Session) -> models.PersonalLink:
    link = (
        db.query(models.PersonalLink)
        .filter(models.PersonalLink.id == link_id, models.PersonalLink.owner_email == user["email"])
        .first()
    )
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")
    return link


@personal_router.get("")
def list_personal_links(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return (
        db.query(models.PersonalLink)
        .filter(models.PersonalLink.owner_email == user["email"])
        .order_by(models.PersonalLink.sort_order.asc(), models.PersonalLink.name.asc())
        .all()
    )


@personal_router.post("", status_code=201)
def create_personal_link(link: PersonalLinkCreate, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    now = _now()
    db_link = models.PersonalLink(**link.model_dump(), owner_email=user["email"], created_at=now, updated_at=now)
    db.add(db_link)
    db.commit()
    db.refresh(db_link)
    return db_link


@personal_router.patch("/reorder")
def reorder_personal_links(entries: list[PersonalReorderEntry], user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """MUST stay registered before PATCH /{link_id} below - same route-order
    gotcha as the main reorder endpoint above (see its comment)."""
    by_id = {e.id: e.sort_order for e in entries}
    rows = (
        db.query(models.PersonalLink)
        .filter(models.PersonalLink.id.in_(by_id.keys()), models.PersonalLink.owner_email == user["email"])
        .all()
    )
    for row in rows:
        row.sort_order = by_id[row.id]
    db.commit()
    return {"ok": True, "updated": len(rows)}


@personal_router.patch("/{link_id}")
def update_personal_link(link_id: int, patch: PersonalLinkUpdate, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    db_link = _own_personal_link(link_id, user, db)
    for field, value in patch.model_dump(exclude_unset=True).items():
        setattr(db_link, field, value)
    db_link.updated_at = _now()
    db.commit()
    db.refresh(db_link)
    return db_link


@personal_router.delete("/{link_id}")
def delete_personal_link(link_id: int, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    db_link = _own_personal_link(link_id, user, db)
    db.delete(db_link)
    db.commit()
    return {"ok": True}


@personal_router.patch("/{link_id}/click")
def click_personal_link(link_id: int, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    db_link = _own_personal_link(link_id, user, db)
    db_link.clicks += 1
    db.commit()
    db.refresh(db_link)
    return db_link
