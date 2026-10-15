"""Cubby -> database sync (Operations, Oct 15 2026).

The Operations screen used to pull Cubby live and keep the answer in each
worker's memory: every worker pulled on its own, a cold worker made the first
reader wait on Cubby, a Cubby outage blanked the screen, and nothing older
than what Cubby returns was kept. Now this module copies what the screen uses
into the `cubby_*` tables (models.py) and cubby.py reads only from them - the
same shape as Accounting, where an ingest writes the source into the database.

  sync_all()   blocking; run it in a thread. cubby_snapshot_loop runs it every
               15 minutes on the deployed worker, Refresh starts one in the
               background (start_manual), and the first read on an empty
               database kicks one.

One transaction per facility: current-state sets (facility row, units with
their rent-roll line, tenancies, leads, receivables, open tasks, customer
names) are replaced whole; payments are incremental - the last PAYMENT_DAYS
days are read again every run so late changes (a decline, a returned debit)
land, and the first run backfills from PAYMENTS_START in month windows.
A facility that fails keeps its previous rows; the run is then `partial`.

One run at a time across every worker and instance: a `running` row in
cubby_sync_runs is the lock (a partial unique index allows only one). A
plain row, not an advisory lock, so it works through the Supabase pooler.
A run that never finished (the worker died) is closed as failed after
STALE_RUN_MIN.

Privacy: phone, email, address, date of birth and ID numbers are stripped
from every tenant row BEFORE it is written (`strip_pii`); a customer is kept
as id + name only. Error text keeps Cubby's message for a Cubby failure and
only the exception type for anything else (a database error can quote row
values), and never the key.
"""
import hashlib
import json
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

from sqlalchemy.exc import IntegrityError

import cubby

PAYMENTS_START = date(2026, 9, 15)   # Cubby has payments from this day on
PAYMENT_DAYS = 45                    # re-read window for late status changes
STALE_RUN_MIN = 30                   # a `running` row older than this is a dead run
MANUAL_GAP_SEC = 180                 # Refresh: at most one sync per 3 minutes
WORKERS = 10                         # Cubby calls in flight at once
NOT_CONFIGURED_EVERY_SEC = 3600      # a missing key is recorded at most this often
NOT_CONFIGURED = ("Cubby is not connected on this server yet. An administrator needs to set "
                  "CUBBY_API_KEY in the API's app settings.")

# A key that holds personal contact or identity data, matched as a substring of
# the lowercased key, so "billingAddress", "mobilePhone", "dateOfBirth",
# "driversLicenseNumber" and the like all go. None of the keys the screen
# reads contains one of these.
_PII = ("email", "phone", "mobile", "address", "birth", "dob", "ssn", "license", "licence",
        "passport", "identification", "idnumber", "nationalid", "taxid", "governmentid", "contact")

_FACILITY_KEYS = ("facilityId", "organizationId", "name", "internalName", "timeZone", "latitude", "longitude", "enabled")


def strip_pii(value):
    """A copy of a Cubby row without contact or identity fields, at any depth."""
    if isinstance(value, dict):
        return {k: strip_pii(v) for k, v in value.items()
                if not any(p in str(k).lower().replace("_", "") for p in _PII)}
    if isinstance(value, list):
        return [strip_pii(v) for v in value]
    return value


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(d: datetime) -> str:
    return d.isoformat()


def _rid(row: dict, key: str, *fallback: str) -> str:
    """The Cubby id of a row, or a stable hash of identifying fields when the
    row carries none (so a re-read replaces it instead of adding a copy)."""
    v = row.get(key)
    if v:
        return str(v)
    basis = json.dumps([row.get(k) for k in fallback], sort_keys=True, default=str)
    return "h" + hashlib.sha1(basis.encode()).hexdigest()[:20]


def payment_day(p: dict) -> str:
    return str(p.get("paymentDate") or p.get("createdAt") or "")[:10]


def month_windows(start: date, end: date) -> list[tuple[date, date]]:
    """[start, end] cut at month ends - one payments/search per window."""
    out = []
    a = start
    while a <= end:
        nxt = date(a.year + (a.month == 12), (a.month % 12) + 1, 1)
        b = min(nxt - timedelta(days=1), end)
        out.append((a, b))
        a = b + timedelta(days=1)
    return out


