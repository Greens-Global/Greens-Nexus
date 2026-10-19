"""Third-party managed properties: saving the reports and reading them back
(Operations, Oct 20 2026 - Neil's Ops call; docs/Third-Party-Properties.md).

  * preview(...) / save(...)   an uploaded SRE Summary, Daily Flash or rent roll
                               -> validation preview -> upsert (property + month,
                               property + day, property + as-of day).
  * ops_facilities(db)         one block per third-party store in the SAME shape
                               cubby.summarize_facility gives a Cubby facility,
                               so the Operations screen's arithmetic
                               (frontend/src/operations/model.js `combine`)
                               adds them in unchanged. Plus a `thirdParty` block:
                               who manages it, Data as of, the Daily Flash
                               revenue table and the SRE months.
  * rent_roll_live(model)      the Site Model's occupancy from the newest
                               uploaded rent roll (site_models.with_live).

Blocking (database) throughout: call from a plain `def` endpoint or through
asyncio.to_thread (CLAUDE.md).
"""
from __future__ import annotations

import re
import uuid
from calendar import monthrange
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import third_party_parse as tpp
from third_party_models import (ThirdPartyFlashDay, ThirdPartyImport, ThirdPartyProperty, ThirdPartyRentRoll,
                                ThirdPartySreMonth)

SOURCES = {"cubesmart": {"label": "CubeSmart", "managed": "CubeSmart Managed"}}

# The three Texas stores CubeSmart runs for Greens (store numbers from the
# Financials workbooks and the Site Models). Seeded on first read; the site
# model ids match backend/site_models/<id>.json.
SEED = (
    {"id": "cubesmart-6992", "source": "cubesmart", "store_number": "6992", "name": "Greens Storage Austin",
     "short_name": "Austin", "site_model_id": "greens-storage-austin"},
    {"id": "cubesmart-4568", "source": "cubesmart", "store_number": "4568", "name": "Greens Storage Sachse",
     "short_name": "Sachse", "site_model_id": "greens-storage-sachse"},
    {"id": "cubesmart-6093", "source": "cubesmart", "store_number": "6093", "name": "Greens Storage Georgetown",
     "short_name": "Georgetown", "site_model_id": "greens-storage-georgetown"},
)
STALE_AFTER_DAYS = 2        # a Daily Flash older than this is flagged on screen
HISTORY_MONTHS = 36


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def us_date(iso: str) -> str:
    """YYYY-MM-DD -> MM/DD/YYYY (CLAUDE.md: never show a raw ISO date)."""
    return f"{iso[5:7]}/{iso[8:10]}/{iso[:4]}" if len(iso or "") >= 10 else ""


def cents(dollars: Optional[float]) -> int:
    return int(round((dollars or 0) * 100))


# ── Properties ───────────────────────────────────────────────────────────────

def ensure_seeded(db: Session) -> None:
    have = {(p.source, p.store_number) for p in db.query(ThirdPartyProperty.source, ThirdPartyProperty.store_number).all()}
    added = False
    for s in SEED:
        if (s["source"], s["store_number"]) in have:
            continue
        now = _now()
        db.add(ThirdPartyProperty(**s, time_zone="America/Chicago", fetch_enabled=False, enabled=True,
                                  property_asset_id="", created_at=now, updated_at=now))
        added = True
    if added:
        try:
            db.commit()
        except IntegrityError:      # another worker seeded at the same moment
            db.rollback()


def properties(db: Session, include_disabled: bool = False) -> List[ThirdPartyProperty]:
    ensure_seeded(db)
    q = db.query(ThirdPartyProperty)
    if not include_disabled:
        q = q.filter(ThirdPartyProperty.enabled.is_(True))
    return q.order_by(ThirdPartyProperty.source, ThirdPartyProperty.short_name).all()


def property_json(p: ThirdPartyProperty) -> Dict[str, Any]:
    src = SOURCES.get(p.source, {"label": p.source.title(), "managed": f"{p.source.title()} Managed"})
    return {"id": p.id, "source": p.source, "sourceLabel": src["label"], "managedLabel": src["managed"],
            "storeNumber": p.store_number, "name": p.name, "shortName": p.short_name,
            "siteModelId": p.site_model_id or "", "propertyAssetId": p.property_asset_id or "",
            "fetchEnabled": bool(p.fetch_enabled), "enabled": bool(p.enabled)}


