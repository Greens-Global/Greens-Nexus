"""Operations > Revenue Management (Neil, Oct 20 2026): rent changes for
EXISTING tenants - the existing-customer rate increase (ECRI) in self storage.

"Revenue management is on my existing customers. Does the rate need to go up
or down? And what pricing strategy am I adding? ... give me the ability to
create a strategy and apply it to a unit type or to a person."

Street rates for NEW renters (and the competitor CMA) are Market Rates'
job (ops_market*.py); this module never sets a street rate.

What is here:
  - tenant_rows: each current tenant from the rent roll Cubby gives
    (cubby.py's synced tables): rent vs today's street rate, move-in, length
    of stay, last rent change, balance, anything already scheduled.
  - propose / preview: a strategy (+X% or +$Y, capped at street or street +
    Z%, eligibility rules) applied to those rows. Pure, so the tests feed it
    fixed rows.
  - NO Cubby writes (Visesh, Oct 20 2026: "we don't want anything to push
    to cubby"). Staff enter each new rent in Cubby by hand from the
    checklist export and mark the row Entered in Cubby here. Never add a
    call to leases/change-rents or any other Cubby write.
  - notice letters (PDF) and a mail-merge export. Nexus never emails a
    tenant (CLAUDE.md); staff print or merge them.

Money is integer cents, like cubby.py. Cubby's monthlyRentalAmount is per
the facility's billing cycle (a 28-day facility sends a 28-day amount), so
"monthly" here means "per billing cycle" - the same basis as the rent roll.
"""
from __future__ import annotations

import io
import math
from datetime import date, datetime, timedelta, timezone

import cubby

DEFAULT_NOTICE_DAYS = 30
MAX_NOTICE_DAYS = 365
OPEN_BATCH = ("draft", "approved", "notified")
STATUSES = ("draft", "approved", "notified", "applied", "canceled")
# What a batch may move to, and from where. Notice comes before Applied: the
# tenant must have had the letter before the new rent can be live.
# A change row is in Cubby once it is "entered" (staff typed it there by hand).
# "pushed" is a status only rows from before Oct 20 2026 can carry; it still
# counts as in Cubby so old batches read right. Nothing sets it any more.
IN_CUBBY = ("entered", "pushed")
NEXT = {
    "approved": ("draft",),
    "notified": ("approved",),
    "applied": ("notified",),
    "canceled": ("draft", "approved", "notified"),
}

DEFAULT_STRATEGY = {
    "name": "", "method": "percent", "increasePct": 8.0, "increaseCents": 0,
    "capMode": "street", "capPct": 0.0, "roundDollar": True,
    "minMonthsIn": 12, "minMonthsSince": 12, "skipBalance": True,
    "noticeDays": DEFAULT_NOTICE_DAYS,
}


# ── Dates ─────────────────────────────────────────────────────────────────────

def _d(iso) -> date | None:
    try:
        return date.fromisoformat(str(iso or "")[:10])
    except ValueError:
        return None


def months_between(start: date | None, end: date) -> int | None:
    """Whole months from `start` to `end` (Jan 15 -> Feb 14 is 0, -> Feb 15 is 1)."""
    if start is None:
        return None
    n = (end.year - start.year) * 12 + (end.month - start.month)
    if end.day < start.day:
        n -= 1
    return max(n, 0)


def us_date(iso) -> str:
    d = _d(iso)
    return f"{d.month:02d}/{d.day:02d}/{d.year}" if d else ""


def money(cents) -> str:
    c = int(cents or 0)
    return f"{'-' if c < 0 else ''}${abs(c) / 100:,.2f}"


def notice_date(effective: date, notice_days: int) -> date:
    return effective - timedelta(days=int(notice_days))


def earliest_effective(today: date, notice_days: int) -> date:
    """The first day a change can take effect with `notice_days` of notice
    given today."""
    return today + timedelta(days=int(notice_days))


# ── Tenants ───────────────────────────────────────────────────────────────────