def payments_from(synced_through: str, today: date) -> date:
    """First payment day this run reads for a facility."""
    if not synced_through:
        return PAYMENTS_START
    try:
        last = date.fromisoformat(synced_through[:10])
    except ValueError:
        return PAYMENTS_START
    return max(PAYMENTS_START, min(last, today - timedelta(days=PAYMENT_DAYS)))


# ── The run lock ──────────────────────────────────────────────────────────────

def claim(trigger: str, requested_by: str = "") -> str | None:
    """Open a run (status running) and return its id, or None when another run
    is already going. Closes a dead run first."""
    import models
    from database import SessionLocal
    db = SessionLocal()
    try:
        cutoff = _iso(_now() - timedelta(minutes=STALE_RUN_MIN))
        for r in (db.query(models.CubbySyncRun)
                  .filter(models.CubbySyncRun.status == "running", models.CubbySyncRun.started_at < cutoff).all()):
            r.status, r.finished_at = "failed", _iso(_now())
            r.error = "Did not finish (the server restarted or the run took too long)"
        db.commit()
        rid = str(uuid.uuid4())
        db.add(models.CubbySyncRun(id=rid, trigger=trigger, requested_by=requested_by,
                                   started_at=_iso(_now()), status="running", facilities={}, error=""))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            return None
        return rid
    finally:
        db.close()


def _finish(run_id: str, status: str, facilities: dict, error: str = "") -> None:
    import models
    from database import SessionLocal
    db = SessionLocal()
    try:
        r = db.get(models.CubbySyncRun, run_id)
        if r is not None:
            r.status, r.finished_at, r.facilities, r.error = status, _iso(_now()), facilities, error[:2000]
            db.commit()
    finally:
        db.close()


def _run_json(r) -> dict | None:
    if r is None:
        return None
    return {"id": r.id, "status": r.status, "trigger": r.trigger, "startedAt": r.started_at,
            "finishedAt": r.finished_at, "error": r.error or "",
            "facilities": {k: {"name": v.get("name", ""), "status": v.get("status", "")}
                           for k, v in (r.facilities or {}).items()}}


def status() -> dict:
    """What the screen polls: is a run going, how the last one went, and when
    every facility was last synced. Blocking."""
    import models
    from database import SessionLocal
    db = SessionLocal()
    try:
        R = models.CubbySyncRun
        running = db.query(R).filter(R.status == "running").first()
        last = db.query(R).filter(R.status != "running").order_by(R.started_at.desc()).first()
        stamps = [f.synced_at for f in db.query(models.CubbyFacility).filter(models.CubbyFacility.enabled.is_(True)).all()]
        return {"running": running is not None, "current": _run_json(running), "last": _run_json(last),
                "configured": cubby.configured(),
                "syncedAt": min(stamps) if stamps and all(stamps) else ""}
    finally:
        db.close()


def record_not_configured() -> bool:
    """The sync loop found no CUBBY_API_KEY: leave a `not_configured` run row
    (GET /facility-ops/sync shows it) and one log line - at most once an hour,
    not every 15 minutes. True when a row was written. Blocking."""
    import models
    from database import SessionLocal
    db = SessionLocal()
    try:
        R = models.CubbySyncRun
        last = db.query(R).filter(R.status == "not_configured").order_by(R.started_at.desc()).first()
        if last is not None and last.started_at >= _iso(_now() - timedelta(seconds=NOT_CONFIGURED_EVERY_SEC)):
            return False
        stamp = _iso(_now())
        db.add(R(id=str(uuid.uuid4()), trigger="schedule", started_at=stamp, finished_at=stamp,
                 status="not_configured", facilities={}, error=NOT_CONFIGURED))
        db.commit()
    finally:
        db.close()
    print("[cubby] sync skipped: CUBBY_API_KEY is not set on this server - Operations keeps showing the last synced figures")
    return True


