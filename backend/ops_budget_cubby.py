"""Operations > Ops Budget: actuals from Cubby (Oct 21 2026).

Nexus already copies Cubby into the cubby_* tables every 15 minutes
(cubby_sync.py). This job reads THOSE tables - it never calls Cubby - and
writes the Ops Budget actuals into ops_metric_month (source `cubby_api`).

Cubby's API reports today only, so month-end values (units, square feet,
rates, autopay, past-due buckets) have to be taken by the server: every run
rewrites the facility's CURRENT month with what is true now, so the last run
before the month turns is that month's month-end snapshot. A finished month's
snapshot values are never touched again. Flows that the synced rows can
rebuild for any month (move-ins / move-outs and their square feet, insured
move-ins, leads, reservations from the lead marks) are rewritten for every
month from Sep 2026 on, so a late-entered lease lands in its month.

Segment rule (the briefing): a unit's pricing group name containing "Parking"
is vehicle storage, "Storage" self-storage; mailboxes, deactivated records
(ops_unit_classes) and anything else ("Other") count nowhere. Money is cents
in Cubby, dollars here.

What the synced rows cannot give (left to the workbook - see the report):
actual rental income (Cubby's accrual general ledger is not synced), so also
economic occupancy; liens (auctions are not synced); tows (workbook only by
rule); website visitors and reviews (Pending API).

Blocking (DB). `ops_budget_loop` runs `snapshot_all` in a thread on the
deployed worker (CLAUDE.md: never on the event loop).
"""
from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import date

import ops_budget as ob
import ops_unit_classes as uc
import job_switch

EVERY_SEC = 15 * 60          # matches the Cubby sync
FIRST_WAIT_SEC = 300         # after the first Cubby sync of a fresh boot
BY = "cubby-snapshot"

SNAPSHOT_KEYS = ("total_units", "occupied_units", "total_sqft", "occupied_sqft", "gpr", "avg_standard_rate",
                 "avg_web_rate", "autopay_tenants", "ar_1_30", "ar_31_60", "ar_61_90", "ar_90_plus")
FLOW_KEYS = ("move_ins", "move_outs", "sqft_moved_in", "sqft_moved_out", "insured_rentals", "leads",
             "reservations", "reservations_converted")
AR_BUCKET = {"RANGE_0_30": "ar_1_30", "RANGE_30_60": "ar_31_60", "RANGE_60_90": "ar_61_90",
             "RANGE_90_120": "ar_90_plus", "RANGE_120_PLUS": "ar_90_plus"}    # RANGE_UNKNOWN is left out
TRANSFER_DAYS = 1            # a move-out and a move-in by one customer this close together is a transfer


def segment_of(group_name: str, rules: dict | None = None) -> str | None:
    if uc.unit_class(group_name, rules) != uc.STORAGE:
        return None
    n = (group_name or "").lower()
    if "parking" in n:
        return "vehicle"
    if "storage" in n:
        return "self_storage"
    return None


