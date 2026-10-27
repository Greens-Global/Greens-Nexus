"""People Analytics (Neil, Oct 27 2026) - the ONE place HR metrics are
calculated. People > Analytics (frontend/src/components/HrAnalytics.jsx)
reads `summary` and every drill-down reads `drill`; both come from the same
`build` dataset, so a card's number and the list behind it can never differ.
Never compute these metrics anywhere else.

Who is counted
  * Internal people only (identity_type internal) - guests and externals are
    not our workforce.
  * Type filter, by the person's CURRENT employment type (no history of type
    changes is kept): `employees` (the default - full-time, part-time and
    interns, the same "employee" hr_checklist_seed uses), `contractors`, or
    `all`.
  * Company filter, by the person's CURRENT company; '' = every company the
    caller's People scope (auth.hr_scope) opens.

Employment spells, from the status-change audit trail (status_log)
  * A change TO Left (offboarded) ends a spell on its effective date (else the
    day it was recorded, in the company's local time). A change FROM Left back
    to working (a rehire) starts a new spell.
  * The start of the CURRENT spell is the profile's start date (a rehire
    overwrites it with the new start); an earlier spell of a rehired person
    starts when the record was created (never counted as a joiner), else
    is unknown.
  * No start date recorded = "Start Not Recorded": counted in headcount for
    every month (most legacy profiles were imported without one) and never as
    a joiner. Someone marked Left with no status-change entry has no known
    leaving date: left out of headcount and of leavers, counted under
    `dataQuality.leftUndated`.
  * Headcount on a day = spells with start <= day <= last day. Inactive
    (on leave / suspended) people are still employed and are counted.
  * Month-end = the month's last day; the current month uses today.

Attrition
  * Monthly = leavers in the month / average headcount, where average =
    (last month-end + this month-end) / 2.
  * Trailing 12 months = leavers over the 12 months ending that month / the
    mean of those 12 monthly averages.
  * Voluntary vs Involuntary from the separation reason, looked up in this
    order: the Offboard life event (hr_life_events, exit_type), the reason
    label Nexus wrote on the status change ("Voluntary Resignation - ..."),
    the offboarding checklist's exit type. Voluntary = resignation, job
    abandonment, retirement, end of contract (Neil, Oct 27 2026: a contract
    that runs its course is not the company letting someone go);
    Involuntary = termination; Other = death. Nothing recorded = "Not Recorded" - free text is never
    read for a guess, and is never shown.

Tenure: whole months since the current spell's start for people Active or
Onboarding today who have started.

Absence: days off per month by reason - approved time off (weekdays; a part
day is its hours / 8; "1/2 Day" is half a day) and punches whose job category
is leave (routers.timeclock._leave_class: Sick / Vacation / Personal, minutes
/ 480, at most a day). A day with both counts once, as the punch (what was
paid). Unplanned Sick = a sick day with no approved request filed before the
day. A confidential request counts as "Other" (its type is private,
timeclock._TimeoffPrivacy). Work From Home is not an absence.

Leave liability: each currently employed person's unused vacation hours
(leave_balances.balances, only once HR set the start date) x their pay in
effect today (timeclock._rate_on): the hourly rate, or for fixed pay the
monthly salary x 12 / 260 working days / the policy's hours a day. Totals are
per currency, never summed across currencies. A negative balance owes
nothing. Money only for the `hr_comp` grant (or owner) - everyone else gets
hours and no rate, amount or currency at all.

Every drill-down row is a person the caller may already see in People.
"""
from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

import hr_checklist_seed
import models
from task_due import us_date

DEFAULT_TZ = "America/Los_Angeles"
MAX_MONTHS = 36
PARTS = ("headcount", "flow", "attrition", "tenure", "absence", "liability")

TYPE_FILTERS = {
    "employees": ("full_time", "part_time", "intern"),
    "contractors": ("contractor",),
    "all": ("full_time", "part_time", "intern", "contractor"),
}
TYPE_LABELS = {"full_time": "Full-Time", "part_time": "Part-Time", "contractor": "Contractor", "intern": "Intern"}

CATEGORY_OF = {
    "resignation": "voluntary", "resignation_no_notice": "voluntary", "retirement": "voluntary",
    "end_of_contract": "voluntary",   # Neil, Oct 27 2026 - not Involuntary
    "termination": "involuntary",
    "death": "other",
}
CATEGORY_LABELS = {"voluntary": "Voluntary", "involuntary": "Involuntary", "other": "Other",
                   "not_recorded": "Not Recorded"}
CATEGORIES = ("voluntary", "involuntary", "other", "not_recorded")

# The labels Nexus writes as the status-change reason (current, then the
# names used before Charmi's Oct 20 2026 rename). Longest first, so
# "Resignation Without Notice" is not read as "Resignation".
_LEGACY_LABELS = {"Resignation": "resignation", "Resignation Without Notice": "resignation_no_notice"}
_REASON_LABELS = sorted(
    [(v, k) for k, v in hr_checklist_seed.EXIT_TYPE_LABELS.items()] + list(_LEGACY_LABELS.items()),
    key=lambda kv: -len(kv[0]))
