"""Construction Module - telling people things (Aug 2026).

The module had a complete review workflow and no way to tell anyone anything.
A worker submitted a daily log and the manager did not know; a manager bounced
it back with a question and the worker - the one person who could answer -
never saw it; a report was published and the executives it was written for were
told by somebody remembering to send a message. `executive_emails` was
documented as "receive published reports" and was only ever read as an access
check.

The module's own notifier, writing to the shared `nexus_notifications` table
the Items module writes to, with the same shape as items.py's `_notify_team`:
ONE bell per person per workflow, updated in place (11/03/2026) - a daily
log's review is one bell for each reviewer and one for its author, whatever
happens to the log; a week's report is one bell for each manager from draft
to publish. A re-fire re-surfaces the same row as unread instead of stacking
a new one. (Jobs may now connect to Tasks fully - Neil, 11/03/2026 - but the
bells stay here, they are about the job's own records.) `graph_mail` is the
generic Graph client tickets and tasks both use.

Reviewers (11/03/2026) are the project's named managers, else the
manager-tier people of the project's company (`reviewers`) - a project with
no managers used to tell nobody its logs were waiting.

**Two channels, chosen by who is being told:**
  bell   anyone with a Nexus login - the crew and the managers. In-app, where
         they already are.
  email  executives, who may not have a Nexus login at all. `executive_emails`
         is a list of addresses, not employees, and an external investor is a
         legitimate entry.

**A notification never breaks the thing that triggered it.** Publishing a report
is not allowed to fail because a mailbox was unreachable - the report is
published either way and the send is retried by nobody, deliberately: a stale
"here is last week's report" three days late is worse than none, and the report
is sitting in the app regardless.
"""
import json
import os
import uuid
from datetime import date, datetime, timezone
from html import escape

import graph_mail
import models
from notify_company import notification_company

_APP_URL = os.getenv("NEXUS_APP_URL", "").rstrip("/")

# Graph takes an attachment inline on the message create; past roughly this size
# it needs a chunked upload session, which is a lot of machinery for a document
# that is also one click away in the app. Over the cap the mail carries the link
# alone and says so.
MAX_ATTACH_BYTES = 3 * 1024 * 1024


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _us(iso) -> str:
    """'2026-10-04' -> '10/04/2026' for text people read; unreadable as-is."""
    try:
        return date.fromisoformat(str(iso or "")[:10]).strftime("%m/%d/%Y")
    except ValueError:
        return str(iso or "")


def _open_action(label: str = "Open Jobsite", sub: str = "construction-dashboard") -> str:
    """NotificationBell's click target. The module lives under Construction
    (view 'ops'); a log's bell opens Site Activity on its jobsite
    (`activity:<project id>`), a project's opens the project
    (`project:<project id>`) - Operations.jsx reads both."""
    return json.dumps({"view": "ops", "sub": sub, "label": label})


# The kinds of one workflow: a re-fire of any of them rewrites the person's
# one bell for that workflow instead of adding another (11/03/2026).
LOG_KINDS = ("log_submitted", "log_approved", "log_needs_info", "log_reopened")
REPORT_KINDS = ("report_draft", "report_published")


def bell(db, *, kind: str, recipient: str, title: str, body: str,
         ref_id: str = "", requested_by: str = "", label: str = "Open Jobsite",
         sub: str = "construction-dashboard", family: tuple = (), done: bool = False,
         company: str = "") -> None:
    """One in-app notification per person per workflow. Server-side only, like
    every other module's - employees get a 403 on the notifications POST API,
    so a client-side write for a workflow event silently does nothing
    (CLAUDE.md).

    `family` (the workflow's kinds) + `ref_id` find the person's existing bell
    for this workflow; it is rewritten in place and re-surfaced as unread
    (items.py's _notify_team), or marked actioned when `done` (the decision
    was made - nothing left to do). An empty recipient would broadcast to
    every manager in the company; this module never wants that, so a blank
    one is dropped instead."""
    recipient = (recipient or "").strip().lower()
    if not recipient:
        return
    kinds = [f"construction_{k}" for k in (family or (kind,))]
    row = None
    if ref_id:
        # Two requests firing the same person's first bell for one workflow
        # (a submit and a review a moment apart) would both find nothing and
        # both insert: they queue on a transaction lock keyed on the pair
        # instead (Postgres; SQLite has one writer anyway).
        _lock_pair(db, recipient, ref_id)
        row = (db.query(models.NexusNotification)
               .filter(models.NexusNotification.recipient == recipient,
                       models.NexusNotification.ref_id == ref_id,
                       models.NexusNotification.type.in_(kinds))
               .order_by(models.NexusNotification.created_at.desc())
               .with_for_update().first())
    if row is not None:
        row.type, row.title, row.body = f"construction_{kind}", title, body[:500]
        row.action = _open_action(label, sub)
        row.requested_by = requested_by or row.requested_by
        row.read_by, row.actioned, row.created_at = "", bool(done), _now()
        return
    db.add(models.NexusNotification(
        id=str(uuid.uuid4()), type=f"construction_{kind}", recipient=recipient,
        title=title, body=body[:500], ref_id=ref_id, item_name="",
        requested_by=requested_by, action=_open_action(label, sub),
        actioned=bool(done), read_by="",
        company=company or notification_company(db, requested_by, recipient),
        created_at=_now(),
    ))
    # autoflush is off: a second bell for the same person and workflow in this
    # request must find this row, not add a twin.
    db.flush()


