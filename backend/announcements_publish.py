"""Announcements reach (Neil, 11/02/2026): publish later + the notify choice.

An announcement is PUBLISHED when its audience hears about it. Two moments:

  bells     One bell notification per person in the audience
            (routers.announcements._notify_audience). A post due at create
            gets them in the create request, as before; a post scheduled for
            later gets them here, when it comes due.
  fan-out   What `notify` asks for beyond the bell, always done here, in the
            publish pass, never in a request (a company-wide email is ~180
            Graph calls):
              quiet       nothing more ("Bell" in the composer)
              push_teams  one Teams DM row per recipient ("Bell and Teams";
                          models.TicketTeamsMessage, kind 'announcement',
                          delivered by teams_post's sweep AS THE AUTHOR - an
                          author with no live session gets one bell saying
                          the Teams messages were not sent, and no rows)
              email       one themed mail per recipient (graph_mail), from the
                          task-notification mailbox, else NEXUS_FROM_EMAIL
            The Web Push is never sent from here: the bell IS the push
            (push.py's after_insert listener queues one for every bell row),
            in every mode. A second queue_push here doubled every phone.

Exactly once: `run_due` CLAIMS a row by a conditional UPDATE on
`notified_at` ('' -> now) and commits before anything is sent, so two workers
or a restart mid-pass never publish the same post twice. Bells are
idempotent too (recipients who already hold one are skipped), so a claim
that follows the create request's bells adds none. A publish that raises
gives the claim back (`notified_at` -> '') so the next pass retries; after
MAX_ATTEMPTS failures the row is stamped 'failed:<iso>' and left alone (the
count is in memory - a restart starts over, which is fine). Rows that
predate these columns carry notified_at '' from the migration default: the
migration backfills them (main.py) and, as a second guard, an immediate
post older than GRACE_MINUTES is never claimed - its bells went out at
create, before this module existed.

The loop runs every minute from main.py's lifespan, leader-gated like the
other `*_loop` tasks, in a thread (never blocking the event loop). A failure
on one recipient is logged and the rest go on; a failure on one row never
stops the pass.
"""
import asyncio
import uuid
from datetime import datetime, timezone
from html import escape

from sqlalchemy.orm import Session

import auth
import graph_mail
import job_switch
from app_url import app_url
from models import Announcement, NexusNotification, TicketTeamsMessage

SCAN_EVERY_SEC = 60
TEAMS_KIND = "announcement"
MODES = ("quiet", "push_teams", "email")
MAX_ATTEMPTS = 5          # publish failures before a row is stamped failed and left alone
GRACE_MINUTES = 10        # an immediate post older than this was belled at create: never re-publish
_attempts: dict = {}      # announcement id -> failed publish attempts (in memory, see module docstring)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_when(s: str):
    """An ISO timestamp -> aware UTC datetime; None for blank or unreadable.
    A naive value is taken as UTC; a trailing Z is accepted."""
    s = (s or "").strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def is_due(a: Announcement, now: str = "") -> bool:
    """Published-or-due: no publish time, or one at or before now. Compared
    as datetimes, never as strings (a seed or a hand-written row may carry
    another shape)."""
    when = parse_when(a.publish_at or "")
    if when is None:
        return True
    ref = parse_when(now) if now else None
    return when <= (ref or datetime.now(timezone.utc))


def _scope_for(db: Session, email: str):
    """The author's company reach, built the way a request would (their role
    level stands in for the request's user dict). Fails CLOSED: an error here
    means NO recipients (an empty scope), never the unrestricted None - a
    company-walled administrator's post must not reach the whole tenant
    because a lookup hiccuped."""
    try:
        return auth.company_scope({"email": email, "level": auth.level_for(email, db)}, db)
    except Exception as e:
        print(f"[announcements] scope lookup failed for {email}: {e} - publishing to nobody")
        return set()


# ── Message bodies ─────────────────────────────────────────────────────────

def _text_html(body: str) -> str:
    return escape(body or "").replace("\n", "<br>")


def _open_url() -> str:
    return app_url().rstrip("/") + "/"


def teams_html(a: Announcement, author_name: str) -> str:
    extra = ""
    if a.image_url:
        extra += "<br><i>Picture attached - open in Nexus to see it.</i>"
    if a.file_url:
        extra += f"<br><i>File: {escape(a.file_name or 'attachment')} - open in Nexus to download it.</i>"
    return (f"<b>Announcement: {escape(a.title or '')}</b><br>"
            f"{_text_html(a.body)}{extra}<br>"
            f"<a href=\"{escape(_open_url())}\">Open in Nexus</a>"
            + (f"<br><span style=\"color:#6b7280\">Posted by {escape(author_name)}</span>" if author_name else ""))