HINT_WINDOW_DAYS = 60

TENURE_BANDS = (("lt6m", "Under 6 Months"), ("6to12m", "6-12 Months"), ("1to2y", "1-2 Years"),
                ("2to5y", "2-5 Years"), ("5yplus", "5+ Years"), ("unknown", "Start Not Recorded"))

ABSENCE_REASONS = (("vacation", "Vacation"), ("sick", "Sick"), ("personal", "Personal"), ("other", "Other"))
ABSENCE_LABELS = dict(ABSENCE_REASONS)
DAY_MIN = 480                       # a full day of leave, in minutes (8 hours)
_NOT_ABSENCE = ("work from home", "wfh")


# ── Dates ────────────────────────────────────────────────────────────────────

def month_key(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def month_first(key: str) -> date:
    return date(int(key[:4]), int(key[5:7]), 1)


def month_last(key: str) -> date:
    y, m = int(key[:4]), int(key[5:7])
    return date(y, m, calendar.monthrange(y, m)[1])


def add_months(key: str, n: int) -> str:
    y, m = int(key[:4]), int(key[5:7]) - 1 + n
    return f"{y + m // 12:04d}-{m % 12 + 1:02d}"


def months_between(a: str, b: str) -> list:
    out, k = [], a
    while k <= b and len(out) <= MAX_MONTHS * 4:
        out.append(k)
        k = add_months(k, 1)
    return out


def valid_month(v: str) -> str:
    v = (v or "").strip()[:7]
    try:
        month_first(v)
    except (ValueError, IndexError):
        return ""
    return v if len(v) == 7 and v[4] == "-" else ""


def _zone(tz: str) -> ZoneInfo:
    try:
        return ZoneInfo(tz or DEFAULT_TZ)
    except Exception:  # noqa: BLE001 - an unknown zone name reads as the default
        return ZoneInfo(DEFAULT_TZ)


def local_day(at: str, tz: str) -> str:
    """A stored instant (UTC ISO; no zone = UTC) as the YYYY-MM-DD it was in `tz`."""
    v = (at or "").strip()
    if not v:
        return ""
    try:
        dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return v[:10] if _iso_day(v[:10]) else ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(_zone(tz)).date().isoformat()


def _iso_day(v: str) -> str:
    v = (v or "").strip()[:10]
    try:
        date.fromisoformat(v)
    except ValueError:
        return ""
    return v


def today_in(tz: str) -> date:
    return datetime.now(timezone.utc).astimezone(_zone(tz)).date()


def company_tz(db: Session, company_id: str, cache: dict | None = None) -> str:
    """The company's local zone: its own Shift Settings time zone when it
    overrides the tenant's, else its country's zone for a company outside the
    US (an India company with no override is on India time), else the
    tenant's Shift Settings zone."""
    cache = cache if cache is not None else {}
    if company_id in cache:
        return cache[company_id]
    from routers.shift_requests import get_settings
    from routers.directory import _COUNTRY_TZ
    if "" not in cache:
        cache[""] = get_settings(db).get("timeZone") or DEFAULT_TZ
    tenant = cache[""]
    if not company_id:
        return tenant
    tz = get_settings(db, company_id).get("timeZone") or tenant
    if tz == tenant:
        ent = db.query(models.HrEntity.country).filter(models.HrEntity.id == company_id).first()
        country = ((ent[0] if ent else "") or "").strip().upper()
        if country and country not in ("US", "USA") and country in _COUNTRY_TZ:
            tz = _COUNTRY_TZ[country]
    cache[company_id] = tz
    return tz


# ── Separation reasons ───────────────────────────────────────────────────────

def reason_from_label(text: str) -> str:
    """The exit type a status-change reason names, when it is one of the
    labels Nexus itself writes ("Voluntary Resignation", "Termination - ...");
    '' for anything else. Free text is never interpreted."""
    t = (text or "").strip()
    low = t.lower()
    for label, key in _REASON_LABELS:
        lab = label.lower()
        if low == lab or low.startswith(lab + " - "):
            return key
    return ""


def _nearest_hint(day: str, hints: list) -> str:
    if not day or not hints:
        return ""
    d = date.fromisoformat(day)
    best, gap = "", None
    for h in hints:
        hd = _iso_day(h.get("date", ""))
        key = h.get("exit_type", "")
        if not hd or key not in CATEGORY_OF:
            continue
        g = abs((date.fromisoformat(hd) - d).days)
        if g <= HINT_WINDOW_DAYS and (gap is None or g < gap):
            best, gap = key, g
    return best


def separation_reason(end_day: str, log_reason: str, life_hints: list, checklist_hints: list) -> str:
    return (_nearest_hint(end_day, life_hints) or reason_from_label(log_reason)
            or _nearest_hint(end_day, checklist_hints))


def category_of(reason_key: str) -> str:
    return CATEGORY_OF.get(reason_key or "", "not_recorded")


# ── Spells ───────────────────────────────────────────────────────────────────

def build_spells(status: str, start_date: str, created_at: str, status_log: list, tz: str,
                 life_hints: list | None = None, checklist_hints: list | None = None) -> list:
    """Employment spells for one person, oldest first. Each: {start, end
    ('' = still employed), rehire, reason, category, leftUndated}. `start`
    '' = not recorded."""
    life_hints, checklist_hints = life_hints or [], checklist_hints or []
    entries = [e for e in (status_log or []) if isinstance(e, dict)]
    entries.sort(key=lambda e: (str(e.get("at") or ""), str(e.get("effectiveDate") or "")))
    events = []
    for e in entries:
        frm, to = (e.get("from") or ""), (e.get("to") or "")
        if to == "offboarded" and frm != "offboarded":
            day = _iso_day(e.get("effectiveDate") or "") or local_day(e.get("at") or "", tz)
            events.append(("leave", day, e))
        elif frm == "offboarded" and to and to != "offboarded":
            events.append(("return", local_day(e.get("at") or "", tz), e))
    spells, cur = [], None
    if not events or events[0][0] == "leave":
        cur = {"start": "", "end": "", "rehire": False, "_first": True}
    for kind, day, e in events:
        if kind == "leave":
            if cur is None:
                continue
            reason = separation_reason(day, e.get("reason") or "", life_hints, checklist_hints)
            cur.update(end=day, reason=reason, category=category_of(reason), leftUndated=not day)
            spells.append(cur)
            cur = None
        else:
            if cur is not None:
                continue
            cur = {"start": day, "end": "", "rehire": True}
    if cur is not None:
        spells.append(cur)
    elif (status or "active") != "offboarded":
        # Working again with no status-change entry for it: a new spell.
        spells.append({"start": "", "end": "", "rehire": True})
    start = _iso_day(start_date)
    created = local_day(created_at or "", tz)
    start_used = False
    if spells:
        cur_s = spells[-1]
        prev_end = spells[-2]["end"] if len(spells) > 1 else ""
        if start and (not prev_end or start > prev_end):
            cur_s["start"], start_used = start, True     # the profile's start date is the current spell's
    first = spells[0] if spells else None
    if first is not None and first.get("_first") and len(spells) > 1 and not first["start"]:
        # A rehired person's first spell: the profile's start date when the
        # rehire did not overwrite it, else when the record was created.
        end = first["end"]
        if not start_used and start and (not end or start <= end):
            first["start"] = start
        elif created and (not end or created <= end):
            # The record's creation is not a hire: counted in headcount from
            # then, never as a joiner.
            first["start"], first["estimated"] = created, True
    for s in spells:
        s.pop("_first", None)
        s.setdefault("estimated", False)
        s.setdefault("reason", "")
        s.setdefault("category", "")
        s.setdefault("leftUndated", False)
    # Marked Left with no change entry for it: the leaving date is unknown.
    if (status or "active") == "offboarded" and spells and not spells[-1]["end"]:
        spells[-1]["leftUndated"] = True
    return spells


def covers(spell: dict, day: str) -> bool:
    if spell.get("leftUndated"):
        return False
    return (not spell["start"] or spell["start"] <= day) and (not spell["end"] or day <= spell["end"])


# ── The dataset ──────────────────────────────────────────────────────────────

class Person:
    __slots__ = ("id", "email", "name", "company", "company_name", "department", "etype", "status", "tz", "spells")

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))

    def employed_on(self, day: str) -> dict | None:
        for s in self.spells:
            if covers(s, day):
                return s
        return None

    @property
    def sub(self) -> str:
        return " · ".join(x for x in (self.company_name, self.department or "No Department",
                                      TYPE_LABELS.get(self.etype, self.etype)) if x)


