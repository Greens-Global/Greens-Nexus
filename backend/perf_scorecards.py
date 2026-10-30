"""KPI scorecards per department (Performance, Oct 30 2026 - Charmi's ask:
reviews and bonuses from data, with rules fixed before the period).

THE SHAPE
  KPI library   what can be measured. Nexus's own metrics (perf_metrics.METRICS -
                on-time arrival, tasks on time, tickets within target, training
                ...) are always there and never typed by anyone; HR may add
                MANUAL KPIs (a manager rates them with a written reason, from
                the scoring PR on) for a company or for every company.
  Scorecard     one per department of a company: the KPIs it cares about, each
                with a WEIGHT (the weights total 100), a TARGET (full marks), a
                THRESHOLD (below it: nothing) and a CAP (above it: no extra).
                Manual KPIs may carry at most MANUAL_MAX of the weight - the
                data does the heavy lifting.
  Versions      a scorecard is never edited under a running period. Saving a
                change to a scorecard already in force makes a NEW version that
                applies from the first of next month; the current one keeps its
                rows and ends on the last day of this month, so a score paid in
                March can always be explained by March's rules. A version that
                has not started yet is edited in place.

WHO
  HR for the company (performance.hr_for - the one HR rule) edits; the
  department's head and backup head (Settings > Companies > Departments) and
  the manager chain read. Everyone in the department reads their own
  department's scorecard from Workday (the scoring PR).

Scores, bonus plans per role and the bonus run build on this file and never
redefine a KPI - perf_metrics.scorecard stays the one calculation.
"""
import uuid
from datetime import date, datetime, timezone

from fastapi import HTTPException
from sqlalchemy import func

import models
import perf_metrics

MANUAL_MAX = 30          # % of the weight manual KPIs may carry together
MANUAL_PREFIX = "manual:"
UNITS = ("%", "count", "per100", "rating")
DIRECTIONS = ("high", "low")


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def month_start(d: date) -> str:
    return d.replace(day=1).isoformat()


