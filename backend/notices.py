"""Workplace Notices + Employee Manual (Neil, Oct 21 2026).

"If the employee is physically located in this state, they should get
separate notices ... every year these posters update ... there has to be an
actual workflow and a manager approval." Plan:
https://claude.ai/artifact/ChfuZt3NpBfkApDztuxqns

This module is the rules engine - who gets which notice, and which version is
live. Everything that writes (the HR library, acknowledgments, deliveries, the
watcher) builds on it.

Who a notice is for (`applies`): the person's country (their company's), worker
type, work state and city, the kinds of their work sites, the headcount of
their company (or of every US company together - Neil, Oct 22: "yes"), whether
they are hourly, and two company facts in Settings (E-Verify, Texas workers'
comp). Nothing is guessed: a US employee whose state Nexus cannot place gets
the federal notices and lands on HR's "Location Unknown" list, as the
California overtime rule does (work_state.py).

Which version is live: the newest APPROVED version whose effective date has
come - computed on every read, so a poster approved for 01/01/2027 goes live
at midnight with no job having to run.
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

import models
import notices_catalog
import work_state

SETTINGS_KEY = "workplace_notices"
ACK_KINDS = ("manual", "addendum", "policy", "contractor_code")
DOC_KINDS = ACK_KINDS + ("closures",)
SITE_KINDS = ("office", "jobsite", "storage")
ACTIVE_STATUSES = ("active", "onboarding")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def today() -> date:
    return date.today()


def norm(e: str) -> str:
    return (e or "").strip().lower()


def log_event(db: Session, actor: str, action: str, notice_id: str = "", version_id: str = "", **detail) -> None:
    db.add(models.WorkplaceNoticeEvent(id=str(uuid.uuid4()), at=now_iso(), actor=norm(actor), action=action,
                                       notice_id=notice_id or "", version_id=version_id or "", detail=detail))


# ── Settings ─────────────────────────────────────────────────────────────────

def settings(db: Session) -> dict:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTINGS_KEY).first()
    stored = {}
    if row and row.value:
        try:
            stored = json.loads(row.value) or {}
        except ValueError:
            stored = {}
    return {**notices_catalog.DEFAULT_SETTINGS, **{k: v for k, v in stored.items() if k in notices_catalog.DEFAULT_SETTINGS}}


def save_settings(db: Session, actor: str, patch: dict) -> dict:
    cur = settings(db)
    for k, v in (patch or {}).items():
        if k in notices_catalog.DEFAULT_SETTINGS:
            cur[k] = v
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTINGS_KEY).first()
    if row is None:
        row = models.NexusSetting(key=SETTINGS_KEY)
        db.add(row)
    row.value, row.updated_by, row.updated_at = json.dumps(cur), norm(actor), now_iso()
    log_event(db, actor, "settings_saved", changed=sorted((patch or {}).keys()))
    return cur


# ── Catalog ──────────────────────────────────────────────────────────────────

def ensure_catalog(db: Session) -> int:
    """Add catalog notices that are missing. Never touches an existing row.
    Also records the module's first day (at-hire bundles go only to people
    who start on or after it, so launch day does not mail everyone)."""
    have = {r[0] for r in db.query(models.WorkplaceNotice.id).all()}
    added = 0
    stamp = now_iso()
    for c in notices_catalog.CATALOG:
        if c["id"] in have:
            continue
        db.add(models.WorkplaceNotice(**c, status="active", created_by="catalog", created_at=stamp,
                                      updated_at=stamp))
        if c["source_url"] and not db.get(models.WorkplaceNoticeSource, c["id"]):
            db.add(models.WorkplaceNoticeSource(notice_id=c["id"], url=c["source_url"]))
        added += 1
    if added:
        s = settings(db)
        if not s.get("hireSince"):
            save_settings(db, "catalog", {"hireSince": today().isoformat()})
        log_event(db, "catalog", "catalog_seeded", added=added)
        db.flush()
    return added


# ── Versions ─────────────────────────────────────────────────────────────────

def versions_of(db: Session, notice_id: str) -> list:
    return (db.query(models.WorkplaceNoticeVersion)
            .filter(models.WorkplaceNoticeVersion.notice_id == notice_id)
            .order_by(models.WorkplaceNoticeVersion.number.desc()).all())


def live_version(db: Session, notice_id: str, on: date | None = None, rows: list | None = None):
    """The newest approved version in effect on `on` (today), or None."""
    d = (on or today()).isoformat()
    vs = rows if rows is not None else versions_of(db, notice_id)
    ok = [v for v in vs if v.status == "approved" and (v.effective_date or "") <= d]
    return max(ok, key=lambda v: v.number) if ok else None


def scheduled_version(db: Session, notice_id: str, rows: list | None = None):
    """An approved version waiting for its effective date."""
    d = today().isoformat()
    vs = rows if rows is not None else versions_of(db, notice_id)
    ok = [v for v in vs if v.status == "approved" and (v.effective_date or "") > d]
    return min(ok, key=lambda v: v.effective_date) if ok else None


def ack_baseline(db: Session, notice_id: str, rows: list | None = None):
    """The version an acknowledgment must be of (or newer): the newest MAJOR
    live-or-older approved version. A minor fix (a phone number) does not ask
    everyone again."""
    live = live_version(db, notice_id, rows=rows)
    if live is None:
        return None
    vs = rows if rows is not None else versions_of(db, notice_id)
    majors = [v for v in vs if v.status == "approved" and v.major and v.number <= live.number]
    return max(majors, key=lambda v: v.number) if majors else live


# ── Places ───────────────────────────────────────────────────────────────────

_SKIP = {"united states", "united states of america", "usa", "us"}


def city_from_address(addr: str) -> str:
    """The city in a US address ("25260 N Centre City Pkwy, Escondido, CA 92026"
    -> "ESCONDIDO"; "..., Temecula, California, 92592, United States" ->
    "TEMECULA"). Upper case; '' when it cannot be read."""
    parts = [p.strip() for p in (addr or "").split(",") if p.strip()]
    for i in range(len(parts) - 1, 0, -1):
        p = re.sub(r"\s*\d{5}(-\d{4})?$", "", parts[i]).strip()
        if not p or p.lower() in _SKIP or p.isdigit():
            continue
        if p.lower() in work_state.STATES or (len(p) == 2 and p.upper() in work_state.ABBRS):
            city = parts[i - 1].strip()
            return "" if any(ch.isdigit() for ch in city) else city.upper()
        return ""
    return ""


def site_info(db: Session, ctx: dict | None = None) -> dict:
    """{site_id: {name, address, state, city, kind, lead}} for every Location
    Library site, with the Notices settings laid over it."""
    if ctx is not None and "siteInfo" in ctx:
        return ctx["siteInfo"]
    extra = {r.site_id: r for r in db.query(models.WorkplaceNoticeSite).all()}
    out = {}
    for s in db.query(models.HrWorkSite).all():
        x = extra.get(s.id)
        out[s.id] = {"id": s.id, "name": s.name or "", "address": s.address or "",
                     "state": work_state.state_from_address(s.address),
                     "city": ((x.city if x else "") or city_from_address(s.address)).strip().upper(),
                     "kind": (x.kind if x else "") or "", "lead": (x.lead_email if x else "") or ""}
    if ctx is not None:
        ctx["siteInfo"] = out
    return out


def _person_sites(db: Session, emp, ctx: dict | None) -> list:
    ids = work_state._allowed_site_ids(emp)
    if ids:
        return ids
    em = norm(emp.work_email)
    if not em:
        return []
    if ctx is not None and em in ctx.get("preloaded", ()):
        return sorted(ctx["punchSites"].get(em, set()))
    return sorted({r[0] for r in db.query(models.TimePunch.work_site_id)
                   .filter(models.TimePunch.employee_email == em, models.TimePunch.work_site_id != "")
                   .distinct().all()})


def _countries(db: Session, ctx: dict | None) -> dict:
    if ctx is not None and "countries" in ctx:
        return ctx["countries"]
    out = {i: (c or "US").strip().upper() for i, c in db.query(models.HrEntity.id, models.HrEntity.country).all()}
    if ctx is not None:
        ctx["countries"] = out
    return out


def headcounts(db: Session, ctx: dict | None = None) -> dict:
    """{company_id: employees} for active US-style employees (contractors are
    not employees), plus "_all" = every US company together."""
    if ctx is not None and "headcounts" in ctx:
        return ctx["headcounts"]
    countries = _countries(db, ctx)
    out: dict = {}
    for cid, n in (db.query(models.NexusEmployee.company, func.count(models.NexusEmployee.id))
                   .filter(models.NexusEmployee.status.in_(ACTIVE_STATUSES),
                           models.NexusEmployee.employment_type != "contractor",
                           (models.NexusEmployee.deleted_at == "") | (models.NexusEmployee.deleted_at.is_(None)))
                   .group_by(models.NexusEmployee.company).all()):
        out[cid or ""] = int(n)
    out["_all"] = sum(n for cid, n in out.items() if countries.get(cid, "US") == "US")
    if ctx is not None:
        ctx["headcounts"] = out
    return out


def _hourly(db: Session, email: str, ctx: dict | None) -> bool:
    if ctx is not None and "payTypes" in ctx:
        return ctx["payTypes"].get(email, "hourly") == "hourly"
    r = db.query(models.PayrollRate.pay_type).filter(models.PayrollRate.employee_email == email).first()
    return ((r[0] if r else "") or "hourly") == "hourly"


def preload(db: Session, emps) -> dict:
    """Everything person_context reads, for a whole roster in a few queries."""
    ctx = work_state.preload(db, [e.work_email for e in emps])
    site_info(db, ctx)
    _countries(db, ctx)
    headcounts(db, ctx)
    ctx["payTypes"] = {norm(e): (p or "hourly") for e, p in
                       db.query(models.PayrollRate.employee_email, models.PayrollRate.pay_type).all()}
    ctx["people"] = {r.email: r for r in db.query(models.WorkplaceNoticePerson).all()}
    return ctx


def person_context(db: Session, emp, ctx: dict | None = None) -> dict:
    """The facts the rules read, for one NexusEmployee."""
    em = norm(emp.work_email)
    countries = _countries(db, ctx)
    country = countries.get(emp.company or "", "") or ((emp.country or "US").strip().upper()[:2] or "US")
    if country in ("IN", "INDIA"):
        country = "IN"
    over = (ctx["people"].get(em) if ctx is not None and "people" in ctx
            else db.get(models.WorkplaceNoticePerson, em) if em else None)
    sites = site_info(db, ctx)
    sids = [s for s in _person_sites(db, emp, ctx) if s in sites]
    if over is not None and (over.notice_state or "").strip():
        st = {"state": over.notice_state.strip().upper(), "label": "Set by HR (Notice Location)", "source": "hr"}
    elif country == "US":
        st = work_state.resolve(db, emp, ctx)
    else:
        st = {"state": "", "label": "", "source": ""}
    cities = sorted({sites[s]["city"] for s in sids if sites[s]["city"] and sites[s]["state"] == st["state"]})
    if over is not None and (over.notice_city or "").strip():
        cities = [over.notice_city.strip().upper()]
    hc = headcounts(db, ctx)
    return {
        "email": em, "company": emp.company or "", "country": country,
        "workerType": "contractor" if (emp.employment_type or "") == "contractor" else "employee",
        "state": st["state"], "stateLabel": st["label"], "stateSource": st["source"],
        "cities": cities, "siteIds": sids,
        "siteKinds": sorted({sites[s]["kind"] for s in sids if sites[s]["kind"]}),
        "headcount": hc.get(emp.company or "", 0), "headcountAll": hc.get("_all", 0),
        "hourly": _hourly(db, em, ctx),
        "language": ((over.language if over else "") or "en"),
        "status": emp.status or "active", "startDate": emp.start_date or "",
    }


# ── The rule ─────────────────────────────────────────────────────────────────

def area_matches(area: str, country: str, state: str, cities) -> bool:
    a = (area or "US").strip().upper()
    if a == "IN":
        return country == "IN"
    if country != "US":
        return False
    if a == "US":
        return True
    m = re.match(r"^US-([A-Z]{2})(?::(.+))?$", a)
    if not m:
        return False
    if m.group(1) != (state or ""):
        return False
    return not m.group(2) or m.group(2).strip() in {c.upper() for c in cities or []}


def in_window(window, on: date) -> bool:
    if not window or len(window) != 2:
        return True
    md = on.strftime("%m-%d")
    lo, hi = window
    return lo <= md <= hi if lo <= hi else (md >= lo or md <= hi)


def election_active(elections, on: date) -> bool:
    """Time Off to Vote: from 10 days before a statewide election through it."""
    for e in elections or []:
        try:
            d = date.fromisoformat(str(e))
        except ValueError:
            continue
        if 0 <= (d - on).days <= 10:
            return True
    return False


def applies(notice, pc: dict, cfg: dict) -> bool:
    """Is this notice for this person at all (any trigger)?"""
    if (getattr(notice, "status", "active") or "active") != "active":
        return False
    rule = getattr(notice, "applies", None) or {}
    if pc["workerType"] not in (rule.get("workerTypes") or ["employee"]):
        return False
    if not area_matches(notice.area, pc["country"], pc["state"], pc["cities"]):
        return False
    if pc["state"] and pc["state"] in (rule.get("notStates") or []):
        return False
    need = int(rule.get("minHeadcount") or 0)
    if need:
        hc = pc["headcountAll"] if cfg.get("countCompaniesTogether") else pc["headcount"]
        if hc < need:
            return False
    kinds = rule.get("siteKinds") or []
    # a person whose sites have no kind yet gets them all - extra posters harm
    # nobody, a missing one is the risk (HR sees the sites to classify)
    if kinds and pc["siteKinds"] and not set(kinds) & set(pc["siteKinds"]):
        return False
    if rule.get("hourlyOnly") and not pc["hourly"]:
        return False
    for k, v in (rule.get("settingIs") or {}).items():
        if cfg.get(k) != v:
            return False
    return True


def shown_now(notice, cfg: dict, on: date | None = None) -> bool:
    """Is a posted notice on the wall right now (seasonal and election ones
    come and go)? Deliver-only and event notices are never 'on the wall'."""
    d = on or today()
    if notice.mode not in ("post", "both", "read"):
        return False
    if notice.trigger == "window":
        return in_window(notice.window, d)
    if notice.trigger == "election":
        return election_active(cfg.get("elections"), d)
    return notice.trigger in ("always", "")


def notices_for(db: Session, emp, ctx: dict | None = None, cfg: dict | None = None,
                rows: list | None = None) -> tuple[dict, list]:
    """(person context, the active notices that apply to them)."""
    cfg = cfg or settings(db)
    pc = person_context(db, emp, ctx)
    rows = rows if rows is not None else db.query(models.WorkplaceNotice).filter(
        models.WorkplaceNotice.status == "active").order_by(models.WorkplaceNotice.sort).all()
    return pc, [n for n in rows if applies(n, pc, cfg)]


def site_notices(db: Session, site_id: str, cfg: dict | None = None, rows: list | None = None,
                 ctx: dict | None = None) -> list:
    """The paper posters a site needs right now: posted notices for the site's
    state and city, its kind, and the largest headcount among the companies
    that use it."""
    cfg = cfg or settings(db)
    s = site_info(db, ctx).get(site_id)
    if not s or not s["state"]:
        return []
    hc = headcounts(db, ctx)
    cos = [r[0] for r in db.query(models.HrCompanyWorkSite.company_id)
           .filter(models.HrCompanyWorkSite.site_id == site_id).all()]
    pc = {"workerType": "employee", "country": "US", "state": s["state"], "cities": [s["city"]] if s["city"] else [],
          "siteKinds": [s["kind"]] if s["kind"] else [], "hourly": True,
          "headcount": max([hc.get(c, 0) for c in cos] or [0]), "headcountAll": hc.get("_all", 0)}
    rows = rows if rows is not None else db.query(models.WorkplaceNotice).filter(
        models.WorkplaceNotice.status == "active").order_by(models.WorkplaceNotice.sort).all()
    return [n for n in rows if n.mode in ("post", "both") and n.kind not in DOC_KINDS
            and applies(n, pc, cfg) and shown_now(n, cfg)]


def unplaced(db: Session, ctx: dict | None = None) -> list:
    """US employees Nexus cannot place in a state - HR's Location Unknown list."""
    emps = active_people(db)
    ctx = ctx or preload(db, emps)
    out = []
    for e in emps:
        pc = person_context(db, e, ctx)
        if pc["country"] == "US" and pc["workerType"] == "employee" and not pc["state"]:
            out.append({"email": pc["email"], "name": person_name(e), "label": pc["stateLabel"]})
    return out