def _name(e) -> str:
    return (e.display_name or f"{e.first_name or ''} {e.last_name or ''}").strip() or (e.work_email or "")


def load_people(db: Session, scope, company: str, type_filter: str, tz_cache: dict) -> list:
    from auth import is_team_scope
    q = db.query(models.NexusEmployee).filter(
        func.coalesce(models.NexusEmployee.identity_type, "internal") == "internal")
    if is_team_scope(scope):
        q = q.filter(func.lower(models.NexusEmployee.work_email).in_(sorted(scope.emails) or [""]))
    elif scope is not None:
        q = q.filter(models.NexusEmployee.company.in_(sorted(scope) or [""]))
    if company:
        q = q.filter(models.NexusEmployee.company == company)
    types = TYPE_FILTERS.get(type_filter, TYPE_FILTERS["employees"])
    rows = [e for e in q.all() if (e.employment_type or "full_time") in types]
    ids = [e.id for e in rows]
    life, checks = {}, {}
    if ids:
        for ev in (db.query(models.HrLifeEvent)
                   .filter(models.HrLifeEvent.kind == "separation", models.HrLifeEvent.employee_id.in_(ids)).all()):
            if (ev.apply_status or "") == "canceled":
                continue
            life.setdefault(ev.employee_id, []).append(
                {"date": ev.effective_date or (ev.inputs or {}).get("last_day", ""),
                 "exit_type": (ev.inputs or {}).get("exit_type", "")})
        for cl in (db.query(models.HrChecklist)
                   .filter(models.HrChecklist.kind == "offboarding", models.HrChecklist.employee_id.in_(ids)).all()):
            if (cl.status or "") == "cancelled" or not cl.exit_type:
                continue
            checks.setdefault(cl.employee_id, []).append(
                {"date": cl.anchor_date or (cl.created_at or "")[:10], "exit_type": cl.exit_type})
    names = {r.id: r.name for r in db.query(models.HrEntity.id, models.HrEntity.name).all()}
    out = []
    for e in rows:
        tz = company_tz(db, e.company or "", tz_cache)
        out.append(Person(
            id=e.id, email=(e.work_email or "").strip().lower(), name=_name(e), company=e.company or "",
            company_name=names.get(e.company or "", "") or "No Company", department=(e.department or "").strip(),
            etype=e.employment_type or "full_time", status=e.status or "active", tz=tz,
            spells=build_spells(e.status, e.start_date, e.created_at, e.status_log, tz,
                                life.get(e.id), checks.get(e.id))))
    return out


