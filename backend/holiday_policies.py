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

Two holidays on one date (review, Oct 29 2026): Christmas 2027 observed on
12/24 lands on Christmas Eve, India's 08/15/2027 has Independence Day and two
observances. Every reader asks `holidays_by_date` / `merge_day`: the day is
the STRONGEST type (mandatory > half_day > optional) and the names are joined
" / " - the same answer whichever row was saved last.
"""
from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Iterable, Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

import holiday_sources
from holiday_sources import canonical_name, name_key, same_holiday_name, us_date, weekday_name
from models import HrCompanyHoliday, HrEntity, HrHolidayPolicy, HrHolidayPolicyAssignment

WEEKEND_RULES = ("keep", "nearest_weekday", "next_monday", "prior_friday", "not_observed")
HOLIDAY_TYPES = ("mandatory", "optional", "half_day")
TYPE_WORDS = {"mandatory": "Mandatory", "optional": "Optional", "half_day": "Half Day"}
# Which holiday a date is when several land on it: the stronger type wins.
TYPE_STRENGTH = {"mandatory": 3, "half_day": 2, "optional": 1}
POLICY_SOURCE = "policy"
# "The same holiday" across sources: the same (alias-aware) name within this
# many days of each other (Independence Day 07/04 and its observed 07/05).
NEAR_DAYS = 3
OLD_PRESIDENTS_DAY = "Washington's Birthday"
PRESIDENTS_DAY = "Presidents' Day"
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


def _days_apart(a: str, b: str) -> Optional[int]:
    if not (valid_iso(a) and valid_iso(b)):
        return None
    return abs((date.fromisoformat(a) - date.fromisoformat(b)).days)


def display_name(name: str, countries=None) -> str:
    """The name a holiday is shown with: a US (or every-country) row the old
    Nager list called "Washington's Birthday" is Presidents' Day (Neil, Oct 29
    2026). Every other name is returned as it is."""
    n = (name or "").strip()
    if name_key(n) not in ("washington s birthday", "washingtons birthday"):
        return n
    codes = countries if isinstance(countries, list) else [c.strip().upper() for c in str(countries or "").split(",")]
    codes = [c for c in codes if c]
    return PRESIDENTS_DAY if not codes or "US" in codes else n


# --- One answer per date (every reader) ---------------------------------------

def _field(r, name: str):
    return r.get(name) if isinstance(r, dict) else getattr(r, name, None)


def row_countries(r) -> list:
    """The countries a calendar row (HrCompanyHoliday) or a policy holiday
    (dict) applies to; [] = everyone at the company."""
    if isinstance(r, dict) and r.get("countries") not in (None, ""):
        return countries_of(r)
    return [c.strip().upper() for c in str(_field(r, "country_code") or "").split(",") if c.strip()]


def company_countries(db: Session, company_ids) -> dict:
    """{company id: its country (upper case)} for person_country."""
    ids = [c for c in set(company_ids or []) if c]
    if not ids:
        return {}
    return {e.id: (e.country or "").strip().upper()
            for e in db.query(HrEntity).filter(HrEntity.id.in_(ids)).all()}


def person_country(emp, company_country: str = "") -> str:
    """The country a person's holidays follow: their own, else their
    company's (Neil, Oct 30 2026 - three people with no country on their
    record were missing Thanksgiving, a US-picked holiday, while their
    colleagues had it). The Workforce Scorecard's `_effective_country` is
    the same rule."""
    own = (getattr(emp, "country", "") or "").strip().upper() if emp is not None else ""
    return own or (company_country or "").strip().upper()


def applies_to(r, country) -> bool:
    """A public holiday applies only to the countries it was picked for; a
    typed-in one (no countries) to everyone."""
    codes = row_countries(r)
    return not codes or str(country or "").strip().upper() in codes


def _type_of(r) -> str:
    t = _field(r, "type")
    return t if t in TYPE_STRENGTH else "mandatory"


def rank(rows) -> list:
    """Holidays sharing a date, strongest first: type (mandatory > half_day >
    optional), then name. Never depends on the order rows were saved in."""
    return sorted(rows, key=lambda r: (-TYPE_STRENGTH[_type_of(r)], name_key(_field(r, "name") or ""),
                                       str(_field(r, "name") or "")))


def merge_day(rows, country) -> Optional[dict]:
    """THE rule for a date that has several holidays (rows of ONE company on
    ONE date): only the rows that apply to `country` count; the day takes the
    strongest type, its name is every name strongest first, joined " / "
    (the same holiday under two names is named once). None = no holiday for
    that country. {name, type}."""
    hits = rank([r for r in rows or [] if applies_to(r, country)])
    if not hits:
        return None
    names, seen = [], set()
    for r in hits:
        n = display_name(str(_field(r, "name") or ""), row_countries(r))
        if n and canonical_name(n) not in seen:
            seen.add(canonical_name(n))
            names.append(n)
    return {"name": " / ".join(names) or "Holiday", "type": _type_of(hits[0])}


def holidays_by_date(rows, country) -> dict:
    """{date: merge_day(...)} over one company's rows for one person's
    country - what timeclock._company_holidays_for_employee /
    _company_holidays_for_many and workforce_scorecard._holidays answer."""
    by: dict = {}
    for r in rows or []:
        by.setdefault(_field(r, "date"), []).append(r)
    out = {}
    for d in sorted(k for k in by if k):
        m = merge_day(by[d], country)
        if m:
            out[d] = m
    return out


def _names(rows) -> str:
    out = []
    for r in rows:
        n = str(_field(r, "name") or "")
        if n and n not in out:
            out.append(n)
    return " and ".join(out)


def same_day_note(h, others) -> str:
    """"Same day as Christmas Eve - Christmas Day wins" for a holiday that
    shares its date with `others` (merge_day's rule, in words)."""
    others = [o for o in others if o is not h]
    if not others:
        return ""
    if all(same_holiday_name(_field(o, "name") or "", _field(h, "name") or "") for o in others):
        return "The same holiday is listed twice on this day - it counts once"
    ranked = rank([h] + others)
    top = ranked[0]
    tied = [r for r in ranked if _type_of(r) == _type_of(top)]
    if len(tied) > 1:
        return f"Same day as {_names(others)} - one {TYPE_WORDS[_type_of(top)]} day, the names shown together"
    return f"Same day as {_names(others)} - {_field(top, 'name')} wins"


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
        "key": key, "date": d, "actualDate": actual, "name": display_name(name, countries), "type": type_,
        "countries": countries, "source": str(h.get("source") or "manual"),
        "scope": str(h.get("scope") or ""), "tentative": bool(h.get("tentative")),
    }


