"""Cubby pricing -> database, change-tracked (Operations > Pricing Insights,
Visesh, Oct 20 2026: "an engine that pulls all of the data every time it
changes").

Cubby has no webhooks and no paging, so "every time it changes" means: on
every 15-minute Cubby sync (cubby_sync.run_claimed calls `sync`, in the sync's
own thread) read each facility's pricing groups and compare them with what we
stored. A row lands in `cubby_rate_history` ONLY when a rate moved, which is
what makes "Last Changed" and the 1 / 7 / 30-day trends of OUR rates
computable. Existing-customer rate increases Cubby has scheduled on leases are
tracked the same way into `cubby_rent_changes` (scheduled -> applied /
canceled), from the leases cubby_sync already copied.

What is read, per facility, in ONE call:
  pricing-groups/search  {"where": {"facilityId"}, "expansions": ["discounts", "valuePricingStrategies"]}
      -> pricingGroups (standard / web / walk-in / strikethrough rate, area,
         parking, features, assigned discounts, value pricing status),
         discounts (name, type, status, terms, the groups they are offered on),
         valuePricingStrategies (tiers).
  (discounts/search scoped to the organization answers 403 for our key, and
  the expansion carries the same rows, so it is not called.)

READ ONLY. Nexus never writes to Cubby (Visesh, Oct 20 2026: "we don't want
anything to push to cubby"). Every call goes through ops_rate_mgmt._call,
which refuses any path that is not a `*/search`. Never add pricing-groups/
change-rates, leases/change-rents or any other Cubby write here.

No tenant data: pricing groups and discounts carry none; rent changes keep
lease / unit ids and money only.
"""
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import cubby
import ops_market
import ops_rate_mgmt

