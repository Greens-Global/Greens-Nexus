"""KPI scorecards per ROLE (Performance, Oct 30 2026 - Charmi: reviews and
bonuses from data, rules fixed before the period; Pranshu: targets and weights
per role, copied from another role or from a shared set).

THE SHAPE
  KPI library   what can be measured. Nexus's own metrics (perf_metrics.METRICS -
                on-time arrival, tasks on time, tickets within target, training
                ...) are always there and never typed by anyone; HR may add
                MANUAL KPIs (a manager rates them with a written reason, from
                the scoring PR on) for a company or for every company.
  Scorecard     one per JOB ROLE (NexusGroup.is_job_role - People > Roles):
                the KPIs the role is scored on, each with a WEIGHT (the weights
                total 100), a TARGET (full marks), a THRESHOLD (below it:
                nothing) and a CAP (above it: no extra). Manual KPIs may carry
                at most MANUAL_MAX of the weight.
  Shared set    a named scorecard that belongs to no role - HR keeps it as a
                starting point ("Office Staff", "Field Crew"). A role COPIES a
                shared set, or another role's scorecard; the copy is its own
                rows from then on, so editing the source changes nothing it
                was copied to (the copy says where it came from).
  Versions      a role's scorecard is never edited under a running period.
                Saving a change to one in force makes a NEW version that
                applies from the first of next month; the current one keeps its
                rows and ends on the last day of this month, so a score paid in
                March is always explained by March's rules. A version that has
                not started yet is edited in place. Shared sets have no
                versions - nobody is scored on them directly.

WHO
  HR for the company (performance.hr_for - the one HR rule) edits roles and
  shared sets of the company; a set for every company (company '') is HR with
  access to every company. A person reads their own role's version in force.

Scores, bonus plans per role and the bonus run build on this file and never
redefine a KPI - perf_metrics.scorecard stays the one calculation.
"""
import uuid
from collections import Counter
from datetime import date, datetime, timezone

from fastapi import HTTPException

import models
import perf_metrics

MANUAL_MAX = 30          # % of the weight manual KPIs may carry together
MANUAL_PREFIX = "manual:"
UNITS = ("%", "count", "per100", "rating")
DIRECTIONS = ("high", "low")
SHARED = "shared"        # PerfScorecard.kind for a shared set; "role" otherwise


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
    out = []
    for key, (label, unit, good, kind, desc) in perf_metrics.METRICS.items():
        out.append({"key": key, "name": label, "description": desc, "unit": "%" if unit == "%" else "count",
                    "direction": good, "kind": kind, "source": "nexus", "active": True, "companyId": ""})
    return out


def manual_kpis(db, company_id: str, include_inactive: bool = False) -> list:
    rows = (db.query(models.PerfKpi).filter(models.PerfKpi.company_id.in_(["", company_id or ""]))
            .order_by(models.PerfKpi.name).all())
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
    """Known KPIs, whole-number weights that total 100, manual weight within
    MANUAL_MAX, targets in the right order for the KPI's direction (high:
    threshold <= target <= cap; low: cap <= target <= threshold)."""
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


# ── roles ────────────────────────────────────────────────────────────────────
def job_roles(db, company_id: str) -> list:
    """The company's job roles plus the ones shared by every company, with how
    many people hold each (People > Roles - NexusGroup.is_job_role)."""
    rows = (db.query(models.NexusGroup).filter(models.NexusGroup.is_job_role == 1,
                                               models.NexusGroup.company_id.in_(["", company_id or ""]))
            .order_by(models.NexusGroup.department, models.NexusGroup.name).all())
    counts = Counter(g for (g,) in db.query(models.NexusGroupMember.group_id)
                     .filter(models.NexusGroupMember.group_id.in_([r.id for r in rows] or ["-"])).all())
    return [{"id": r.id, "name": r.name, "department": r.department or "", "tier": r.tier or "", "companyId": r.company_id or "",
             "members": counts.get(r.id, 0)} for r in rows]