def _keep_existing_keys(rows: list, existing: list) -> list:
    """A holiday sent without a key keeps the key it already has in the policy
    (Oct 29 2026 review): by its name first (the key it would get anyway),
    else - a rename - the existing holiday of the same countries on the same
    day off or the same real date. Re-keying would delete the companies' rows
    and detach the changes they made. Each existing key is given out once."""
    old = [normalize_holiday(o) for o in existing or []]
    old_keys = {o["key"] for o in old}
    claimed = {str(h.get("key") or "").strip() for h in rows if str(h.get("key") or "").strip()}
    pending = []
    for h in rows:
        if str(h.get("key") or "").strip():
            continue
        natural = normalize_holiday(h)["key"]
        if natural in old_keys and natural not in claimed:
            claimed.add(natural)
        else:
            pending.append(h)
    for h in pending:
        n = normalize_holiday(h)
        real = n["actualDate"] or n["date"]
        for o in old:
            if o["key"] in claimed or o["countries"] != n["countries"]:
                continue
            if o["date"] == n["date"] or (o["actualDate"] or o["date"]) == real:
                h["key"] = o["key"]
                claimed.add(o["key"])
                break
    return rows


def normalize_holidays(rows: Iterable[dict], existing: Optional[Iterable[dict]] = None) -> list:
    """normalize_holiday over a list, keys made unique (a second holiday with
    the same key gets ":2", ":3" ...), sorted by date. `existing` = the
    policy's holidays before this save (see _keep_existing_keys)."""
    rows = [dict(h or {}) for h in rows or []]
    if existing:
        rows = _keep_existing_keys(rows, list(existing))
    out, seen = [], set()
    for h in rows:
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
    """{company_id: assignment}. (policy_id, company_id) is unique (the
    ux_hr_holiday_policy_assignments_policy_company index); should a
    duplicate ever exist, the oldest one counts - never whichever came last."""
    q = db.query(HrHolidayPolicyAssignment).filter(HrHolidayPolicyAssignment.policy_id == policy_id)
    if company_ids is not None:
        q = q.filter(HrHolidayPolicyAssignment.company_id.in_(list(company_ids)))
    out: dict = {}
    for a in q.order_by(HrHolidayPolicyAssignment.assigned_at, HrHolidayPolicyAssignment.id).all():
        out.setdefault(a.company_id, a)
    return out


