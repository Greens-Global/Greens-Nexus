"""Stores in the Daily Briefing (Neil, 11/20/2026).

The briefing went out every day and read nothing from Cubby: the people who
run the stores had to open Operations to learn what the stores looked like
that morning. This adds one plain line per store to the email and to My
Briefing:

    Escondido: 96.5% occupied, up 0.4 points on last week. 18 vacant,
    $7,853 past due from 22 tenants, 2 leads waiting more than a week.

Figures only - counts, a percent and dollars, never a tenant. They come from
the daily snapshot Cubby's sync already writes (`cubby_daily_snapshots`, the
figures behind Operations > Overview) and from the lead rows; nothing is read
from Cubby here and nothing is stored.

WHO: Administrators and above, and people who hold the Operations grant - not
everyone who may open Operations by tier (supervisors may), because the rent
roll's past-due dollars do not belong in every supervisor's daily email. The
facility access rules (`ops_access.reach`) narrow which stores a person reads.

WHEN: the lines ride along with a briefing that is going out anyway. A day
with nothing to act on and no updates still sends nothing (Neil, 11/17/2026):
the store lines never make an email by themselves. My Briefing always has them.

A store whose last snapshot is more than STALE_DAYS old is left out - a number
from last week must not read as this morning's.
"""
from datetime import date, timedelta

import models

STALE_DAYS = 3          # the newest snapshot must be this recent to be shown
WEEK_DAYS = 7           # "on last week" = the snapshot a week before the newest
WEEK_SLACK = 3          # ... or up to this many days older when that day is missing
LEAD_WAIT_DAYS = 7      # a NEW lead older than this is "waiting"
FLAT_POINTS = 0.05      # a change smaller than this reads as no change


def audience(db, email: str):
    """The reader as Operations sees them when they are sent store lines, else None."""
    import auth
    level = auth.level_for(email, db)
    if level >= auth._LEVELS["administrator"]:
        return {"email": email, "level": level}
    try:
        granted = auth._module_level(email, "operations", db) >= auth._MODULE_LEVEL_RANK["viewer"]
    except Exception:  # noqa: BLE001 - a briefing must not fail on a grant read; in doubt, no store lines
        granted = False
    return {"email": email, "level": level} if granted else None


def occupancy(rented, total):
    """Percent of storage units rented, one decimal; None with no units."""
    total = int(total or 0)
    return round(100.0 * int(rented or 0) / total, 1) if total > 0 else None


def _money(cents) -> str:
    return f"${round(int(cents or 0) / 100):,}"


def _n(count: int, one: str, many: str) -> str:
    return f"{count:,} {one if count == 1 else many}"


def line_for(name: str, latest: dict, prior: dict = None, leads_waiting: int = 0) -> dict:
    """One store's line: {"name", "text"}. `latest` / `prior` carry
    units_total, units_rented, units_vacant, past_due_cents, past_due_tenants."""
    occ = occupancy(latest.get("units_rented"), latest.get("units_total"))
    first = "No storage units on file" if occ is None else f"{occ:g}% occupied"
    if occ is not None and prior:
        before = occupancy(prior.get("units_rented"), prior.get("units_total"))
        if before is not None:
            move = round(occ - before, 1)
            first += (", level with last week" if abs(move) < FLAT_POINTS
                      else f", {'up' if move > 0 else 'down'} {abs(move):g} {'point' if abs(move) == 1 else 'points'} on last week")
    bits = [f"{int(latest.get('units_vacant') or 0):,} vacant"]
    due, tenants = int(latest.get("past_due_cents") or 0), int(latest.get("past_due_tenants") or 0)
    bits.append(f"{_money(due)} past due from {_n(tenants, 'tenant', 'tenants')}" if due > 0 else "nothing past due")
    if leads_waiting:
        bits.append(f"{_n(leads_waiting, 'lead', 'leads')} waiting more than a week")
    rest = ", ".join(bits)
    return {"name": name, "text": f"{first}. {rest[0].upper()}{rest[1:]}."}


def _snap(row) -> dict:
    return {"units_total": row.units_total, "units_rented": row.units_rented, "units_vacant": row.units_vacant,
            "past_due_cents": row.past_due_cents, "past_due_tenants": row.past_due_tenants}


def lines(db, email: str, briefing_date: str) -> list:
    """The store lines for this reader on their briefing day, by store name;
    [] for anyone outside the audience or with no store to read."""
    user = audience(db, email)
    if not user:
        return []
    import ops_access
    reached = ops_access.reach(user, db)
    stores = [f for f in db.query(models.CubbyFacility).filter(models.CubbyFacility.enabled.is_(True)).all()
              if ops_access.sees(reached, f.facility_id)]
    if not stores:
        return []
    today = date.fromisoformat(briefing_date)
    floor = (today - timedelta(days=STALE_DAYS + WEEK_DAYS + WEEK_SLACK)).isoformat()
    ids = [f.facility_id for f in stores]
    snaps = {}
    for s in (db.query(models.CubbyDailySnapshot)
              .filter(models.CubbyDailySnapshot.facility_id.in_(ids), models.CubbyDailySnapshot.snapshot_date >= floor,
                      models.CubbyDailySnapshot.snapshot_date <= briefing_date).all()):
        snaps.setdefault(s.facility_id, {})[s.snapshot_date] = s
    cutoff = (today - timedelta(days=LEAD_WAIT_DAYS)).isoformat()
    waiting = {}
    for lead in db.query(models.CubbyLead).filter(models.CubbyLead.facility_id.in_(ids), models.CubbyLead.status == "NEW").all():
        made = str(lead.created_at or "")[:10]
        if made and made < cutoff:
            waiting[lead.facility_id] = waiting.get(lead.facility_id, 0) + 1
    out = []
    for f in sorted(stores, key=lambda x: (x.name or "").lower()):
        days = snaps.get(f.facility_id) or {}
        if not days:
            continue
        newest = max(days)
        if newest < (today - timedelta(days=STALE_DAYS)).isoformat():
            continue
        week_ago = date.fromisoformat(newest) - timedelta(days=WEEK_DAYS)
        prior = next((days[d] for d in sorted(days, reverse=True)
                      if (week_ago - timedelta(days=WEEK_SLACK)).isoformat() <= d <= week_ago.isoformat()), None)
        out.append(line_for(f.name or "Store", _snap(days[newest]), _snap(prior) if prior else None, waiting.get(f.facility_id, 0)))
    return out