def _active_lease_by_unit(leases: list[dict], today_s: str) -> dict:
    out: dict[str, dict] = {}
    for le in leases:
        mo = le.get("moveOutDate") or ""
        if mo and mo <= today_s:
            continue
        uid = le.get("unitId")
        if not uid:
            continue
        cur = out.get(uid)
        if cur is None or (le.get("moveInDate") or "") > (cur.get("moveInDate") or ""):
            out[uid] = le
    return out


def tenant_rows(raw: dict, nexus_last: dict | None = None, pending: dict | None = None) -> list[dict]:
    """Every current tenant at one facility, one row per rented unit.

    raw         one facility's rows as cubby.py keeps them (rent_roll,
                receivables, leases, today)
    nexus_last  {leaseId: YYYY-MM-DD} rent changes Nexus applied (used when
                Cubby has no lastRentChangeDate for the tenant)
    pending     {leaseId: {"batchId", "status", "effective"}} open Nexus batches
    """
    today: date = raw["today"]
    today_s = today.isoformat()
    nexus_last = nexus_last or {}
    pending = pending or {}
    owed = {e.get("unitId"): int(e.get("totalAmount") or 0) for e in raw.get("receivables", [])}
    leases = _active_lease_by_unit(raw.get("leases", []), today_s)
    rows = []
    for r in raw.get("rent_roll", []):
        if r.get("status") != "RENTED":
            continue
        uid = r.get("unitId") or ""
        le = leases.get(uid) or {}
        lease_id = le.get("leaseId") or ""
        rent = int(r.get("monthlyRentalAmount") or 0)
        street = int(r.get("standardRate") or 0)
        move_in = r.get("moveInDate") or le.get("moveInDate") or ""
        cubby_last = r.get("lastRentChangeDate") or ""
        nexus = nexus_last.get(lease_id, "") if lease_id else ""
        last, source = (cubby_last, "cubby") if cubby_last >= nexus and cubby_last else ((nexus, "nexus") if nexus else ("", ""))
        balance = max(owed.get(uid, 0), 0)
        paid_through = r.get("paidThroughDate") or ""
        sched_date = le.get("rentChangeScheduledDate") or ""
        sched_amt = le.get("rentChangeNewRentAmount")
        gap = street - rent
        rows.append({
            "key": lease_id or f"unit:{uid}",
            "leaseId": lease_id, "unitId": uid, "customerId": r.get("customerId") or "",
            "tenant": r.get("customerName") or "", "unit": (r.get("unitName") or "").strip(),
            "unitType": (r.get("pricingGroupName") or "Other").strip(),
            "moveIn": move_in, "monthsStayed": months_between(_d(move_in), today),
            "rent": rent, "street": street, "gap": gap,
            "gapPct": round(gap / street * 100, 1) if street else None,
            "lastIncrease": last, "lastIncreaseSource": source,
            "monthsSinceIncrease": months_between(_d(last), today),
            "balance": balance, "pastDue": balance > 0 and bool(paid_through) and paid_through < today_s,
            "paidThrough": paid_through,
            "scheduled": ({"date": sched_date, "amount": int(sched_amt)} if sched_date and sched_amt is not None else None),
            "pending": pending.get(lease_id) if lease_id else None,
            "url": cubby._tenant_url(r.get("customerId") or ""),
        })
    rows.sort(key=lambda t: (t["unit"], t["tenant"]))
    return rows


# ── Strategies ────────────────────────────────────────────────────────────────

def strategy_dict(m) -> dict:
    """A saved strategy (model row) in the shape propose() and the screen use."""
    return {
        "id": m.id, "name": m.name or "", "method": m.method or "percent",
        "increasePct": float(m.increase_pct or 0), "increaseCents": int(m.increase_cents or 0),
        "capMode": m.cap_mode or "street", "capPct": float(m.cap_pct or 0),
        "roundDollar": bool(m.round_dollar), "minMonthsIn": int(m.min_months_in or 0),
        "minMonthsSince": int(m.min_months_since or 0), "skipBalance": bool(m.skip_balance),
        "noticeDays": int(m.notice_days or DEFAULT_NOTICE_DAYS), "active": bool(m.active),
        "createdBy": m.created_by or "", "createdAt": m.created_at or "",
        "updatedBy": m.updated_by or "", "updatedAt": m.updated_at or "",
    }


