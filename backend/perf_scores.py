"""The monthly score (Performance, Oct 30 2026 - PR 2 of Charmi's ask).

A person's score for a month is their ROLE's scorecard (perf_scorecards:
the version in force that month) applied to their numbers:

  Nexus KPI    the metric from perf_metrics.scorecard for the month - the one
               calculation My Numbers, goals and reviews already read.
  Manual KPI   the rating their manager (or HR) gave for that month, with a
               written reason (PerfKpiRating) - one per person, KPI and month.

For each KPI with a value, ATTAINMENT runs 0..100% from the threshold to the
target (below the threshold nothing, at the target full marks); OVER TARGET
runs 0..100% from the target to the cap and is shown, not scored (the bonus
plan may use it later). "Lower is better" KPIs read the other way round.
A KPI with no value yet - a metric that does not apply to the person, a manual
KPI nobody rated - is UNMEASURED: it is left out and the rest of the weights
are scaled up, so a gap in data never costs anyone points; the screen says
how much of the weight was measured.

  score = sum(weight_i x attainment_i) / sum(measured weights) x 100

Who reads a score: the person, their manager chain and HR for their company
(performance.can_see_person). Who rates a manual KPI: the manager chain or
HR. Nothing here is a bonus - that is PR 3's plan per role, read from the
same score.
"""
import uuid
from datetime import date, datetime, timezone

from fastapi import HTTPException

import models
import perf_metrics
import perf_scorecards as sc
import performance as perf


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def month_bounds(month: str, today: date | None = None) -> tuple:
    """'2026-10' -> ('2026-10-01', '2026-10-31'); '' = this month."""
    today = today or perf_metrics.local_today()
    try:
        y, m = (int(x) for x in (month or today.strftime("%Y-%m")).split("-")[:2])
        start = date(y, m, 1)
    except (TypeError, ValueError):
        raise HTTPException(400, "Month must be YYYY-MM")
    end = date.fromisoformat(sc.month_end(start))
    return start.isoformat(), end.isoformat()


def _clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


def attainment(direction: str, value: float, target: float, threshold: float, cap: float) -> tuple:
    """(attainment 0..1, over 0..1) for one KPI."""
    if direction == "low":
        att = 1.0 if value <= target else (_clamp((threshold - value) / (threshold - target)) if threshold > target else 0.0)
        over = _clamp((target - value) / (target - cap)) if value < target and target > cap else 0.0
    else:
        att = 1.0 if value >= target else (_clamp((value - threshold) / (target - threshold)) if target > threshold else 0.0)
        over = _clamp((value - target) / (cap - target)) if value > target and cap > target else 0.0
    return att, over


def ratings_for(db, email: str, period: str) -> dict:
    rows = (db.query(models.PerfKpiRating)
            .filter(models.PerfKpiRating.email == (email or "").lower(), models.PerfKpiRating.period == period).all())
    return {r.kpi_key: r for r in rows}


def _display(value, unit: str) -> str:
    if value is None:
        return ""
    if unit == "%":
        return f"{int(round(value))}%"
    if unit == "rating":
        return f"{value:g} / 5"
    return f"{value:g}"