# ── Upload: preview, then save ───────────────────────────────────────────────

_SRE_COLS = [c.name for c in ThirdPartySreMonth.__table__.columns
             if c.name not in ("id", "property_id", "month", "extra", "import_id", "updated_at")]
_FLASH_COLS = [c.name for c in ThirdPartyFlashDay.__table__.columns
               if c.name not in ("id", "property_id", "day", "extra", "import_id", "updated_at")]


def _resolve(db: Session, props: List[ThirdPartyProperty], file_store: str, property_id: str):
    """The property a block of the file belongs to: the store number the file
    names, checked against the one picked on the form (when both are given)."""
    picked = next((p for p in props if p.id == property_id), None) if property_id else None
    if file_store:
        by_store = next((p for p in props if p.store_number == file_store), None)
        if picked and by_store and picked.id != by_store.id:
            return None, f"The file is for store {file_store} ({by_store.short_name}), not {picked.short_name}."
        if by_store:
            return by_store, None
        if picked:
            return None, f"The file is for store {file_store}, which is not {picked.short_name} (store {picked.store_number})."
        return None, f"Store {file_store} is not a third-party property in Nexus."
    if picked:
        return picked, None
    return None, "The file does not name its store. Pick the property and upload again."


def build_preview(db: Session, raw: bytes, file_name: str, kind: str = "auto", property_id: str = "",
                  as_of: str = "") -> Dict[str, Any]:
    """Parse and validate without saving. Everything `save` will write is in
    `rows`; `errors` non-empty means Save is refused."""
    sheets = tpp.read_sheets(raw, file_name)
    if kind in ("", "auto"):
        kind = tpp.detect_kind(sheets) or ""
        if not kind:
            raise tpp.ParseError("Nexus could not tell which report this is. Pick SRE Summary, Daily Flash or Rent Roll and upload again.")
    if kind not in tpp.KINDS:
        raise tpp.ParseError("Unknown report type.")
    as_of = tpp.day_of(as_of) or "" if as_of else ""
    props = properties(db)
    out: Dict[str, Any] = {"kind": kind, "fileName": (file_name or "")[:200], "rows": [], "warnings": [], "errors": [],
                           "unknownLabels": [], "properties": []}
    targets: Dict[str, ThirdPartyProperty] = {}

    def target(file_store: str):
        p, err = _resolve(db, props, file_store, property_id)
        if err:
            if err not in out["errors"]:
                out["errors"].append(err)
            return None
        targets[p.id] = p
        return p

    if kind == "sre":
        got = tpp.parse_sre(sheets)
        out["unknownLabels"] = got["unknown"]
        for store, months in got["stores"].items():
            p = target(store)
            if not p:
                continue
            have = {r.month for r in db.query(ThirdPartySreMonth.month).filter(ThirdPartySreMonth.property_id == p.id).all()}
            for m in sorted(months, reverse=True):
                vals = months[m]
                extra = (got["extras"].get(store) or {}).get(m) or {}
                out["rows"].append({"propertyId": p.id, "property": p.short_name, "period": m, "values": vals,
                                    "extra": extra, "replaces": m in have})
                if vals.get("total_cubes_avail") and vals.get("cubes_occ_eom", 0) > vals["total_cubes_avail"]:
                    out["warnings"].append(f"{p.short_name} {m[5:7]}/{m[:4]}: more cubes occupied than available.")
                rd, vc, nr = vals.get("rented_during_month"), vals.get("vacated_during_month"), vals.get("net_rentals")
                if None not in (rd, vc, nr) and rd - vc != nr:
                    out["warnings"].append(f"{p.short_name} {m[5:7]}/{m[:4]}: Net Rentals ({nr}) is not Rented minus Vacated ({rd - vc}).")
    elif kind == "flash":
        got = tpp.parse_flash(sheets, default_day=as_of or None)
        out["unknownLabels"] = got["unknown"]
        for store, days in got["stores"].items():
            p = target(store)
            if not p:
                continue
            have = {r.day for r in db.query(ThirdPartyFlashDay.day).filter(ThirdPartyFlashDay.property_id == p.id).all()}
            for d in sorted(days, reverse=True):
                vals = days[d]
                out["rows"].append({"propertyId": p.id, "property": p.short_name, "period": d, "values": vals,
                                    "extra": {}, "replaces": d in have})
                parts = [vals.get(f"{s}_cubes") for s in ("occupied", "vacant", "reserved", "damaged", "unrentable")]
                if vals.get("total_cubes") and all(x is not None for x in parts) and sum(parts) != vals["total_cubes"]:
                    out["warnings"].append(f"{p.short_name} {us_date(d)}: occupancy by status adds to {sum(parts)}, not the {vals['total_cubes']} total.")
                if d > date.today().isoformat():
                    out["errors"].append(f"{p.short_name}: the Daily Flash is dated {us_date(d)}, which is in the future.")
    else:
        store_hint = next((p.store_number for p in props if p.id == property_id), "") if property_id else ""
        got = tpp.parse_rent_roll(sheets, store=store_hint)
        day = as_of or got["asOf"] or _date_in_name(file_name)
        if not day:
            out["errors"].append("The rent roll does not say which day it is for. Pick the As Of date and upload again.")
        if got["bad"]:
            out["warnings"].append(f"{got['bad']} rows were skipped: their Cube or Cube Dimensions did not look like a unit "
                                   "(check the export's columns).")
        for store, units in got["stores"].items():
            p = target(store)
            if not p or not day:
                continue
            have = db.query(ThirdPartyRentRoll.id).filter(ThirdPartyRentRoll.property_id == p.id, ThirdPartyRentRoll.as_of == day).first()
            dupes = len(units) - len({u["n"] for u in units})
            if dupes:
                out["warnings"].append(f"{p.short_name}: {dupes} units are listed twice; each is counted once.")
            out["rows"].append({"propertyId": p.id, "property": p.short_name, "period": day,
                                "values": {"rentedUnits": len({u['n'] for u in units})}, "units": units,
                                "extra": {}, "replaces": bool(have)})
    if not out["rows"] and not out["errors"]:
        out["errors"].append("No figures were found in this file.")
    out["properties"] = [property_json(p) for p in targets.values()]
    return out


