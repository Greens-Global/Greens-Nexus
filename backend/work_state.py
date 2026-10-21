"""Where a person works, by US state (Charmi, Oct 20 2026).

The California rules (ca_breaks.py meal detection, ca_review.py California
Review) and the company-default overtime rule used to follow the COMPANY's
country alone: every US employee without an explicit rule was on the
California rule wherever they worked. Charmi: "this should only come up if
the employee is in California". This module answers "which state does this
person work in, and how do we know" from the records Nexus already has, in
this order (the first that gives an answer wins):

  1. their assigned work sites (People > Time Clock, allowed sites);
  2. the work sites they actually punched at;
  3. their People `location` text (a site name, or an address with a state);
  4. their company's work-site list, when every site on it is in one state;
  5. their company's registered address.

A site's state comes from its address ("..., California, 92592, United
States" / "Lakeside, CA 92040"). When a tier names several states and one of
them is California, the person counts as California (California law follows
the days worked there). Nothing found = unknown (""), which HR sees in the
California Review as "Work State Unknown" - never guessed.

CA_SCOPE_BY_WORK_STATE switches the whole behavior. True: a US person's
company-default overtime rule is 'ca' only when they work in California
(another known state -> 'federal'; unknown -> 'ca' still, so pay never drops
on a guess), and the California Review lists only people who work in
California. False: the company's country decides, as before Oct 20.
An overtime rule HR picked by hand (Pay & Benefits) always wins.
"""
from __future__ import annotations

import json
import re

from sqlalchemy.orm import Session

import models

# One line to switch back to the company-country rule (Visesh confirms the
# impact on pay before this ships - see default_rule_changes()).
CA_SCOPE_BY_WORK_STATE = True

OT_RULES = ("ca", "federal", "none")

STATES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA", "colorado": "CO",
    "connecticut": "CT", "delaware": "DE", "district of columbia": "DC", "florida": "FL", "georgia": "GA",
    "hawaii": "HI", "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
    "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD", "massachusetts": "MA",
    "michigan": "MI", "minnesota": "MN", "mississippi": "MS", "missouri": "MO", "montana": "MT",
    "nebraska": "NE", "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
    "new york": "NY", "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
    "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA",
    "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
}
ABBRS = set(STATES.values())
STATE_NAME = {v: k.title() for k, v in STATES.items()}
_NOT_US = ("india", "canada", "mexico", "united kingdom", "philippines")


def state_from_address(addr: str) -> str:
    """The US state in an address ('' when none can be read). Reads the
    comma-separated parts from the END, so a street called "Via California"
    or "California 67" never decides it."""
    a = (addr or "").strip()
    if not a:
        return ""
    low = a.lower()
    if any(c in low for c in _NOT_US):
        return ""
    for part in reversed([p.strip() for p in a.split(",") if p.strip()]):
        p = re.sub(r"\s*\d{5}(-\d{4})?$", "", part).strip()
        if not p or p.lower() in ("united states", "united states of america", "usa", "us"):
            continue
        if p.lower() in STATES:
            return STATES[p.lower()]
        if p.upper() in ABBRS and len(p) == 2 and p.isalpha():
            return p.upper()
    return ""


def _pick(states: list) -> str:
    """One state from a tier's answers: California if any of them is."""
    s = [x for x in states if x]
    if not s:
        return ""
    if "CA" in s:
        return "CA"
    return max(sorted(set(s)), key=s.count)


def _sites(db: Session, ctx: dict | None) -> dict:
    if ctx is not None and "sites" in ctx:
        return ctx["sites"]
    sites = {s.id: {"name": s.name or "", "state": state_from_address(s.address)}
             for s in db.query(models.HrWorkSite.id, models.HrWorkSite.name, models.HrWorkSite.address).all()}
    if ctx is not None:
        ctx["sites"] = sites
    return sites


