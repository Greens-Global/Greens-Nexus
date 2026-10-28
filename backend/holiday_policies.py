"""Holiday policies (Neil, Oct 29 2026 - docs/superpowers/specs/
2026-10-29-holiday-policies-design.md).

A policy is a named set of holidays that applies, LIVE, to one or more
companies (HrHolidayPolicyAssignment). `hr_company_holidays` stays the one
effective table every reader uses (Time Sheets, the Workforce Scorecard, the
no-show scan, checklists, the dashboard, the directory): `sync` materializes
a policy's holidays into each assigned company's rows (policy_id set). A
company may skip a policy holiday (the assignment's `skipped`), change one's
date / type / name for itself (`overridden` = 1, sync leaves it alone) and
keep its own holidays (policy_id '').

`sync` runs inside the caller's transaction - it flushes and never commits.
"""
from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Iterable, Optional

from sqlalchemy.orm import Session

import holiday_sources
from holiday_sources import name_key, us_date, weekday_name
from models import HrCompanyHoliday, HrEntity, HrHolidayPolicy, HrHolidayPolicyAssignment

WEEKEND_RULES = ("keep", "nearest_weekday", "next_monday", "prior_friday", "not_observed")
WEEKEND_RULE_WORDS = {
    "keep": "Keep The Date",
    "nearest_weekday": "Nearest Weekday (Saturday to Friday, Sunday to Monday)",
    "next_monday": "The Monday After",
    "prior_friday": "The Friday Before",
    "not_observed": "No Day Off",
}
HOLIDAY_TYPES = ("mandatory", "optional", "half_day")
POLICY_SOURCE = "policy"
_ISO = re.compile(r"\d{4}-\d{2}-\d{2}")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def valid_iso(s) -> bool:
    if not isinstance(s, str) or not _ISO.fullmatch(s):
        return False
    try:
        date.fromisoformat(s)
        return True
    except ValueError:
        return False


# --- Weekend rules ----------------------------------------------------------

def apply_rule(date_iso: str, rule: str) -> Optional[str]:
    """The day off for a holiday whose real date is `date_iso`, under the
    policy's weekend rule. None = not observed (no day off). A weekday date
    is returned unchanged under every rule."""
    d = date.fromisoformat(date_iso[:10])
    wd = d.weekday()
    if wd < 5:
        return d.isoformat()
    rule = rule if rule in WEEKEND_RULES else "keep"
    if rule == "keep":
        return d.isoformat()
    if rule == "not_observed":
        return None
    if rule == "nearest_weekday":
        return (d - timedelta(days=1) if wd == 5 else d + timedelta(days=1)).isoformat()
    if rule == "next_monday":
        return (d + timedelta(days=7 - wd)).isoformat()
    # prior_friday
    return (d - timedelta(days=wd - 4)).isoformat()


# --- Holiday rows inside a policy -------------------------------------------

def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-") or "holiday"


def countries_of(h: dict) -> list:
    """A policy holiday's countries: the new `countries` list, else the old
    comma-separated `country_code` string."""
    raw = h.get("countries")
    if raw is None or raw == "" or raw == []:
        raw = h.get("country_code") or h.get("countryCode") or ""
    if isinstance(raw, str):
        raw = raw.split(",")
    out = []
    for c in raw or []:
        c = str(c or "").strip().upper()
        if c and c not in out:
            out.append(c)
    return sorted(out)


def make_key(countries: Iterable[str], name: str, year) -> str:
    joined = ",".join(sorted(countries)) or "ALL"
    return f"{joined}:{slug(name)}:{year}"