def assignment(db: Session, policy_id: str, company_id: str):
    """The one assignment of a policy to a company, or None."""
    return _assignments(db, policy_id, [company_id]).get(company_id)


# --- Skipped holidays --------------------------------------------------------
# An assignment's `skipped` holds a key per holiday the company does not take.
# A holiday the company had CHANGED before skipping it is kept as
# {key, date, actualDate, type, name} so Restore brings back the changed row
# (Oct 29 2026 review) - plain keys are the older shape and still read.

def _entry_key(e) -> str:
    return str((e.get("key") if isinstance(e, dict) else e) or "")


def skipped_keys(a) -> set:
    return {k for k in (_entry_key(e) for e in ((a.skipped if a else None) or [])) if k}


def skipped_entries(a) -> list:
    return [e for e in ((a.skipped if a else None) or []) if _entry_key(e)]


def _policy_row(db: Session, policy_id: str, company_id: str, key: str):
    return (db.query(HrCompanyHoliday)
            .filter(HrCompanyHoliday.company_id == company_id, HrCompanyHoliday.policy_id == policy_id,
                    HrCompanyHoliday.policy_key == key)
            .order_by(HrCompanyHoliday.created_at, HrCompanyHoliday.id).first())


def skip_holiday(db: Session, policy: HrHolidayPolicy, a, key: str, *, actor: str = "") -> dict:
    """Skip For This Company: the row goes; a change the company had made to
    it is kept in the skipped entry. Flushes, never commits."""
    row = _policy_row(db, policy.id, a.company_id, key)
    entry = key
    if row is not None and row.overridden:
        entry = {"key": key, "date": row.date, "actualDate": row.actual_date or "",
                 "type": row.type or "mandatory", "name": row.name, "countryCode": row.country_code or ""}
    a.skipped = [e for e in skipped_entries(a) if _entry_key(e) != key] + [entry]
    return sync(db, policy, [a.company_id], actor=actor)