def _date_in_name(name: str) -> Optional[str]:
    m = re.search(r"(\d{4})[-_](\d{2})[-_](\d{2})", name or "")
    if m:
        return tpp.day_of(f"{m.group(1)}-{m.group(2)}-{m.group(3)}")
    m = re.search(r"(\d{2})[-_.](\d{2})[-_.](\d{4})", name or "")
    return tpp.day_of(f"{m.group(1)}/{m.group(2)}/{m.group(3)}") if m else None


def save(db: Session, preview: Dict[str, Any], by: str, via: str = "upload") -> Dict[str, Any]:
    """Upsert every previewed row: one row per property + month (SRE), property
    + day (Daily Flash) or property + as-of day (rent roll). Rows locked while
    they are replaced so two uploads of the same file cannot both insert."""
    if preview.get("errors"):
        raise tpp.ParseError(preview["errors"][0])
    kind = preview["kind"]
    now = _now()
    saved: Dict[str, int] = {}
    imports: Dict[str, str] = {}
    for r in preview["rows"]:
        pid = r["propertyId"]
        if pid not in imports:
            imports[pid] = str(uuid.uuid4())
        imp = imports[pid]
        if kind == "sre":
            row = (db.query(ThirdPartySreMonth).filter(ThirdPartySreMonth.property_id == pid, ThirdPartySreMonth.month == r["period"])
                   .with_for_update().first())
            if row is None:
                row = ThirdPartySreMonth(id=str(uuid.uuid4()), property_id=pid, month=r["period"])
                db.add(row)
            for c in _SRE_COLS:
                if c in r["values"]:
                    setattr(row, c, r["values"][c])
            row.extra = {**(row.extra or {}), **(r.get("extra") or {})}
        elif kind == "flash":
            row = (db.query(ThirdPartyFlashDay).filter(ThirdPartyFlashDay.property_id == pid, ThirdPartyFlashDay.day == r["period"])
                   .with_for_update().first())
            if row is None:
                row = ThirdPartyFlashDay(id=str(uuid.uuid4()), property_id=pid, day=r["period"])
                db.add(row)
            for c in _FLASH_COLS:
                if c in r["values"]:
                    setattr(row, c, r["values"][c])
        else:
            row = (db.query(ThirdPartyRentRoll).filter(ThirdPartyRentRoll.property_id == pid, ThirdPartyRentRoll.as_of == r["period"])
                   .with_for_update().first())
            if row is None:
                row = ThirdPartyRentRoll(id=str(uuid.uuid4()), property_id=pid, as_of=r["period"])
                db.add(row)
            seen, units = set(), []
            for u in r.get("units") or []:
                if u["n"] not in seen:
                    seen.add(u["n"])
                    units.append({"n": u["n"], "size": u["size"], "attr": u.get("attr", "")})
            row.units, row.unit_count = units, len(units)
        row.import_id, row.updated_at = imp, now
        saved[pid] = saved.get(pid, 0) + 1
    for pid, imp in imports.items():
        db.add(ThirdPartyImport(id=imp, property_id=pid, kind=kind, via=via, file_name=preview.get("fileName", "")[:200],
                                rows=saved.get(pid, 0), status="ok", error="", created_by=by or "", created_at=now))
    db.commit()
    return {"savedRows": sum(saved.values()), "byProperty": saved}