def score(db, email: str, month: str = "", today: date | None = None, metrics: dict | None = None) -> dict:
    """The person's score for the month (default this month)."""
    email = (email or "").lower()
    today = today or perf_metrics.local_today()
    start, end = month_bounds(month, today)
    period = start[:7]
    role = sc.role_of_person(db, email)
    out = {"email": email, "name": perf.name_of(db, email), "period": period, "start": start, "end": end,
           "role": {"id": role.id, "name": role.name} if role else None, "scorecard": None, "items": [],
           "score": None, "measuredWeight": 0, "status": "no_role" if not role else "no_scorecard"}
    if not role:
        return out
    version = sc.active_for(db, role.id, date.fromisoformat(start))
    if not version:
        return out
    emp = perf.employee(db, email)
    lib = sc.library_map(db, (emp.company if emp else "") or version.company_id)
    nums = metrics if metrics is not None else perf_metrics.scorecard(db, email, start, end, today)
    values = {m["key"]: m for m in nums.get("metrics", [])}
    rated = ratings_for(db, email, period)
    items, measured, points = [], 0, 0.0
    for it in sc.items_of(db, version):
        k = lib.get(it["kpi"]) or {"name": it["kpi"], "unit": "", "direction": "high", "source": "nexus"}
        value, rating = None, None
        if k["source"] == "manual":
            r = rated.get(it["kpi"])
            if r is not None:
                value = float(r.value)
                rating = {"value": r.value, "reason": r.reason or "", "by": r.rated_by or "", "byName": perf.name_of(db, r.rated_by or ""), "at": r.rated_at or ""}
        else:
            m = values.get(it["kpi"])
            if m and m.get("available") and m.get("value") is not None:
                value = float(m["value"])
        row = {"kpi": it["kpi"], "name": k["name"], "source": k["source"], "unit": k.get("unit", ""), "direction": k.get("direction", "high"),
               "weight": it["weight"], "target": it["target"], "threshold": it["threshold"], "cap": it["cap"],
               "value": value, "display": _display(value, k.get("unit", "")), "measured": value is not None, "rating": rating,
               "attainment": None, "overTarget": None, "contribution": None, "status": "unmeasured"}
        if value is not None:
            att, over = attainment(k.get("direction", "high"), value, float(it["target"]), float(it["threshold"]), float(it["cap"]))
            row.update({"attainment": round(att * 100, 1), "overTarget": round(over * 100, 1),
                        "status": "met" if att >= 1 else "partly" if att > 0 else "missed"})
            measured += it["weight"]
            points += it["weight"] * att
        items.append(row)
    for row in items:
        if row["measured"] and measured:
            row["contribution"] = round(row["weight"] * (row["attainment"] / 100) * 100 / measured, 1)
    out.update({"scorecard": {"id": version.id, "version": version.version, "effectiveFrom": version.effective_from},
                "items": items, "measuredWeight": measured,
                "score": round(points / measured * 100, 1) if measured else None,
                "status": "scored" if measured else "unmeasured"})
    return out


def team_scores(db, manager: str, month: str = "", today: date | None = None) -> list:
    """Direct reports' scores for the month, one metrics pass for all of them."""
    reports = [(e.work_email or "").lower() for e in perf.direct_reports(db, manager)]
    if not reports:
        return []
    today = today or perf_metrics.local_today()
    start, end = month_bounds(month, today)
    nums = perf_metrics.scorecards(db, reports, start, end, today)
    return [score(db, em, month, today, nums.get(em) or {"metrics": []}) for em in reports]


def rate(db, user: dict, email: str, kpi_key: str, month: str, value, reason: str, today: date | None = None):
    """A manager (chain) or HR rates a manual KPI for a person and month, with
    a reason; rating again replaces the row. The KPI must be manual and on the
    person's scorecard that month."""
    email = (email or "").lower()
    me = (user.get("email") or "").lower()
    if not (perf.is_above(db, me, email) or perf.hr_for_person(db, user, email)):
        raise HTTPException(403, "Only the person's manager chain or HR rates a manual KPI")
    today = today or perf_metrics.local_today()
    start, _ = month_bounds(month, today)
    period = start[:7]
    role = sc.role_of_person(db, email)
    version = sc.active_for(db, role.id, date.fromisoformat(start)) if role else None
    if not version or kpi_key not in {it["kpi"] for it in sc.items_of(db, version)}:
        raise HTTPException(400, "That KPI is not on this person's scorecard for the month")
    emp = perf.employee(db, email)
    k = sc.library_map(db, (emp.company if emp else "") or version.company_id).get(kpi_key)
    if not k or k["source"] != "manual":
        raise HTTPException(400, "Only a manual KPI is rated by hand - Nexus measures the others")
    if not (reason or "").strip():
        raise HTTPException(400, "A rating needs a written reason")
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise HTTPException(400, "The rating must be a number")
    if k["unit"] == "rating" and not (1 <= v <= 5):
        raise HTTPException(400, "A rating runs from 1 to 5")
    if k["unit"] == "%" and not (0 <= v <= 100):
        raise HTTPException(400, "A percentage runs from 0 to 100")
    row = (db.query(models.PerfKpiRating).filter(models.PerfKpiRating.email == email, models.PerfKpiRating.kpi_key == kpi_key,
                                                 models.PerfKpiRating.period == period).first())
    if row is None:
        row = models.PerfKpiRating(id=str(uuid.uuid4()), email=email, kpi_key=kpi_key, period=period, company_id=(emp.company if emp else "") or "")
        db.add(row)
    row.value, row.reason, row.rated_by, row.rated_at = v, reason.strip(), me, _now()
    db.flush()
    return row
