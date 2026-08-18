"""Construction Module - telling people things (Aug 2026).

The module had a complete review workflow and no way to tell anyone anything.
A worker submitted a daily log and the manager did not know; a manager bounced
it back with a question and the worker - the one person who could answer -
never saw it; a report was published and the executives it was written for were
told by somebody remembering to send a message. `executive_emails` was
documented as "receive published reports" and was only ever read as an access
check.

**This is deliberately the module's OWN notifier, not the Task module's.**
`routers/task_util.task_notify` does almost exactly this, and importing it is
the coupling the module is explicitly built to avoid (see
ConstructionProject's docstring, and CLAUDE.md). `nexus_notifications` itself is
shared infrastructure - the Items module writes to the same table - so writing
rows there is not a cross-module dependency; importing a Task-module function to
do it would be. `graph_mail` is the same kind of shared plumbing: a generic
Graph client that tickets and tasks both use.

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
from datetime import datetime, timezone

import graph_mail
import models

_APP_URL = os.getenv("NEXUS_APP_URL", "").rstrip("/")

# Graph takes an attachment inline on the message create; past roughly this size
# it needs a chunked upload session, which is a lot of machinery for a document
# that is also one click away in the app. Over the cap the mail carries the link
# alone and says so.
MAX_ATTACH_BYTES = 3 * 1024 * 1024


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _open_action(label: str = "Open Jobsite") -> str:
    """NotificationBell's click target. The module lives under Operations ->
    Project Dashboard (Sidebar.jsx), and the bell dispatches nexus:navigate."""
    return json.dumps({"view": "ops", "sub": "construction-dashboard", "label": label})


def bell(db, *, kind: str, recipient: str, title: str, body: str,
         ref_id: str = "", requested_by: str = "", label: str = "Open Jobsite") -> None:
    """One in-app notification. Server-side only, like every other module's -
    employees get a 403 on the notifications POST API, so a client-side write
    for a workflow event silently does nothing (CLAUDE.md).

    An empty recipient would broadcast to every manager in the company; this
    module never wants that, so a blank one is dropped instead."""
    recipient = (recipient or "").strip().lower()
    if not recipient:
        return
    db.add(models.NexusNotification(
        id=str(uuid.uuid4()), type=f"construction_{kind}", recipient=recipient,
        title=title, body=body[:500], ref_id=ref_id, item_name="",
        requested_by=requested_by, action=_open_action(label),
        actioned=False, read_by="", created_at=_now(),
    ))


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
def log_submitted(db, project, log) -> None:
    """Worker pressed Submit. The managers are the ones who can act on it."""
    who = (log.author_email or "").split("@")[0] or "A worker"
    for m in _emails(project.manager_emails):
        if m == (log.author_email or "").lower():
            continue        # a manager filing their own log does not need telling
        bell(db, kind="log_submitted", recipient=m,
             title="Daily log ready to review",
             body=f"{who} filed {log.log_date} on {project.name}.",
             ref_id=log.id, requested_by=log.author_email or "",
             label="Review Log")


def log_reviewed(db, project, log) -> None:
    """Manager approved it or sent it back.

    The sent-back case is the one that matters: `review_note` is the manager's
    question, and until now it was written to the row and shown to nobody. It
    goes in the body, because the answer has to come from the person on site and
    they will not open the app to discover they were asked."""
    author = (log.author_email or "").strip().lower()
    if not author:
        return
    if log.status == "approved":
        bell(db, kind="log_approved", recipient=author,
             title="Daily log approved",
             body=f"{log.log_date} on {project.name} was approved.",
             ref_id=log.id, requested_by=log.reviewed_by or "", label="View Log")
    else:
        note = (log.review_note or "").strip()
        bell(db, kind="log_needs_info", recipient=author,
             title="Daily log sent back",
             body=(f"{log.log_date} on {project.name}: "
                   + (note or "your manager needs more detail before approving.")),
             ref_id=log.id, requested_by=log.reviewed_by or "", label="Open Log")


# ── Weekly report ────────────────────────────────────────────────────────────
def draft_cut(db, project, report) -> None:
    """The scheduler cut this week's draft. Managers edit it; nobody else sees a
    draft (list_reports hides drafts from executives on purpose)."""
    for m in _emails(project.manager_emails):
        bell(db, kind="report_draft", recipient=m,
             title="Weekly report drafted",
             body=f"Week of {report.week_start} on {project.name} is ready to review and publish.",
             ref_id=report.id, label="Open Report")


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

    link = f"{_APP_URL}/?view=ops&sub=construction-dashboard" if _APP_URL else ""
    attach = None
    note = ""
    name = f"{project.name} - week of {report.week_start}.pdf".replace("/", "-")
    if pdf and len(pdf) <= MAX_ATTACH_BYTES:
        attach = (name, "application/pdf", pdf)
    elif pdf:
        note = ("<p style='color:#666;font-size:13px'>The report was too large to attach. "
                "Open it in Nexus to read the full version.</p>")

    html = f"""
      <div style="font-family:Inter,Segoe UI,Arial,sans-serif;color:#111">
        <h2 style="margin:0 0 4px;font-size:19px">{project.name}</h2>
        <div style="color:#666;font-size:13px;margin-bottom:14px">
          Weekly report - week of {report.week_start}
          {f' to {report.week_end}' if report.week_end else ''}
        </div>
        <p style="font-size:14px;line-height:1.5">{report.title or 'This week on site'}</p>
        {note}
        {f'<p><a href="{link}" style="font-size:14px">Open it in Nexus</a></p>' if link else ''}
      </div>
    """
    err = _send(to=to, subject=f"{project.name} - weekly report, week of {report.week_start}",
                html=html, attachment=attach)

    # Managers get a bell either way, so "was it sent?" has an answer in the app.
    for m in _emails(project.manager_emails):
        bell(db, kind="report_published", recipient=m,
             title="Weekly report published",
             body=(f"Week of {report.week_start} on {project.name} was sent to "
                   f"{len(to)} recipient(s)." if not err
                   else f"Week of {report.week_start} on {project.name} was published, "
                        f"but the email failed: {err}"),
             ref_id=report.id, label="Open Report")
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
                     .filter(_models.ConstructionMedia.id.in_(r.media_ids or [""])).all()} \
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