def normalize_holiday(h: dict, year=None) -> dict:
    """One policy holiday in the current shape. Old rows (Sep 22 shape:
    date, name, source, country_code, type) get a key on read. The key's
    year is the REAL date's year (actualDate when the day off is observed on
    another day), else `year`, else the date's."""
    h = dict(h or {})
    d = str(h.get("date") or "").strip()[:10]
    actual = str(h.get("actualDate") or h.get("actual_date") or "").strip()[:10]
    if actual == d:
        actual = ""
    name = str(h.get("name") or "").strip()
    countries = countries_of(h)
    type_ = h.get("type") if h.get("type") in HOLIDAY_TYPES else "mandatory"
    key = str(h.get("key") or "").strip()
    if not key:
        yr = (actual or d)[:4] if valid_iso(actual or d) else (str(year) if year else "")
        key = make_key(countries, name, yr)
    return {
        "key": key, "date": d, "actualDate": actual, "name": name, "type": type_,
        "countries": countries, "source": str(h.get("source") or "manual"),
        "scope": str(h.get("scope") or ""), "tentative": bool(h.get("tentative")),
    }


def normalize_holidays(rows: Iterable[dict]) -> list:
    """normalize_holiday over a list, keys made unique (a second holiday with
    the same key gets ":2", ":3" ...), sorted by date."""
    out, seen = [], set()
    for h in rows or []:
        n = normalize_holiday(h)
        base, i = n["key"], 2
        while n["key"] in seen:
            n["key"] = f"{base}:{i}"
            i += 1
        seen.add(n["key"])
        out.append(n)
    out.sort(key=lambda x: (x["date"], x["name"]))
    return out


def policy_holidays(policy: HrHolidayPolicy) -> list:
    return normalize_holidays(policy.holidays or [])


def holiday_years(holidays: Iterable[dict]) -> list:
    return sorted({(h.get("actualDate") or h.get("date") or "")[:4] for h in holidays
                   if valid_iso(h.get("actualDate") or h.get("date") or "")})


def _usable(h: dict) -> bool:
    return valid_iso(h.get("date")) and bool(h.get("name"))


# --- Sync -------------------------------------------------------------------

def _wanted_fields(h: dict) -> dict:
    return {"date": h["date"], "actual_date": h.get("actualDate") or "", "name": h["name"],
            "type": h.get("type") or "mandatory", "country_code": ",".join(h.get("countries") or [])}


def _diff(rows: list, holidays: list, skipped: set, assigned: bool) -> list:
    """The operations that bring one company's rows for one policy in line.
    rows = that company's hr_company_holidays rows with this policy_id.
    [("add", holiday) | ("update", row, {field: value}, holiday) |
     ("delete", row) | ("detach", row) | ("hold", row, holiday)]
    "hold" = an overridden row whose policy holiday differs: left alone."""
    ops, by_key = [], {}
    for r in sorted(rows, key=lambda r: r.created_at or ""):
        if r.policy_key in by_key:
            ops.append(("delete", r))          # a duplicate of the same key
        else:
            by_key[r.policy_key] = r
    policy_keys = {h["key"] for h in holidays}
    wanted = {h["key"]: h for h in holidays if assigned and h["key"] not in skipped and _usable(h)}
    for key, h in wanted.items():
        r = by_key.get(key)
        fields = _wanted_fields(h)
        if r is None:
            ops.append(("add", h))
            continue
        if r.overridden:
            changes = {"country_code": fields["country_code"]} if (r.country_code or "") != fields["country_code"] else {}
            if changes:
                ops.append(("update", r, changes, h))
            if any((getattr(r, f) or "") != fields[f] for f in ("date", "type", "name")):
                ops.append(("hold", r, h))
            continue
        changes = {f: v for f, v in fields.items() if (getattr(r, f) or "") != v}
        if (r.source or "") != POLICY_SOURCE:
            changes["source"] = POLICY_SOURCE
        if changes:
            ops.append(("update", r, changes, h))
    for key, r in by_key.items():
        if key in wanted:
            continue
        if r.overridden and (not assigned or key not in policy_keys):
            ops.append(("detach", r))        # the company's change survives as its own holiday
        else:
            ops.append(("delete", r))
    return ops


def _assignments(db: Session, policy_id: str, company_ids=None) -> dict:
    q = db.query(HrHolidayPolicyAssignment).filter(HrHolidayPolicyAssignment.policy_id == policy_id)
    if company_ids is not None:
        q = q.filter(HrHolidayPolicyAssignment.company_id.in_(list(company_ids)))
    return {a.company_id: a for a in q.all()}