def start_manual(requested_by: str) -> tuple[str | None, str]:
    """Refresh: (run id, '') when a run was opened - the caller runs it in the
    background with run_claimed - or (None, 'running' | 'too-soon')."""
    import models
    from database import SessionLocal
    db = SessionLocal()
    try:
        R = models.CubbySyncRun
        if db.query(R).filter(R.status == "running").first() is not None:
            return None, "running"
        last = db.query(R).filter(R.status != "not_configured").order_by(R.started_at.desc()).first()
        if last is not None and last.started_at >= _iso(_now() - timedelta(seconds=MANUAL_GAP_SEC)):
            return None, "too-soon"
    finally:
        db.close()
    rid = claim("manual", requested_by)
    return (rid, "") if rid else (None, "running")


# ── Pull ──────────────────────────────────────────────────────────────────────

def _pull_all(facilities: list[dict], since: dict[str, date]) -> dict[str, dict]:
    """{facility_id: {"today", call name -> rows..., "payments", "payments_from"} | {"error": str}}.
    Every Cubby call for every facility, WORKERS at a time; a failing call
    fails only its own facility."""
    jobs = []
    out: dict[str, dict] = {}
    for f in facilities:
        fid = f["facilityId"]
        today = cubby._facility_today(f)
        out[fid] = {"today": today, "payments": [], "payments_from": since[fid]}
        calls = cubby._facility_calls(f, today)
        calls.pop("payments")
        for name, (path, where, key) in calls.items():
            jobs.append((fid, name, path, where, key))
        # Both bounds on every window (without either, Cubby answers with the last month only).
        for a, b in month_windows(since[fid], today):
            jobs.append((fid, "payments", "payments/search",
                         {"facilityId": fid, "paymentDateOnOrAfter": a.isoformat(), "paymentDateOnOrBefore": b.isoformat()},
                         "payments"))

    def call(job):
        fid, name, path, where, key = job
        try:
            return job, cubby._post(path, where).get(key, []), None
        except cubby.CubbyError as e:
            return job, None, f"{name}: {e.message}"[:300]
        except Exception as e:  # noqa: BLE001 - one bad call fails its facility, not the run
            return job, None, f"{name}: {type(e).__name__}"

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for (fid, name, *_), rows, err in pool.map(call, jobs):
            slot = out[fid]
            if err:
                slot.setdefault("errors", []).append(err)
            elif name == "payments":
                slot["payments"] += rows or []
            else:
                slot[name] = rows or []
    return out


# ── Write ─────────────────────────────────────────────────────────────────────

def _name(c: dict) -> str:
    return (c.get("name") or f"{c.get('firstName') or ''} {c.get('lastName') or ''}").strip()