class Dataset:
    def __init__(self, db: Session, people: list, months: list, today: date, tz: str, money: bool):
        self.db = db
        self.people = people
        self.months = months
        self.today = today
        self.tz = tz
        self.money = money
        self._absence = None
        self._liability = None

    def month_end(self, key: str) -> str:
        return min(month_last(key), self.today).isoformat()

    def headcount_people(self, day: str) -> list:
        return [p for p in self.people if p.employed_on(day)]

    def headcount(self, day: str) -> int:
        return sum(1 for p in self.people if p.employed_on(day))

    def avg_headcount(self, key: str) -> float:
        prev = month_last(add_months(key, -1)).isoformat()
        return (self.headcount(prev) + self.headcount(self.month_end(key))) / 2

    def joiners(self, key: str) -> list:
        """[(person, spell)] whose spell started in the month (a recorded start)."""
        return [(p, s) for p in self.people for s in p.spells
                if s["start"] and not s.get("estimated") and s["start"][:7] == key
                and s["start"] <= self.today.isoformat()]

    def leavers(self, key: str) -> list:
        return [(p, s) for p in self.people for s in p.spells
                if s["end"] and not s.get("leftUndated") and s["end"][:7] == key
                and s["end"] <= self.today.isoformat()]


def build(db: Session, scope, money: bool, company: str = "", type_filter: str = "employees",
          from_month: str = "", to_month: str = "", today: date | None = None) -> Dataset:
    """`today` is for tests; the API always uses the company's own today."""
    tz_cache: dict = {}
    tz = company_tz(db, company, tz_cache)
    today = today or today_in(tz)
    to_m = valid_month(to_month) or month_key(today)
    if to_m > month_key(today):
        to_m = month_key(today)
    from_m = valid_month(from_month) or add_months(to_m, -11)
    if from_m > to_m:
        from_m = to_m
    if len(months_between(from_m, to_m)) > MAX_MONTHS:
        from_m = add_months(to_m, -(MAX_MONTHS - 1))
    people = load_people(db, scope, company, type_filter, tz_cache)
    return Dataset(db, people, months_between(from_m, to_m), today, tz, money)


# ── Metrics ──────────────────────────────────────────────────────────────────

def _rate(n: float, d: float):
    return round(100.0 * n / d, 1) if d else None


def _counts(people: list, attr) -> list:
    m = {}
    for p in people:
        k = attr(p)
        m[k] = m.get(k, 0) + 1
    return [{"label": k, "n": n} for k, n in sorted(m.items(), key=lambda kv: (-kv[1], kv[0]))]


def _dims():
    return {"company": lambda p: p.company_name,
            "department": lambda p: p.department or "No Department",
            "type": lambda p: TYPE_LABELS.get(p.etype, p.etype)}


def headcount(ds: Dataset) -> dict:
    months = []
    for k in ds.months:
        here = ds.headcount_people(ds.month_end(k))
        months.append({"month": k, "asOf": ds.month_end(k), "total": len(here),
                       **{f"by{d.title()}": _counts(here, f) for d, f in _dims().items()}})
    now = ds.headcount(ds.today.isoformat())
    avg = round(sum(m["total"] for m in months) / len(months), 1) if months else 0
    return {"months": months, "now": now, "average": avg}