def _rows_by_company(db: Session, policy_id: str, company_ids=None) -> dict:
    q = db.query(HrCompanyHoliday).filter(HrCompanyHoliday.policy_id == policy_id)
    if company_ids is not None:
        q = q.filter(HrCompanyHoliday.company_id.in_(list(company_ids)))
    out: dict = {}
    for r in q.all():
        out.setdefault(r.company_id, []).append(r)
    return out


def sync(db: Session, policy: HrHolidayPolicy, company_ids=None, *, actor: str = "", holidays=None) -> dict:
    """Bring every assigned company's rows for `policy` in line with it (or
    only `company_ids`). A company that has rows for the policy but no
    assignment (just unassigned, or the policy is being deleted) loses the
    non-overridden ones; its overridden ones become its own holidays.
    Flushes, never commits. {companies, added, updated, removed, detached}."""
    db.flush()
    holidays = policy_holidays(policy) if holidays is None else holidays
    ids = None if company_ids is None else [c for c in company_ids if c]
    assigns = _assignments(db, policy.id, ids)
    rows = _rows_by_company(db, policy.id, ids)
    companies = sorted(set(assigns) | set(rows))
    now = _now()
    out = {"companies": 0, "added": 0, "updated": 0, "removed": 0, "detached": 0}
    for cid in companies:
        a = assigns.get(cid)
        ops = _diff(rows.get(cid, []), holidays, set((a.skipped if a else None) or []), a is not None)
        if a is not None:
            out["companies"] += 1
        for op in ops:
            kind = op[0]
            if kind == "add":
                h = op[1]
                f = _wanted_fields(h)
                db.add(HrCompanyHoliday(
                    id=str(uuid.uuid4()), company_id=cid, date=f["date"], name=f["name"], source=POLICY_SOURCE,
                    country_code=f["country_code"], type=f["type"], policy_id=policy.id, policy_key=h["key"],
                    actual_date=f["actual_date"], overridden=0, created_by=actor or "policy",
                    created_at=now, updated_at=now))
                out["added"] += 1
            elif kind == "update":
                r, changes = op[1], op[2]
                for k, v in changes.items():
                    setattr(r, k, v)
                r.updated_at = now
                out["updated"] += 1
            elif kind == "delete":
                db.delete(op[1])
                out["removed"] += 1
            elif kind == "detach":
                r = op[1]
                r.policy_id, r.policy_key, r.overridden, r.source = "", "", 0, "manual"
                r.updated_at = now
                out["detached"] += 1
    db.flush()
    return out


def unassign_all(db: Session, policy: HrHolidayPolicy, *, actor: str = "") -> dict:
    """Every assignment of the policy goes, then sync takes its rows off
    (overridden ones stay as the companies' own)."""
    for a in db.query(HrHolidayPolicyAssignment).filter(HrHolidayPolicyAssignment.policy_id == policy.id).all():
        db.delete(a)
    db.flush()
    return sync(db, policy, actor=actor)


# --- Preview ----------------------------------------------------------------

def _overlap(a: list, b: list) -> bool:
    return not a or not b or bool(set(a) & set(b))


def _changed_keys(old: list, new: list) -> set:
    o = {h["key"]: h for h in old}
    out = set()
    for h in new:
        p = o.get(h["key"])
        if p is not None and any(p.get(f) != h.get(f) for f in ("date", "type", "name", "countries")):
            out.add(h["key"])
    return out


def _brief(h_or_row) -> dict:
    if isinstance(h_or_row, dict):
        return {"key": h_or_row.get("key", ""), "date": h_or_row["date"], "name": h_or_row["name"]}
    return {"key": h_or_row.policy_key or "", "date": h_or_row.date, "name": h_or_row.name}