def role_of_person(db, email: str):
    """The job role a person holds - the first job-role group they belong to
    (the same door People uses)."""
    return (db.query(models.NexusGroup).join(models.NexusGroupMember, models.NexusGroupMember.group_id == models.NexusGroup.id)
            .filter(models.NexusGroupMember.email == (email or "").lower(), models.NexusGroup.is_job_role == 1)
            .order_by(models.NexusGroup.name).first())


def _role(db, company_id: str, role_id: str):
    r = db.get(models.NexusGroup, (role_id or "").strip())
    if not r or r.is_job_role != 1 or (r.company_id or "") not in ("", company_id):
        raise HTTPException(404, "Role not found")
    return r


# ── versions (role scorecards) ───────────────────────────────────────────────
def versions(db, role_id: str) -> list:
    return (db.query(models.PerfScorecard)
            .filter(models.PerfScorecard.kind == "role", models.PerfScorecard.role_id == role_id)
            .order_by(models.PerfScorecard.effective_from.desc(), models.PerfScorecard.version.desc()).all())


def active_for(db, role_id: str, on: date | None = None):
    on = on or date.today()
    ms = month_start(on)
    for v in versions(db, role_id):
        if v.status == "retired":
            continue
        if v.effective_from <= ms and (not v.effective_to or v.effective_to >= ms):
            return v
    return None


def upcoming_for(db, role_id: str, on: date | None = None):
    on = on or date.today()
    ms = month_start(on)
    for v in versions(db, role_id):
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
    return {"id": sc.id, "companyId": sc.company_id, "kind": sc.kind, "roleId": sc.role_id or "", "name": sc.name or "",
            "version": sc.version, "effectiveFrom": sc.effective_from or "", "effectiveTo": sc.effective_to or "", "status": sc.status,
            "notes": sc.notes or "", "copiedFrom": sc.copied_from or "", "items": items,
            "createdBy": sc.created_by or "", "createdAt": sc.created_at or ""}


def _write_rows(db, sc, rows: list) -> None:
    db.query(models.PerfScorecardKpi).filter(models.PerfScorecardKpi.scorecard_id == sc.id).delete()
    for r in rows:
        db.add(models.PerfScorecardKpi(id=str(uuid.uuid4()), scorecard_id=sc.id, kpi_key=r["kpi"], weight=r["weight"],
                                       target=r["target"], threshold=r["threshold"], cap=r["cap"], position=r["position"]))


def save(db, user: dict, company_id: str, role_id: str, items: list, notes: str = "", copied_from: str = "", today: date | None = None):
    """A role's scorecard: a change to the version in force becomes next
    month's version; a version not yet started is edited in place; nothing yet
    starts this month. Returns the version that holds the rows."""
    role = _role(db, company_id, role_id)
    today = today or date.today()
    rows = clean_items(db, company_id, items)
    me = (user.get("email") or "").lower()
    current, upcoming = active_for(db, role.id, today), upcoming_for(db, role.id, today)
    if upcoming is not None:
        target = upcoming
        target.notes, target.copied_from = (notes or "").strip(), (copied_from or "").strip()
    elif current is not None:
        if items_of(db, current) == rows and (current.notes or "") == (notes or "").strip():
            return current
        current.effective_to = month_end(today)
        target = models.PerfScorecard(id=str(uuid.uuid4()), company_id=company_id, kind="role", role_id=role.id, name=role.name,
                                      version=current.version + 1, effective_from=next_month_start(today), effective_to="",
                                      status="active", notes=(notes or "").strip(), copied_from=(copied_from or "").strip(),
                                      created_by=me, created_at=_now())
        db.add(target)
    else:
        last = versions(db, role.id)
        target = models.PerfScorecard(id=str(uuid.uuid4()), company_id=company_id, kind="role", role_id=role.id, name=role.name,
                                      version=(last[0].version + 1) if last else 1, effective_from=month_start(today), effective_to="",
                                      status="active", notes=(notes or "").strip(), copied_from=(copied_from or "").strip(),
                                      created_by=me, created_at=_now())
        db.add(target)
    db.flush()
    _write_rows(db, target, rows)
    db.flush()
    return target


