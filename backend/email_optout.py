"""One-click stop for digest emails (11/02/2026, the legal compliance pass:
stopping something must be no harder than starting it).

The digests a person gets on a schedule now each carry a "Stop These Emails"
link. It opens Nexus at `/?stopEmail=<kind>`; the signed-in app asks one
question - "Stop the <digest> emails?" Stop / Keep - and shows Start It Again
after (Profile > Task Emails lists the same switches). The Weekly Ticket
Report switch is listed only for people it can go to (weekly_status). The link carries no token
and changes nothing by itself: the change is the signed-in app's PUT, so a
mail scanner that opens links cannot unsubscribe anyone.

  daily_briefing        the Daily Briefing           (new per-person switch)
  weekly_digest         the Weekly Digest            (new per-person switch)
  whats_new_digest      What's New weekly digest     (the existing Follow > digest flag)
  ticket_weekly_report  the Weekly Ticket Report     (the existing Weekly Email switch)

The first two are stored in NexusPersonPref.email_optouts; an administrator's
mode (Off / Test / Live) still decides whether the digest runs at all. The
other two reuse the switch their screen already has, so there is one truth.
Operational notices (a ticket you raised, a shift change, an announcement,
overdue training) are not digests and are not listed here.
"""
from datetime import datetime, timezone

import models

KINDS = {
    "daily_briefing": "Daily Briefing",
    "weekly_digest": "Weekly Digest",
    "whats_new_digest": "What's New Weekly Digest",
    "ticket_weekly_report": "Weekly Ticket Report",
}
_OWN = ("daily_briefing", "weekly_digest")   # stored in email_optouts


def _row(db, email: str, create: bool = False):
    email = (email or "").strip().lower()
    row = db.get(models.NexusPersonPref, email)
    if row is None and create:
        row = models.NexusPersonPref(email=email)
        db.add(row)
    return row


def _own_out(row) -> set:
    return {k for k in (getattr(row, "email_optouts", "") or "").split(",") if k in _OWN} if row else set()


def is_out(db, email: str, kind: str) -> bool:
    """Has this person stopped this digest? (daily_briefing / weekly_digest)"""
    return kind in _own_out(_row(db, email))


def prefs(db, email: str) -> dict:
    """{kind: {"label", "on"}} for every kind, as this person stands."""
    row = _row(db, email)
    out = {k: {"label": KINDS[k], "on": k not in _own_out(row)} for k in _OWN}
    sub = db.get(models.ChangelogSubscription, (email or "").strip().lower())
    out["whats_new_digest"] = {"label": KINDS["whats_new_digest"], "on": bool(sub and sub.digest)}
    # The Weekly Ticket Report only for people it can go to, showing what the
    # Reports tab shows (the effective value, the desk mode's default included).
    import ticket_reports
    try:
        st = ticket_reports.weekly_status(db, email)
    except Exception:
        st = {"eligible": False}
    if st.get("eligible"):
        out["ticket_weekly_report"] = {"label": KINDS["ticket_weekly_report"], "on": bool(st.get("on"))}
    return out


def set_on(db, email: str, kind: str, on: bool) -> dict:
    """Turn one digest on or off for this person. Commits."""
    if kind not in KINDS:
        raise ValueError("Unknown email")
    email = (email or "").strip().lower()
    now = datetime.now(timezone.utc).isoformat()
    if kind in _OWN:
        row = _row(db, email, create=True)
        out = _own_out(row)
        (out.discard if on else out.add)(kind)
        row.email_optouts = ",".join(sorted(out))
        row.updated_at = now
        db.commit()
    elif kind == "whats_new_digest":
        sub = db.get(models.ChangelogSubscription, email)
        if sub is None:
            sub = models.ChangelogSubscription(email=email, modules=[], categories=[], digest=False)
            db.add(sub)
        sub.digest = bool(on)
        sub.updated_at = now
        db.commit()
    else:
        import ticket_reports
        if not ticket_reports.weekly_status(db, email).get("eligible"):
            raise ValueError("The Weekly Ticket Report is not sent to you")
        ticket_reports.set_weekly_opt_in(db, email, on)
    return prefs(db, email)


def stop_url(kind: str) -> str:
    from app_url import app_url
    return f"{app_url()}/?stopEmail={kind}"


def stop_link_html(kind: str, color: str = "#6b7280") -> str:
    """The footer line every digest carries."""
    from html import escape
    return (f"<div style='margin-top:6px'><a href='{escape(stop_url(kind))}' "
            f"style='color:{color};text-decoration:underline'>Stop These Emails</a></div>")