# ── The Operations screen ────────────────────────────────────────────────────

def _month_last_day(ym: str) -> str:
    y, m = int(ym[:4]), int(ym[5:7])
    return f"{ym}-{monthrange(y, m)[1]:02d}"


def _empty_block() -> Dict[str, Any]:
    return {
        "lat": None, "lng": None,
        "units": {"total": 0, "rented": 0, "vacant": 0, "unavailable": 0},
        "area": {"total": 0, "rented": 0},
        "rent": {"rentRoll": 0, "streetRented": 0, "vacantPotential": 0, "belowStreetGap": 0, "belowStreetCount": 0},
        "autoPay": 0, "protected": 0,
        "pastDue": {"total": 0, "tenants": 0, "buckets": {"d0_30": 0, "d30_60": 0, "d60_90": 0, "d90_120": 0, "d120_plus": 0, "unknown": 0}, "rows": []},
        "locks": {"toPlace": [], "toRemove": [], "applied": 0},
        "history": [],
        "moves": {"insMtd": 0, "outsMtd": 0, "movingOut": [], "movingIn": [], "daily": []},
        "rentChanges": {"count": 0, "lift": 0},
        "unitTypes": [], "belowStreet": [], "offMarket": [],
        "leads": {"total": 0, "open": 0, "reserved": 0, "converted": 0, "byStatus": {}, "rows": []},
        "tasks": {"open": 0, "overdue": 0, "rows": []},
        "payments": {"collectedMtd": 0, "daily": [], "failed": []},
    }


def _daily_moves(flash: List[ThirdPartyFlashDay], sre: List[ThirdPartySreMonth]) -> List[Dict[str, Any]]:
    """Move-ins / move-outs per day for the period selector. A Daily Flash
    carries month-to-date counts, so a day's figure is its MTD less the last
    loaded day's in the same month (all of the month so far when it is the
    first one loaded). A month with no Daily Flash takes its SRE totals on the
    month's last day."""
    out: Dict[str, List[int]] = {}
    prev: Dict[str, ThirdPartyFlashDay] = {}
    for f in sorted(flash, key=lambda x: x.day):
        ym = f.day[:7]
        p = prev.get(ym)
        if f.move_ins_mtd is not None or f.move_outs_mtd is not None:
            ins = (f.move_ins_mtd or 0) - ((p.move_ins_mtd or 0) if p else 0)
            outs = (f.move_outs_mtd or 0) - ((p.move_outs_mtd or 0) if p else 0)
        else:
            ins, outs = f.move_ins_day or 0, f.move_outs_day or 0
        out[f.day] = [max(0, ins), max(0, outs)]
        prev[ym] = f
    flash_months = {f.day[:7] for f in flash}
    for s in sre:
        if s.month in flash_months:
            continue
        d = min(_month_last_day(s.month), date.today().isoformat())
        out.setdefault(d, [0, 0])
        out[d][0] += s.rented_during_month or 0
        out[d][1] += s.vacated_during_month or 0
    return [{"date": d, "ins": v[0], "outs": v[1]} for d, v in sorted(out.items())]


