"""Who is off today - one Teams post per team at the start of its day.

Neil, 10/08: "if someone is off or has a scheduled offtime on a particular
day, the entire team is notified in the teams chat at the start of the day.
Bind it to the channel they are a part of and that they report to with
EOD/BOD. This will help people know that certain people are off."

The team's day starts when its first Beginning-of-day message lands: the
first BOD posted to a Teams chat or channel on a given workday carries, right
behind it, one "Out today" post listing everyone bound to that same
destination (job role first, shift group as the fallback - exactly how
timeclock._resolve_group_target routes their own BOD/EOD) who has APPROVED
time off covering that day. It goes out as the same person, through the same
delivery queue (a `time_bod` row, kind "off_today", that teams_post.deliver_row
sends and teams_post_loop retries), so it needs no token of its own and can
never be lost between the BOD and the post.

One post per destination per day: the row's id is derived from the
destination and the day, so two BODs arriving together can only insert it
once - the second insert fails on the primary key and is dropped. A day on
which nobody bound to the destination is off posts nothing and records
nothing, so a request approved later that morning is still announced by the
next BOD. Nothing is posted when nobody posts a BOD (a team whose roles are
all BOD-exempt has no "start of day" to hang it on).

What the post says follows the time-off privacy rule (timeclock._TimeoffPrivacy):
a confidential request shows as plain "Time off"; any other shows its type
("Vacation", "Sick"), the way the schedule already shows it to the team.
Never the note, never the reason.
"""
import html
import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session

KIND = "off_today"
_NS = uuid.UUID("5b3a7a0e-6a1c-4d7f-9b1e-0ff70da70001")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def post_id(destination_id: str, day: str) -> str:
    """Deterministic: the same destination on the same day is the same row."""
    return str(uuid.uuid5(_NS, f"{destination_id}|{day}"))


def _us_day(iso: str) -> str:
    try:
        return datetime.strptime((iso or "")[:10], "%Y-%m-%d").strftime("%m/%d/%Y")
    except ValueError:
        return iso or ""


def _weekday(iso: str) -> str:
    try:
        return datetime.strptime((iso or "")[:10], "%Y-%m-%d").strftime("%A")
    except ValueError:
        return ""


def _hhmm12(v: str) -> str:
    try:
        return datetime.strptime((v or "")[:5], "%H:%M").strftime("%I:%M %p").lstrip("0")
    except ValueError:
        return v or ""


def _type_label(t: str) -> str:
    t = (t or "").strip()
    if not t:
        return "Time off"
    if t.lower() in ("other", "personal", "unpaid"):
        return "Time off" if t.lower() == "other" else t.title()
    return t if t[:1].isdigit() else t.title()      # "1/2 Day" stays as typed


def members_of_destination(db: Session, destination_id: str) -> list:
    """Every employee whose BOD/EOD posts route to this chat or channel:
    members of a job role bound to it, members of a shift group bound to it,
    kept only when the person's RESOLVED destination (role beats group) is
    this one - so someone whose role sends them elsewhere is not listed in a
    group they merely belong to."""
    from models import NexusGroup, NexusGroupMember, ShiftGroup, ShiftGroupMember
    from routers.timeclock import _resolve_group_target
    dest = (destination_id or "").strip()
    if not dest:
        return []
    candidates = set()
    role_ids = [r.id for r in db.query(NexusGroup.id)
                .filter(NexusGroup.is_job_role == 1, NexusGroup.bod_chat_id == dest).all()]
    if role_ids:
        candidates.update((m.email or "").strip().lower() for m in db.query(NexusGroupMember.email)
                          .filter(NexusGroupMember.group_id.in_(role_ids)).all())
    group_ids = [g.id for g in db.query(ShiftGroup.id).filter(ShiftGroup.teams_chat_id == dest).all()]
    if group_ids:
        candidates.update((m.employee_email or "").strip().lower() for m in db.query(ShiftGroupMember.employee_email)
                          .filter(ShiftGroupMember.group_id.in_(group_ids)).all())
    candidates.discard("")
    return sorted(e for e in candidates if _resolve_group_target(db, e).get("id") == dest)


