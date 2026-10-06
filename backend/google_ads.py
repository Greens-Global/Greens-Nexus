"""Google Ads in Nexus (Marketing, plan Phase 3). Read-only.

What it does: mirror spend, clicks, impressions and conversions per campaign
per day (and per bought keyword per day) from every Google Ads account the
connection can see, so Marketing > Google Ads shows the real figures and
budget pacing compares real spend with the budgets saved here. Nexus never
creates, edits or pauses a campaign - those buttons open Google Ads.

How it hangs together:
  - ONE Google account (with access to the Ads manager account) is connected
    once by an administrator - the same OAuth client as Business Profile,
    its own callback and its own MarketingIntegrationToken row ("google_ads").
  - Every sync re-discovers the accounts (a newly linked one just appears):
    the manager accounts the Google account reaches, then the accounts under
    them, plus any it reaches directly.
  - Daily rows: a new account backfills FIRST_DAYS, after that each sync
    re-reads the last REFRESH_DAYS - conversions are credited days or weeks
    after the click, so recent days keep changing. The window is replaced as
    a whole: a day Google no longer reports must not linger.
  - Campaigns are mapped to a facility by hand (Google has no idea what our
    facilities are); an unmapped campaign counts as "Unassigned".

google_ads_client.py does the HTTP; this module owns the database.
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
from datetime import date, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

import gbp_client
import google_ads_client as gac
import models
import secret_box
from gbp_client import GbpError
from routers.task_util import now_iso

CONN_ID = "google_ads"
STATE_TTL = 10 * 60
SYNC_EVERY_SEC = 2 * 3600   # budget pacing wants today's spend reasonably fresh
SYNC_MIN_GAP_SEC = 60
FIRST_DAYS = 425            # a new account: about 14 months, so a year-on-year month compares
REFRESH_DAYS = 30           # conversions keep landing on recent days
UNASSIGNED = "Unassigned"
MAX_BUDGET = 10_000_000
PLATFORM = {
    "SEARCH": "Google Search", "DISPLAY": "Google Display", "VIDEO": "YouTube Ads",
    "PERFORMANCE_MAX": "Performance Max", "LOCAL": "Google Local", "SMART": "Smart Campaign",
    "SHOPPING": "Google Shopping", "DEMAND_GEN": "Demand Gen", "DISCOVERY": "Demand Gen",
    "MULTI_CHANNEL": "App Campaign", "LOCAL_SERVICES": "Local Services",
}

_sync_lock = threading.Lock()


# ── OAuth state (sealed and expiring, as gbp.issue_state; tagged "ads") ───────

def issue_state(email: str) -> str:
    return secret_box.encrypt(json.dumps({"p": "ads", "e": (email or "").lower(), "x": int(time.time()) + STATE_TTL}))


def consume_state(state: str) -> str:
    try:
        d = json.loads(secret_box.decrypt(state or ""))
    except (ValueError, TypeError):
        return ""
    if d.get("p") != "ads":
        return ""
    return d.get("e", "") if int(d.get("x") or 0) >= time.time() else ""


# ── The connection ────────────────────────────────────────────────────────────

def get_connection(db: Session):
    return db.get(models.MarketingIntegrationToken, CONN_ID)


def _token(db: Session) -> tuple:
    conn = get_connection(db)
    if not conn or not conn.refresh_token_enc:
        raise GbpError("No Google Ads account is connected yet.", 409)
    try:
        refresh = secret_box.decrypt(conn.refresh_token_enc)
    except ValueError:
        raise GbpError("The stored Google Ads connection cannot be read - reconnect it.", 409)
    try:
        return conn, gbp_client.access_token(refresh)
    except GbpError as e:
        if e.status == 401:
            conn.last_error = str(e)[:500]
            db.commit()
        raise


def _active_accounts(db: Session) -> list:
    return db.query(models.MarketingAdsAccount).filter(models.MarketingAdsAccount.active.is_(True)).all()


def status(db: Session) -> dict:
    conn = get_connection(db)
    connected = bool(conn and conn.refresh_token_enc)
    accounts = _active_accounts(db) if connected else []
    ids = [a.id for a in accounts]
    camps = (db.query(models.MarketingAdsCampaign).filter(models.MarketingAdsCampaign.customer_id.in_(ids),
                                                          models.MarketingAdsCampaign.status != "REMOVED").all()
             if ids else [])
    return {
        "configured": not gac.not_configured_reason(),
        "notConfiguredReason": gac.not_configured_reason(),
        "redirectUri": gac.redirect_uri(),
        "connected": connected,
        "accountEmail": conn.account_email if connected else "",
        "accountLabel": conn.account_label if connected else "",
        "connectedBy": conn.connected_by if connected else "",
        "connectedAt": conn.connected_at if connected else "",
        "lastSyncAt": conn.last_sync_at if connected else "",
        "lastError": conn.last_error if connected else "",
        "needsReconnect": bool(connected and gbp_client.RECONNECT in (conn.last_error or "")),
        "accounts": [{"id": a.id, "name": a.name, "currency": a.currency} for a in accounts],
        "campaignCount": len(camps),
        "unmappedCount": sum(1 for c in camps if not c.facility_name),
    }


def connect(db: Session, code: str, admin_email: str) -> dict:
    """Finish the OAuth flow, keep the refresh token, then sync once (which
    also finds the Ads accounts)."""
    tok = gbp_client.exchange_code(code, gac.redirect_uri())
    refresh = tok.get("refresh_token") or ""
    if not refresh:
        raise GbpError("Google did not grant offline access. Remove Nexus from the Google account's "
                       "third-party access and connect again.", 400)
    access = tok.get("access_token") or gbp_client.access_token(refresh)
    email = gbp_client.account_email(access)
    conn = get_connection(db) or models.MarketingIntegrationToken(id=CONN_ID)
    old = conn.refresh_token_enc
    conn.account_email, conn.account_name, conn.account_label = email, "", ""
    conn.refresh_token_enc, conn.scope = secret_box.encrypt(refresh), tok.get("scope") or ""
    conn.connected_by, conn.connected_at, conn.last_error = (admin_email or "").lower(), now_iso(), ""
    db.merge(conn)
    db.commit()
    if old:
        try:
            gbp_client.forget(secret_box.decrypt(old))
        except ValueError:
            pass
    return sync(db, force=True)


def disconnect(db: Session) -> None:
    """Revoke at Google and forget the token. Synced figures, the facility
    mapping and the budgets stay."""
    conn = get_connection(db)
    if not conn:
        return
    try:
        gbp_client.revoke(secret_box.decrypt(conn.refresh_token_enc or ""))
    except ValueError:
        pass
    conn.refresh_token_enc, conn.last_error = "", ""
    db.commit()


# ── Sync ──────────────────────────────────────────────────────────────────────

def _discover(token: str) -> tuple:
    """(label, {customer id: {name, currency, manager_id}}): every
    non-manager account reachable, through a manager account where there is
    one. GOOGLE_ADS_LOGIN_CUSTOMER_ID pins the manager when set."""
    override = gac.login_customer_override()
    managers, direct, errors = [], [], []
    if override:
        managers = [(override, "")]
    else:
        for cid in gac.accessible_customers(token):
            try:
                info = gac.customer_info(token, cid)
            except GbpError as e:
                errors.append(e)    # e.g. a cancelled account - the others still count
                continue
            name = info.get("descriptiveName") or ""
            if info.get("manager"):
                managers.append((cid, name))
            else:
                direct.append((cid, name, info.get("currencyCode") or ""))
    found = {}
    for mid, _ in managers:
        for c in gac.client_accounts(token, mid):
            cid = gac.clean_id(c.get("id"))
            if cid and not c.get("manager") and (c.get("status") or "ENABLED") == "ENABLED":
                found.setdefault(cid, {"name": c.get("descriptiveName") or "", "currency": c.get("currencyCode") or "",
                                       "manager_id": mid})
    for cid, name, currency in direct:
        found.setdefault(cid, {"name": name, "currency": currency, "manager_id": ""})
    if not found:
        if errors:
            raise errors[0]
        raise GbpError("The connected Google account cannot see any Google Ads account. Give it access in the "
                       "manager account (Admin > Access and security), then sync again.", 400)
    label = (managers[0][1] if managers else "") or next(iter(found.values()))["name"]
    return label, found


def sync(db: Session, *, force: bool = False) -> dict:
    if not _sync_lock.acquire(timeout=180):
        raise GbpError("A Google Ads sync is already running - try again in a minute.", 409)
    try:
        return _sync(db, force)
    finally:
        _sync_lock.release()


def _sync(db: Session, force: bool) -> dict:
    from gbp import _recent
    db.expire_all()
    conn = get_connection(db)
    if not force and conn and not conn.last_error and _recent(conn.last_sync_at, SYNC_MIN_GAP_SEC):
        return {"skipped": True, "accounts": len(_active_accounts(db))}
    try:
        conn, token = _token(db)
        label, found = _discover(token)
    except GbpError as e:
        db.rollback()
        conn = get_connection(db)
        if conn:
            conn.last_error = str(e)[:500]
            db.commit()
        raise
    for a in db.query(models.MarketingAdsAccount).all():
        a.active = a.id in found
    for cid, info in found.items():
        row = db.get(models.MarketingAdsAccount, cid) or models.MarketingAdsAccount(id=cid)
        row.name, row.currency, row.manager_id, row.active = info["name"], info["currency"], info["manager_id"], True
        db.merge(row)
    conn.account_label = label
    db.commit()

    errors, days = [], 0
    for cid, info in found.items():
        try:
            days += _sync_account(db, token, cid, info["manager_id"])
        except GbpError as e:
            db.rollback()
            errors.append(f"{info['name'] or cid}: {e}")
            if e.status == 401:
                break
    conn = get_connection(db)
    conn.last_sync_at = now_iso()
    conn.last_error = "; ".join(errors)[:500]
    db.commit()
    if errors and len(errors) == len(found):
        raise GbpError(errors[0], 409 if "Test access" in errors[0] else 502)
    return {"accounts": len(found), "days": days, "errors": errors}


def _n(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _sync_account(db: Session, token: str, cid: str, manager: str) -> int:
    now = now_iso()
    for r in gac.campaigns(token, cid, manager):
        c, b = r.get("campaign") or {}, r.get("campaignBudget") or {}
        key = f"{cid}|{c.get('id')}"
        row = db.get(models.MarketingAdsCampaign, key) or models.MarketingAdsCampaign(
            id=key, customer_id=cid, campaign_id=str(c.get("id") or ""))
        row.name, row.status, row.serving = c.get("name") or "", c.get("status") or "", c.get("servingStatus") or ""
        row.channel, row.daily_budget = c.get("advertisingChannelType") or "", _n(b.get("amountMicros")) / 1e6
        row.synced_at = now
        db.merge(row)

    today = date.today()
    has_data = db.query(models.MarketingAdsDaily.id).filter(models.MarketingAdsDaily.customer_id == cid).first()
    start = (today - timedelta(days=REFRESH_DAYS if has_data else FIRST_DAYS)).isoformat()
    end = today.isoformat()
    daily = gac.campaign_days(token, cid, start, end, manager)
    words = gac.keyword_days(token, cid, start, end, manager)

    # Replace the window whole (see the module note).
    for model in (models.MarketingAdsDaily, models.MarketingAdsKeyword):
        db.query(model).filter(model.customer_id == cid, model.date >= start, model.date <= end) \
            .delete(synchronize_session=False)
    seen = set()
    for r in daily:
        camp, seg, m = str((r.get("campaign") or {}).get("id") or ""), r.get("segments") or {}, r.get("metrics") or {}
        key = f"{cid}|{camp}|{seg.get('date')}"
        if not camp or not seg.get("date") or key in seen:
            continue
        seen.add(key)
        db.add(models.MarketingAdsDaily(
            id=key, customer_id=cid, campaign_id=camp, date=seg["date"], impressions=int(_n(m.get("impressions"))),
            clicks=int(_n(m.get("clicks"))), conversions=_n(m.get("conversions")), cost=_n(m.get("costMicros")) / 1e6))
    kw: dict = {}
    for r in words:
        camp = str((r.get("campaign") or {}).get("id") or "")
        crit, seg, m = r.get("adGroupCriterion") or {}, r.get("segments") or {}, r.get("metrics") or {}
        key = f"{cid}|{camp}|{crit.get('criterionId')}|{seg.get('date')}"
        if not camp or not seg.get("date"):
            continue
        # The same keyword in two ad groups is two rows with one criterion id - add them up.
        row = kw.get(key) or models.MarketingAdsKeyword(
            id=key, customer_id=cid, campaign_id=camp, criterion_id=str(crit.get("criterionId") or ""),
            keyword=((crit.get("keyword") or {}).get("text") or "")[:300],
            match_type=(crit.get("keyword") or {}).get("matchType") or "", date=seg["date"],
            impressions=0, clicks=0, conversions=0.0, cost=0.0)
        row.impressions += int(_n(m.get("impressions")))
        row.clicks += int(_n(m.get("clicks")))
        row.conversions += _n(m.get("conversions"))
        row.cost += _n(m.get("costMicros")) / 1e6
        kw[key] = row
    db.add_all(kw.values())
    acct = db.get(models.MarketingAdsAccount, cid)
    if acct:
        acct.synced_at = now
    db.commit()
    return len(seen)


def sync_once() -> None:
    from database import SessionLocal
    db = SessionLocal()
    try:
        conn = get_connection(db)
        if conn and conn.refresh_token_enc:
            sync(db, force=True)
    except GbpError as e:
        print(f"[google-ads] sync failed: {e}")
    finally:
        db.close()


async def google_ads_sync_loop():
    """Started from main.py on the deployed API only; blocking work in a
    thread (CLAUDE.md)."""
    await asyncio.sleep(180)
    while True:
        try:
            await asyncio.to_thread(sync_once)
        except Exception as e:
            print(f"[google-ads] loop error: {e}")
        await asyncio.sleep(SYNC_EVERY_SEC)


# ── Reading it back ───────────────────────────────────────────────────────────

def _campaign_meta(db: Session) -> dict:
    return {c.id: c for c in db.query(models.MarketingAdsCampaign).all()}


def _status_label(c) -> str:
    if c is None or c.status == "REMOVED" or c.serving == "ENDED":
        return "Completed"
    return "Paused" if c.status == "PAUSED" else "Active"


def _blank() -> dict:
    return {"impressions": 0, "clicks": 0, "conversions": 0.0, "spend": 0.0}


def _add(acc: dict, r) -> None:
    acc["impressions"] += r.impressions or 0
    acc["clicks"] += r.clicks or 0
    acc["conversions"] += r.conversions or 0
    acc["spend"] += r.cost or 0


def _round(d: dict) -> dict:
    return {**d, "conversions": round(d["conversions"], 2), "spend": round(d["spend"], 2)}


def _dates(start: str, end: str) -> tuple:
    try:
        d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
    except ValueError:
        raise GbpError("Pick a valid date range.", 422)
    if d1 < d0 or (d1 - d0).days > 731:
        raise GbpError("Pick a range of up to two years.", 422)
    return d0, d1


def report(db: Session, start: str, end: str, facility: str = "") -> dict:
    """Everything Marketing > Google Ads shows for start..end, scoped to one
    facility when given, in the shapes the screen already uses:
      rows / prevRows   daily totals (prevRows = the same length just before)
      campaigns         per campaign over the range
      geoRows           per facility over the range (always every facility -
                        the screen filters it, and Compare reads it)
      keywordRows       bought keywords over the range
      monthSpend        this calendar month so far (budget pacing)."""
    d0, d1 = _dates(start, end)
    span = (d1 - d0).days + 1
    p0 = d0 - timedelta(days=span)
    meta = _campaign_meta(db)
    fac = {k: (c.facility_name or UNASSIGNED) for k, c in meta.items()}

    def in_scope(key: str) -> bool:
        return not facility or fac.get(key, UNASSIGNED) == facility

    today = date.today()
    month0 = today.replace(day=1).isoformat()
    lo = min(p0.isoformat(), month0)
    by_day, by_camp, by_fac, month_spend = {}, {}, {}, 0.0
    for r in db.query(models.MarketingAdsDaily).filter(models.MarketingAdsDaily.date >= lo,
                                                       models.MarketingAdsDaily.date <= max(d1.isoformat(), today.isoformat())):
        key = f"{r.customer_id}|{r.campaign_id}"
        inside = d0.isoformat() <= r.date <= d1.isoformat()
        if inside:
            _add(by_fac.setdefault(fac.get(key, UNASSIGNED), _blank()), r)
        if not in_scope(key):
            continue
        if r.date >= month0:
            month_spend += r.cost or 0
        if p0.isoformat() <= r.date <= d1.isoformat():
            _add(by_day.setdefault(r.date, _blank()), r)
        if inside:
            _add(by_camp.setdefault(key, _blank()), r)

    def rows(a: date, b: date) -> list:
        out, d = [], a
        while d <= b:
            out.append({"date": d.isoformat(), **_round(by_day.get(d.isoformat(), _blank()))})
            d += timedelta(days=1)
        return out

    campaigns = []
    for key in set(by_camp) | {k for k, c in meta.items() if c.status != "REMOVED" and in_scope(k)}:
        c = meta.get(key)
        st = _status_label(c)
        tot = by_camp.get(key, _blank())
        if st == "Completed" and not tot["impressions"] and not tot["spend"]:
            continue
        campaigns.append({
            "id": key, "name": (c.name if c else "") or f"Campaign {key.split('|')[-1]}",
            "platform": PLATFORM.get(c.channel if c else "", (c.channel if c else "").replace("_", " ").title() or "Google Ads"),
            "facility": fac.get(key, UNASSIGNED), "status": st,
            "dailyBudget": round(c.daily_budget or 0, 2) if c else 0, **_round(tot),
        })
    campaigns.sort(key=lambda x: -x["spend"])

    words: dict = {}
    kq = db.query(models.MarketingAdsKeyword).filter(models.MarketingAdsKeyword.date >= d0.isoformat(),
                                                     models.MarketingAdsKeyword.date <= d1.isoformat())
    for r in kq:
        if not in_scope(f"{r.customer_id}|{r.campaign_id}"):
            continue
        w = words.setdefault(r.keyword.lower(), {"keyword": r.keyword, **_blank()})
        _add(w, r)
    keywords = sorted((_round(w) for w in words.values()), key=lambda w: (-w["clicks"], -w["impressions"]))[:200]

    conn = get_connection(db)
    accounts = _active_accounts(db)
    return {
        "rows": rows(d0, d1), "prevRows": rows(p0, d0 - timedelta(days=1)),
        "campaigns": campaigns,
        "geoRows": [{"location": k, **_round(v)} for k, v in sorted(by_fac.items())],
        "keywordRows": keywords,
        "monthSpend": round(month_spend, 2),
        "firstDate": db.query(func.min(models.MarketingAdsDaily.date)).scalar() or "",
        "currency": accounts[0].currency if accounts else "",
        "syncedAt": conn.last_sync_at if conn else "",
        "error": conn.last_error if conn else "",
    }


def summary(db: Session) -> dict:
    """Real spend for Marketing's alerts bell and AI Analyst: this month so
    far, all of last month, and the campaigns this month."""
    conn = get_connection(db)
    if not (conn and conn.refresh_token_enc):
        return {"connected": False}
    today = date.today()
    month0 = today.replace(day=1)
    prev0 = (month0 - timedelta(days=1)).replace(day=1)
    meta = _campaign_meta(db)
    month, prev, camps = 0.0, 0.0, {}
    for r in db.query(models.MarketingAdsDaily).filter(models.MarketingAdsDaily.date >= prev0.isoformat()):
        if r.date >= month0.isoformat():
            month += r.cost or 0
            _add(camps.setdefault(f"{r.customer_id}|{r.campaign_id}", _blank()), r)
        else:
            prev += r.cost or 0
    campaigns = []
    for key, tot in camps.items():
        c = meta.get(key)
        campaigns.append({"name": (c.name if c else "") or f"Campaign {key.split('|')[-1]}",
                          "facility": (c.facility_name if c else "") or UNASSIGNED, "platform": "Google Ads",
                          "spend": round(tot["spend"], 2), "conversions": round(tot["conversions"], 2),
                          "status": _status_label(c)})
    return {"connected": True, "monthSpend": round(month, 2), "prevMonthSpend": round(prev, 2),
            "campaigns": sorted(campaigns, key=lambda x: -x["spend"]), "syncedAt": conn.last_sync_at}


def campaigns_for_mapping(db: Session) -> list:
    """Every live campaign with its facility, for the mapping screen."""
    ids = [a.id for a in _active_accounts(db)]
    if not ids:
        return []
    names = {a.id: a.name for a in _active_accounts(db)}
    rows = (db.query(models.MarketingAdsCampaign)
            .filter(models.MarketingAdsCampaign.customer_id.in_(ids), models.MarketingAdsCampaign.status != "REMOVED")
            .order_by(models.MarketingAdsCampaign.name).all())
    return [{"id": c.id, "customerId": c.customer_id, "campaignId": c.campaign_id, "account": names.get(c.customer_id, ""),
             "name": c.name, "status": _status_label(c), "platform": PLATFORM.get(c.channel, c.channel.title()),
             "facility": c.facility_name, "mappedBy": c.mapped_by, "mappedAt": c.mapped_at} for c in rows]


def map_campaigns(db: Session, changes: list, actor: str) -> list:
    """[{id, facility}] - '' clears a mapping."""
    if not isinstance(changes, list) or len(changes) > 1000:
        raise GbpError("Nothing to save.", 422)
    for ch in changes:
        c = db.get(models.MarketingAdsCampaign, str((ch or {}).get("id") or ""))
        if c is None:
            raise GbpError("One of those campaigns is no longer in Google Ads - reload and try again.", 404)
        fac = str(ch.get("facility") or "").strip()[:100]
        if fac == UNASSIGNED:
            fac = ""
        if fac != c.facility_name:
            c.facility_name, c.mapped_by, c.mapped_at = fac, (actor or "").lower(), now_iso()
    db.commit()
    return campaigns_for_mapping(db)


def get_budgets(db: Session) -> dict:
    return {b.facility_name: b.monthly_budget or 0 for b in db.query(models.MarketingAdBudget).all()}


def set_budgets(db: Session, budgets: dict, actor: str) -> dict:
    if not isinstance(budgets, dict) or not budgets or len(budgets) > 200:
        raise GbpError("Nothing to save.", 422)
    for name, amount in budgets.items():
        name = str(name or "").strip()[:100]
        try:
            value = float(amount)
        except (TypeError, ValueError):
            raise GbpError(f"The budget for {name or 'a facility'} is not a number.", 422)
        if not name or value < 0 or value > MAX_BUDGET or value != value:
            raise GbpError(f"Enter a budget between $0 and ${MAX_BUDGET:,} for {name or 'each facility'}.", 422)
        row = db.get(models.MarketingAdBudget, name) or models.MarketingAdBudget(facility_name=name)
        row.monthly_budget, row.updated_by, row.updated_at = round(value, 2), (actor or "").lower(), now_iso()
        db.merge(row)
    db.commit()
    return get_budgets(db)