_BELL_LOCK_SPACE = 815224907   # beside construction_worker's sweep lock key


def _lock_pair(db, recipient: str, ref_id: str) -> None:
    """Transaction-scoped Postgres advisory lock on (recipient, workflow)."""
    try:
        if db.bind.dialect.name != "postgresql":
            return
    except AttributeError:
        return
    import zlib
    from sqlalchemy import text
    db.execute(text("SELECT pg_advisory_xact_lock(:a, :b)"),
               {"a": _BELL_LOCK_SPACE, "b": zlib.crc32(f"{recipient}|{ref_id}".encode()) & 0x7FFFFFFF})


def close_bells(db, *, ref_id: str, family: tuple, kind: str, title: str, body: str,
                except_recipient: str = "") -> int:
    """Rewrite every existing bell of one workflow (but `except_recipient`'s)
    to its outcome and mark it actioned, leaving it where its reader left it
    (read stays read, no move to the top). Never adds a bell."""
    kinds = [f"construction_{k}" for k in family]
    rows = (db.query(models.NexusNotification)
            .filter(models.NexusNotification.ref_id == ref_id,
                    models.NexusNotification.type.in_(kinds)).with_for_update().all())
    skip = (except_recipient or "").strip().lower()
    n = 0
    for row in rows:
        if (row.recipient or "") == skip:
            continue
        row.type, row.title, row.body, row.actioned = f"construction_{kind}", title, body[:500], True
        n += 1
    return n


def reviewers(db, project) -> list:
    """Who reviews this project's daily logs: its named managers; with none,
    the manager-tier people (Manager, Administrator, Super Administrator) of
    the project's company; with no company either, whoever created it - never
    a broadcast to every manager in the organization."""
    named = _emails(project.manager_emails)
    if named:
        return named
    cid = (getattr(project, "company_id", "") or "").strip()
    if cid:
        from auth import tiers_by_email
        tiers = tiers_by_email(db)
        E = models.NexusEmployee
        rows = (db.query(E.work_email)
                .filter(E.company == cid, E.status.in_(("active", "onboarding")),
                        E.identity_type.notin_(("guest", "external"))).all())
        out = sorted({(r.work_email or "").lower() for r in rows
                      if (r.work_email or "") and tiers.get((r.work_email or "").lower())})
        if out:
            return out
    creator = (project.created_by or "").strip().lower()
    return [creator] if creator and creator != "system" else []


def _emails(v) -> list:
    return [e.strip().lower() for e in (v or []) if isinstance(e, str) and e.strip()]


def _send(*, to: list, subject: str, html: str, attachment: tuple | None = None) -> str:
    """Returns "" on success or a reason. Never raises - see the module
    docstring: mail is not allowed to fail the act that triggered it."""
    to = [e for e in _emails(to)]
    if not to:
        return "no recipients"
    sender = (graph_mail.DEFAULT_FROM_EMAIL or "").strip()
    if not sender:
        return "no sender mailbox configured (NEXUS_FROM_EMAIL)"
    try:
        graph_mail.send_mail(from_email=sender, to=to, cc=None, subject=subject,
                             html=html, attachments=[attachment] if attachment else None)
        return ""
    except Exception as e:
        return str(e)[:300]


