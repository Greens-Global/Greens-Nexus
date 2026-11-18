"""New sign-in notices (Neil, 11/02/2026): "people [should] know when their
account is logged in to a new location."

Every BFF sign-in - an employee's Entra callback (routers/auth_bff.py) and a
guest's passwordless code (routers/external_auth.py) - calls `watch` with the
new session's id, the caller's trusted address (client_ip.client_ip, never
the first X-Forwarded-For hop) and the browser's User-Agent. It:

  1. `record`s the sign-in in nexus_sign_ins (device gloss from ua_summary,
     approximate location from ip_location, a `device_key` = sha256 of the
     gloss + the address's /24 or /48) and stamps the same facts on the
     server_sessions row so My Profile > Security can show where each live
     session is. `is_new` when this person has signed in before AND no
     sign-in of theirs in the last WINDOW_DAYS carried the same device_key -
     the very first sign-in ever is never "new".
  2. `notify_new` for a new device: ONE bell to the person (each new sign-in
     matters - never rolled up) and one email with the same facts, sent off
     the request after commit. The Web Push follows the bell (push.py).

Rules: never block or delay the sign-in - `watch` cannot raise; the email
and the bell never carry the session id; US dates and 12-hour times in the
PERSON's own zone (`person_zone`: their latest punch, else their People
country, else the company's saved shift time zone - "(Pacific time)" when
nothing says); the location is left out of the sentence when it is unknown,
never "Unknown".

`sweep` (the Workflows > Automations job "sign_in_watch", daily, deployed
worker only) removes server_sessions rows idle past Settings > Security's
limit and sign-ins older than WINDOW_DAYS.
"""
import asyncio
import hashlib
import ipaddress
import json
import threading
import uuid
from datetime import datetime, timedelta, timezone
from html import escape

from sqlalchemy import event as sa_event, text

import ip_location
import job_switch
import ua_summary
from company_time import PACIFIC
from models import NexusNotification, NexusSignIn, ServerSession

