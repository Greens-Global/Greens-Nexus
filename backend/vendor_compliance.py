"""Subcontractor papers (Round Two item 7, Neil, 11/05/2026, plan
https://claude.ai/artifact/EpG2gQr8KVi1ZZRaM6zVBE).

A sub is one of Intacct's vendors - read through Accounting > Vendors &
Customers (routers/accounting_partners), never a Construction vendor
directory. Nexus keeps, per VENDORID, only what Intacct does not hold
(models.VendorCompliance): when the certificate of insurance, the workers
comp certificate and the license expire, and whether a W-9 is on file.

ONE rule for the state (`state`): missing (no insurance certificate on
file), expired (any date before today), expiring (any date within
WARN_DAYS[0]), else ok. The Subs tab, the Accounting vendor record's
Compliance tab and the bells all read it.

`expiry_tick` runs in construction_field.field_loop beside the missing-log
bell: 30 days out, 7 days out and the day a paper lapses, one bell to the
managers of every active job the sub is on - once per paper and date
(the field loop's marks, key vc:<vendor>:<field>:<date>:<days>). A paper
renewed (a later date saved) starts its own count.
"""
from __future__ import annotations

from datetime import date, datetime, timezone

from sqlalchemy.orm import Session

import models

FIELDS = ("coi_expires_on", "wc_expires_on", "license_expires_on")
LABEL = {"coi_expires_on": "Insurance Certificate", "wc_expires_on": "Workers Comp Certificate",
         "license_expires_on": "License"}
WARN_DAYS = (30, 7, 0)


def _us(iso: str) -> str:
    try:
        return date.fromisoformat(iso).strftime("%m/%d/%Y")
    except ValueError:
        return iso


def state(row, today: date) -> tuple[str, list[str]]:
    """(state, the sentences a manager acts on)."""
    if row is None or not (row.coi_expires_on or ""):
        return "missing", ["No insurance certificate on file."]
    issues, worst = [], "ok"
    for f in FIELDS:
        raw = getattr(row, f, "") or ""
        if not raw:
            continue
        days = (date.fromisoformat(raw) - today).days
        if days < 0:
            issues.append(f"{LABEL[f]} expired {_us(raw)}.")
            worst = "expired"
        elif days <= WARN_DAYS[0]:
            issues.append(f"{LABEL[f]} expires {_us(raw)} ({'today' if days == 0 else f'in {days} days'}).")
            if worst == "ok":
                worst = "expiring"
    return worst, issues


def to_dict(row, today: date, vendor_id: str = "") -> dict:
    st, issues = state(row, today)
    return {
        "vendorId": row.vendor_id if row is not None else vendor_id,
        "vendorName": (row.vendor_name if row is not None else "") or "",
        "coiExpiresOn": (row.coi_expires_on if row is not None else "") or "",
        "wcExpiresOn": (row.wc_expires_on if row is not None else "") or "",
        "licenseNumber": (row.license_number if row is not None else "") or "",
        "licenseExpiresOn": (row.license_expires_on if row is not None else "") or "",
        "w9OnFile": bool(row.w9_on_file) if row is not None else False,
        "notes": (row.notes if row is not None else "") or "",
        "updatedBy": (row.updated_by if row is not None else "") or "",
        "updatedAt": (row.updated_at if row is not None else "") or "",
        "state": st, "issues": issues,
    }


def live_subs(db: Session, project_ids: list) -> list:
    L = models.ConstructionJobLink
    if not project_ids:
        return []
    return db.query(L).filter(L.kind == "sub", L.ended_at == "", L.project_id.in_(project_ids)).all()


def expiry_tick(db: Session, now: datetime | None = None) -> int:
    """The 30 / 7 / 0 day bells to the managers of every active job a sub
    is on. Returns how many bells went out."""
    import construction_notify
    from construction_field import _marks, _save_marks, _zone
    P = models.ConstructionProject
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    jobs = {p.id: p for p in db.query(P).filter(P.deleted_at == "", P.status == "active").all()}
    by_vendor: dict[str, list] = {}
    for lk in live_subs(db, list(jobs)):
        by_vendor.setdefault(lk.ref_id, []).append(jobs[lk.project_id])
    if not by_vendor:
        return 0
    rows = {r.vendor_id: r for r in db.query(models.VendorCompliance)
            .filter(models.VendorCompliance.vendor_id.in_(list(by_vendor))).all()}
    marks = _marks(db)
    n = 0
    for vid, on_jobs in by_vendor.items():
        row = rows.get(vid)
        if row is None:
            continue
        # The sub's day is the first job's jobsite day - a sub on two sites
        # in two zones gets the bell on the earlier one's morning.
        today = now.astimezone(_zone(db, on_jobs[0])).date()
        name = row.vendor_name or vid
        for f in FIELDS:
            raw = getattr(row, f, "") or ""
            if not raw:
                continue
            days = (date.fromisoformat(raw) - today).days
            if days not in WARN_DAYS:
                continue
            key = f"vc:{vid}:{f}:{raw}:{days}"
            if marks.get(key):
                continue
            when = "expires today" if days == 0 else f"expires {_us(raw)} (in {days} days)"
            where = ", ".join(sorted(p.name for p in on_jobs))
            to = set()
            for p in on_jobs:
                to.update(construction_notify.reviewers(db, p))
            for em in sorted(to):
                construction_notify.bell(
                    db, kind="sub_papers", family=("sub_papers",), recipient=em, ref_id=f"sub-papers:{vid}:{f}",
                    title="Sub Papers Expiring" if days else "Sub Papers Expired",
                    body=f"{name}'s {LABEL[f].lower()} {when}. On: {where}. Ask for the renewal and save the new date.",
                    label="Open Subs", sub=f"project:{on_jobs[0].id}:subs",
                    company=getattr(on_jobs[0], "company_id", "") or "")
            marks[key] = raw
            n += 1
    _save_marks(db, marks)
    db.commit()
    return n