def flow(ds: Dataset) -> dict:
    months, tj, tl, tr = [], 0, 0, 0
    for k in ds.months:
        j, lv = ds.joiners(k), ds.leavers(k)
        r = sum(1 for _p, s in j if s.get("rehire"))
        months.append({"month": k, "joiners": len(j), "leavers": len(lv), "rehires": r})
        tj, tl, tr = tj + len(j), tl + len(lv), tr + r
    return {"months": months, "joiners": tj, "leavers": tl, "rehires": tr}


def attrition(ds: Dataset) -> dict:
    span = months_between(add_months(ds.months[0], -11), ds.months[-1])
    per = {}
    for k in span:
        lv = ds.leavers(k)
        cats = {c: sum(1 for _p, s in lv if (s.get("category") or "not_recorded") == c) for c in CATEGORIES}
        per[k] = {"leavers": len(lv), "avg": ds.avg_headcount(k), "cats": cats}
    months = []
    for k in ds.months:
        win = [per[add_months(k, -i)] for i in range(12)]
        avg12 = sum(w["avg"] for w in win) / 12
        lv12 = sum(w["leavers"] for w in win)
        v12 = sum(w["cats"]["voluntary"] for w in win)
        i12 = sum(w["cats"]["involuntary"] for w in win)
        cur = per[k]
        months.append({
            "month": k, "leavers": cur["leavers"], "avgHeadcount": round(cur["avg"], 1),
            "rate": _rate(cur["leavers"], cur["avg"]),
            "voluntaryRate": _rate(cur["cats"]["voluntary"], cur["avg"]),
            "involuntaryRate": _rate(cur["cats"]["involuntary"], cur["avg"]),
            "otherRate": _rate(cur["cats"]["other"] + cur["cats"]["not_recorded"], cur["avg"]),
            "byCategory": cur["cats"],
            "trailing12": _rate(lv12, avg12), "trailing12Voluntary": _rate(v12, avg12),
            "trailing12Involuntary": _rate(i12, avg12), "trailing12Leavers": lv12,
        })
    in_range = [per[k] for k in ds.months]
    cats = {c: sum(w["cats"][c] for w in in_range) for c in CATEGORIES}
    avg = sum(w["avg"] for w in in_range) / len(in_range) if in_range else 0
    total = sum(w["leavers"] for w in in_range)
    last = months[-1] if months else {}
    return {"months": months,
            "byCategory": [{"key": c, "label": CATEGORY_LABELS[c], "n": cats[c]} for c in CATEGORIES],
            "range": {"leavers": total, "avgHeadcount": round(avg, 1), "rate": _rate(total, avg)},
            "trailing12": {k: last.get(k) for k in ("trailing12", "trailing12Voluntary", "trailing12Involuntary",
                                                    "trailing12Leavers")}}


def _months_since(start: str, today: date) -> int:
    s = date.fromisoformat(start)
    n = (today.year - s.year) * 12 + (today.month - s.month)
    if today.day < s.day:
        n -= 1
    return max(0, n)


def tenure_band(start: str, today: date) -> str:
    if not start:
        return "unknown"
    m = _months_since(start, today)
    if m < 6:
        return "lt6m"
    if m < 12:
        return "6to12m"
    if m < 24:
        return "1to2y"
    if m < 60:
        return "2to5y"
    return "5yplus"


def tenure_people(ds: Dataset) -> list:
    """[(person, spell, band)] for people Active or Onboarding today who have started."""
    t = ds.today.isoformat()
    out = []
    for p in ds.people:
        if p.status not in ("active", "onboarding"):
            continue
        s = p.employed_on(t)
        if s is None:
            continue
        out.append((p, s, tenure_band(s["start"], ds.today)))
    return out


def tenure(ds: Dataset) -> dict:
    rows = tenure_people(ds)
    counts = {k: 0 for k, _ in TENURE_BANDS}
    for _p, _s, b in rows:
        counts[b] += 1
    return {"bands": [{"key": k, "label": lab, "n": counts[k]} for k, lab in TENURE_BANDS
                      if k != "unknown" or counts[k]],
            "total": len(rows)}


# ── Absence ──────────────────────────────────────────────────────────────────

def absence_class(type_name: str) -> str:
    from routers.timeclock import _leave_class
    return _leave_class(type_name) or "other"


def _weekdays(a: date, b: date):
    d, n = a, 0
    while d <= b and n < 800:
        if d.weekday() < 5:
            yield d
        d += timedelta(days=1)
        n += 1


def _request_fraction(r) -> float:
    st, et = (r.start_time or ""), (r.end_time or "")
    if st and et:
        try:
            mins = (datetime.strptime(et, "%H:%M") - datetime.strptime(st, "%H:%M")).total_seconds() / 60
        except ValueError:
            return 0.0
        return max(0.0, min(1.0, mins / DAY_MIN))
    return 0.5 if (r.type or "").strip().lower() in ("1/2 day", "half day") else 1.0