def email_html(db: Session, a: Announcement, author_name: str, recipient: str) -> str:
    """One themed mail. The picture and the file live in our PRIVATE storage,
    so the mail links to Nexus rather than to the files (a mail client holds
    no login)."""
    import email_theme
    th = email_theme.current()
    accent = th.color("#166534")
    logo = th.logo_block(email_theme.logo_for(db, "", recipient))
    font = "Inter, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    attach = ""
    if a.image_url:
        attach += (f'<div style="margin-top:14px;font-family:{font};font-size:13px;color:#6b7280">'
                   f'A picture is attached - open the post in Nexus to see it.</div>')
    if a.file_url:
        attach += (f'<div style="margin-top:8px;font-family:{font};font-size:13px;color:#6b7280">'
                   f'File: <b>{escape(a.file_name or "attachment")}</b> - open the post in Nexus to download it.</div>')
    who = f" by {escape(author_name)}" if author_name else ""
    return (
        f'<div style="background:#f6f7f9;padding:24px 12px">'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;'
        f'background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">'
        f'<tr><td style="padding:20px 28px 0">{logo}</td></tr>'
        f'<tr><td style="padding:18px 28px 0;font-family:{font};font-size:12px;letter-spacing:.04em;'
        f'text-transform:uppercase;color:{accent};font-weight:700">Announcement{who}</td></tr>'
        f'<tr><td style="padding:6px 28px 0;font-family:{font};font-size:22px;line-height:1.3;font-weight:700;color:#111827">'
        f'{escape(a.title or "")}</td></tr>'
        f'<tr><td style="padding:14px 28px 0;font-family:{font};font-size:15px;line-height:1.6;color:#1f2937">'
        f'{_text_html(a.body)}{attach}</td></tr>'
        f'<tr><td style="padding:22px 28px 26px"><a href="{escape(_open_url())}" style="display:inline-block;background:{accent};'
        f'color:#ffffff;text-decoration:none;font-family:{font};font-size:14px;font-weight:600;padding:10px 18px;'
        f'border-radius:8px">Open in Nexus</a></td></tr>'
        f'<tr><td style="padding:0 28px 22px">{th.footer_lines("#9ca3af")}</td></tr>'
        f'</table></div>')


def _from_mailbox(db: Session) -> str:
    try:
        import task_notify
        return (task_notify.get_settings(db).get("fromMailbox") or "").strip() or graph_mail.DEFAULT_FROM_EMAIL
    except Exception:
        return graph_mail.DEFAULT_FROM_EMAIL


# ── Publishing ─────────────────────────────────────────────────────────────

def _bells(db: Session, a: Announcement, people: dict, scope, author_name: str, recipients: list[str]) -> int:
    """Bells for the recipients who do not already hold one for this post."""
    from routers import announcements as ann
    have = {n.recipient for n in db.query(NexusNotification.recipient)
            .filter(NexusNotification.type == "announcement", NexusNotification.ref_id == a.id).all()}
    missing = [em for em in recipients if em not in have]
    if not missing:
        return 0
    return ann._notify_audience(db, a, people, scope, author_name, recipients=missing)


def _author_can_send_teams(db: Session, author: str) -> bool:
    """The Teams DMs go out as the author with their delegated Graph token
    (teams_post.deliver_ticket_row). No live session = no token = every row
    would die quietly after 48 hours, so we check before queueing."""
    try:
        import bff_session
        return bool(bff_session.graph_token_for_email(db, author))
    except Exception as e:
        print(f"[announcements] token check failed for {author}: {e}")
        return False


def _teams_not_sent_bell(db: Session, a: Announcement) -> None:
    """One bell to the author: the Teams messages did not go."""
    author = (a.author_email or "").strip().lower()
    if not author:
        return
    db.add(NexusNotification(
        id=str(uuid.uuid4()), type="announcement", recipient=author,
        title="Teams Messages Not Sent",
        body=f"Sign in to Nexus and republish '{a.title or ''}' to send the Teams messages.",
        ref_id=f"{a.id}:teams", item_name="", requested_by="", action="", actioned=False, read_by="",
        company="", created_at=_now()))