def _write_facility(db, org: str, fac: dict, pulled: dict, stamp: str) -> dict:
    """Replace one facility's rows in the open session (the caller commits).
    Returns the row counts."""
    import models as m
    fid = fac["facilityId"]
    today: date = pulled["today"]

    for model in (m.CubbyUnit, m.CubbyRental, m.CubbyCustomer, m.CubbyLead, m.CubbyReceivable, m.CubbyTask):
        db.query(model).filter(model.facility_id == fid).delete(synchronize_session=False)

    def insert(model, rows):
        if rows:
            db.execute(model.__table__.insert(), rows)

    # Units: the rent-roll line and the units/search row, joined on unitId.
    rr = {str(r.get("unitId")): strip_pii(r) for r in pulled.get("rent_roll", []) if r.get("unitId")}
    us = {str(u.get("unitId")): strip_pii(u) for u in pulled.get("units", []) if u.get("unitId")}
    units = []
    for uid in sorted(set(rr) | set(us)):
        r, u = rr.get(uid), us.get(uid)
        units.append({"id": f"{fid}:{uid}", "facility_id": fid, "unit_id": uid,
                      "unit_name": ((r or {}).get("unitName") or (u or {}).get("name") or "").strip(),
                      "status": (r or {}).get("status") or "", "customer_id": (r or {}).get("customerId") or "",
                      "data": {"rentRoll": r, "unit": u}})
    insert(m.CubbyUnit, units)

    leases, seen = [], set()
    for le in pulled.get("leases", []):
        le = strip_pii(le)
        lid = _rid(le, "leaseId", "unitId", "customerId", "moveInDate")
        if lid in seen:
            continue
        seen.add(lid)
        leases.append({"id": f"{fid}:{lid}", "facility_id": fid, "lease_id": lid, "unit_id": le.get("unitId") or "",
                       "customer_id": le.get("customerId") or "", "move_in_date": (le.get("moveInDate") or "")[:10],
                       "move_out_date": (le.get("moveOutDate") or "")[:10], "data": le})
    insert(m.CubbyRental, leases)

    leads, seen = [], set()
    for ld in pulled.get("leads", []):
        ld = strip_pii(ld)
        lid = _rid(ld, "leadId", "customerId", "createdAt", "status")
        if lid in seen:
            continue
        seen.add(lid)
        leads.append({"id": f"{fid}:{lid}", "facility_id": fid, "lead_id": lid, "customer_id": ld.get("customerId") or "",
                      "status": ld.get("status") or "", "created_at": ld.get("createdAt") or "", "data": ld})
    insert(m.CubbyLead, leads)

    recs, seen = [], set()
    for e in pulled.get("receivables", []):
        e = strip_pii(e)
        key = f"{e.get('unitId') or ''}:{e.get('customerId') or ''}"
        if key == ":":
            key = _rid(e, "", "unitName", "customerName", "totalAmount")
        if key in seen:
            continue
        seen.add(key)
        recs.append({"id": f"{fid}:{key}", "facility_id": fid, "unit_id": e.get("unitId") or "",
                     "customer_id": e.get("customerId") or "", "total_cents": int(e.get("totalAmount") or 0), "data": e})
    insert(m.CubbyReceivable, recs)

    tasks, seen = [], set()
    for t in pulled.get("tasks", []):
        t = strip_pii(t)
        tid = _rid(t, "taskId", "title", "dueDate", "unitId")
        if tid in seen:
            continue
        seen.add(tid)
        tasks.append({"id": f"{fid}:{tid}", "facility_id": fid, "task_id": tid, "unit_id": t.get("unitId") or "",
                      "due_date": t.get("dueDate") or "", "data": t})
    insert(m.CubbyTask, tasks)

    # Customers: the name only, and only for people this facility's rows point at.
    wanted = ({row["customer_id"] for row in units + leases + leads + recs if row["customer_id"]}
              | {str(p.get("customerId")) for p in pulled.get("payments", []) if p.get("customerId")})
    custs, seen = [], set()
    for c in pulled.get("customers", []):
        cid = str(c.get("customerId") or "")
        if not cid or cid not in wanted or cid in seen:
            continue
        seen.add(cid)
        custs.append({"id": f"{fid}:{cid}", "facility_id": fid, "customer_id": cid, "name": _name(c)})
    insert(m.CubbyCustomer, custs)

    # Payments: replace the re-read window (and any id read again), keep the rest.
    since = pulled["payments_from"].isoformat()
    pays = {}
    for p in pulled.get("payments", []):
        p = strip_pii(p)
        pid = _rid(p, "paymentId", "customerId", "createdAt", "amount", "methodType")
        pays[pid] = {"id": f"{fid}:{pid}", "facility_id": fid, "payment_id": pid, "customer_id": p.get("customerId") or "",
                     "payment_date": payment_day(p), "status": p.get("status") or "",
                     "amount_cents": int(p.get("amount") or 0), "data": p}
    db.query(m.CubbyPayment).filter(m.CubbyPayment.facility_id == fid,
                                    m.CubbyPayment.payment_date >= since).delete(synchronize_session=False)
    ids = [r["id"] for r in pays.values()]
    for i in range(0, len(ids), 500):
        db.query(m.CubbyPayment).filter(m.CubbyPayment.id.in_(ids[i:i + 500])).delete(synchronize_session=False)
    insert(m.CubbyPayment, list(pays.values()))

    row = db.get(m.CubbyFacility, fid)
    if row is None:
        row = m.CubbyFacility(facility_id=fid)
        db.add(row)
    row.organization = org
    row.name = fac.get("name") or ""
    row.time_zone = fac.get("timeZone") or ""
    row.enabled = True
    row.data = {k: fac.get(k) for k in _FACILITY_KEYS if k in fac}
    row.synced_at = stamp
    row.payments_synced_through = today.isoformat()
    return {"units": len(units), "rentals": len(leases), "leads": len(leads), "receivables": len(recs),
            "tasks": len(tasks), "customers": len(custs), "payments": len(pays)}