def restore_holiday(db: Session, policy: HrHolidayPolicy, a, key: str, *, actor: str = "") -> dict:
    """Restore a skipped holiday. One the company had changed comes back
    changed (overridden); one the policy no longer has comes back as the
    company's own, the way sync detaches a changed holiday. Flushes, never
    commits."""
    entry = next((e for e in skipped_entries(a) if _entry_key(e) == key), None)
    a.skipped = [e for e in skipped_entries(a) if _entry_key(e) != key]
    result = sync(db, policy, [a.company_id], actor=actor)
    if not isinstance(entry, dict):
        return result
    now = _now()
    fields = {"date": entry.get("date") or "", "type": entry.get("type") or "mandatory",
              "name": (entry.get("name") or "").strip()}
    row = _policy_row(db, policy.id, a.company_id, key)
    if row is None:
        h = next((x for x in policy_holidays(policy) if x["key"] == key), None)
        if h is not None or not valid_iso(fields["date"]) or not fields["name"]:
            return result      # the policy still has it but it is not usable - nothing to bring back
        row = HrCompanyHoliday(id=str(uuid.uuid4()), company_id=a.company_id, source="manual", policy_id="",
                               policy_key="", overridden=0, country_code=entry.get("countryCode") or "",
                               created_by=actor or "policy", created_at=now)
        db.add(row)
        result["detached"] = result.get("detached", 0) + 1
    else:
        row.overridden = 1
    if valid_iso(fields["date"]):
        row.date = fields["date"]
    if fields["type"] in HOLIDAY_TYPES:
        row.type = fields["type"]
    if fields["name"]:
        row.name = fields["name"]
    actual = entry.get("actualDate") or ""
    row.actual_date = "" if actual == row.date else actual
    row.updated_at = now
    db.flush()
    return result


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
        ops = _diff(rows.get(cid, []), holidays, skipped_keys(a), a is not None)
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
    changedSkipped, conflicts}], otherCompanies: N, sameDay: [...]}.
    `visible` (a set) limits the companies shown to a scoped admin; the
    others are only counted (otherCompanies). conflicts = clash() against
    the company's other rows; sameDay = holidays of the policy sharing a day."""
    pid = policy.id if policy else ""
    assigns = _assignments(db, pid) if pid else {}
    rows = _rows_by_company(db, pid) if pid else {}
    target = set(assigns) if companies is None else set(companies)
    old = policy_holidays(policy) if policy else []
    changed_keys = _changed_keys(old, holidays)
    all_ids = sorted(target | set(rows))
    ids = all_ids if visible is None else [c for c in all_ids if c in visible]
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
        skipped = skipped_keys(a)
        assigned = cid in target
        ops = _diff(rows.get(cid, []), holidays, skipped, assigned)
        held = {op[2]["key"] for op in ops if op[0] == "hold"}
        conflicts = []
        if assigned:
            for h in holidays:
                if h["key"] in skipped or not _usable(h):
                    continue
                for r in others.get(cid, []):
                    c = clash(h, r, policy_names)
                    if c:
                        conflicts.append({"date": h["date"], "name": h["name"], "key": h["key"],
                                          "with": c["with"], "withName": c["name"], "withDate": c["date"],
                                          "reason": c["reason"], "note": c["note"]})
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
    # Companies the caller cannot see are still updated by the save - they
    # are counted, never named (Oct 29 2026 review).
    return {"companies": out, "otherCompanies": len(all_ids) - len(ids), "sameDay": same_day_in_policy(holidays)}


def same_day_in_policy(holidays: list) -> list:
    """Every holiday of the policy that shares its day off with another one
    for an overlapping country: [{key, date, name, with: [names], note}]
    ("Same day as Christmas Eve - Christmas Day wins")."""
    usable = [h for h in holidays or [] if _usable(h)]
    out = []
    for h in usable:
        others = [o for o in usable if o is not h and o["date"] == h["date"]
                  and _overlap(h.get("countries") or [], o.get("countries") or [])]
        if others:
            out.append({"key": h.get("key", ""), "date": h["date"], "name": h["name"],
                        "with": [o["name"] for o in others], "note": same_day_note(h, others)})
    return out


def _row_label(r, policy_names: dict) -> str:
    return (policy_names.get(r.policy_id, "") or "Another Policy") if r.policy_id else "Company's Own Holidays"