def preload(db: Session, emails) -> dict:
    """Everything resolve() reads, for a roster at once (a few queries)."""
    ems = sorted({(e or "").lower() for e in emails if e})
    ctx = {"punchSites": {}, "companySites": {}, "entities": {}}
    _sites(db, ctx)
    if ems:
        for em, sid in (db.query(models.TimePunch.employee_email, models.TimePunch.work_site_id)
                        .filter(models.TimePunch.employee_email.in_(ems), models.TimePunch.work_site_id != "")
                        .distinct().all()):
            ctx["punchSites"].setdefault((em or "").lower(), set()).add(sid)
    for cid, sid in db.query(models.HrCompanyWorkSite.company_id, models.HrCompanyWorkSite.site_id).all():
        ctx["companySites"].setdefault(cid, set()).add(sid)
    for e in db.query(models.HrEntity.id, models.HrEntity.name, models.HrEntity.registered_address).all():
        ctx["entities"][e.id] = (e.name or "", e.registered_address or "")
    ctx["preloaded"] = set(ems)
    return ctx


def _allowed_site_ids(emp) -> list:
    raw = (getattr(emp, "work_site_ids", "") or "").strip()
    ids = []
    if raw:
        try:
            v = json.loads(raw)
            ids = [str(x).strip() for x in v if str(x).strip()] if isinstance(v, list) else []
        except ValueError:
            ids = []
    if not ids and (getattr(emp, "work_site_id", "") or "").strip():
        ids = [emp.work_site_id.strip()]
    return ids


def _site_tier(sites: dict, ids, prefix: str) -> dict | None:
    known = [(sites[i]["name"], sites[i]["state"]) for i in ids if i in sites and sites[i]["state"]]
    st = _pick([s for _n, s in known])
    if not st:
        return None
    names = [n for n, s in known if s == st]
    shown = ", ".join(sorted(set(names))[:2]) + (" and more" if len(set(names)) > 2 else "")
    return {"state": st, "label": f"{prefix}: {shown}, {st}"}


def resolve(db: Session, emp, ctx: dict | None = None) -> dict:
    """{state, label, source} for one NexusEmployee row. state '' = unknown;
    label says why in plain words ("Work site: GS Temecula, CA")."""
    if emp is None:
        return {"state": "", "label": "No People record", "source": ""}
    sites = _sites(db, ctx)
    em = (getattr(emp, "work_email", "") or "").lower()
    # 1. assigned sites
    t = _site_tier(sites, _allowed_site_ids(emp), "Work site")
    if t:
        return {**t, "source": "site"}
    # 2. where they punched
    if ctx is not None and em in ctx.get("preloaded", ()):
        punched = ctx["punchSites"].get(em, set())
    else:
        punched = {r[0] for r in db.query(models.TimePunch.work_site_id)
                   .filter(models.TimePunch.employee_email == em, models.TimePunch.work_site_id != "")
                   .distinct().all()} if em else set()
    t = _site_tier(sites, sorted(punched), "Punched at")
    if t:
        return {**t, "source": "punches"}
    # 3. People location text
    loc = (getattr(emp, "location", "") or "").strip()
    if loc:
        by_name = [v for v in sites.values() if v["name"].strip().lower() == loc.lower() and v["state"]]
        st = by_name[0]["state"] if by_name else state_from_address(loc)
        if st:
            return {"state": st, "label": f"Location: {loc}" + ("" if loc.endswith(st) else f", {st}"),
                    "source": "location"}
    # 4. the company's work sites, when they are all in one state
    cid = (getattr(emp, "company", "") or "").strip()
    if cid:
        if ctx is not None and "companySites" in ctx:
            cs = ctx["companySites"].get(cid, set())
            ent = ctx["entities"].get(cid)
        else:
            cs = {r[0] for r in db.query(models.HrCompanyWorkSite.site_id)
                  .filter(models.HrCompanyWorkSite.company_id == cid).all()}
            e = db.query(models.HrEntity.name, models.HrEntity.registered_address).filter(models.HrEntity.id == cid).first()
            ent = (e[0] or "", e[1] or "") if e else None
        states = {sites[i]["state"] for i in cs if i in sites and sites[i]["state"]}
        if len(states) == 1:
            st = next(iter(states))
            return {"state": st, "label": f"Every {ent[0] if ent else 'company'} work site is in {st}",
                    "source": "company_sites"}
        # 5. the company's registered address
        st = state_from_address(ent[1]) if ent else ""
        if st:
            return {"state": st, "label": f"{ent[0]} address, {st}", "source": "company_address"}
    return {"state": "", "label": "No work site, punch location or company address with a state",
            "source": ""}


