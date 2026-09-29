"""Accounting: memorized reports, reporting packages, and who may read which
entities (Neil and Charmi, Sep 25).

Memorized reports - a Reports view (report, period, book, entities, dimension
filters, comparison) saved under a name so the same statement is one click the
next fifty times. Private to the person who saved it unless shared with the
accounting team.

Reporting packages - an ordered set of memorized reports that goes to a lender
as one PDF. Only the list is stored; the statements are read fresh from the
ledger every time the package is built.

Entity access - the people who hold the Accounting grant and the entities each
is limited to. The limits are nexus_access_scopes rows (module "accounting"),
enforced on every read in routers/accounting.py; this router is only where a
person with the Full level on Accounting (or an administrator) sets them.

Everything here is Nexus's own database, read and written in sync endpoints so
FastAPI runs them in the threadpool.
"""
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
from auth import _LEVELS, _MODULE_LEVEL_RANK, get_current_user, require_module_grant
from database import get_db
from routers.accounting import ACCOUNTING_SCOPE_MODULE, ACCOUNTING_SCOPE_TYPE

router = APIRouter(
    prefix="/accounting",
    tags=["Accounting"],
    dependencies=[Depends(require_module_grant("accounting", "viewer"))],
)

_REPORTS = ("pnl", "balance-sheet", "trial-balance", "cash-position")
_CONFIG_MAX = 8000     # characters of JSON - filters, never figures
_PREFS_MAX = 6000      # characters of JSON - one person's column layout
_PACKAGE_MAX = 40      # statements in one package


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _name(v: str) -> str:
    name = (v or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Give it a name.")
    return name[:120]


# ── A person's own layout ────────────────────────────────────────────────────
class PrefsBody(BaseModel):
    prefs: dict[str, Any]


@router.get("/prefs")
def get_prefs(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.query(models.AccountingUserPref).filter(models.AccountingUserPref.email == user["email"].lower()).first()
    return {"prefs": row.prefs if row and isinstance(row.prefs, dict) else {}}


@router.put("/prefs")
def put_prefs(body: PrefsBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Replace the caller's layout. Only ever their own row."""
    if len(json.dumps(body.prefs)) > _PREFS_MAX:
        raise HTTPException(status_code=400, detail="That layout is too large to save.")
    me = user["email"].lower()
    row = db.query(models.AccountingUserPref).filter(models.AccountingUserPref.email == me).first()
    if row:
        row.prefs, row.updated_at = body.prefs, _now()
    else:
        db.add(models.AccountingUserPref(email=me, prefs=body.prefs, updated_at=_now()))
    db.commit()
    return {"prefs": body.prefs}


# ── Memorized reports ────────────────────────────────────────────────────────
def _report_out(r: models.AccountingSavedReport, me: str) -> dict:
    return {
        "id": r.id, "name": r.name, "config": r.config if isinstance(r.config, dict) else {},
        "shared": bool(r.shared), "owner": r.owner_email, "mine": r.owner_email == me,
        "createdAt": r.created_at, "updatedAt": r.updated_at,
    }


def _visible_reports(db: Session, me: str):
    from sqlalchemy import or_
    return (db.query(models.AccountingSavedReport)
            .filter(or_(models.AccountingSavedReport.owner_email == me, models.AccountingSavedReport.shared.is_(True)))
            .order_by(models.AccountingSavedReport.name).all())


class SavedReportBody(BaseModel):
    name: str
    config: dict[str, Any]
    shared: Optional[bool] = False


def _config(config: dict) -> dict:
    if config.get("report") not in _REPORTS:
        raise HTTPException(status_code=400, detail="Unknown report.")
    if len(json.dumps(config)) > _CONFIG_MAX:
        raise HTTPException(status_code=400, detail="That view has too many filters to save.")
    return config


@router.get("/saved-reports")
def list_saved_reports(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = user["email"].lower()
    return [_report_out(r, me) for r in _visible_reports(db, me)]


@router.post("/saved-reports", status_code=201)
def save_report(body: SavedReportBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Memorize the current view. Saving under a name the caller already uses
    replaces that report, so "Save" on a changed view is one step."""
    me = user["email"].lower()
    name = _name(body.name)
    config = _config(body.config)
    row = (db.query(models.AccountingSavedReport)
           .filter(models.AccountingSavedReport.owner_email == me, models.AccountingSavedReport.name == name).first())
    now = _now()
    if row:
        row.config, row.shared, row.updated_at = config, bool(body.shared), now
    else:
        row = models.AccountingSavedReport(id=str(uuid.uuid4()), owner_email=me, name=name, config=config,
                                           shared=bool(body.shared), created_at=now, updated_at=now)
        db.add(row)
    db.commit()
    db.refresh(row)
    return _report_out(row, me)


def _own_report(db: Session, report_id: str, user: dict) -> models.AccountingSavedReport:
    row = db.query(models.AccountingSavedReport).filter(models.AccountingSavedReport.id == report_id).first()
    # 404 for someone else's private report, so its existence does not leak.
    if not row or (row.owner_email != user["email"].lower() and not row.shared):
        raise HTTPException(status_code=404, detail="Report not found.")
    if row.owner_email != user["email"].lower() and user["level"] < _LEVELS["administrator"]:
        raise HTTPException(status_code=403, detail="Only the person who saved a report can change it.")
    return row


class SavedReportPatch(BaseModel):
    name: Optional[str] = None
    shared: Optional[bool] = None


@router.patch("/saved-reports/{report_id}")
def update_saved_report(report_id: str, body: SavedReportPatch, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = _own_report(db, report_id, user)
    if body.name is not None:
        row.name = _name(body.name)
    if body.shared is not None:
        row.shared = bool(body.shared)
    row.updated_at = _now()
    db.commit()
    db.refresh(row)
    return _report_out(row, user["email"].lower())


@router.delete("/saved-reports/{report_id}", status_code=204)
def delete_saved_report(report_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = _own_report(db, report_id, user)
    db.delete(row)
    db.commit()


# ── Reporting packages ───────────────────────────────────────────────────────
def _package_out(p: models.AccountingReportPackage, me: str, reports: dict) -> dict:
    items = []
    for it in (p.items if isinstance(p.items, list) else []):
        r = reports.get(it.get("reportId"))
        # A report that was deleted, or is private to someone else, stays in the
        # list as missing so the package owner sees the gap instead of a
        # package that silently lost a statement.
        items.append({"reportId": it.get("reportId"), "title": it.get("title") or (r.name if r else ""), "missing": r is None,
                      "config": (r.config if r and isinstance(r.config, dict) else None)})
    return {"id": p.id, "name": p.name, "description": p.description or "", "items": items, "shared": bool(p.shared),
            "owner": p.owner_email, "mine": p.owner_email == me, "createdAt": p.created_at, "updatedAt": p.updated_at}


class PackageItem(BaseModel):
    reportId: str
    title: Optional[str] = ""


class PackageBody(BaseModel):
    name: str
    description: Optional[str] = ""
    items: list[PackageItem] = []
    shared: Optional[bool] = False


def _items(body: PackageBody, reports: dict) -> list[dict]:
    if len(body.items) > _PACKAGE_MAX:
        raise HTTPException(status_code=400, detail=f"A package holds at most {_PACKAGE_MAX} statements.")
    out = []
    for it in body.items:
        if it.reportId not in reports:
            raise HTTPException(status_code=400, detail="A package can only hold memorized reports you can open.")
        out.append({"reportId": it.reportId, "title": (it.title or "").strip()[:120]})
    return out


@router.get("/packages")
def list_packages(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    from sqlalchemy import or_
    me = user["email"].lower()
    reports = {r.id: r for r in _visible_reports(db, me)}
    rows = (db.query(models.AccountingReportPackage)
            .filter(or_(models.AccountingReportPackage.owner_email == me, models.AccountingReportPackage.shared.is_(True)))
            .order_by(models.AccountingReportPackage.name).all())
    return [_package_out(p, me, reports) for p in rows]


@router.post("/packages", status_code=201)
def create_package(body: PackageBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = user["email"].lower()
    reports = {r.id: r for r in _visible_reports(db, me)}
    now = _now()
    row = models.AccountingReportPackage(id=str(uuid.uuid4()), owner_email=me, name=_name(body.name),
                                         description=(body.description or "").strip()[:400], items=_items(body, reports),
                                         shared=bool(body.shared), created_at=now, updated_at=now)
    db.add(row)
    db.commit()
    db.refresh(row)
    return _package_out(row, me, reports)


def _own_package(db: Session, package_id: str, user: dict) -> models.AccountingReportPackage:
    row = db.query(models.AccountingReportPackage).filter(models.AccountingReportPackage.id == package_id).first()
    if not row or (row.owner_email != user["email"].lower() and not row.shared):
        raise HTTPException(status_code=404, detail="Package not found.")
    if row.owner_email != user["email"].lower() and user["level"] < _LEVELS["administrator"]:
        raise HTTPException(status_code=403, detail="Only the person who built a package can change it.")
    return row


@router.put("/packages/{package_id}")
def update_package(package_id: str, body: PackageBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = user["email"].lower()
    row = _own_package(db, package_id, user)
    reports = {r.id: r for r in _visible_reports(db, me)}
    row.name = _name(body.name)
    row.description = (body.description or "").strip()[:400]
    row.items = _items(body, reports)
    row.shared = bool(body.shared)
    row.updated_at = _now()
    db.commit()
    db.refresh(row)
    return _package_out(row, me, reports)


@router.delete("/packages/{package_id}", status_code=204)
def delete_package(package_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = _own_package(db, package_id, user)
    db.delete(row)
    db.commit()


# ── Who may read which entities ──────────────────────────────────────────────
_manage_access = require_module_grant("accounting", "full")


def _holders(db: Session) -> dict[str, int]:
    """Everyone an Access Group gives the Accounting screen to, with their
    level. Administrators and owners are left out: they are never limited."""
    rows = (db.query(models.NexusGroupMember.email, models.NexusGroup.allowed_modules)
            .join(models.NexusGroup, models.NexusGroup.id == models.NexusGroupMember.group_id)
            .filter(models.NexusGroup.allowed_modules.like("%accounting%")).all())
    out: dict[str, int] = {}
    for email, modules in rows:
        for part in (modules or "").split(","):
            mid, _, level = part.strip().partition(":")
            if mid == "accounting" and email:
                out[email.lower()] = max(out.get(email.lower(), 0), _MODULE_LEVEL_RANK.get(level, 1))
    admin_roles = [name for name, lvl in _LEVELS.items() if lvl >= _LEVELS["administrator"]]
    admins = {e.lower() for (e,) in db.query(models.NexusRole.email).filter(models.NexusRole.role.in_(admin_roles)).all() if e}
    return {e: lvl for e, lvl in out.items() if e not in admins}


def _limits(db: Session, emails=None) -> dict[str, list[str]]:
    q = db.query(models.NexusAccessScope).filter(models.NexusAccessScope.module_id == ACCOUNTING_SCOPE_MODULE)
    if emails is not None:
        q = q.filter(models.NexusAccessScope.email.in_(list(emails)))
    out: dict[str, list[str]] = {}
    for r in q.all():
        out.setdefault(r.email, []).append(r.scope_id)
    return {e: sorted(v) for e, v in out.items()}


@router.get("/access")
def list_entity_access(user: dict = Depends(_manage_access), db: Session = Depends(get_db)):
    """The accounting team and the entities each person is limited to. An empty
    list means every entity."""
    holders = _holders(db)
    limits = _limits(db)
    levels = {v: k for k, v in _MODULE_LEVEL_RANK.items()}
    # A person who lost the grant but still has limit rows is listed too, so
    # the rows can be seen and cleared.
    emails = sorted(set(holders) | set(limits))
    return {"people": [{"email": e, "level": levels.get(holders.get(e, 0), ""), "hasGrant": e in holders, "entities": limits.get(e, [])} for e in emails]}


class EntityAccessBody(BaseModel):
    entities: list[str] = []


@router.put("/access/{email}")
def set_entity_access(email: str, body: EntityAccessBody, user: dict = Depends(_manage_access), db: Session = Depends(get_db)):
    """Replace one person's entity limit. An empty list lifts the limit."""
    target = email.strip().lower()
    if not target:
        raise HTTPException(status_code=400, detail="Whose access?")
    if target == user["email"].lower() and user["level"] < _LEVELS["administrator"]:
        raise HTTPException(status_code=400, detail="Someone else has to change your own entity access.")
    codes = sorted({c.strip() for c in body.entities if c and c.strip()})[:400]
    before = _limits(db, [target]).get(target, [])
    (db.query(models.NexusAccessScope)
     .filter(models.NexusAccessScope.email == target, models.NexusAccessScope.module_id == ACCOUNTING_SCOPE_MODULE)
     .delete(synchronize_session=False))
    now = _now()
    for code in codes:
        db.add(models.NexusAccessScope(id=str(uuid.uuid4()), email=target, module_id=ACCOUNTING_SCOPE_MODULE,
                                       scope_type=ACCOUNTING_SCOPE_TYPE, scope_id=code, created_by=user["email"], created_at=now))
    db.add(models.AuditLog(timestamp=now, user_email=user["email"], user_role=user.get("role", ""),
                           action="accounting_entity_access_set", resource_type="accounting_access", resource_id=target,
                           details=json.dumps({"before": before, "after": codes})))
    db.commit()
    return {"email": target, "entities": codes}