def describe(s: dict) -> str:
    """'+8%, capped at street' - one line a person reads."""
    step = f"+{s['increasePct']:g}%" if s["method"] == "percent" else f"+{money(s['increaseCents'])}"
    cap = {"street": "capped at street rate", "street_plus": f"capped at street + {s['capPct']:g}%",
           "none": "no cap"}.get(s["capMode"], "")
    return f"{step}, {cap}"


def _cap(s: dict, street: int) -> int | None:
    if s["capMode"] == "none":
        return None
    if s["capMode"] == "street_plus":
        return int(math.floor(street * (1 + s["capPct"] / 100)))
    return street


def propose(s: dict, t: dict, asof: date) -> dict:
    """One tenant under one strategy: the new rent, or why they are skipped.
    Months are counted to `asof` (the effective date: the time between rent
    changes is what the rule limits)."""
    reasons = []
    rent, street = t["rent"], t["street"]
    if rent <= 0:
        reasons.append("Comped unit ($0 rent)")
    stayed = months_between(_d(t["moveIn"]), asof)
    if stayed is None or stayed < s["minMonthsIn"]:
        reasons.append(f"Moved in less than {s['minMonthsIn']} months before the effective date")
    since = months_between(_d(t["lastIncrease"]), asof)
    if since is not None and since < s["minMonthsSince"]:
        reasons.append(f"Rent changed less than {s['minMonthsSince']} months before the effective date")
    if s["skipBalance"] and t["balance"] > 0:
        reasons.append("Has a balance due")
    if t.get("scheduled"):
        reasons.append("A rent change is already scheduled in Cubby")
    if t.get("pending"):
        reasons.append("Already in an open rent change batch")
    cap = _cap(s, street)
    if s["capMode"] != "none" and street <= 0:
        reasons.append("No street rate to cap at")
    raw_new = rent * (1 + s["increasePct"] / 100) if s["method"] == "percent" else rent + s["increaseCents"]
    new = int(math.floor(raw_new / 100 + 0.5) * 100) if s["roundDollar"] else int(math.floor(raw_new + 0.5))
    capped = False
    if cap is not None and new > cap:
        new, capped = cap, True
    if not reasons and new <= rent:
        reasons.append("Already at or above the cap" if cap is not None and cap <= rent else "No increase")
    eligible = not reasons
    inc = new - rent if eligible else 0
    return {
        **t, "eligible": eligible, "reasons": reasons,
        "newRent": new if eligible else rent, "increase": inc,
        "increasePct": round(inc / rent * 100, 1) if eligible and rent else 0.0,
        "capped": capped and eligible,
    }


def in_scope(rows: list[dict], scope: dict) -> list[dict]:
    kind = (scope or {}).get("type")
    if kind == "unit_type":
        name = (scope.get("unitType") or "").strip()
        return [t for t in rows if t["unitType"] == name]
    if kind in ("tenants", "tenant"):
        keys = set(scope.get("keys") or [])
        return [t for t in rows if t["key"] in keys]
    return []


def scope_label(scope: dict, picked: list[dict]) -> str:
    kind = (scope or {}).get("type")
    if kind == "unit_type":
        return f"Unit type {scope.get('unitType') or ''}".strip()
    if len(picked) == 1:
        return f"{picked[0]['tenant']} ({picked[0]['unit']})"
    return f"{len(picked)} selected tenants"


def preview(s: dict, rows: list[dict], asof: date) -> dict:
    out = [propose(s, t, asof) for t in rows]
    ok = [r for r in out if r["eligible"]]
    monthly = sum(r["increase"] for r in ok)
    current = sum(r["rent"] for r in ok)
    skipped: dict[str, int] = {}
    for r in out:
        if not r["eligible"]:
            skipped[r["reasons"][0]] = skipped.get(r["reasons"][0], 0) + 1
    return {
        "rows": sorted(out, key=lambda r: (not r["eligible"], -r["increase"], r["unit"])),
        "totals": {
            "inScope": len(out), "eligible": len(ok), "skipped": len(out) - len(ok),
            "currentMonthly": current, "newMonthly": current + monthly,
            "monthlyIncrease": monthly, "annualIncrease": monthly * 12,
            "avgIncreasePct": round(monthly / current * 100, 1) if current else 0.0,
            "capped": sum(1 for r in ok if r["capped"]),
            "skippedBy": skipped,
        },
    }