def preview(db: Session, policy: Optional[HrHolidayPolicy], holidays: list, companies: Optional[set],
            visible=None) -> dict:
    """What saving `holidays` (normalized) with assignment set `companies`
    (None = unchanged) would do, per company - nothing is written.
    {companies: [{id, name, assigned, added, removed, changed, detached,
    changedSkipped, conflicts}]}. `visible` (a set) limits the companies
    shown to a scoped admin."""
    pid = policy.id if policy else ""
    assigns = _assignments(db, pid) if pid else {}
    rows = _rows_by_company(db, pid) if pid else {}
    target = set(assigns) if companies is None else set(companies)
    old = policy_holidays(policy) if policy else []
    changed_keys = _changed_keys(old, holidays)
    ids = sorted(target | set(rows))
    if visible is not None:
        ids = [c for c in ids if c in visible]
    names = {e.id: e.name for e in db.query(HrEntity).filter(HrEntity.id.in_(ids)).all()} if ids else {}
    others: dict = {}
    if ids:
        for r in (db.query(HrCompanyHoliday).filter(HrCompanyHoliday.company_id.in_(ids)).all()):
            if pid and r.policy_id == pid:
                continue
            others.setdefault(r.company_id, []).append(r)
    policy_names = {p.id: p.name for p in db.query(HrHolidayPolicy).all()}
    out = []
    for cid in ids:
        a = assigns.get(cid)
        skipped = set((a.skipped if a else None) or [])
        assigned = cid in target
        ops = _diff(rows.get(cid, []), holidays, skipped, assigned)
        held = {op[2]["key"] for op in ops if op[0] == "hold"}
        conflicts = []
        if assigned:
            for h in holidays:
                if h["key"] in skipped or not _usable(h):
                    continue
                for r in others.get(cid, []):
                    if (r.date == h["date"] and name_key(r.name) == name_key(h["name"])
                            and _overlap(h.get("countries") or [], [c for c in (r.country_code or "").split(",") if c])):
                        conflicts.append({"date": h["date"], "name": h["name"],
                                          "with": policy_names.get(r.policy_id, "") if r.policy_id
                                          else "Company's Own Holidays"})
        out.append({
            "id": cid, "name": names.get(cid, cid), "assigned": assigned,
            "added": [_brief(op[1]) for op in ops if op[0] == "add"],
            "removed": [_brief(op[1]) for op in ops if op[0] == "delete"],
            "changed": [_brief(op[3]) for op in ops if op[0] == "update" and set(op[2]) - {"source"}
                        and not op[1].overridden],
            "detached": [_brief(op[1]) for op in ops if op[0] == "detach"],
            "changedSkipped": len({k for k in changed_keys if k in skipped or k in held}),
            "conflicts": conflicts,
        })
    return {"companies": out}


# --- The company calendar ---------------------------------------------------

def _fixed_federal_name(name: str) -> str:
    nk = name_key(name)
    for fname in holiday_sources.US_FIXED_FEDERAL:
        fk = name_key(fname)
        if nk == fk or (fk == "christmas day" and nk == "christmas") or (fk == "juneteenth" and nk.startswith("juneteenth")):
            return fname
    return ""


def observed_hint(name: str, date_iso: str, country_code: str = "") -> str:
    """For a saved row sitting on the federal OBSERVED date of a US fixed-date
    holiday: "Independence Day is 07/04/2027, a Sunday - this company takes
    07/05/2027". '' otherwise."""
    codes = [c for c in (country_code or "").split(",") if c]
    if codes and "US" not in codes:
        return ""
    fname = _fixed_federal_name(name)
    if not fname or not valid_iso(date_iso):
        return ""
    m, d = holiday_sources.US_FIXED_FEDERAL[fname]
    y = int(date_iso[:4])
    for yy in (y, y + 1):
        try:
            real = date(yy, m, d)
        except ValueError:
            continue
        if real.weekday() >= 5 and real.isoformat() != date_iso and holiday_sources.observed_federal(real) == date_iso:
            shown = re.sub(r"\s*\(observed\)\s*", " ", name, flags=re.I).strip() or fname
            return (f"{shown} is {us_date(real.isoformat())}, a {weekday_name(real.isoformat())} - "
                    f"this company takes {us_date(date_iso)}")
    return ""