def explicit_rule(emp) -> str:
    """The overtime rule HR picked by hand on Pay & Benefits ('' = company
    default)."""
    comp = (getattr(emp, "compensation", None) or {}) if emp is not None else {}
    r = (comp.get("overtimeRule") or "").strip().lower() if isinstance(comp, dict) else ""
    return r if r in OT_RULES else ""


def default_rule(country: str, state: str) -> str:
    """The company-default overtime rule for a person. `country` is their
    company's (US / IN / ...)."""
    c = (country or "US").strip().upper()
    if c in ("US", "USA"):
        if not CA_SCOPE_BY_WORK_STATE:
            return "ca"
        if not state or state == "CA":
            return "ca"      # unknown keeps California until HR sets the state
        return "federal"
    return "none" if c == "IN" else "federal"


def review_scope(db: Session, emp, ctx: dict | None = None) -> tuple[bool, dict]:
    """(belongs in the California Review, work state). With the switch off,
    everyone on the CA rule does (as before). On: people who work in
    California, or whom HR put on the California rule by hand."""
    ws = resolve(db, emp, ctx) if CA_SCOPE_BY_WORK_STATE else {"state": "", "label": "", "source": ""}
    if not CA_SCOPE_BY_WORK_STATE:
        return True, ws
    return (ws["state"] == "CA" or explicit_rule(emp) == "ca"), ws


def engine_scope(db: Session, emp, ctx: dict | None = None) -> bool:
    """The time sheet's CA meal detection / premiums / waiver: off ONLY for a
    person known to work outside California whose rule HR did not set to
    California by hand. Unknown keeps them on (their pay is still on the
    California rule until HR sets the state)."""
    if not CA_SCOPE_BY_WORK_STATE or emp is None or explicit_rule(emp) == "ca":
        return True
    st = resolve(db, emp, ctx)["state"]
    return st in ("", "CA")


def default_rule_changes(db: Session) -> list:
    """Dry run: every person whose STORED overtime rule is 'ca' by default
    (no rule picked by hand) but whose work state now says otherwise -
    [{email, name, from, to, workState}]. Read-only."""
    from sqlalchemy import func
    rates = {(r.employee_email or "").lower(): r for r in db.query(models.PayrollRate).all()}
    emps = [e for e in db.query(models.NexusEmployee).filter(func.lower(models.NexusEmployee.work_email).in_(list(rates))).all()
            if e.work_email] if rates else []
    ctx = preload(db, [e.work_email for e in emps])
    country = {i: (c or "") for i, c in db.query(models.HrEntity.id, models.HrEntity.country).all()}
    out = []
    for e in emps:
        r = rates[e.work_email.lower()]
        cur = (r.overtime_rule or "ca").lower()
        if explicit_rule(e) or cur != "ca":
            continue
        ws = resolve(db, e, ctx)
        new = default_rule(country.get(e.company or "", "") or "US", ws["state"])
        if new != cur:
            out.append({"email": e.work_email.lower(), "name": _name(e), "from": cur, "to": new, "workState": ws})
    return sorted(out, key=lambda x: x["name"].lower())


def apply_default_rule_changes(db: Session, actor: str) -> list:
    """Write default_rule_changes() to the pay records (Visesh runs this once
    after confirming the list). Finalized periods keep the rule they were
    finalized with. Returns what changed."""
    from datetime import datetime, timezone
    changes = default_rule_changes(db)
    now = datetime.now(timezone.utc).isoformat()
    for c in changes:
        r = db.query(models.PayrollRate).filter(models.PayrollRate.employee_email == c["email"]).first()
        if r is not None:
            r.overtime_rule = c["to"]
            if hasattr(r, "updated_by"):
                r.updated_by = actor
            if hasattr(r, "updated_at"):
                r.updated_at = now
    db.commit()
    return changes


def _name(e) -> str:
    n = (getattr(e, "display_name", "") or "").strip()
    if not n:
        n = f"{getattr(e, 'first_name', '') or ''} {getattr(e, 'last_name', '') or ''}".strip()
    return n or (e.work_email or "")
