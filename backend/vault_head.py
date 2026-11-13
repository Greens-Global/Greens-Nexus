"""The department head's code for changing a login (Pranshu, 11/13/2026).

Adding, editing, moving to the trash, recovering, deleting for good, importing
or handing over a company login needs the OK of the head of the login's
department: the change is refused with `head_code_required` (naming the
departments and their heads), the person asks for a code (`request` - it goes
to the head and backup head by email and bell, never to the person asking),
the head passes it on if they agree, and a verified code opens a short window
(HEAD_WINDOW_SEC) for that department, so a save and the owner hand-over after
it do not ask twice. The head and backup head themselves and a Super
Administrator need no code. A department with no head set goes to the Super
Administrators. A scope is (company id, department name); "" = every
department ("All" on the form).

The codes reuse the vault's own challenge and session tables
(VaultOtpChallenge / VaultOtpSession, purpose "head:<company>:<dept>").
"""
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import func

import models

HEAD_WINDOW_SEC = 600   # one OK covers ten minutes of changes in that department


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def scope(company_id: str, dept: str) -> tuple:
    return ((company_id or "").strip(), (dept or "").strip())


def purpose(sc: tuple) -> str:
    return f"head:{sc[0]}:{sc[1].lower()}"


def dept_heads(db, sc: tuple) -> list:
    """The head and backup head of the department in that company (lead first)."""
    co, name = sc
    if not name:
        return []
    out = []
    for d in db.query(models.HrDepartment).filter(func.lower(models.HrDepartment.name) == name.lower()).all():
        if co and (d.company_id or "") != co:
            continue
        for e in ((d.lead_email or "").strip().lower(), (d.backup_email or "").strip().lower()):
            if e and e not in out:
                out.append(e)
    return out


def super_admins(db) -> list:
    return sorted({(r.email or "").lower() for r in db.query(models.NexusRole).filter(models.NexusRole.role == "owner").all() if r.email})


def approvers(db, sc: tuple) -> tuple:
    """(emails, fallback) - the department's heads, else the Super Administrators."""
    heads = dept_heads(db, sc)
    return (heads, False) if heads else (super_admins(db), True)


def exempt(db, user: dict, sc: tuple) -> bool:
    return int(user.get("level") or 0) >= 5 or user["email"].lower() in dept_heads(db, sc)


def has_window(db, email: str, sc: tuple) -> bool:
    return (db.query(models.VaultOtpSession.id)
            .filter(models.VaultOtpSession.email == email.lower(), models.VaultOtpSession.purpose == purpose(sc),
                    models.VaultOtpSession.expires_at > _now()).first()) is not None


def open_window(db, email: str, sc: tuple, sid: str) -> int:
    db.add(models.VaultOtpSession(
        id=sid, email=email.lower(), purpose=purpose(sc), channel="head",
        expires_at=(datetime.now(timezone.utc) + timedelta(seconds=HEAD_WINDOW_SEC)).isoformat(), created_at=_now()))
    return HEAD_WINDOW_SEC


def require(db, user: dict, scopes, name_of, company_name=lambda c: c) -> None:
    """Raise 403 head_code_required unless every scope is the caller's own
    (head, backup head, Super Administrator) or has a live window."""
    missing, seen = [], set()
    for sc in scopes:
        sc = scope(*sc)
        if sc in seen:
            continue
        seen.add(sc)
        if exempt(db, user, sc) or has_window(db, user["email"], sc):
            continue
        who, fallback = approvers(db, sc)
        missing.append({"companyId": sc[0], "company": company_name(sc[0]) if sc[0] else "", "dept": sc[1],
                        "heads": [name_of(e) for e in who], "fallback": fallback})
    if missing:
        first = missing[0]
        raise HTTPException(403, {
            "code": "head_code_required", "scopes": missing,
            "message": f"This change needs a code from {' or '.join(first['heads']) or 'a Super Administrator'}"
                       f" ({first['dept'] or 'every department'} head).",
        })