def company_calendar(db: Session, company_id: str, year: Optional[int] = None) -> dict:
    yr = str(year) if year else ""
    assigns = (db.query(HrHolidayPolicyAssignment)
               .filter(HrHolidayPolicyAssignment.company_id == company_id).all())
    pols = {p.id: p for p in db.query(HrHolidayPolicy).order_by(HrHolidayPolicy.name).all()}
    assigned_ids = [a.policy_id for a in assigns if a.policy_id in pols]
    q = db.query(HrCompanyHoliday).filter(HrCompanyHoliday.company_id == company_id)
    if yr:
        q = q.filter(HrCompanyHoliday.date.like(f"{yr}-%"))
    holidays = []
    for r in q.order_by(HrCompanyHoliday.date, HrCompanyHoliday.name).all():
        pol = pols.get(r.policy_id or "")
        holidays.append({
            "id": r.id, "date": r.date, "actualDate": r.actual_date or "", "weekday": weekday_name(r.date),
            "name": r.name, "type": r.type or "mandatory",
            "countries": [c for c in (r.country_code or "").split(",") if c], "countryCode": r.country_code or "",
            "source": r.source or "manual", "policyId": r.policy_id or "", "policyName": pol.name if pol else "",
            "policyKey": r.policy_key or "", "overridden": bool(r.overridden),
            "observedHint": "" if r.actual_date else observed_hint(r.name, r.date, r.country_code or ""),
        })
    policies, skipped = [], []
    for a in sorted(assigns, key=lambda a: (pols[a.policy_id].name if a.policy_id in pols else "")):
        p = pols.get(a.policy_id)
        if not p:
            continue
        keys = list(a.skipped or [])
        policies.append({"id": p.id, "name": p.name, "weekendRule": p.weekend_rule or "keep", "skipped": keys})
        by_key = {h["key"]: h for h in policy_holidays(p)}
        for k in keys:
            h = by_key.get(k)
            if not h or (yr and not h["date"].startswith(yr)):
                continue
            skipped.append({"policyId": p.id, "policyName": p.name, "key": k, "date": h["date"], "name": h["name"]})
    skipped.sort(key=lambda s: (s["date"], s["name"]))
    available = [{"id": p.id, "name": p.name} for pid, p in pols.items() if pid not in assigned_ids]
    return {"policies": policies, "holidays": holidays, "skipped": skipped, "available": available}


# --- Copy a year ------------------------------------------------------------

def copy_year(policy: HrHolidayPolicy, from_year: int, to_year: int, *, source=None) -> dict:
    """The policy's holidays of `from_year` rebuilt for `to_year` from the
    public sources, matched by (country, name), with the policy's weekend
    rule applied. Nothing is saved. {holidays: [...], unmatched: [names],
    notObserved: [names]}. `source` = public_holidays (tests pass a fake)."""
    source = source or holiday_sources.public_holidays
    rule = policy.weekend_rule or "keep"
    fy, ty = str(from_year), int(to_year)
    lists: dict = {}

    def _list(country: str) -> list:
        if country not in lists:
            res = source(country, ty)
            lists[country] = (res or {}).get("holidays") or []
        return lists[country]

    existing = {h["key"] for h in policy_holidays(policy)}
    out, unmatched, not_observed = [], [], []
    for h in policy_holidays(policy):
        real_old = h.get("actualDate") or h["date"]
        if not real_old.startswith(fy):
            continue
        hit = None
        for c in (h.get("countries") or []):
            for s in _list(c):
                if name_key(s["name"]) == name_key(h["name"]):
                    hit = s
                    break
            if hit:
                break
        if not hit:
            unmatched.append(h["name"])
            continue
        day = apply_rule(hit["date"], rule)
        if day is None:
            not_observed.append(h["name"])
            continue
        n = {"date": day, "actualDate": hit["date"] if day != hit["date"] else "", "name": h["name"],
             "type": h.get("type") or "mandatory", "countries": h.get("countries") or [],
             "source": h.get("source") or "public", "scope": hit.get("scope") or h.get("scope") or "",
             "tentative": bool(hit.get("tentative"))}
        n["key"] = make_key(n["countries"], n["name"], ty)
        if n["key"] in existing:
            continue        # already in the policy for that year
        out.append(n)
    out.sort(key=lambda x: (x["date"], x["name"]))
    return {"holidays": out, "unmatched": unmatched, "notObserved": not_observed}