def active_people(db: Session) -> list:
    return (db.query(models.NexusEmployee)
            .filter(models.NexusEmployee.status.in_(ACTIVE_STATUSES), models.NexusEmployee.work_email != "",
                    (models.NexusEmployee.deleted_at == "") | (models.NexusEmployee.deleted_at.is_(None)),
                    func.coalesce(models.NexusEmployee.identity_type, "internal") != "guest")
            .all())


def person_name(e) -> str:
    return work_state._name(e)


# ── Acknowledgments ──────────────────────────────────────────────────────────
# A manual, addendum, policy or contractor code with requires_ack needs one
# acknowledgment of its current MAJOR version from each person it applies to.
# With yearlyAck on (Neil, Oct 22 2026: "everyone re-acknowledges the manual
# every January") that acknowledgment must also be from this calendar year.

def _d(iso: str):
    try:
        return date.fromisoformat(str(iso)[:10])
    except (TypeError, ValueError):
        return None


def my_acks(db: Session, email: str) -> dict:
    """{notice_id: [delivery rows with acknowledged_at]} for one person."""
    out: dict = {}
    for r in (db.query(models.WorkplaceNoticeDelivery)
              .filter(models.WorkplaceNoticeDelivery.email == norm(email),
                      models.WorkplaceNoticeDelivery.acknowledged_at != "").all()):
        out.setdefault(r.notice_id, []).append(r)
    return out