WORKERS = 5
# Cubby field -> our column. Only these are change-tracked.
TRACKED = {"standardRate": "standard_cents", "webRate": "web_cents",
           "walkInRate": "walk_in_cents", "strikethroughRate": "strike_cents"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _int(v):
    try:
        return None if v is None or v == "" else int(v)
    except (TypeError, ValueError):
        return None


def _float(v):
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


# ── Pure ──────────────────────────────────────────────────────────────────────

def climate_of(group: dict):
    """True / False when Cubby's features (or the name) say whether a group is
    climate controlled, None when nothing says."""
    feats = [str(f).strip().lower() for f in (group.get("features") or [])]
    if any(f.startswith("not climate") or f.startswith("non climate") or f.startswith("non-climate") for f in feats):
        return False
    if any("climate controlled" in f or f == "climate control" for f in feats):
        return True
    if group.get("parking") or group.get("vehicleStorage"):
        return False
    return ops_market.unit_climate(group.get("name"))


def group_values(g: dict) -> dict:
    """A Cubby pricing group as our row's column values."""
    w, d = _float(g.get("width")), _float(g.get("depth"))
    return {
        "pricing_group_id": str(g.get("pricingGroupId") or ""),
        "name": (g.get("name") or "").strip(),
        "width": w, "depth": d, "area": _float(g.get("area")) or round(w * d, 1),
        "parking": bool(g.get("parking")), "vehicle_storage": bool(g.get("vehicleStorage")),
        "climate": climate_of(g),
        "standard_cents": _int(g.get("standardRate")), "web_cents": _int(g.get("webRate")),
        "walk_in_cents": _int(g.get("walkInRate")), "strike_cents": _int(g.get("strikethroughRate")),
        "value_pricing_id": str(g.get("valuePricingStrategyId") or ""),
        "value_pricing_status": str(g.get("valuePricingStatus") or ""),
        "available_units": _int(g.get("availableUnits")) or 0,
        "rentable_units": _int(g.get("rentableUnits")) or 0,
        "discount_ids": [str(x) for x in (g.get("discounts") or []) if x],
        "features": [str(x) for x in (g.get("features") or [])][:40],
    }


def rate_changes(old: dict | None, new: dict) -> list[tuple[str, int | None, int | None]]:
    """[(Cubby field, old cents, new cents)] for every tracked rate that moved.
    A group seen for the first time has no "before" - nothing to record."""
    if old is None:
        return []
    out = []
    for field, col in TRACKED.items():
        if old.get(col) != new.get(col):
            out.append((field, old.get(col), new.get(col)))
    return out


def rent_change_plan(existing: dict[str, dict], leases: list[dict], today_s: str) -> tuple[list[dict], dict[str, dict]]:
    """(rows to add, {id: changed fields}) for the scheduled rent changes.

    existing  {id: {"status", "new_cents", "effective_date"}} stored rows for one facility
    leases    the facility's leases as cubby_sync keeps them (data dicts)

    A lease with rentChangeScheduledDate + rentChangeNewRentAmount is a
    scheduled change. A stored `scheduled` row that is no longer on any lease
    becomes `applied` once its date has come, else `canceled`. Nothing is
    returned for a row that did not change."""
    seen, adds, updates = set(), [], {}
    for le in leases:
        when = str(le.get("rentChangeScheduledDate") or "")[:10]
        new = _int(le.get("rentChangeNewRentAmount"))
        lid = str(le.get("leaseId") or "")
        mo = str(le.get("moveOutDate") or "")[:10]
        if not (when and new is not None and lid) or (mo and mo <= today_s):
            continue
        rid = f"{le.get('facilityId') or ''}:{lid}:{when}"
        seen.add(rid)
        # Cubby may keep the scheduled date on the lease after it passes.
        status = "applied" if when <= today_s else "scheduled"
        cur = existing.get(rid)
        if cur is None:
            adds.append({"id": rid, "lease_id": lid, "unit_id": str(le.get("unitId") or ""),
                         "pricing_group_id": str(le.get("pricingGroupId") or ""),
                         "old_cents": _int(le.get("monthlyRentalAmount")) or 0, "new_cents": new,
                         "effective_date": when, "status": status})
        elif cur.get("new_cents") != new or cur.get("status") != status:
            updates[rid] = {"new_cents": new, "status": status}
    for rid, cur in existing.items():
        if rid in seen or cur.get("status") != "scheduled":
            continue
        updates[rid] = {"status": "applied" if (cur.get("effective_date") or "9") <= today_s else "canceled"}
    return adds, updates


# ── Cubby (blocking I/O, read only) ──────────────────────────────────────────

def pull(facility_id: str) -> dict:
    """One facility's pricing groups with their discounts and value pricing
    strategies. A `*/search` through ops_rate_mgmt._call - the read-only door."""
    return ops_rate_mgmt._call("pricing-groups/search", {
        "where": {"facilityId": facility_id}, "expansions": ["discounts", "valuePricingStrategies"]})


# ── Write ─────────────────────────────────────────────────────────────────────

def write_groups(db, facility_id: str, groups: list[dict], stamp: str, local_day: str) -> dict:
    """Upsert one facility's pricing groups, recording each rate that moved.
    Groups Cubby no longer lists turn inactive (one `active` history row).
    The caller commits. Returns counts."""
    import models as m
    stored = {r.pricing_group_id: r for r in db.query(m.CubbyPricingGroup).filter(m.CubbyPricingGroup.facility_id == facility_id).all()}
    changes = 0
    live = set()

    def history(row, field, old, new):
        db.add(m.CubbyRateHistory(id=str(uuid.uuid4()), facility_id=facility_id, pricing_group_id=row.pricing_group_id,
                                  group_name=row.name or "", field=field, old_value=old, new_value=new,
                                  changed_at=stamp, changed_on=local_day))

    for g in groups:
        vals = group_values(g)
        gid = vals["pricing_group_id"]
        if not gid or gid in live:
            continue
        live.add(gid)
        row = stored.get(gid)
        before = None if row is None else {col: getattr(row, col) for col in TRACKED.values()}
        if row is None:
            row = m.CubbyPricingGroup(id=f"{facility_id}:{gid}", facility_id=facility_id, first_seen_at=stamp, last_changed_at="")
            db.add(row)
        elif row.active is False:
            history(row, "active", 0, 1)
            changes += 1
        for k, v in vals.items():
            setattr(row, k, v)
        moved = rate_changes(before, vals)
        for field, old, new in moved:
            history(row, field, old, new)
        if moved:
            row.last_changed_at = stamp
            changes += len(moved)
        row.active = True
        row.synced_at = stamp
    for gid, row in stored.items():
        if gid not in live and row.active is not False:
            row.active = False
            row.synced_at = stamp
            history(row, "active", 1, 0)
            changes += 1
    return {"groups": len(live), "changes": changes}


def write_discounts(db, discounts: dict[str, dict], facilities_of: dict[str, set], stamp: str, complete: bool) -> int:
    """Upsert the discounts seen this run. When every facility was read
    (`complete`), a discount Cubby no longer returns is removed - the table is
    Cubby's current list, not a history."""
    import models as m
    for did, d in discounts.items():
        row = db.get(m.CubbyDiscount, did) or m.CubbyDiscount(discount_id=did)
        if row not in db:
            db.add(row)
        row.name = (d.get("name") or "").strip()
        row.type = d.get("type") or ""
        row.status = d.get("status") or ""
        row.active = d.get("active") is not False
        row.application_method = d.get("applicationMethod") or ""
        row.amount_cents = _int(d.get("applicationAmount"))
        pct = d.get("applicationPercentage")
        row.percentage = float(pct) if isinstance(pct, (int, float)) else None
        row.start_after_months = _int(d.get("startAfterMonths"))
        row.discounted_months = _int(d.get("discountedMonths"))
        row.pricing_groups = [{"pricingGroupId": str(p.get("pricingGroupId") or ""), "name": (p.get("name") or "").strip(),
                               "visibility": p.get("visibility") or ""} for p in (d.get("pricingGroups") or [])]
        row.facility_ids = sorted(facilities_of.get(did, set()))
        row.synced_at = stamp
    if complete:
        q = db.query(m.CubbyDiscount)
        if discounts:
            q = q.filter(m.CubbyDiscount.discount_id.notin_(list(discounts)))
        q.delete(synchronize_session=False)
    return len(discounts)


def write_strategies(db, strategies: dict[str, dict], stamp: str, complete: bool) -> int:
    import models as m
    for sid, s in strategies.items():
        row = db.get(m.CubbyValuePricingStrategy, sid) or m.CubbyValuePricingStrategy(strategy_id=sid)
        if row not in db:
            db.add(row)
        row.name = (s.get("name") or "").strip()
        row.tiers = list(s.get("tiers") or [])
        row.synced_at = stamp
    if complete:
        q = db.query(m.CubbyValuePricingStrategy)
        if strategies:
            q = q.filter(m.CubbyValuePricingStrategy.strategy_id.notin_(list(strategies)))
        q.delete(synchronize_session=False)
    return len(strategies)


def track_rent_changes(db, facility_id: str, today_s: str, stamp: str) -> dict:
    """Bring cubby_rent_changes up to date from the leases cubby_sync just
    wrote for this facility. The caller commits."""
    import models as m
    leases = [{**(r.data or {}), "facilityId": facility_id}
              for r in db.query(m.CubbyRental).filter(m.CubbyRental.facility_id == facility_id).all()]
    rows = {r.id: r for r in db.query(m.CubbyRentChange).filter(m.CubbyRentChange.facility_id == facility_id).all()}
    existing = {rid: {"status": r.status, "new_cents": r.new_cents, "effective_date": r.effective_date} for rid, r in rows.items()}
    adds, updates = rent_change_plan(existing, leases, today_s)
    for a in adds:
        db.add(m.CubbyRentChange(facility_id=facility_id, first_seen_at=stamp, updated_at=stamp, **a))
    for rid, fields in updates.items():
        for k, v in fields.items():
            setattr(rows[rid], k, v)
        rows[rid].updated_at = stamp
    return {"added": len(adds), "updated": len(updates)}


# ── The run (called from cubby_sync.run_claimed, already in a thread) ────────

def sync(facilities: list[dict]) -> dict[str, str]:
    """Read and store pricing for the given Cubby facilities (dicts with
    facilityId and timeZone). Blocking. Returns {facility_id: "ok" | error}.
    A facility that fails keeps its previous rows."""
    from database import SessionLocal
    out: dict[str, str] = {}
    if not facilities or not cubby.configured():
        return out

    def one(f):
        try:
            return f, pull(f["facilityId"]), None
        except cubby.CubbyError as e:
            return f, None, f"pricing groups: {e.message}"[:300]
        except Exception as e:  # noqa: BLE001 - one facility's failure is not the run's
            return f, None, f"pricing groups: {type(e).__name__}"

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        got = list(pool.map(one, facilities))

    stamp = _now()
    discounts: dict[str, dict] = {}
    facilities_of: dict[str, set] = {}
    strategies: dict[str, dict] = {}
    for f, data, err in got:
        fid = f["facilityId"]
        if err:
            out[fid] = err
            continue
        today_s = cubby._facility_today(f).isoformat()
        db = SessionLocal()
        try:
            write_groups(db, fid, data.get("pricingGroups") or [], stamp, today_s)
            track_rent_changes(db, fid, today_s, stamp)
            db.commit()
            out[fid] = "ok"
        except Exception as e:  # noqa: BLE001 - this facility keeps its previous rows
            db.rollback()
            out[fid] = f"saving pricing: {type(e).__name__}"
            continue
        finally:
            db.close()
        for d in data.get("discounts") or []:
            did = str(d.get("discountId") or "")
            if did:
                discounts[did] = d
                facilities_of.setdefault(did, set()).add(fid)
        for s in data.get("valuePricingStrategies") or []:
            sid = str(s.get("valuePricingStrategyId") or "")
            if sid:
                strategies[sid] = s
    complete = all(v == "ok" for v in out.values())
    if any(v == "ok" for v in out.values()):
        db = SessionLocal()
        try:
            write_discounts(db, discounts, facilities_of, stamp, complete)
            write_strategies(db, strategies, stamp, complete)
            db.commit()
        except Exception as e:  # noqa: BLE001
            db.rollback()
            print(f"[cubby-pricing] discounts not saved: {type(e).__name__}")
        finally:
            db.close()
    ok = sum(1 for v in out.values() if v == "ok")
    print(f"[cubby-pricing] {ok} of {len(out)} facilities")
    return out