def clash(h: dict, r, policy_names: dict) -> Optional[dict]:
    """Does policy holiday `h` land beside calendar row `r` (a row of
    another policy, or the company's own)? For an overlapping country:
    "same_day" - the same day off, whatever the names; "same_name" - the
    same holiday (alias-aware: "Washington's Birthday" is "Presidents' Day")
    within NEAR_DAYS of it. None when neither."""
    if not _overlap(h.get("countries") or [], row_countries(r)):
        return None
    reason = ""
    if r.date == h["date"]:
        reason = "same_day"
    elif same_holiday_name(r.name, h["name"]):
        mine = {h["date"], h.get("actualDate") or h["date"]}
        theirs = {r.date} | ({r.actual_date} if r.actual_date else set())
        gaps = [g for g in (_days_apart(x, y) for x in mine for y in theirs) if g is not None]
        if gaps and min(gaps) <= NEAR_DAYS:
            reason = "same_name"
    if not reason:
        return None
    name = display_name(r.name, r.country_code or "")
    note = (f"{h['name']} is already on this calendar on {us_date(r.date)}" if same_holiday_name(r.name, h["name"])
            else same_day_note(h, [{"name": name, "type": r.type or "mandatory"}]))
    return {"id": r.id, "date": r.date, "actualDate": r.actual_date or "", "name": name,
            "type": r.type or "mandatory", "countries": row_countries(r), "policyId": r.policy_id or "",
            "with": _row_label(r, policy_names), "replaceable": not r.policy_id, "reason": reason, "note": note,
            "holiday": {"key": h.get("key", ""), "date": h["date"], "actualDate": h.get("actualDate") or "",
                        "name": h["name"], "type": h.get("type") or "mandatory"}}


def assign_clashes(db: Session, policy: HrHolidayPolicy, company_id: str) -> list:
    """What assigning `policy` to a company would put beside rows already on
    its calendar (another policy's or its own): one entry per calendar row,
    with the policy holiday it meets (`holiday`). Only the company's own rows
    are `replaceable` - another policy's row is never removed from here."""
    a = assignment(db, policy.id, company_id)
    skipped = skipped_keys(a)
    holidays = [h for h in policy_holidays(policy) if _usable(h) and h["key"] not in skipped]
    rows = (db.query(HrCompanyHoliday)
            .filter(HrCompanyHoliday.company_id == company_id,
                    or_(HrCompanyHoliday.policy_id.is_(None), HrCompanyHoliday.policy_id != policy.id))
            .order_by(HrCompanyHoliday.date, HrCompanyHoliday.name, HrCompanyHoliday.id).all())
    if not rows or not holidays:
        return []
    policy_names = {p.id: p.name for p in db.query(HrHolidayPolicy).all()}
    by_row: dict = {}
    for r in rows:
        for h in holidays:
            c = clash(h, r, policy_names)
            if c:
                by_row[r.id] = c
                break
    return sorted(by_row.values(), key=lambda c: (c["date"], c["name"], c["id"]))


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


def year_note(name: str, date_iso: str, actual_iso: str) -> str:
    """For a holiday taken in another year than its real date: "New Year's
    Day 2028, taken 12/31/2027". '' otherwise."""
    if not (valid_iso(date_iso) and valid_iso(actual_iso)) or date_iso[:4] == actual_iso[:4]:
        return ""
    return f"{name} {actual_iso[:4]}, taken {us_date(date_iso)}"


def _in_year(yr: str, *dates) -> bool:
    return not yr or any((d or "").startswith(f"{yr}-") for d in dates)