def _fan_out(db: Session, a: Announcement, author_name: str, recipients: list[str]) -> dict:
    """What `notify` asks for beyond the bell. Never a Web Push: the bell's
    after_insert listener (push.py) already pushes every bell row, so the
    phone buzzes once per post whatever the mode."""
    mode = (a.notify or "quiet").strip().lower()
    out = {"teams": 0, "email": 0, "failed": 0}
    if mode == "quiet" or not recipients:
        return out
    now = _now()
    if mode == "push_teams":
        if not _author_can_send_teams(db, a.author_email or ""):
            _teams_not_sent_bell(db, a)
            out["failed"] = len(recipients)
            print(f"[announcements] no Teams token for {a.author_email} - DMs for {a.id} not queued, author told")
            return out
        html = teams_html(a, author_name)
        for em in recipients:
            db.add(TicketTeamsMessage(id=str(uuid.uuid4()), ticket_id=a.id, agent_email=a.author_email or "",
                                      requester_email=em, html=html, created_at=now, kind=TEAMS_KIND))
            out["teams"] += 1
        return out
    if mode == "email":
        sender = _from_mailbox(db)
        if not sender:
            print(f"[announcements] no sending mailbox - email skipped for {a.id}")
            return out
        subject = f"Announcement: {a.title or ''}".strip()
        for em in recipients:
            try:
                graph_mail.send_mail(from_email=sender, to=[em], cc=None, subject=subject,
                                     html=email_html(db, a, author_name, em))
                out["email"] += 1
            except Exception as e:
                out["failed"] += 1
                print(f"[announcements] mail to {em} failed for {a.id}: {e}")
    return out


def publish(db: Session, a: Announcement) -> dict:
    """Bells (for anyone still missing one) + the notify fan-out for ONE
    claimed post. The caller claimed the row and commits."""
    from routers import announcements as ann
    people = ann._people(db)
    scope = _scope_for(db, a.author_email or "")
    author_name = ann._name_of(people, db, a.author_email)
    recipients = ann._audience_emails(a, people, scope)
    bells = _bells(db, a, people, scope, author_name, recipients)
    out = _fan_out(db, a, author_name, recipients)
    out["bells"] = bells
    out["recipients"] = len(recipients)
    return out


def reset_attempts(aid: str) -> None:
    """A failed post was given a new publish time: count from zero again."""
    _attempts.pop(aid, None)


def _predates_reach(a: Announcement, now: str) -> bool:
    """An immediate post (no publish time) created more than GRACE_MINUTES
    ago with no publish stamp is one the migration default left at '' - its
    bells went out at create. Never claim it: that would bell the whole
    company again for every old post."""
    if (a.publish_at or "").strip():
        return False
    made = parse_when(a.created_at or "")
    ref = parse_when(now) or datetime.now(timezone.utc)
    return made is not None and (ref - made).total_seconds() > GRACE_MINUTES * 60


def _release_claim(db: Session, aid: str, err: Exception) -> None:
    """A publish that raised: give the claim back so the next pass retries,
    or after MAX_ATTEMPTS stamp the row failed so it stops trying."""
    n = _attempts.get(aid, 0) + 1
    _attempts[aid] = n
    stamp = "" if n < MAX_ATTEMPTS else f"failed:{_now()}"
    try:
        (db.query(Announcement).filter(Announcement.id == aid)
           .update({"notified_at": stamp}, synchronize_session=False))
        db.commit()
    except Exception as e2:
        db.rollback()
        print(f"[announcements] could not release claim on {aid}: {e2}")
    print(f"[announcements] publish failed for {aid} (attempt {n}/{MAX_ATTEMPTS}"
          f"{', giving up' if stamp else ', will retry'}): {err}")


def run_due() -> int:
    """One pass: claim every live, due, unpublished post and publish it.
    Returns how many were published."""
    if job_switch.off("announcements_publish"):
        return 0
    from database import SessionLocal
    db = SessionLocal()
    done = 0
    try:
        now = _now()
        rows = (db.query(Announcement)
                .filter(Announcement.deleted_at == "", Announcement.notified_at == "")
                .order_by(Announcement.created_at.asc()).all())
        due = [a for a in rows if is_due(a, now) and not _predates_reach(a, now)]
        for a in due:
            # Claim first: the UPDATE wins on one worker only.
            claimed = (db.query(Announcement)
                       .filter(Announcement.id == a.id, Announcement.notified_at == "")
                       .update({"notified_at": now}, synchronize_session=False))
            db.commit()
            if not claimed:
                continue
            try:
                db.refresh(a)
                result = publish(db, a)
                db.commit()
                done += 1
                _attempts.pop(a.id, None)
                print(f"[announcements] published {a.id} ({a.notify or 'quiet'}): {result}")
            except Exception as e:
                db.rollback()
                _release_claim(db, a.id, e)
    finally:
        db.close()
    return done


async def announcements_loop():
    await asyncio.sleep(45)
    while True:
        try:
            await asyncio.to_thread(run_due)
        except Exception as e:
            print(f"[announcements] loop error: {e}")
        await asyncio.sleep(SCAN_EVERY_SEC)