def retire(db, sc, today: date | None = None) -> None:
    today = today or date.today()
    if sc.kind == SHARED or sc.effective_from > month_start(today):
        db.query(models.PerfScorecardKpi).filter(models.PerfScorecardKpi.scorecard_id == sc.id).delete()
        db.delete(sc)
        return
    sc.status = "retired"
    sc.effective_to = month_end(today)


# ── shared sets ──────────────────────────────────────────────────────────────
def shared_sets(db, company_id: str) -> list:
    return (db.query(models.PerfScorecard)
            .filter(models.PerfScorecard.kind == SHARED, models.PerfScorecard.company_id.in_(["", company_id or ""]))
            .order_by(models.PerfScorecard.name).all())


def save_shared(db, user: dict, company_id: str, shared_id: str, name: str, items: list, notes: str = ""):
    """A named set to copy from; edited in place (nobody is scored on it)."""
    name = (name or "").strip()
    if not name:
        raise HTTPException(400, "The shared set needs a name")
    rows = clean_items(db, company_id, items)
    if shared_id:
        sc = db.get(models.PerfScorecard, shared_id)
        if not sc or sc.kind != SHARED:
            raise HTTPException(404, "Shared set not found")
        sc.name, sc.notes = name, (notes or "").strip()
    else:
        sc = models.PerfScorecard(id=str(uuid.uuid4()), company_id=company_id or "", kind=SHARED, role_id="", name=name, version=1,
                                  effective_from="", effective_to="", status="active", notes=(notes or "").strip(),
                                  created_by=(user.get("email") or "").lower(), created_at=_now())
        db.add(sc)
        db.flush()
    _write_rows(db, sc, rows)
    db.flush()
    return sc


def copy_source(db, company_id: str, source_id: str) -> tuple:
    """(rows, label) to copy into a role: from a shared set or another role's
    version in force (or upcoming when nothing is in force yet)."""
    sc = db.get(models.PerfScorecard, source_id)
    if sc and sc.kind == SHARED and (sc.company_id or "") in ("", company_id):
        return items_of(db, sc), f"Shared set: {sc.name}"
    role = db.get(models.NexusGroup, source_id)
    if role and role.is_job_role == 1 and (role.company_id or "") in ("", company_id):
        src = active_for(db, role.id) or upcoming_for(db, role.id)
        if not src:
            raise HTTPException(400, f"{role.name} has no scorecard to copy")
        return items_of(db, src), f"Role: {role.name}"
    raise HTTPException(404, "Nothing to copy from")


# ── a starting set per role (by its department, else its name) ─────────────
SUGGESTIONS = {
    "accounting":   [("tasks_on_time", 40, 95, 70, 100), ("ticket_sla", 25, 90, 60, 100), ("training", 15, 100, 80, 100), ("on_time", 20, 95, 80, 100)],
    "it":           [("ticket_sla", 35, 90, 60, 100), ("tickets_resolved", 25, 40, 15, 60), ("tasks_on_time", 25, 90, 60, 100), ("training", 15, 100, 80, 100)],
    "construction": [("on_time", 35, 95, 80, 100), ("no_shows", 25, 0, 2, 0), ("hours", 25, 100, 85, 110), ("training", 15, 100, 80, 100)],
    "default":      [("tasks_on_time", 40, 90, 60, 100), ("on_time", 30, 95, 80, 100), ("training", 15, 100, 80, 100), ("timesheets", 15, 100, 80, 100)],
}


def suggestion_for(department: str, role_name: str = "") -> list:
    text = f"{department or ''} {role_name or ''}".strip().lower()
    rows = next((v for k, v in SUGGESTIONS.items() if k != "default" and k in text), None)
    if rows is None and any(w in text for w in ("crew", "site", "field", "foreman")):
        rows = SUGGESTIONS["construction"]
    if rows is None and any(w in text for w in ("account", "book", "payroll", "finance")):
        rows = SUGGESTIONS["accounting"]
    rows = rows or SUGGESTIONS["default"]
    return [{"kpi": k, "weight": w, "target": t, "threshold": th, "cap": c} for k, w, t, th, c in rows]