def absence_days(timeoff: list, punches: list, tz_of: dict, range_start: str, range_end: str) -> dict:
    """{(email, day): {reason, fraction, unplanned, source}} - the person-days
    off. `timeoff` = approved TimeOffRequest rows; `punches` = every punch of
    the people and days that hold a leave-category clock-in, ordered by `at`;
    `tz_of` = email -> the company zone a request's filing time is read in."""
    import shift_day
    from routers.timeclock import _leave_class
    req_days = {}
    for r in timeoff:
        em = (r.employee_email or "").strip().lower()
        typ = (r.type or "").strip()
        if any(w in typ.lower() for w in _NOT_ABSENCE):
            continue
        try:
            d0 = date.fromisoformat((r.start_date or "")[:10])
            d1 = date.fromisoformat(((r.end_date or "") or r.start_date or "")[:10])
        except ValueError:
            continue
        filed = local_day(r.created_at or "", tz_of.get(em, DEFAULT_TZ))
        reason = "other" if r.confidential else absence_class(typ)
        frac = _request_fraction(r)
        for d in _weekdays(max(d0, date.fromisoformat(range_start)), min(d1, date.fromisoformat(range_end))):
            ds = d.isoformat()
            planned = bool(filed) and filed < ds
            cur = req_days.get((em, ds))
            if cur is None or frac > cur["fraction"]:
                req_days[(em, ds)] = {"reason": reason, "fraction": frac, "planned": planned, "source": "timeoff"}
            elif planned:
                cur["planned"] = True
    by_email = {}
    for p in punches:
        by_email.setdefault((p.employee_email or "").strip().lower(), []).append(p)
    punch_days = {}
    for em, ps in by_email.items():
        cat = {p.id: _leave_class(p.category or "") for p in ps if p.kind == "in"}
        for s in shift_day.shifts(ps):
            cls = cat.get(s["in_id"] or "", "")
            if not cls or not s["in_at"] or not s["out_at"] or not (range_start <= s["day"] <= range_end):
                continue
            try:
                a = datetime.fromisoformat(s["in_at"].replace("Z", "+00:00"))
                b = datetime.fromisoformat(s["out_at"].replace("Z", "+00:00"))
            except ValueError:
                continue
            mins = max(0.0, (b - a).total_seconds() / 60)
            k = (em, s["day"])
            cur = punch_days.setdefault(k, {"minutes": {}, "total": 0.0})
            cur["minutes"][cls] = cur["minutes"].get(cls, 0.0) + mins
            cur["total"] += mins
    out = dict(req_days)
    for k, v in punch_days.items():
        if v["total"] <= 0:
            continue
        reason = max(v["minutes"].items(), key=lambda kv: kv[1])[0]
        req = req_days.get(k)
        out[k] = {"reason": reason, "fraction": min(1.0, v["total"] / DAY_MIN),
                  "planned": bool(req and req["planned"]), "source": "punch"}
    for v in out.values():
        v["unplanned"] = v["reason"] == "sick" and not v.pop("planned", False)
    return out


def _absence(ds: Dataset) -> dict:
    if ds._absence is not None:
        return ds._absence
    db = ds.db
    start = month_first(ds.months[0]).isoformat()
    end = ds.month_end(ds.months[-1])
    emails = sorted({p.email for p in ds.people if p.email})
    timeoff, punches = [], []
    if emails:
        timeoff = (db.query(models.TimeOffRequest)
                   .filter(func.lower(models.TimeOffRequest.employee_email).in_(emails),
                           models.TimeOffRequest.status == "approved",
                           models.TimeOffRequest.start_date <= end,
                           or_(models.TimeOffRequest.end_date >= start,
                               and_(func.coalesce(models.TimeOffRequest.end_date, "") == "",
                                    models.TimeOffRequest.start_date >= start))).all())
        from routers.timeclock import _leave_class
        leave_ins = (db.query(models.TimePunch.employee_email, models.TimePunch.local_date, models.TimePunch.category)
                     .filter(func.lower(models.TimePunch.employee_email).in_(emails),
                             models.TimePunch.kind == "in",
                             models.TimePunch.category != "",
                             models.TimePunch.local_date >= start,
                             models.TimePunch.local_date <= end).all())
        days_by = {}
        for em, day, cat in leave_ins:
            if _leave_class(cat or ""):
                days_by.setdefault((em or "").strip().lower(), set()).add(day)
        for em, days in days_by.items():
            want = set(days) | {(date.fromisoformat(d) + timedelta(days=1)).isoformat() for d in days}
            punches += [p for p in (db.query(models.TimePunch)
                                    .filter(func.lower(models.TimePunch.employee_email) == em,
                                            models.TimePunch.local_date.in_(sorted(want)))
                                    .order_by(models.TimePunch.at.asc()).all())]
        punches.sort(key=lambda p: (p.employee_email or "", p.at or ""))
    tz_of = {p.email: p.tz for p in ds.people}
    ds._absence = absence_days(timeoff, punches, tz_of, start, end)
    return ds._absence


