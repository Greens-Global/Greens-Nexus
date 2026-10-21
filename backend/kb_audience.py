"""Audiences (Oct 2026 rebuild): who must sign a policy, who takes a course,
who is on a training plan. One picker, one JSON shape, one matcher - built
on the People fields that already exist.

  {
    "everyone": false,
    "companies": ["<HrEntity.id>", ...],
    "departments": ["Operations", ...],
    "job_titles": ["Site Manager", ...],
    "locations": ["Escondido", ...],
    "managers": ["lead@greensglobal.com", ...],   # their direct reports
    "people": ["a@greensglobal.com", ...],        # named people, always in
    "employment_types": ["full_time", ...]
  }

A person matches when they are named, OR every non-empty rule list matches
them (AND across lists, OR inside a list). An empty audience ("" / {} /
everyone) means every active employee.
"""
from __future__ import annotations

import json
from typing import Iterable

from sqlalchemy.orm import Session

import models

KEYS = ("companies", "departments", "job_titles", "locations", "managers", "people", "employment_types")


def loads(raw) -> dict:
    if isinstance(raw, dict):
        a = raw
    else:
        try:
            a = json.loads(raw) if raw else {}
        except (ValueError, TypeError):
            a = {}
    out = {"everyone": bool(a.get("everyone"))}
    for k in KEYS:
        v = a.get(k) or []
        out[k] = [str(x).strip() for x in v if str(x or "").strip()]
    out["people"] = [p.lower() for p in out["people"]]
    out["managers"] = [m.lower() for m in out["managers"]]
    return out


def dumps(a: dict) -> str:
    return json.dumps(loads(a), separators=(",", ":"))


def is_everyone(a: dict) -> bool:
    a = loads(a)
    return a["everyone"] or not any(a[k] for k in KEYS)


def describe(a: dict, db: Session | None = None) -> str:
    """Plain words for a card: "Operations · Site Manager, Assistant Manager · 2 named"."""
    a = loads(a)
    if is_everyone(a):
        return "Everyone"
    parts = []
    if a["companies"]:
        names = a["companies"]
        if db is not None:
            rows = db.query(models.HrEntity).filter(models.HrEntity.id.in_(a["companies"])).all()
            names = [r.name for r in rows] or names
        parts.append(", ".join(names))
    if a["departments"]:
        parts.append(", ".join(a["departments"]))
    if a["job_titles"]:
        parts.append(", ".join(a["job_titles"]))
    if a["locations"]:
        parts.append(", ".join(a["locations"]))
    if a["employment_types"]:
        parts.append(", ".join(t.replace("_", " ").title() for t in a["employment_types"]))
    if a["managers"]:
        parts.append(f"reports to {', '.join(a['managers'])}")
    if a["people"]:
        parts.append(f"{len(a['people'])} named")
    return " · ".join(parts)


def _active_people(db: Session) -> list[models.NexusEmployee]:
    return db.query(models.NexusEmployee).filter(
        models.NexusEmployee.status.in_(("onboarding", "active")),
        models.NexusEmployee.deleted_at == "",
        models.NexusEmployee.work_email != "",
        models.NexusEmployee.identity_type != "guest",
    ).all()


def matches(emp: models.NexusEmployee, a: dict) -> bool:
    a = loads(a)
    email = (emp.work_email or "").lower()
    if email in a["people"]:
        return True
    if a["everyone"]:
        return True
    rules = [k for k in KEYS if k != "people" and a[k]]
    if not rules:
        return not a["people"]   # nothing set at all = everyone; only named people = those only
    for k in rules:
        want = a[k]
        if k == "companies" and (emp.company or "") not in want:
            return False
        if k == "departments" and (emp.department or "").strip().lower() not in {w.lower() for w in want}:
            return False
        if k == "job_titles" and (emp.job_title or "").strip().lower() not in {w.lower() for w in want}:
            return False
        if k == "locations" and (emp.location or "").strip().lower() not in {w.lower() for w in want}:
            return False
        if k == "employment_types" and (emp.employment_type or "") not in want:
            return False
        if k == "managers" and (emp.manager_email or "").lower() not in want:
            return False
    return True


def members(db: Session, a: dict) -> list[models.NexusEmployee]:
    """Every active employee the audience covers (named people included even
    if they match no rule)."""
    a = loads(a)
    people = _active_people(db)
    out = [e for e in people if matches(e, a)]
    have = {(e.work_email or "").lower() for e in out}
    by_email = {(e.work_email or "").lower(): e for e in people}
    for p in a["people"]:
        if p not in have and p in by_email:
            out.append(by_email[p])
    return out


def member_emails(db: Session, a: dict) -> set[str]:
    return {(e.work_email or "").lower() for e in members(db, a)}


def options(db: Session) -> dict:
    """What the picker offers: the distinct values People actually has."""
    people = _active_people(db)
    ents = {e.id: e.name for e in db.query(models.HrEntity).all()}

    def distinct(vals: Iterable[str]) -> list[str]:
        seen: dict[str, str] = {}
        for v in vals:
            v = (v or "").strip()
            if v and v.lower() not in seen:
                seen[v.lower()] = v
        return sorted(seen.values(), key=str.lower)

    managers = distinct(e.manager_email for e in people)
    return {
        "companies": [{"id": i, "name": n} for i, n in sorted(ents.items(), key=lambda kv: kv[1].lower())],
        "departments": distinct(e.department for e in people),
        "job_titles": distinct(e.job_title for e in people),
        "locations": distinct(e.location for e in people),
        "employment_types": distinct(e.employment_type for e in people),
        "managers": [{"email": m.lower(), "name": next((f"{p.first_name} {p.last_name}".strip() for p in people
                                                           if (p.work_email or "").lower() == m.lower()), m)} for m in managers],
        "people_count": len(people),
    }


def preview(db: Session, a: dict, limit: int = 12) -> dict:
    ms = members(db, a)
    ms.sort(key=lambda e: ((e.last_name or ""), (e.first_name or "")))
    return {
        "count": len(ms),
        "description": describe(a, db),
        "sample": [{"email": (e.work_email or "").lower(), "name": (e.display_name or f"{e.first_name or ''} {e.last_name or ''}").strip(),
                    "department": e.department or "", "job_title": e.job_title or ""} for e in ms[:limit]],
    }


def person_start_date(emp: models.NexusEmployee) -> str:
    return (emp.start_date or "")[:10]