def facility_block(p: ThirdPartyProperty, sre: List[ThirdPartySreMonth], flash: List[ThirdPartyFlashDay],
                   roll: Optional[ThirdPartyRentRoll], last_import: Optional[ThirdPartyImport] = None,
                   today: Optional[date] = None) -> Dict[str, Any]:
    """A third-party store in cubby.summarize_facility's shape, from the
    uploaded reports. Money is integer cents, like Cubby's."""
    today = today or date.today()
    sre = sorted(sre, key=lambda s: s.month)
    flash = sorted(flash, key=lambda f: f.day)
    fl = flash[-1] if flash else None
    latest_sre = sre[-1] if sre else None
    b = _empty_block()

    if fl and (fl.total_cubes or fl.occupied_cubes):
        held = (fl.reserved_cubes or 0) + (fl.damaged_cubes or 0) + (fl.unrentable_cubes or 0)
        total = fl.total_cubes or ((fl.occupied_cubes or 0) + (fl.vacant_cubes or 0) + held)
        b["units"] = {"total": total, "rented": fl.occupied_cubes or 0, "vacant": fl.vacant_cubes or 0, "unavailable": held}
        b["area"] = {"total": fl.total_sqft or 0, "rented": fl.occupied_sqft or 0}
    elif latest_sre and latest_sre.total_cubes_avail:
        total, rented, maint = latest_sre.total_cubes_avail, latest_sre.cubes_occ_eom or 0, latest_sre.total_maint_cubes or 0
        b["units"] = {"total": total, "rented": rented, "vacant": max(0, total - rented - maint), "unavailable": maint}

    # Monthly rent: the newest COMPLETE month's rental revenue from the SRE;
    # before one is loaded, the Daily Flash's accrued rent month to date.
    this_month = (fl.day[:7] if fl else today.isoformat()[:7])
    done = [s for s in sre if s.month < this_month and s.rental_revenue is not None]
    if done:
        b["rent"]["rentRoll"] = cents(done[-1].rental_revenue)
    elif fl and fl.accrued_rent_mtd is not None:
        b["rent"]["rentRoll"] = cents(fl.accrued_rent_mtd)

    ar = next((s for s in reversed(sre) if s.ar_total is not None or s.ar_0_30 is not None), None)
    if ar:
        bk = {"d0_30": cents(ar.ar_0_30), "d30_60": cents(ar.ar_31_60), "d60_90": cents(ar.ar_61_90),
              "d90_120": cents(ar.ar_91_plus), "d120_plus": 0, "unknown": 0}
        total = cents(ar.ar_total) if ar.ar_total is not None else sum(bk.values())
        bk["unknown"] = max(0, total - sum(bk.values()))
        b["pastDue"] = {"total": total, "tenants": 0, "buckets": bk, "rows": []}

    hist = {s.month: {"month": s.month, "moveIns": s.rented_during_month or 0, "moveOuts": s.vacated_during_month or 0,
                      "rented": s.cubes_occ_eom or 0} for s in sre}
    if fl and fl.day[:7] not in hist:
        hist[fl.day[:7]] = {"month": fl.day[:7], "moveIns": fl.move_ins_mtd or 0, "moveOuts": fl.move_outs_mtd or 0,
                            "rented": fl.occupied_cubes or 0}
    b["history"] = [hist[k] for k in sorted(hist)][-HISTORY_MONTHS:]

    if fl:
        b["moves"]["insMtd"], b["moves"]["outsMtd"] = fl.move_ins_mtd or 0, fl.move_outs_mtd or 0
    elif latest_sre:
        b["moves"]["insMtd"], b["moves"]["outsMtd"] = latest_sre.rented_during_month or 0, latest_sre.vacated_during_month or 0
    b["moves"]["daily"] = _daily_moves(flash, sre)

    # Data as of: the newest Daily Flash; else the end of the newest SRE month
    # (or today, for the month in progress).
    if fl:
        as_of = fl.day
    elif latest_sre:
        as_of = min(_month_last_day(latest_sre.month), today.isoformat())
    else:
        as_of = ""
    stale = (not as_of) or (today - date.fromisoformat(as_of)).days > STALE_AFTER_DAYS
    src = SOURCES.get(p.source, {"label": p.source.title(), "managed": f"{p.source.title()} Managed"})

    def trio(prefix):
        return {"mtd": cents(getattr(fl, f"{prefix}_mtd")) if getattr(fl, f"{prefix}_mtd") is not None else None,
                "budget": cents(getattr(fl, f"{prefix}_budget")) if getattr(fl, f"{prefix}_budget") is not None else None,
                "py": cents(getattr(fl, f"{prefix}_py")) if getattr(fl, f"{prefix}_py") is not None else None}

    flash_json = None
    if fl:
        flash_json = {
            "day": fl.day,
            "revenue": [{"key": k, "label": label, **trio(k)} for k, label in (
                ("accrued_rent", "Accrued Rent"), ("fees", "Fees"), ("insurance", "Insurance"), ("merchandise", "Merchandise"),
                ("revenue", "Total Revenue"), ("discount", "Discount"), ("write_offs", "Write Offs"), ("net_revenue", "Net Revenue"))],
            "occupancy": [{"key": k, "label": label, "cubes": getattr(fl, f"{k}_cubes"), "sqft": getattr(fl, f"{k}_sqft")}
                          for k, label in (("occupied", "Occupied"), ("vacant", "Vacant"), ("reserved", "Reserved"),
                                           ("damaged", "Damaged"), ("unrentable", "Unrentable"), ("total", "Totals"))],
            "moves": {k: getattr(fl, k) for k in ("move_ins_day", "move_ins_day_budget", "move_ins_mtd", "move_ins_mtd_budget",
                                                  "move_ins_mtd_py", "move_outs_day", "move_outs_day_budget", "move_outs_mtd",
                                                  "move_outs_mtd_budget", "move_outs_mtd_py")},
        }
    sre_json = [{
        "month": s.month, "totalCubesAvail": s.total_cubes_avail, "rented": s.rented_during_month,
        "vacated": s.vacated_during_month, "netRentals": s.net_rentals, "occupiedEom": s.cubes_occ_eom,
        "pctRentedCube": s.pct_rented_cube, "pctRentedSqft": s.pct_rented_sqft, "losDays": s.los_days,
        "losMonths": s.los_months, "losValue": cents(s.los_value) if s.los_value is not None else None,
        "rentalRevenue": cents(s.rental_revenue) if s.rental_revenue is not None else None,
        "totalRevenue": cents(s.total_revenue) if s.total_revenue is not None else None,
        "promoDiscounts": cents(s.promo_discounts) if s.promo_discounts is not None else None,
        "promoMoveIns": s.promo_move_ins, "writeOffs": cents(s.write_offs) if s.write_offs is not None else None,
        "arTotal": cents(s.ar_total) if s.ar_total is not None else None,
    } for s in reversed(sre[-13:])]

    return {
        **b,
        "id": f"tp:{p.id}", "name": p.name, "shortName": p.short_name, "asOf": as_of or today.isoformat(),
        "syncedAt": (last_import.created_at if last_import else ""),
        "managedBy": p.source, "managedLabel": src["managed"],
        "thirdParty": {
            "propertyId": p.id, "source": p.source, "sourceLabel": src["label"], "label": src["managed"],
            "storeNumber": p.store_number, "siteModelId": p.site_model_id or "", "propertyAssetId": p.property_asset_id or "",
            "dataAsOf": as_of, "dataAsOfText": us_date(as_of) if as_of else "", "stale": stale,
            "flashAsOf": fl.day if fl else "", "sreThrough": latest_sre.month if latest_sre else "",
            "rentRollAsOf": roll.as_of if roll else "",
            "lastImport": ({"kind": last_import.kind, "via": last_import.via, "at": last_import.created_at,
                            "by": last_import.created_by} if last_import else None),
            "flash": flash_json, "sre": sre_json,
            # What this store cannot show: Nexus has the operator's reports, not its tenant ledger.
            "notAvailable": ["tenants", "payments", "leads", "tasks", "unitTypes"],
        },
    }