def absence(ds: Dataset) -> dict:
    days = _absence(ds)
    months = {k: {"month": k, "days": 0.0, "byReason": {r: 0.0 for r, _ in ABSENCE_REASONS}, "unplannedSick": 0.0}
              for k in ds.months}
    for (_em, day), v in days.items():
        m = months.get(day[:7])
        if m is None:
            continue
        m["days"] += v["fraction"]
        m["byReason"][v["reason"]] += v["fraction"]
        if v["unplanned"]:
            m["unplannedSick"] += v["fraction"]
    rows = []
    for k in ds.months:
        m = months[k]
        rows.append({"month": k, "days": round(m["days"], 2), "unplannedSick": round(m["unplannedSick"], 2),
                     "byReason": {r: round(x, 2) for r, x in m["byReason"].items()}})
    tot = {r: round(sum(m["byReason"][r] for m in rows), 2) for r, _ in ABSENCE_REASONS}
    return {"months": rows, "days": round(sum(m["days"] for m in rows), 2),
            "unplannedSick": round(sum(m["unplannedSick"] for m in rows), 2),
            "byReason": [{"key": r, "label": lab, "days": tot[r]} for r, lab in ABSENCE_REASONS]}


# ── Leave liability ──────────────────────────────────────────────────────────

def hourly_equivalent(rate: dict, hours_per_day: float) -> float:
    """Pay per hour for leave: the hourly rate, or monthly x 12 / 260 / hours a day."""
    if (rate.get("payType") or "hourly") == "fixed":
        m = float(rate.get("monthlySalary") or 0)
        return m * 12 / 260 / (hours_per_day or 8) if m > 0 else 0.0
    return max(0.0, float(rate.get("hourlyRate") or 0))


def _liability_rows(ds: Dataset) -> list:
    """[{person, hours, rate, currency, amount}] for people employed today
    with live balances and unused vacation."""
    if ds._liability is not None:
        return ds._liability
    import leave_balances as lb
    from routers import timeclock as tc
    db = ds.db
    pols = lb.policies(db)
    t = ds.today.isoformat()
    emps = {}
    emails = [p.email for p in ds.people if p.email and p.status != "offboarded" and p.employed_on(t)]
    if emails:
        emps = {(e.work_email or "").strip().lower(): e for e in
                db.query(models.NexusEmployee).filter(func.lower(models.NexusEmployee.work_email).in_(emails)).all()}
    rows = []
    for p in ds.people:
        e = emps.get(p.email)
        if e is None:
            continue
        b = lb.balances(db, p.email, today=ds.today, pols=pols, emp=e)
        if not b.get("live"):
            continue
        hours = float((b.get("vacation") or {}).get("available") or 0)
        if hours <= 0:
            continue
        rate = tc._rate_on(db, p.email, t)
        per_hour = hourly_equivalent(rate, float((b.get("policy") or {}).get("hoursPerDay") or 8))
        cur = (rate.get("currency") or "USD").upper()
        rows.append({"person": p, "hours": round(hours, 2), "rate": round(per_hour, 4) if per_hour else 0.0,
                     "currency": cur if per_hour else "", "amount": round(hours * per_hour, 2) if per_hour else None})
    ds._liability = rows
    return rows


def liability(ds: Dataset) -> dict:
    rows = _liability_rows(ds)
    out = {"unit": "hours", "hours": round(sum(r["hours"] for r in rows), 2), "people": len(rows)}
    if ds.money:
        cur = {}
        for r in rows:
            if r["amount"] is None:
                continue
            c = cur.setdefault(r["currency"], {"currency": r["currency"], "amount": 0.0, "hours": 0.0, "people": 0})
            c["amount"] += r["amount"]
            c["hours"] += r["hours"]
            c["people"] += 1
        out["byCurrency"] = [{**c, "amount": round(c["amount"], 2), "hours": round(c["hours"], 2)}
                             for c in sorted(cur.values(), key=lambda c: c["currency"])]
        out["noRate"] = sum(1 for r in rows if r["amount"] is None)
    return out


# ── The summary and the drill-down ───────────────────────────────────────────

def data_quality(ds: Dataset) -> dict:
    return {"noStartDate": sum(1 for p in ds.people if p.spells and not p.spells[-1]["start"]
                               and not p.spells[-1].get("leftUndated")),
            "leftUndated": sum(1 for p in ds.people if any(s.get("leftUndated") for s in p.spells))}


_PART_FN = {"headcount": headcount, "flow": flow, "attrition": attrition, "tenure": tenure,
            "absence": absence, "liability": liability}