# ── Daily log workflow ───────────────────────────────────────────────────────
def _who(db, email: str) -> str:
    em = (email or "").strip().lower()
    if not em:
        return "A worker"
    try:
        from construction_company import people_names
        return people_names(db, [em]).get(em) or em.split("@")[0].replace(".", " ").title()
    except Exception:   # noqa: BLE001 - a name is never worth a failed bell
        return em.split("@")[0]


def _activity(project) -> str:
    return f"activity:{project.id}"


def log_submitted(db, project, log) -> None:
    """Worker pressed Submit. The reviewers are the ones who can act on it -
    one bell each for this log, rewritten when it is filed again after a
    send-back."""
    who = _who(db, log.author_email)
    for m in reviewers(db, project):
        if m == (log.author_email or "").lower():
            continue        # a manager filing their own log does not need telling
        bell(db, kind="log_submitted", recipient=m,
             title="Daily Log Ready to Review",
             body=f"{who} filed {_us(log.log_date)} on {project.name}.",
             ref_id=log.id, requested_by=log.author_email or "",
             label="Review Log", sub=_activity(project), family=LOG_KINDS)


def log_reviewed(db, project, log) -> None:
    """Manager approved it or sent it back.

    The sent-back case is the one that matters: `review_note` is the manager's
    question, and until now it was written to the row and shown to nobody. It
    goes in the body, because the answer has to come from the person on site and
    they will not open the app to discover they were asked."""
    author = (log.author_email or "").strip().lower()
    # The reviewers' "ready to review" bell is answered: rewritten to the
    # outcome and closed, so it stops asking (one bell per workflow). Only an
    # existing bell is touched, and quietly - nobody is told about a decision
    # someone else already made.
    approved = log.status == "approved"
    close_bells(db, ref_id=log.id, family=LOG_KINDS, except_recipient=author,
                kind="log_approved" if approved else "log_needs_info",
                title=f"Daily Log {'Approved' if approved else 'Sent Back'}",
                body=(f"{_us(log.log_date)} on {project.name} was {'approved' if approved else 'sent back'} "
                      f"by {_who(db, log.reviewed_by)}."))
    if not author:
        return
    if approved:
        bell(db, kind="log_approved", recipient=author,
             title="Daily Log Approved",
             body=f"{_us(log.log_date)} on {project.name} was approved.",
             ref_id=log.id, requested_by=log.reviewed_by or "", label="View Log",
             sub=_activity(project), family=LOG_KINDS)
    else:
        note = (log.review_note or "").strip()
        bell(db, kind="log_needs_info", recipient=author,
             title="Daily Log Sent Back",
             body=(f"{_us(log.log_date)} on {project.name}: "
                   + (note or "your manager needs more detail before approving.")),
             ref_id=log.id, requested_by=log.reviewed_by or "", label="Open Log",
             sub=_activity(project), family=LOG_KINDS)


def log_reopened(db, project, log, actor: str, reason: str) -> None:
    """An approved log was reopened (a manager, with a reason). Its author's
    bell says so, in place."""
    author = (log.author_email or "").strip().lower()
    if not author or author == (actor or "").lower():
        return
    bell(db, kind="log_reopened", recipient=author, title="Daily Log Reopened",
         body=f"{_us(log.log_date)} on {project.name} is back in review: {reason}"[:500],
         ref_id=log.id, requested_by=actor or "", label="Open Log",
         sub=_activity(project), family=LOG_KINDS)


def _report_ref(project, report) -> str:
    """One workflow per project-week: a regenerated week (a new version row)
    rewrites the same bell rather than adding one."""
    return f"{project.id}:{report.week_start}"


# ── Weekly report ────────────────────────────────────────────────────────────
def draft_cut(db, project, report) -> None:
    """The scheduler cut this week's draft. Managers edit it; nobody else sees a
    draft (list_reports hides drafts from executives on purpose)."""
    for m in reviewers(db, project):
        bell(db, kind="report_draft", recipient=m,
             title="Weekly Report Drafted",
             body=f"Week of {_us(report.week_start)} on {project.name} is ready to review and publish.",
             ref_id=_report_ref(project, report), label="Open Report",
             sub=_activity(project), family=REPORT_KINDS)