WINDOW_DAYS = 180
TITLE = "New Sign-In To Nexus"
NOT_YOU = "Not you? Open Profile > Security and sign out other devices."   # the menu says Profile
ACTION = {"view": "profile", "sub": "security", "label": "Open Security", "url": "/?profile=security"}
_LOCK_KEY = 794217     # stable advisory-lock id (notification retention is 794216)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse(iso: str):
    try:
        d = datetime.fromisoformat((iso or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def person_zone(db, email: str):
    """The zone this person's clock reads in (a ZoneInfo), or None when nothing
    says. The same facts timeclock._employee_zone_key reads: their latest
    punch's offset (IST is -330 in JS getTimezoneOffset terms, anything else
    is Pacific), else their People country, else the shift time zone their
    company (or the tenant) SAVED under Settings > Shifts & Scheduling - the
    unsaved default is not a fact about the person."""
    try:
        from sqlalchemy import func
        from zoneinfo import ZoneInfo

        from models import NexusEmployee, TimePunch
        from routers.shift_requests import _saved_settings
        from routers.timeclock import _ZONE_KEY_TZ
        email = (email or "").strip().lower()
        # The zone the person set for themselves wins (person_zone.py, 11/13/2026).
        import person_zone as _own_zone
        own = _own_zone.stored(db, email)
        if own:
            return ZoneInfo(own)
        p = (db.query(TimePunch.tz_offset_min).filter(TimePunch.employee_email == email)
             .order_by(TimePunch.at.desc()).first())
        if p is not None and p[0] is not None:
            return ZoneInfo(_ZONE_KEY_TZ["india" if int(p[0]) == -330 else "california"])
        emp = (db.query(NexusEmployee.country, NexusEmployee.company)
               .filter(func.lower(NexusEmployee.work_email) == email).first())
        country = ((emp[0] if emp else "") or "").strip().upper()
        if country in ("IN", "INDIA"):
            return ZoneInfo(_ZONE_KEY_TZ["india"])
        if country in ("US", "USA", "UNITED STATES"):
            return ZoneInfo(_ZONE_KEY_TZ["california"])
        company = ((emp[1] if emp else "") or "").strip()
        saved = {**_saved_settings(db), **(_saved_settings(db, company) if company else {})}
        tz = (saved.get("timeZone") or "").strip()
        return ZoneInfo(tz) if tz else None
    except Exception:   # noqa: BLE001 - a zone is a nicety; the notice goes out either way
        return None


def when_text(iso: str, zone=None) -> str:
    """'Mon 11/02/2026 8:33 AM PST' in the person's own zone (`zone`, a
    ZoneInfo), US format with the zone's short name; with no zone known the
    stamp is Pacific and says so in words - "(Pacific time)", never a bare
    abbreviation."""
    d = _parse(iso)
    if d is None:
        return ""
    local = d.astimezone(zone or PACIFIC)
    stamp = f"{local.strftime('%a')} {local.strftime('%m/%d/%Y')} {local.strftime('%I:%M %p').lstrip('0')}"
    return f"{stamp} {local.strftime('%Z')}" if zone is not None else f"{stamp} (Pacific time)"


def device_key(summary: str, ip: str) -> str:
    """One browser on one network: the UA gloss plus the address's /24 (IPv4)
    or /48 (IPv6), so a home line's rotating address is still the same device."""
    ip = (ip or "").strip()
    try:
        addr = ipaddress.ip_address(ip)
        prefix = str(ipaddress.ip_network(f"{addr}/{24 if addr.version == 4 else 48}", strict=False))
    except ValueError:
        prefix = ip
    return hashlib.sha256(f"{summary or ''}|{prefix}".encode()).hexdigest()


def record(db, *, email: str, session_id: str, ip: str, user_agent: str) -> NexusSignIn:
    """Write the sign-in row, stamp the session, return the row (committed)."""
    email = (email or "").strip().lower()
    ip = (ip or "").strip()[:64]
    ua = (user_agent or "").strip()[:1000]
    summary = ua_summary.summarize(ua)
    location = ip_location.lookup(ip)
    key = device_key(summary, ip)
    since = (datetime.now(timezone.utc) - timedelta(days=WINDOW_DAYS)).isoformat()
    earlier = db.query(NexusSignIn.id).filter(NexusSignIn.email == email).first() is not None
    seen = earlier and (db.query(NexusSignIn.id)
                        .filter(NexusSignIn.email == email, NexusSignIn.device_key == key, NexusSignIn.at >= since)
                        .first() is not None)
    row = NexusSignIn(id=f"si_{uuid.uuid4().hex}", email=email, session_id=session_id or "", at=_now_iso(),
                      ip=ip, user_agent=ua, ua_summary=summary, location=location, device_key=key,
                      is_new=bool(earlier and not seen), notified=False)
    db.add(row)
    sess = db.query(ServerSession).filter(ServerSession.id == session_id).first() if session_id else None
    if sess is not None:
        sess.ip, sess.user_agent, sess.ua_summary, sess.location = ip, ua, summary, location
    db.commit()
    return row


def notice_body(row: NexusSignIn, zone=None) -> str:
    parts = [when_text(row.at, zone)]
    if row.location:
        parts.append(row.location)
    parts.append(row.ua_summary or "Unrecognized device")
    return " - ".join(p for p in parts if p) + ". " + NOT_YOU


def notify_new(db, row: NexusSignIn) -> None:
    """One bell and one email to the person for THIS sign-in."""
    from notify_company import notification_company
    to = (row.email or "").strip().lower()
    if not to:
        return
    zone = person_zone(db, to)
    db.add(NexusNotification(
        id=str(uuid.uuid4()), type="custom_alert", recipient=to, title=TITLE, body=notice_body(row, zone),
        ref_id=f"signin:{row.id}", item_name="", requested_by="sign_in_watch", action=json.dumps(ACTION),
        actioned=False, read_by="", company=notification_company(db, to), created_at=_now_iso(), priority=0))
    row.notified = True
    _mail_after_commit(db, [(to, TITLE, _email_html(db, to, row, zone))])
    db.commit()


def watch(db, *, email: str, session_id: str, ip: str, user_agent: str):
    """The one call the sign-in doors make. Never raises: a sign-in is never
    blocked or failed by its own notice."""
    try:
        row = record(db, email=email, session_id=session_id, ip=ip, user_agent=user_agent)
    except Exception as e:   # noqa: BLE001 - the sign-in itself is already done
        print(f"[sign-in-watch] record failed for {email}: {type(e).__name__}: {e}")
        try:
            db.rollback()
        except Exception:    # noqa: BLE001
            pass
        return None
    if row.is_new:
        try:
            notify_new(db, row)
        except Exception as e:   # noqa: BLE001
            print(f"[sign-in-watch] notice failed for {email}: {type(e).__name__}: {e}")
            try:
                db.rollback()
            except Exception:    # noqa: BLE001
                pass
    return row


# ── email ────────────────────────────────────────────────────────────────────

def _email_html(db, to: str, row: NexusSignIn, zone=None) -> str:
    """hr_probation._email_html's layout with the recipient's company logo
    (email_theme.logo_for - the one logo chain). Facts only - no session id."""
    import email_theme
    from app_url import app_url
    theme = email_theme.current()
    band = theme.color("#0f3d2e")
    url = f"{app_url()}/?profile=security"
    intro = (f"Your Nexus account was just signed in to from a device you had not used in the last "
             f"{WINDOW_DAYS} days. If this was you, there is nothing to do.")
    rows = [("When", when_text(row.at, zone)), ("Location", row.location or ""),
            ("Device", row.ua_summary or "Unrecognized device"), ("IP Address", row.ip or "")]
    cells = "".join(
        f'<tr><td style="padding:8px 12px;font-size:12px;color:#6b7280;width:130px;vertical-align:top;border-top:1px solid #e5e7eb">{escape(k)}</td>'
        f'<td style="padding:8px 12px;font-size:14px;color:#111827;border-top:1px solid #e5e7eb;white-space:pre-line">{escape(v)}</td></tr>'
        for k, v in rows if v)
    return f"""<div style="background:#f3f4f6;padding:28px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <table align="center" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-collapse:collapse">
    <tr><td style="background:{band};padding:16px 28px">{theme.logo_block(email_theme.logo_for(db, "", to))}</td></tr>
    <tr><td style="padding:24px 28px 0">
      <div style="font-size:20px;font-weight:600;color:#111827">{escape(TITLE)}</div>
      <div style="font-size:14px;line-height:1.55;color:#374151;margin-top:8px">{escape(intro)}</div>
    </td></tr>
    <tr><td style="padding:18px 28px 0">
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-top:none;border-collapse:collapse">{cells}</table>
    </td></tr>
    <tr><td style="padding:18px 28px 0;font-size:14px;line-height:1.55;color:#374151">
      {escape(NOT_YOU)} Then tell your administrator.
    </td></tr>
    <tr><td style="padding:24px 28px 28px">
      <a href="{escape(url)}" style="display:inline-block;padding:10px 22px;border-radius:4px;background:{band};color:#ffffff;text-decoration:none;font-weight:600;font-size:13px">Open Security</a>
    </td></tr>
    <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-size:11.5px;line-height:1.6;color:#6b7280">
      You get this because a device you had not used recently signed in to your Nexus account.{theme.footer_lines()}
    </td></tr>
  </table>
</div>"""


def send_emails(batch: list) -> None:
    """Off the request (a thread after commit). One failure never stops the
    rest; the bell is there either way."""
    import graph_mail
    for to, subject, html in batch:
        try:
            graph_mail.send_mail(from_email=graph_mail.DEFAULT_FROM_EMAIL, to=[to], cc=None, subject=subject, html=html)
        except Exception as e:   # noqa: BLE001 - mail never fails the sign-in
            print(f"[sign-in-watch] email to {to} failed: {type(e).__name__}: {e}")


def _deliver(batch: list) -> None:
    threading.Thread(target=send_emails, args=(list(batch),), daemon=True).start()


def _mail_after_commit(db, batch: list) -> None:
    if not batch:
        return
    sa_event.listen(db, "after_commit", lambda _s: _deliver(batch), once=True)


# ── the sweep ────────────────────────────────────────────────────────────────

def sweep(db) -> dict:
    """Delete server_sessions idle past Settings > Security's limit and
    sign-ins older than WINDOW_DAYS. {"sessions": n, "signIns": m}."""
    if job_switch.off("sign_in_watch"):   # Workflows > Automations switch
        return {"sessions": 0, "signIns": 0}
    import bff_session
    now = datetime.now(timezone.utc)
    idle_cut = (now - timedelta(days=bff_session.session_idle_days(db))).isoformat()
    old_cut = (now - timedelta(days=WINDOW_DAYS)).isoformat()
    # The stamps are UTC ISO strings, so lexicographic < is chronological <.
    n = (db.query(ServerSession)
         .filter(ServerSession.last_seen != "", ServerSession.last_seen < idle_cut)
         .delete(synchronize_session=False))
    m = (db.query(NexusSignIn).filter(NexusSignIn.at < old_cut).delete(synchronize_session=False))
    db.commit()
    return {"sessions": int(n or 0), "signIns": int(m or 0)}


def _sweep_once() -> dict:
    from database import SessionLocal
    db = SessionLocal()
    is_pg = db.bind.dialect.name == "postgresql"
    try:
        if is_pg and not db.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": _LOCK_KEY}).scalar():
            return {"sessions": 0, "signIns": 0}   # another worker holds it
        try:
            return sweep(db)
        finally:
            if is_pg:
                db.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _LOCK_KEY})
                db.commit()
    finally:
        db.close()


async def sign_in_watch_loop():
    """Daily-ish, off the event loop (notification_retention_loop's shape)."""
    await asyncio.sleep(300)   # let startup settle
    while True:
        try:
            out = await asyncio.to_thread(_sweep_once)
            if out["sessions"] or out["signIns"]:
                print(f"[sign-in-watch] removed {out['sessions']} idle session(s) and "
                      f"{out['signIns']} sign-in(s) past {WINDOW_DAYS} days")
            await asyncio.sleep(6 * 3600)
        except Exception as e:   # noqa: BLE001
            print(f"[sign-in-watch] sweep failed: {e}")
            await asyncio.sleep(600)