def ack_state(db: Session, notice, pc: dict, cfg: dict, rows: list, acks: list, numbers: dict,
              on: date | None = None) -> dict:
    """{required, done, ackedAt, ackedVersion, due, overdue, reason} for one
    person and one acknowledgment notice. `numbers` = {version_id: number}."""
    d = on or today()
    out = {"required": False, "done": False, "ackedAt": "", "ackedVersion": "", "due": "", "overdue": False,
           "reason": ""}
    if not notice.requires_ack or notice.kind not in ACK_KINDS:
        return out
    base = ack_baseline(db, notice.id, rows=rows)
    if base is None:
        return out
    out["required"] = True
    year_start = date(d.year, 1, 1)
    valid = [a for a in acks if numbers.get(a.version_id, 0) >= base.number]
    if cfg.get("yearlyAck"):
        this_year = [a for a in valid if (_d(a.acknowledged_at) or date.min) >= year_start]
    else:
        this_year = valid
    if this_year:
        best = max(this_year, key=lambda a: a.acknowledged_at)
        out.update(done=True, ackedAt=best.acknowledged_at, ackedVersion=best.version_id)
        return out
    days = int(cfg.get("ackDueDays") or 14)
    eff = _d(base.effective_date) or d
    candidates = [eff + timedelta(days=days)]
    start = _d(pc.get("startDate"))
    if start:
        candidates.append(start + timedelta(days=days))
    if valid and cfg.get("yearlyAck"):
        # acknowledged this version before - only the January round is owed
        candidates.append(year_start + timedelta(days=int(cfg.get("yearlyAckDueDays") or 31)))
        out["reason"] = "yearly"
    else:
        out["reason"] = "new_version" if acks else "first"
    due = max(candidates)
    out.update(due=due.isoformat(), overdue=due < d)
    return out


def version_numbers(db: Session) -> dict:
    return {i: n for i, n in db.query(models.WorkplaceNoticeVersion.id, models.WorkplaceNoticeVersion.number).all()}


def owed(db: Session, emp, ctx: dict | None = None, cfg: dict | None = None, rows_by: dict | None = None,
         notice_rows: list | None = None, numbers: dict | None = None) -> list:
    """[(notice, ack_state)] this person still has to acknowledge."""
    cfg = cfg or settings(db)
    pc, ns = notices_for(db, emp, ctx, cfg, notice_rows)
    acks = my_acks(db, pc["email"])
    numbers = numbers if numbers is not None else version_numbers(db)
    out = []
    for n in ns:
        if not n.requires_ack or n.kind not in ACK_KINDS:
            continue
        rows = rows_by.get(n.id, []) if rows_by is not None else versions_of(db, n.id)
        st = ack_state(db, n, pc, cfg, rows, acks.get(n.id, []), numbers)
        if st["required"] and not st["done"]:
            out.append((n, st))
    return out