# ── The run ───────────────────────────────────────────────────────────────────

def run_claimed(run_id: str) -> dict:
    """Do the sync for a run opened by claim(). Blocking. Always closes the run."""
    import models
    from database import SessionLocal
    results: dict[str, dict] = {}
    try:
        orgs = cubby._post("organizations/search", {}).get("organizations", [])
        facilities = []
        for org in orgs:
            facilities += cubby._post("facilities/search", {"organizationId": org["organizationId"]}).get("facilities", [])
        facilities = [f for f in facilities if f.get("enabled", True) and f.get("facilityId")]
        org_name = orgs[0].get("name") if orgs else ""
    except cubby.CubbyError as e:
        _finish(run_id, "failed", {}, f"Facility list: {e.message}"[:300])
        return {"status": "failed"}
    except Exception as e:  # noqa: BLE001
        _finish(run_id, "failed", {}, f"Facility list: {type(e).__name__}")
        return {"status": "failed"}

    db = SessionLocal()
    try:
        known = {f.facility_id: f.payments_synced_through for f in db.query(models.CubbyFacility).all()}
        # A facility Cubby no longer lists is hidden, not deleted.
        live = {f["facilityId"] for f in facilities}
        for f in db.query(models.CubbyFacility).filter(models.CubbyFacility.enabled.is_(True)).all():
            if f.facility_id not in live:
                f.enabled = False
        db.commit()
    finally:
        db.close()

    since = {f["facilityId"]: payments_from(known.get(f["facilityId"], ""), cubby._facility_today(f)) for f in facilities}
    pulled = _pull_all(facilities, since)

    for fac in facilities:
        fid = fac["facilityId"]
        name = cubby._short(fac)
        got = pulled[fid]
        if got.get("errors"):
            results[fid] = {"name": name, "status": "failed", "error": "; ".join(got["errors"])[:600]}
            continue
        db = SessionLocal()
        try:
            counts = _write_facility(db, org_name, fac, got, _iso(_now()))
            db.commit()
            results[fid] = {"name": name, "status": "ok", "counts": counts}
        except Exception as e:  # noqa: BLE001 - this facility keeps its previous rows
            db.rollback()
            results[fid] = {"name": name, "status": "failed", "error": f"Saving: {type(e).__name__}"}
        finally:
            db.close()

    ok = [r for r in results.values() if r["status"] == "ok"]
    state = "ok" if len(ok) == len(results) else "partial" if ok else "failed"
    if not results:
        state = "ok"
    errors = "; ".join(f"{r['name']}: {r['error']}" for r in results.values() if r["status"] != "ok")
    _finish(run_id, state, results, errors)
    if ok:
        try:
            cubby.after_sync()
        except Exception as e:  # noqa: BLE001 - the history row is a bonus
            print(f"[cubby] snapshot after sync skipped: {type(e).__name__}")
    print(f"[cubby] sync {state}: {len(ok)} of {len(results)} facilities")
    return {"status": state, "facilities": results}


def sync_all(trigger: str = "schedule", requested_by: str = "") -> dict:
    """Pull every facility into the database. Blocking - call it in a thread.
    Returns {"status": "skipped"} when another run holds the lock."""
    rid = claim(trigger, requested_by)
    if rid is None:
        return {"status": "skipped"}
    try:
        return run_claimed(rid)
    except Exception as e:  # noqa: BLE001 - never leave the lock row open
        _finish(rid, "failed", {}, f"{type(e).__name__}")
        raise


def run_in_background(run_id: str) -> None:
    def go():
        try:
            run_claimed(run_id)
        except Exception as e:  # noqa: BLE001
            _finish(run_id, "failed", {}, f"{type(e).__name__}")
            print(f"[cubby] background sync failed: {type(e).__name__}")
    threading.Thread(target=go, daemon=True, name="cubby-sync").start()
