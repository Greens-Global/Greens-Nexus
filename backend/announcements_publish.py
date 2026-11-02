"""Announcements reach (Neil, 11/02/2026): publish later + the notify choice.

An announcement is PUBLISHED when its audience hears about it. Two moments:

  bells     One bell notification per person in the audience
            (routers.announcements._notify_audience). A post due at create
            gets them in the create request, as before; a post scheduled for
            later gets them here, when it comes due.
  fan-out   What `notify` asks for beyond the bell, always done here, in the
            publish pass, never in a request (a company-wide email is ~180
            Graph calls):
              quiet       nothing more
              push_teams  one Web Push (push.queue_push, when Task A's module
                          is installed and configured) to everyone in the
                          audience + one Teams DM row per recipient
                          (models.TicketTeamsMessage, kind 'announcement',
                          delivered by teams_post's sweep as the author)
              email       one themed mail per recipient (graph_mail), from the
                          task-notification mailbox, else NEXUS_FROM_EMAIL

Exactly once: `run_due` CLAIMS a row by a conditional UPDATE on
`notified_at` ('' -> now) and commits before anything is sent, so two workers
or a restart mid-pass never publish the same post twice. Bells are
idempotent too (recipients who already hold one are skipped), so a claim
that follows the create request's bells adds none.

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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def is_due(a: Announcement, now: str = "") -> bool:
    """Published-or-due: no publish time, or one at or before now."""
    return not (a.publish_at or "") or a.publish_at <= (now or _now())


def _scope_for(db: Session, email: str):
    """The author's company reach, built the way a request would (their role
    level stands in for the request's user dict)."""
    try:
        return auth.company_scope({"email": email, "level": auth.level_for(email, db)}, db)
    except Exception:
        return None


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


def _fan_out(db: Session, a: Announcement, author_name: str, recipients: list[str]) -> dict:
    mode = (a.notify or "quiet").strip().lower()
    out = {"push": 0, "teams": 0, "email": 0, "failed": 0}
    if mode == "quiet" or not recipients:
        return out
    now = _now()
    if mode == "push_teams":
        try:
            import push      # Task A's module - absent or unconfigured = no push, Teams still goes
            if push.configured():
                push.queue_push(db, recipients, a.title or "Announcement", (a.body or "")[:140],
                                _open_url(), f"announcement:{a.id}")
                out["push"] = len(recipients)
        except ImportError:
            pass
        except Exception as e:
            print(f"[announcements] push skipped for {a.id}: {e}")
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
        due = [a for a in rows if is_due(a, now)]
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
                print(f"[announcements] published {a.id} ({a.notify or 'quiet'}): {result}")
            except Exception as e:
                db.rollback()
                print(f"[announcements] publish failed for {a.id}: {e}")
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