def report_published(db, project, report, pdf: bytes = b"") -> str:
    """Deliver a published report to the people it was written for.

    Returns "" or a reason, for the caller to record - the publish itself has
    already happened and is not undone by a mail failure.

    The PDF is ATTACHED rather than linked wherever it fits. The report endpoint
    is authenticated, so a link is useless to an external investor, and even an
    internal executive reading on a phone should not have to sign in to see the
    thing that was sent to them."""
    to = _emails(project.executive_emails)
    if not to:
        return "no executive recipients on this project"

    link = f"{_APP_URL}/construction/activity:{project.id}" if _APP_URL else ""
    attach = None
    note = ""
    name = f"{project.name} - week of {_us(report.week_start)}.pdf".replace("/", "-")
    if pdf and len(pdf) <= MAX_ATTACH_BYTES:
        attach = (name, "application/pdf", pdf)
    elif pdf:
        note = ("<p style='color:#666;font-size:13px'>The report was too large to attach. "
                "Open it in Nexus to read the full version.</p>")

    # Every value is escaped (11/03/2026): a project name or a report title is
    # typed by a person and must never become markup in an executive's inbox.
    html = f"""
      <div style="font-family:Inter,Segoe UI,Arial,sans-serif;color:#111">
        <h2 style="margin:0 0 4px;font-size:19px">{escape(project.name or '')}</h2>
        <div style="color:#666;font-size:13px;margin-bottom:14px">
          Weekly report - week of {escape(_us(report.week_start))}
          {f' to {escape(_us(report.week_end))}' if report.week_end else ''}
        </div>
        <p style="font-size:14px;line-height:1.5">{escape(report.title or 'This week on site')}</p>
        {note}
        {f'<p><a href="{escape(link, quote=True)}" style="font-size:14px">Open it in Nexus</a></p>' if link else ''}
      </div>
    """
    err = _send(to=to, subject=f"{project.name} - Weekly Report, Week of {_us(report.week_start)}",
                html=html, attachment=attach)

    # Managers get a bell either way, so "was it sent?" has an answer in the
    # app. It is the week's draft bell, rewritten (one per workflow).
    for m in reviewers(db, project):
        bell(db, kind="report_published", recipient=m,
             title="Weekly Report Published",
             body=(f"Week of {_us(report.week_start)} on {project.name} was sent to "
                   f"{len(to)} recipient(s)." if not err
                   else f"Week of {_us(report.week_start)} on {project.name} was published, "
                        f"but the email failed: {err}"),
             ref_id=_report_ref(project, report), label="Open Report",
             sub=_activity(project), family=REPORT_KINDS, done=not err)
    return err


def deliver_published_report(report_id: str) -> str:
    """Background entry point: render the PDF and mail it out, after the publish
    request has already returned.

    Owns its own session because it runs past the request's. Rendering a PDF
    full of jobsite photos and then waiting on Graph is a second or two that the
    manager who pressed Publish should not sit through - the publish itself is
    already committed and is what they were waiting for."""
    import models as _models
    from database import SessionLocal

    db = SessionLocal()
    try:
        r = db.query(_models.ConstructionWeeklyReport).filter(
            _models.ConstructionWeeklyReport.id == report_id).first()
        if not r:
            return "report not found"
        p = db.query(_models.ConstructionProject).filter(
            _models.ConstructionProject.id == r.project_id).first()
        if not p:
            return "project not found"

        pdf = b""
        try:
            import construction_pdf
            media = {m.id: m for m in db.query(_models.ConstructionMedia)
                     .filter(_models.ConstructionMedia.id.in_(r.media_ids or [""]),
                             _models.ConstructionMedia.project_id == r.project_id,
                             _models.ConstructionMedia.deleted_at == "").all()} \
                if r.media_ids else {}
            logs = (db.query(_models.ConstructionDailyLog)
                    .filter(_models.ConstructionDailyLog.id.in_(r.daily_log_ids or [""]))
                    .order_by(_models.ConstructionDailyLog.log_date).all()) \
                if r.daily_log_ids else []
            pdf = construction_pdf.build(r, p, media, logs)
        except Exception as e:
            # Still send the mail - a report someone can open in the app beats
            # silence because the renderer choked on one photo.
            print(f"[construction] report PDF render failed for {report_id}: {e}")

        err = report_published(db, p, r, pdf)
        db.commit()
        if err:
            print(f"[construction] report {report_id} published but not mailed: {err}")
        return err
    except Exception as e:
        db.rollback()
        print(f"[construction] report delivery failed for {report_id}: {e}")
        return str(e)[:300]
    finally:
        db.close()