def company_calendar(db: Session, company_id: str, year: Optional[int] = None) -> dict:
    """A company's calendar for a year. A holiday belongs to a year by its day
    off OR its real date (Oct 29 2026 review): New Year's Day 2028 taken on
    12/31/2027 shows under both years, with a yearNote saying so."""
    yr = str(year) if year else ""
    assigns: dict = {}
    for a in (db.query(HrHolidayPolicyAssignment)
              .filter(HrHolidayPolicyAssignment.company_id == company_id)
              .order_by(HrHolidayPolicyAssignment.assigned_at, HrHolidayPolicyAssignment.id).all()):
        assigns.setdefault(a.policy_id, a)
    pols = {p.id: p for p in db.query(HrHolidayPolicy).order_by(HrHolidayPolicy.name).all()}
    assigned_ids = [pid for pid in assigns if pid in pols]
    q = db.query(HrCompanyHoliday).filter(HrCompanyHoliday.company_id == company_id)
    if yr:
        q = q.filter(or_(HrCompanyHoliday.date.like(f"{yr}-%"), HrCompanyHoliday.actual_date.like(f"{yr}-%")))
    rows = q.order_by(HrCompanyHoliday.date, HrCompanyHoliday.name).all()
    holidays = []
    for r in rows:
        pol = pols.get(r.policy_id or "")
        name = display_name(r.name, r.country_code or "")
        same = [o for o in rows if o is not r and o.date == r.date and _overlap(row_countries(r), row_countries(o))]
        holidays.append({
            "id": r.id, "date": r.date, "actualDate": r.actual_date or "", "weekday": weekday_name(r.date),
            "name": name, "type": r.type or "mandatory",
            "countries": [c for c in (r.country_code or "").split(",") if c], "countryCode": r.country_code or "",
            "source": r.source or "manual", "policyId": r.policy_id or "", "policyName": pol.name if pol else "",
            "policyKey": r.policy_key or "", "overridden": bool(r.overridden),
            "observedHint": "" if r.actual_date else observed_hint(r.name, r.date, r.country_code or ""),
            "yearNote": year_note(name, r.date, r.actual_date or ""),
            "sameDayNote": same_day_note(r, same) if same else "",
        })
    policies, skipped = [], []
    for a in sorted(assigns.values(), key=lambda a: (pols[a.policy_id].name if a.policy_id in pols else "")):
        p = pols.get(a.policy_id)
        if not p:
            continue
        entries = skipped_entries(a)
        policies.append({"id": p.id, "name": p.name, "weekendRule": p.weekend_rule or "keep",
                         "skipped": [_entry_key(e) for e in entries]})
        by_key = {h["key"]: h for h in policy_holidays(p)}
        for e in entries:
            k = _entry_key(e)
            h = by_key.get(k)
            changed = isinstance(e, dict)
            if changed:
                d, actual, name = e.get("date") or "", e.get("actualDate") or "", e.get("name") or ""
                if h is not None:
                    name = name or h["name"]
            elif h is not None:
                d, actual, name = h["date"], h.get("actualDate") or "", h["name"]
            else:
                continue
            if not valid_iso(d) or not _in_year(yr, d, actual):
                continue
            skipped.append({"policyId": p.id, "policyName": p.name, "key": k, "date": d, "actualDate": actual,
                            "name": name, "changed": changed, "yearNote": year_note(name, d, actual)})
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


# --- Startup data fix ---------------------------------------------------------

def rename_presidents_day(db: Session) -> tuple:
    """One-time, idempotent rename (Neil, Oct 29 2026: "it's not showing
    Presidents' Day"): every saved "Washington's Birthday" - calendar rows
    (hr_company_holidays.name) and the names inside hr_holiday_policies.
    holidays - becomes "Presidents' Day". A rename only: nothing is deleted,
    keys stay as they are, so policy rows stay attached. Flushes, never
    commits. (rows renamed, policies renamed)."""
    n_rows = (db.query(HrCompanyHoliday).filter(HrCompanyHoliday.name == OLD_PRESIDENTS_DAY)
              .update({HrCompanyHoliday.name: PRESIDENTS_DAY}, synchronize_session=False))
    n_pols = 0
    for p in db.query(HrHolidayPolicy).all():
        changed, rows = False, []
        for h in p.holidays or []:
            if isinstance(h, dict) and str(h.get("name") or "").strip() == OLD_PRESIDENTS_DAY:
                h = dict(h, name=PRESIDENTS_DAY)
                changed = True
            rows.append(h)
        if changed:
            p.holidays = rows
            n_pols += 1
    db.flush()
    return n_rows or 0, n_pols