def _num(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _day(v) -> str:
    return str(v or "")[:10]


def _area(r: dict) -> float:
    return _num(r.get("width")) * _num(r.get("depth"))


# ── Pure: rows in, values out ─────────────────────────────────────────────────

def snapshot_values(rent_roll: list[dict], receivables: list[dict], web_by_group: dict, rules=None) -> dict:
    """{segment: {metric: value}} for the month-end metrics, as of now."""
    out = {s: {k: 0.0 for k in SNAPSHOT_KEYS} for s in ob.SEGMENTS}
    std_sum = defaultdict(float)
    web_sum, web_n = defaultdict(float), defaultdict(int)
    seg_of_unit = {}
    for r in rent_roll:
        seg = segment_of(r.get("pricingGroupName"), rules)
        seg_of_unit[str(r.get("unitId") or "")] = seg
        status = (r.get("status") or "").upper()
        if seg is None or status not in ("RENTED", "VACANT"):
            continue
        v = out[seg]
        std = _num(r.get("standardRate")) / 100
        v["total_units"] += 1
        v["total_sqft"] += _area(r)
        v["gpr"] += std
        std_sum[seg] += std
        web = web_by_group.get((r.get("pricingGroupId") or "", (r.get("pricingGroupName") or "").strip()))
        if web is None:
            web = web_by_group.get(("", (r.get("pricingGroupName") or "").strip()))
        if web is not None:
            web_sum[seg] += web / 100
            web_n[seg] += 1
        if status == "RENTED":
            v["occupied_units"] += 1
            v["occupied_sqft"] += _area(r)
            if r.get("autoPayEnabled"):
                v["autopay_tenants"] += 1
    for seg, v in out.items():
        n = v["total_units"]
        v["avg_standard_rate"] = round(std_sum[seg] / n, 4) if n else None
        v["avg_web_rate"] = round(web_sum[seg] / web_n[seg], 4) if web_n[seg] else None
        v["total_sqft"] = round(v["total_sqft"], 1)
        v["occupied_sqft"] = round(v["occupied_sqft"], 1)
        v["gpr"] = round(v["gpr"], 2)
    for e in receivables:
        seg = seg_of_unit.get(str(e.get("unitId") or ""))
        if seg is None and not e.get("unitId"):
            seg = segment_of(e.get("pricingGroupName"), rules)
        if seg is None:
            continue
        for x in e.get("ranges") or []:
            key = AR_BUCKET.get(x.get("range"))
            if key:
                out[seg][key] += _num(x.get("amount")) / 100
    for v in out.values():
        for k in ("ar_1_30", "ar_31_60", "ar_61_90", "ar_90_plus"):
            v[k] = round(v[k], 2)
        if not v["total_units"]:
            # A segment the site does not have: blanks, not zeros.
            for k in SNAPSHOT_KEYS:
                v[k] = None
    return out


def transfers(leases: list[dict]) -> set[int]:
    """Indexes of leases whose move-in or move-out is one half of a transfer:
    the same customer moving out of one unit and into another within a day."""
    outs = defaultdict(list)
    for i, le in enumerate(leases):
        if le.get("customerId") and _day(le.get("moveOutDate")):
            outs[le["customerId"]].append((i, _day(le["moveOutDate"]), le.get("unitId")))
    hit: set[int] = set()
    for i, le in enumerate(leases):
        mi, cid = _day(le.get("moveInDate")), le.get("customerId")
        if not mi or not cid or cid not in outs:
            continue
        for j, mo, unit in outs[cid]:
            if j == i or unit == le.get("unitId"):
                continue
            try:
                gap = abs((date.fromisoformat(mi) - date.fromisoformat(mo)).days)
            except ValueError:
                continue
            if gap <= TRANSFER_DAYS:
                hit.add(i)
                hit.add(-j - 1)          # j's move-out (negative = the move-out side)
    return hit


def lead_segment(lead: dict, seg_of_unit: dict, seg_of_group_id: dict, rules=None) -> str:
    """A lead's segment from the unit or unit type it asked about. A lead
    that names neither is counted under self-storage."""
    uid = str(lead.get("unitId") or "")
    if uid and seg_of_unit.get(uid):
        return seg_of_unit[uid]
    gid = str(lead.get("pricingGroupId") or "")
    if gid and seg_of_group_id.get(gid):
        return seg_of_group_id[gid]
    seg = segment_of(lead.get("pricingGroupName") or lead.get("unitTypeName") or "", rules)
    return seg or "self_storage"


def flow_values(months: list[str], rent_roll: list[dict], leases: list[dict], leads: list[dict],
                marks: dict, seg_of_group_id: dict, rules=None) -> dict:
    """{(segment, month): {metric: value}} for the flow metrics Cubby's rows
    can rebuild. `marks` = {leadId: {"reserved": YYYY-MM|'before'|'', "converted": ...}}."""
    wanted = set(months)
    out = {(s, m): {k: 0.0 for k in FLOW_KEYS} for s in ob.SEGMENTS for m in months}
    unit = {str(r.get("unitId") or ""): r for r in rent_roll}
    seg_of_unit = {uid: segment_of(r.get("pricingGroupName"), rules) for uid, r in unit.items()}
    skip = transfers(leases)
    for i, le in enumerate(leases):
        uid = str(le.get("unitId") or "")
        seg = seg_of_unit.get(uid)
        if seg is None:
            continue
        area = _area(unit.get(uid) or {})
        mi, mo = _day(le.get("moveInDate"))[:7], _day(le.get("moveOutDate"))[:7]
        if mi in wanted and i not in skip:
            v = out[(seg, mi)]
            v["move_ins"] += 1
            v["sqft_moved_in"] += area
            if _num((le.get("coverage") or {}).get("premiumAmount")) > 0:
                v["insured_rentals"] += 1
        if mo in wanted and (-i - 1) not in skip:
            v = out[(seg, mo)]
            v["move_outs"] += 1
            v["sqft_moved_out"] += area
    for ld in leads:
        seg = lead_segment(ld, seg_of_unit, seg_of_group_id, rules)
        lid = str(ld.get("leadId") or "")
        created = _day(ld.get("createdAt"))[:7]
        if created in wanted and (ld.get("status") or "").upper() != "DUPLICATE":
            out[(seg, created)]["leads"] += 1
        mk = marks.get(lid) or {}
        if mk.get("reserved") in wanted:
            out[(seg, mk["reserved"])]["reservations"] += 1
        if mk.get("converted") in wanted and mk.get("reserved"):
            out[(seg, mk["converted"])]["reservations_converted"] += 1
    for v in out.values():
        v["sqft_moved_in"] = round(v["sqft_moved_in"], 1)
        v["sqft_moved_out"] = round(v["sqft_moved_out"], 1)
    return out


def update_marks(marks: dict, leads: list[dict], current: str) -> dict:
    """The lead marks after this run: {leadId: {"created", "reserved", "converted", "new"}}.
    A lead's reservation / move-in month is when it is first SEEN in that
    status. Cubby's own date wins when the lead row carries one. A lead first
    seen already reserved or converted, created before this month, is marked
    'before' - its month is unknown and it counts in none."""
    out = {k: dict(v) for k, v in marks.items()}
    for ld in leads:
        lid = str(ld.get("leadId") or "")
        if not lid:
            continue
        st = (ld.get("status") or "").upper()
        created = _day(ld.get("createdAt"))[:7]
        mk = out.get(lid)
        first = mk is None
        if first:
            mk = out[lid] = {"created": created, "reserved": "", "converted": ""}
        stated_res = _day(ld.get("reservationDate") or ld.get("reservedAt"))[:7]
        stated_conv = _day(ld.get("convertedAt") or ld.get("convertedDate"))[:7]
        when = current if (not first or created == current) else "before"
        if st in ("RESERVATION", "CONVERTED") and not mk["reserved"] and (st == "RESERVATION" or stated_res):
            mk["reserved"] = stated_res or when
        if st == "CONVERTED" and not mk["converted"]:
            mk["converted"] = stated_conv or when
    return out


# ── The job ───────────────────────────────────────────────────────────────────

def _facility_links(db) -> list[tuple]:
    """[(OpsBudgetFacility, CubbyFacility)] for the sites Cubby has, matched by
    name, and keeps cubby_facility_id current."""
    import models
    from ops_budget_models import OpsBudgetFacility
    ob.ensure_seeded(db)
    cubby = db.query(models.CubbyFacility).filter(models.CubbyFacility.enabled.is_(True)).all()
    out = []
    for f in db.query(OpsBudgetFacility).order_by(OpsBudgetFacility.sort_order).all():
        short = (f.short_name or "").lower()
        hit = next((c for c in cubby if c.facility_id == f.cubby_facility_id), None) or \
            next((c for c in cubby if short and short in (c.name or "").lower()), None)
        if hit is None:
            continue
        if f.cubby_facility_id != hit.facility_id:
            f.cubby_facility_id = hit.facility_id
        out.append((f, hit))
    db.commit()
    return out


def _raw(db, cubby_fid: str) -> dict:
    import models as m
    rent_roll, leases, leads, recs = [], [], [], []
    for u in db.query(m.CubbyUnit).filter(m.CubbyUnit.facility_id == cubby_fid).all():
        rr = (u.data or {}).get("rentRoll")
        if rr:
            rent_roll.append(rr)
    for r in db.query(m.CubbyRental).filter(m.CubbyRental.facility_id == cubby_fid).all():
        leases.append(r.data or {})
    for ld in db.query(m.CubbyLead).filter(m.CubbyLead.facility_id == cubby_fid).all():
        d = dict(ld.data or {})
        d.setdefault("leadId", ld.lead_id)
        d.setdefault("status", ld.status)
        d.setdefault("createdAt", ld.created_at)
        leads.append(d)
    for e in db.query(m.CubbyReceivable).filter(m.CubbyReceivable.facility_id == cubby_fid).all():
        recs.append(e.data or {})
    web, seg_gid = {}, {}
    for g in db.query(m.CubbyPricingGroup).filter(m.CubbyPricingGroup.facility_id == cubby_fid,
                                                  m.CubbyPricingGroup.active.is_(True)).all():
        if g.web_cents is not None:
            web[(g.pricing_group_id or "", (g.name or "").strip())] = g.web_cents
            web.setdefault(("", (g.name or "").strip()), g.web_cents)
        seg_gid[g.pricing_group_id or ""] = g.name or ""
    return {"rent_roll": rent_roll, "leases": leases, "leads": leads, "receivables": recs, "web": web, "groups": seg_gid}


def run_facility(db, fac, cubby_fac, today: date, rules) -> dict:
    """Write one facility's Cubby actuals in the open session (the caller commits)."""
    from ops_budget_models import OpsBudgetLeadMark as L
    from ops_budget_models import OpsBudgetLoad
    raw = _raw(db, cubby_fac.facility_id)
    current = ob.ym(today)
    stamp = ob.now_iso()

    stored = {r.id.split(":", 1)[1]: r for r in db.query(L).filter(L.facility_id == cubby_fac.facility_id).all()}
    marks = {lid: {"created": r.created_month, "reserved": r.reserved_month, "converted": r.converted_month}
             for lid, r in stored.items()}
    marks = update_marks(marks, raw["leads"], current)
    for lid, mk in marks.items():
        r = stored.get(lid)
        if r is None:
            db.add(L(id=f"{cubby_fac.facility_id}:{lid}", facility_id=cubby_fac.facility_id, created_month=mk["created"],
                     reserved_month=mk["reserved"], converted_month=mk["converted"], first_seen_at=stamp, updated_at=stamp))
        elif (r.reserved_month, r.converted_month) != (mk["reserved"], mk["converted"]):
            r.reserved_month, r.converted_month, r.updated_at = mk["reserved"], mk["converted"], stamp

    seg_gid = {gid: segment_of(name, rules) for gid, name in raw["groups"].items()}
    months = ob.month_range(ob.CUBBY_FROM, current) if current >= ob.CUBBY_FROM else []
    # Only the segments this site has: a site with no parking shows dashes, not zeros.
    present = {segment_of(r.get("pricingGroupName"), rules) for r in raw["rent_roll"]} - {None}
    values = []
    for (seg, mo), vals in flow_values(months, raw["rent_roll"], raw["leases"], raw["leads"], marks, seg_gid, rules).items():
        for k, v in vals.items():
            if seg in present:
                values.append((fac.id, seg, mo, "actual", k, v))
    if current >= ob.CUBBY_FROM:
        for seg, vals in snapshot_values(raw["rent_roll"], raw["receivables"], raw["web"], rules).items():
            for k, v in vals.items():
                values.append((fac.id, seg, current, "actual", k, v))
    lid = f"cubby:{fac.id}:{current}"
    written = ob.upsert(db, values, source="cubby_api", by=BY, load_id=lid, stamp=stamp)
    log = db.get(OpsBudgetLoad, lid)
    if log is None:
        log = OpsBudgetLoad(id=lid, facility_id=fac.id, kind="cubby", file_name="", rows_written=0)
        db.add(log)
    log.months = months
    log.rows_written = (log.rows_written or 0) + written
    log.status, log.error, log.loaded_by, log.loaded_at = "ok", "", BY, stamp
    return {"facility": fac.id, "rows": written, "month": current}


def snapshot_all() -> dict:
    """Every linked facility. Blocking - call it in a thread."""
    if job_switch.off("ops_budget"):   # Workflows > Automations switch
        return {}
    import cubby
    from database import SessionLocal
    db = SessionLocal()
    results = {}
    try:
        rules = uc.load(db)
        links = _facility_links(db)
        for fac, cf in links:
            try:
                tz_fac = {"timeZone": cf.time_zone or (cf.data or {}).get("timeZone") or cubby.DEFAULT_TZ}
                results[fac.id] = run_facility(db, fac, cf, cubby._facility_today(tz_fac), rules)
                db.commit()
            except Exception as e:  # noqa: BLE001 - one site failing keeps the others
                db.rollback()
                results[fac.id] = {"facility": fac.id, "error": type(e).__name__}
    finally:
        db.close()
    return results


async def ops_budget_loop():
    """Started from main.py on the deployed worker only."""
    await asyncio.sleep(FIRST_WAIT_SEC)
    while True:
        try:
            done = await asyncio.to_thread(snapshot_all)
            bad = [k for k, v in done.items() if v.get("error")]
            if bad:
                print(f"[ops-budget] snapshot failed for {', '.join(bad)}")
        except Exception as e:  # noqa: BLE001
            print(f"[ops-budget] loop error: {type(e).__name__}")
        await asyncio.sleep(EVERY_SEC)