def ops_facilities(db: Session, today: Optional[date] = None) -> Dict[str, Any]:
    """{"facilities": [...]} - every enabled third-party store, with or without data."""
    out = []
    since = ((today or date.today()) - timedelta(days=430)).isoformat()
    for p in properties(db):
        sre = db.query(ThirdPartySreMonth).filter(ThirdPartySreMonth.property_id == p.id,
                                                  ThirdPartySreMonth.month >= since[:7]).all()
        flash = db.query(ThirdPartyFlashDay).filter(ThirdPartyFlashDay.property_id == p.id, ThirdPartyFlashDay.day >= since).all()
        roll = (db.query(ThirdPartyRentRoll.as_of).filter(ThirdPartyRentRoll.property_id == p.id)
                .order_by(ThirdPartyRentRoll.as_of.desc()).first())
        last = (db.query(ThirdPartyImport).filter(ThirdPartyImport.property_id == p.id, ThirdPartyImport.status == "ok")
                .order_by(ThirdPartyImport.created_at.desc()).first())
        out.append(facility_block(p, sre, flash, roll, last, today))
    return {"facilities": out, "sources": SOURCES}


# ── Site Model ───────────────────────────────────────────────────────────────

_NAME = re.compile(r"^(\d)(\d{3})(?:-(\d{2,4}))?([A-Z]?)$")