def next_month_start(d: date) -> str:
    return (date(d.year + (d.month // 12), d.month % 12 + 1, 1)).isoformat()


def month_end(d: date) -> str:
    nm = date.fromisoformat(next_month_start(d))
    return (nm.fromordinal(nm.toordinal() - 1)).isoformat()


# ── the library ──────────────────────────────────────────────────────────────
def builtin_kpis() -> list:
    """Nexus's own metrics, as library rows. `good` high/low becomes the direction."""
    out = []
    for key, (label, unit, good, kind, desc) in perf_metrics.METRICS.items():
        out.append({"key": key, "name": label, "description": desc, "unit": "%" if unit == "%" else "count",
                    "direction": good, "kind": kind, "source": "nexus", "active": True, "companyId": ""})
    return out


def manual_kpis(db, company_id: str, include_inactive: bool = False) -> list:
    q = db.query(models.PerfKpi).filter(models.PerfKpi.company_id.in_(["", company_id or ""]))
    rows = q.order_by(models.PerfKpi.name).all()
    return [{"id": k.id, "key": k.key, "name": k.name, "description": k.description or "", "unit": k.unit or "rating",
             "direction": k.direction or "high", "kind": "manual", "source": "manual", "active": bool(k.active),
             "companyId": k.company_id or ""} for k in rows if include_inactive or k.active]


def library(db, company_id: str, include_inactive: bool = False) -> list:
    return builtin_kpis() + manual_kpis(db, company_id, include_inactive)


def library_map(db, company_id: str) -> dict:
    return {k["key"]: k for k in library(db, company_id, include_inactive=True)}


def create_manual_kpi(db, user: dict, company_id: str, name: str, description: str, unit: str, direction: str):
    name = (name or "").strip()
    if not name:
        raise HTTPException(400, "The KPI needs a name")
    unit = unit if unit in UNITS else "rating"
    direction = direction if direction in DIRECTIONS else "high"
    slug = "".join(ch if ch.isalnum() else "-" for ch in name.lower()).strip("-")[:40] or "kpi"
    key = f"{MANUAL_PREFIX}{slug}"
    taken = {k.key for k in db.query(models.PerfKpi).filter(models.PerfKpi.company_id.in_(["", company_id or ""])).all()}
    n = 2
    while key in taken or key in perf_metrics.METRICS:
        key = f"{MANUAL_PREFIX}{slug}-{n}"
        n += 1
    row = models.PerfKpi(id=str(uuid.uuid4()), company_id=company_id or "", key=key, name=name,
                         description=(description or "").strip(), unit=unit, direction=direction, active=True,
                         created_by=(user.get("email") or "").lower(), created_at=_now())
    db.add(row)
    return row


# ── validation ───────────────────────────────────────────────────────────────
def _num(v, field: str):
    try:
        return float(v)
    except (TypeError, ValueError):
        raise HTTPException(400, f"{field} must be a number")


def clean_items(db, company_id: str, items: list) -> list:
    """The rows of a scorecard as saved: known KPIs, whole-number weights that
    total 100, manual weight within MANUAL_MAX, targets in the right order for
    the KPI's direction (high: threshold <= target <= cap; low: cap <= target
    <= threshold - the cap is the best value)."""
    lib = library_map(db, company_id)
    out, seen, total, manual = [], set(), 0, 0
    for i, it in enumerate(items or []):
        key = (it.get("kpi") or it.get("key") or "").strip()
        k = lib.get(key)
        if not k:
            raise HTTPException(400, f"Unknown KPI: {key or '(blank)'}")
        if not k["active"]:
            raise HTTPException(400, f"{k['name']} is retired - take it off the scorecard")
        if key in seen:
            raise HTTPException(400, f"{k['name']} is on the scorecard twice")
        seen.add(key)
        w = _num(it.get("weight"), "Weight")
        if w != int(w) or w < 0 or w > 100:
            raise HTTPException(400, f"{k['name']}: the weight is a whole number from 0 to 100")
        w = int(w)
        target, threshold, cap = _num(it.get("target"), "Target"), _num(it.get("threshold"), "Threshold"), _num(it.get("cap"), "Cap")
        if k["unit"] == "%":
            for v, name in ((target, "Target"), (threshold, "Threshold"), (cap, "Cap")):
                if v < 0 or v > 100:
                    raise HTTPException(400, f"{k['name']}: {name} is a percentage from 0 to 100")
        if k["direction"] == "high" and not (threshold <= target <= cap):
            raise HTTPException(400, f"{k['name']}: for a higher-is-better KPI, threshold <= target <= cap")
        if k["direction"] == "low" and not (cap <= target <= threshold):
            raise HTTPException(400, f"{k['name']}: for a lower-is-better KPI, cap <= target <= threshold")
        total += w
        if k["source"] == "manual":
            manual += w
        out.append({"kpi": key, "weight": w, "target": target, "threshold": threshold, "cap": cap, "position": i})
    if not out:
        raise HTTPException(400, "A scorecard needs at least one KPI")
    if total != 100:
        raise HTTPException(400, f"The weights total {total}%; they must total 100%")
    if manual > MANUAL_MAX:
        raise HTTPException(400, f"Manual KPIs carry {manual}% of the weight; at most {MANUAL_MAX}% may be rated by hand")
    return out


# ── versions ─────────────────────────────────────────────────────────────────
def versions(db, company_id: str, department: str) -> list:
    return (db.query(models.PerfScorecard)
            .filter(models.PerfScorecard.company_id == company_id,
                    func.lower(models.PerfScorecard.department) == (department or "").strip().lower())
            .order_by(models.PerfScorecard.effective_from.desc(), models.PerfScorecard.version.desc()).all())


def active_for(db, company_id: str, department: str, on: date | None = None):
    """The version in force on `on` (default today): started on or before that
    month, not ended before it, not retired."""
    on = on or date.today()
    ms = month_start(on)
    for v in versions(db, company_id, department):
        if v.status == "retired":
            continue
        if v.effective_from <= ms and (not v.effective_to or v.effective_to >= ms):
            return v
    return None


def upcoming_for(db, company_id: str, department: str, on: date | None = None):
    on = on or date.today()
    ms = month_start(on)
    for v in versions(db, company_id, department):
        if v.status != "retired" and v.effective_from > ms:
            return v
    return None


def items_of(db, sc) -> list:
    rows = (db.query(models.PerfScorecardKpi).filter(models.PerfScorecardKpi.scorecard_id == sc.id)
            .order_by(models.PerfScorecardKpi.position).all())
    return [{"kpi": r.kpi_key, "weight": r.weight, "target": r.target, "threshold": r.threshold, "cap": r.cap, "position": r.position} for r in rows]


def version_out(db, sc, lib: dict | None = None) -> dict:
    lib = lib or library_map(db, sc.company_id)
    items = items_of(db, sc)
    for it in items:
        k = lib.get(it["kpi"]) or {}
        it.update({"name": k.get("name", it["kpi"]), "unit": k.get("unit", ""), "direction": k.get("direction", "high"), "source": k.get("source", "nexus")})
    return {"id": sc.id, "companyId": sc.company_id, "department": sc.department, "version": sc.version,
            "effectiveFrom": sc.effective_from, "effectiveTo": sc.effective_to or "", "status": sc.status,
            "notes": sc.notes or "", "items": items, "createdBy": sc.created_by or "", "createdAt": sc.created_at or ""}


def save(db, user: dict, company_id: str, department: str, items: list, notes: str = "", today: date | None = None):
    """The rules above: a change to a version in force becomes next month's
    version; a version that has not started is edited in place; nothing yet
    starts this month. Returns the version that holds the new rows."""
    department = (department or "").strip()
    if not department:
        raise HTTPException(400, "Pick the department")
    today = today or date.today()
    rows = clean_items(db, company_id, items)
    me = (user.get("email") or "").lower()
    current = active_for(db, company_id, department, today)
    upcoming = upcoming_for(db, company_id, department, today)
    if upcoming is not None:
        target = upcoming
        db.query(models.PerfScorecardKpi).filter(models.PerfScorecardKpi.scorecard_id == target.id).delete()
        target.notes = (notes or "").strip()
    elif current is not None:
        if items_of(db, current) == [{**r} for r in rows] and (current.notes or "") == (notes or "").strip():
            return current                                   # nothing changed
        current.effective_to = month_end(today)
        target = models.PerfScorecard(id=str(uuid.uuid4()), company_id=company_id, department=department,
                                      version=current.version + 1, effective_from=next_month_start(today), effective_to="",
                                      status="active", notes=(notes or "").strip(), created_by=me, created_at=_now())
        db.add(target)
    else:
        last = versions(db, company_id, department)
        target = models.PerfScorecard(id=str(uuid.uuid4()), company_id=company_id, department=department,
                                      version=(last[0].version + 1) if last else 1, effective_from=month_start(today), effective_to="",
                                      status="active", notes=(notes or "").strip(), created_by=me, created_at=_now())
        db.add(target)
    for r in rows:
        db.add(models.PerfScorecardKpi(id=str(uuid.uuid4()), scorecard_id=target.id, kpi_key=r["kpi"], weight=r["weight"],
                                       target=r["target"], threshold=r["threshold"], cap=r["cap"], position=r["position"]))
    db.flush()
    return target


def retire(db, sc, today: date | None = None) -> None:
    """Stop scoring this department: the version in force ends this month; one
    that has not started is dropped."""
    today = today or date.today()
    if sc.effective_from > month_start(today):
        db.query(models.PerfScorecardKpi).filter(models.PerfScorecardKpi.scorecard_id == sc.id).delete()
        db.delete(sc)
        return
    sc.status = "retired"
    sc.effective_to = month_end(today)


# ── who ──────────────────────────────────────────────────────────────────────
def heads_of(db, company_id: str, department: str) -> set:
    rows = (db.query(models.HrDepartment)
            .filter(models.HrDepartment.company_id == company_id,
                    func.lower(models.HrDepartment.name) == (department or "").strip().lower()).all())
    return {x for d in rows for x in ((d.lead_email or "").lower(), (d.backup_email or "").lower()) if x}


def departments_of(db, company_id: str) -> list:
    rows = (db.query(models.HrDepartment).filter(models.HrDepartment.company_id == company_id)
            .order_by(models.HrDepartment.sort_order, models.HrDepartment.name).all())
    names, out = set(), []
    for d in rows:
        n = (d.name or "").strip()
        if n and n.lower() not in names:
            names.add(n.lower())
            out.append({"name": n, "head": d.lead_email or "", "backup": d.backup_email or ""})
    # Departments people are in but Settings does not list yet still get a card.
    for (dept,) in (db.query(models.NexusEmployee.department)
                    .filter(models.NexusEmployee.company == company_id, models.NexusEmployee.status == "active").distinct().all()):
        n = (dept or "").strip()
        if n and n.lower() not in names:
            names.add(n.lower())
            out.append({"name": n, "head": "", "backup": "", "unlisted": True})
    return out


# ── a starting set per department (the form's "Start from a suggestion") ────
SUGGESTIONS = {
    "accounting":   [("tasks_on_time", 40, 95, 70, 100), ("ticket_sla", 25, 90, 60, 100), ("training", 15, 100, 80, 100), ("on_time", 20, 95, 80, 100)],
    "it":           [("ticket_sla", 35, 90, 60, 100), ("tickets_resolved", 25, 40, 15, 60), ("tasks_on_time", 25, 90, 60, 100), ("training", 15, 100, 80, 100)],
    "construction": [("on_time", 35, 95, 80, 100), ("no_shows", 25, 0, 2, 0), ("hours", 25, 100, 85, 110), ("training", 15, 100, 80, 100)],
    "default":      [("tasks_on_time", 40, 90, 60, 100), ("on_time", 30, 95, 80, 100), ("training", 15, 100, 80, 100), ("timesheets", 15, 100, 80, 100)],
}


def suggestion_for(department: str) -> list:
    d = (department or "").strip().lower()
    rows = SUGGESTIONS.get(d) or next((v for k, v in SUGGESTIONS.items() if k != "default" and k in d), SUGGESTIONS["default"])
    return [{"kpi": k, "weight": w, "target": t, "threshold": th, "cap": c} for k, w, t, th, c in rows]