def off_entries(db: Session, emails: list, day: str) -> list:
    """[{email, name, label, detail}] for everyone in `emails` with an approved
    request covering `day` (YYYY-MM-DD), sorted by name. `detail` is the span
    ("through 10/10/2026") or the hours of a partial day ("11:00 AM - 1:00 PM"),
    '' for a single full day."""
    from models import NexusEmployee, TimeOffRequest
    if not emails or not day:
        return []
    rows = (db.query(TimeOffRequest)
            .filter(TimeOffRequest.status == "approved",
                    TimeOffRequest.employee_email.in_(list(emails)),
                    TimeOffRequest.start_date <= day, TimeOffRequest.end_date >= day)
            .order_by(TimeOffRequest.start_date.asc()).all())
    if not rows:
        return []
    emps = {(e.work_email or "").strip().lower(): e
            for e in db.query(NexusEmployee).filter(NexusEmployee.work_email.in_([r.employee_email for r in rows])).all()}
    out, seen = [], set()
    for r in rows:
        em = (r.employee_email or "").strip().lower()
        if em in seen:
            continue            # two approved requests on one day - one line
        seen.add(em)
        emp = emps.get(em)
        name = (f"{emp.first_name} {emp.last_name}".strip() if emp else "") or em.split("@")[0].replace(".", " ").title()
        label = "Time off" if getattr(r, "confidential", 0) else _type_label(r.type)
        if r.start_time and r.end_time and (r.start_date or "")[:10] == (r.end_date or "")[:10]:
            detail = f"{_hhmm12(r.start_time)} - {_hhmm12(r.end_time)}"
        elif (r.end_date or "")[:10] > day:
            detail = f"through {_us_day(r.end_date)}"
        else:
            detail = ""
        out.append({"email": em, "name": name, "label": label, "detail": detail})
    out.sort(key=lambda x: x["name"].lower())
    return out


def compose(day: str, entries: list) -> tuple:
    """(plain text, Teams HTML) for the post."""
    head = f"Out today - {_weekday(day)}, {_us_day(day)}"
    lines = [f"{e['name']} - {e['label']}" + (f", {e['detail']}" if e["detail"] else "") for e in entries]
    text = head + "\n" + "\n".join(lines)
    items = "".join(
        f"<li><b>{html.escape(e['name'])}</b> - {html.escape(e['label'])}"
        + (f", {html.escape(e['detail'])}" if e["detail"] else "") + "</li>"
        for e in entries)
    body = f"<p><b>{html.escape(head)}</b></p><ul>{items}</ul>"
    return text, body


def maybe_post(db: Session, bod_row, *, deliver: bool = True):
    """Called right after a BOD row is committed. Queues (and tries to send)
    the day's "Out today" post for that BOD's destination if it is the first
    BOD there today and someone bound to it is off. Returns the new TimeBod
    row, or None when there was nothing to post or it was already posted.
    Never raises past a caller: a failure here must not fail the BOD."""
    from models import TimeBod
    if getattr(bod_row, "kind", "") != "bod":
        return None
    dest, day = (bod_row.channel_id or "").strip(), (bod_row.local_date or "")[:10]
    if not dest or not day:
        return None
    rid = post_id(dest, day)
    if db.query(TimeBod.id).filter(TimeBod.id == rid).first():
        return None
    members = members_of_destination(db, dest)
    entries = off_entries(db, members, day)
    if not entries:
        return None
    text, body = compose(day, entries)
    row = TimeBod(id=rid, employee_email=bod_row.employee_email, kind=KIND, local_date=day,
                  message=text[:1000], tasks="",
                  team_id=bod_row.team_id or "", team_name=bod_row.team_name or "",
                  channel_id=dest, channel_name=bod_row.channel_name or "",
                  target_type=getattr(bod_row, "target_type", "chat") or "chat",
                  sent=0, send_error="", created_at=_now_iso(), html=body[:8000], attempts=0, last_try_at="")
    db.add(row)
    try:
        db.commit()
    except Exception:
        db.rollback()          # the other BOD got there first - its post is the post
        return None
    if deliver:
        try:
            import teams_post
            teams_post.deliver_row(db, row)
        except Exception:
            pass               # queued; teams_post_loop owns it now
    return row