def summary(ds: Dataset, parts=PARTS) -> dict:
    out = {"range": {"from": ds.months[0], "to": ds.months[-1], "months": ds.months},
           "today": ds.today.isoformat(), "timeZone": ds.tz, "canSeeMoney": ds.money,
           "people": len(ds.people), "dataQuality": data_quality(ds)}
    for part in PARTS:
        if part in parts:
            out[part] = _PART_FN[part](ds)
    return out


def _month_title(key: str) -> str:
    return f"{calendar.month_name[int(key[5:7])]} {key[:4]}"


def _row(p: Person, detail: str, value=None) -> dict:
    out = {"id": p.id, "name": p.name, "sub": p.sub, "detail": detail}
    if value is not None:
        out["value"] = value
    return out


def _days_text(n: float) -> str:
    n = round(n, 2)
    return f"{n:g} day" + ("" if n == 1 else "s")


def _split_key(key: str) -> tuple:
    dim, _, val = (key or "").partition(":")
    return dim, val


def drill(ds: Dataset, metric: str, month: str = "", key: str = "") -> dict:
    """The people behind one number: {title, total, rows: [{id, name, sub, detail, value?}]}."""
    month = valid_month(month)
    if month and month not in ds.months:
        month = ""
    months = [month] if month else ds.months
    when = _month_title(month) if month else f"{_month_title(ds.months[0])} - {_month_title(ds.months[-1])}"
    rows, title = [], ""
    if metric == "headcount":
        day = ds.month_end(month) if month else ds.today.isoformat()
        dim, val = _split_key(key)
        f = _dims().get(dim)
        for p in ds.headcount_people(day):
            if f and f(p) != val:
                continue
            s = p.employed_on(day)
            rows.append(_row(p, f"Since {us_date(s['start'])}" if s["start"] else "Start Not Recorded"))
        title = f"Headcount On {us_date(day)}" + (f" - {val}" if f else "")
    elif metric in ("joiners", "leavers"):
        for k in months:
            for p, s in (ds.joiners(k) if metric == "joiners" else ds.leavers(k)):
                if metric == "leavers" and key and (s.get("category") or "not_recorded") != key:
                    continue
                if metric == "joiners":
                    rows.append(_row(p, f"Started {us_date(s['start'])}" + (" (Rehire)" if s.get("rehire") else "")))
                else:
                    why = hr_checklist_seed.EXIT_TYPE_LABELS.get(s.get("reason") or "", "")
                    cat = CATEGORY_LABELS[s.get("category") or "not_recorded"]
                    rows.append(_row(p, f"Left {us_date(s['end'])} - {cat}" + (f" ({why})" if why else "")))
        label = "Joiners" if metric == "joiners" else "Leavers"
        if metric == "leavers" and key in CATEGORY_LABELS:
            label = f"{CATEGORY_LABELS[key]} Leavers"
        title = f"{label} - {when}"
    elif metric == "tenure":
        lab = dict(TENURE_BANDS)
        for p, s, band in tenure_people(ds):
            if key and band != key:
                continue
            rows.append(_row(p, f"Since {us_date(s['start'])}" if s["start"] else "Start Not Recorded"))
        title = f"Tenure - {lab.get(key, 'Everyone')}"
    elif metric == "absence":
        names = {p.email: p for p in ds.people}
        per = {}
        for (em, day), v in _absence(ds).items():
            if day[:7] not in months or em not in names:
                continue
            if key == "unplanned" and not v["unplanned"]:
                continue
            if key in ABSENCE_LABELS and v["reason"] != key:
                continue
            per.setdefault(em, []).append((day, v))
        for em, items in per.items():
            items.sort()
            total = sum(v["fraction"] for _d, v in items)
            first, last = items[0][0], items[-1][0]
            span = us_date(first) if first == last else f"{us_date(first)} - {us_date(last)}"
            rows.append(_row(names[em], f"{_days_text(total)} ({span})", round(total, 2)))
        rows.sort(key=lambda r: -r.get("value", 0))
        label = "Unplanned Sick" if key == "unplanned" else ABSENCE_LABELS.get(key, "Days Off")
        title = f"{label} - {when}"
    elif metric == "liability":
        for r in _liability_rows(ds):
            if ds.money and key and r["currency"] != key:
                continue
            detail = f"{r['hours']:g} hours unused vacation"
            row = _row(r["person"], detail, r["hours"])
            if ds.money:
                row["currency"] = r["currency"]
                row["amount"] = r["amount"]
                row["rate"] = r["rate"] or None
                if r["amount"] is None:
                    row["detail"] = detail + " - No Pay Rate"
            rows.append(row)
        rows.sort(key=lambda r: -r.get("value", 0))
        title = "Unused Vacation" + (f" - {key}" if ds.money and key else "")
    else:
        raise ValueError("Unknown metric.")
    if metric not in ("absence", "liability"):
        rows.sort(key=lambda r: r["name"].lower())
    return {"title": title, "total": len(rows), "rows": rows}