def _names(n: str) -> List[str]:
    """'1003-1004' -> ['1003-1004', '1003', '1004'] so a combined unit on the
    rent roll matches the model whichever way the model names it."""
    out = [n]
    m = _NAME.match(n)
    if m and m.group(3):
        a = int(m.group(1) + m.group(2))
        tail = m.group(3)
        b = int(str(a)[:len(str(a)) - len(tail)] + tail)
        if 0 < b - a <= 10:
            out += [f"{x}{m.group(4)}" for x in range(a, b + 1)]
    return out


def rent_roll_live(model: Dict[str, Any], db: Optional[Session] = None) -> Optional[Dict[str, Any]]:
    """The model with occupancy from the newest uploaded rent roll of the
    third-party store mapped to it, or None (no mapping, no upload, no table
    yet). Rented = on the rent roll; every other unit is vacant. Units on the
    roll the model does not have are listed as unplaced. Blocking."""
    pid = (model.get("property") or {}).get("id") or ""
    if not pid:
        return None
    own = db is None
    if own:
        from database import SessionLocal
        db = SessionLocal()
    try:
        p = (db.query(ThirdPartyProperty).filter(ThirdPartyProperty.site_model_id == pid, ThirdPartyProperty.enabled.is_(True)).first())
        if not p:
            return None
        roll = (db.query(ThirdPartyRentRoll).filter(ThirdPartyRentRoll.property_id == p.id)
                .order_by(ThirdPartyRentRoll.as_of.desc()).first())
        if not roll:
            return None
        rented: Dict[str, Dict[str, str]] = {}
        for u in roll.units or []:
            for name in _names(u["n"]):
                rented.setdefault(name, u)
        units, matched = [], set()
        for u in model.get("units", []):
            hit = rented.get(u["n"])
            if hit:
                matched.add(hit["n"])
            was_vacant = not u.get("l")
            units.append({**u, "l": 1 if hit else 0,
                          "dvac": (u.get("dvac") if (was_vacant and not hit) else (0 if hit else None))})
        unplaced = []
        for u in roll.units or []:
            if u["n"] in matched:
                continue
            w, d = (str(u.get("size") or "0X0").upper().split("X") + ["0"])[:2]
            attr = u.get("attr") or ""
            k = "ccdu" if attr[:1] == "C" and attr[1:2] == "O" else "cc" if attr[:1] == "C" else "du" if attr[1:2] == "O" else "in"
            try:
                wf, df = float(w or 0), float(d or 0)
            except ValueError:
                wf = df = 0.0
            unplaced.append({"n": u["n"], "w": wf, "d": df, "k": k, "l": 1, "r": 1, "why": "", "note": "", "group": ""})
        src = SOURCES.get(p.source, {"label": p.source.title()})
        live = {"source": "file", "enabled": False, "ok": True, "asOf": roll.as_of, "uploaded": True,
                "system": f"{src['label']} rent roll, {us_date(roll.as_of)}",
                "matched": len(matched), "unplaced": unplaced, "missing": []}
        return {**model, "units": units, "live": live}
    except Exception as e:  # noqa: BLE001 - a missing table (first deploy) keeps the built snapshot
        print(f"[third-party] rent roll overlay skipped: {type(e).__name__}")
        return None
    finally:
        if own:
            db.close()