# ── Notices for staff (never emailed by Nexus) ───────────────────────────────

MERGE_COLUMNS = ["Facility", "Tenant", "Unit", "Unit Type", "Current Rent", "New Rent", "Increase", "Increase %",
                 "Notice Date", "Effective Date", "Status in Nexus", "Entered in Cubby", "Cubby Link"]
CHANGE_STATUS = {"pending": "Not Yet in Cubby", "pushed": "In Cubby", "entered": "Entered in Cubby",
                 "failed": "Not Yet in Cubby", "removed": "Removed"}


def merge_rows(batch, changes) -> list[list]:
    out = []
    for c in changes:
        if c.status == "removed":
            continue
        inc = (c.new_cents or 0) - (c.current_cents or 0)
        out.append([
            batch.facility_name, c.tenant_name, c.unit_name, c.unit_type,
            f"{(c.current_cents or 0) / 100:.2f}", f"{(c.new_cents or 0) / 100:.2f}", f"{inc / 100:.2f}",
            f"{inc / c.current_cents * 100:.1f}%" if c.current_cents else "",
            us_date(batch.notice_date), us_date(c.cubby_change_date or batch.effective_date),
            CHANGE_STATUS.get(c.status, c.status), "Yes" if c.status in IN_CUBBY else "",
            cubby._tenant_url(c.customer_id),
        ])
    return out


def letters_pdf(batch, changes, today: date) -> bytes:
    """One notice letter per tenant, ready to print and mail. No mailing
    address: Nexus does not keep tenant contact details (cubby.py); staff
    address the envelope from Cubby."""
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.units import inch
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    pdf = canvas.Canvas(buf, pagesize=letter)
    pdf.setTitle(f"Rent Change Notices - {batch.facility_name}")
    width, height = letter
    left = inch
    for c in changes:
        if c.status == "removed":
            continue
        effective = c.cubby_change_date or batch.effective_date
        y = height - inch
        pdf.setFont("Helvetica-Bold", 14)
        pdf.drawString(left, y, batch.facility_name or "Greens Storage")
        y -= 0.35 * inch
        pdf.setFont("Helvetica", 11)
        pdf.drawString(left, y, us_date(today.isoformat()))
        y -= 0.5 * inch
        pdf.drawString(left, y, c.tenant_name or "")
        y -= 0.2 * inch
        pdf.drawString(left, y, f"Unit {c.unit_name}" + (f" ({c.unit_type})" if c.unit_type else ""))
        y -= 0.5 * inch
        pdf.setFont("Helvetica-Bold", 12)
        pdf.drawString(left, y, "Notice of Rent Change")
        y -= 0.35 * inch
        pdf.setFont("Helvetica", 11)
        body = [
            f"Dear {c.tenant_name or 'Tenant'},",
            "",
            f"This letter is your written notice that the monthly rent for unit {c.unit_name} at",
            f"{batch.facility_name} will change on {us_date(effective)}.",
            "",
            f"    Current monthly rent:   {money(c.current_cents)}",
            f"    New monthly rent:       {money(c.new_cents)}",
            f"    Effective date:         {us_date(effective)}",
            "",
            "Your rent stays the same until the effective date. Everything else in your rental",
            "agreement stays the same. If you have any questions, please contact the facility office.",
            "",
            "Thank you for storing with us.",
            "",
            "Sincerely,",
            "",
            f"{batch.facility_name} Management",
        ]
        for line in body:
            pdf.drawString(left, y, line)
            y -= 0.22 * inch
        pdf.showPage()
    pdf.save()
    return buf.getvalue()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
