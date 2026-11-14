"""Hiring steps waiting (Pranshu, 11/03/2026, from the multi-company review of
the hiring documents flow): signers are chased by Nexus Sign, but three hiring
steps could sit for weeks with nobody told -

  - the new hire has not sent their details form (a hiring packet in "intake")
  - an offer letter or hiring packet waits for HR's Verify And Send ("review")
  - the offer was signed but the hiring packet never started
    (the `packet_not_started` flag `_apply_offer` raises)

Every morning (reminders_loop, in a thread) each step quiet for at least
`afterDays` (Settings > Emails & Reminders > HR & Compliance Reminders >
Hiring Steps Waiting, default 3) goes on ONE bell per person who can move it, rewritten
in place (CLAUDE.md): raised again when the list changes or `afterDays` after it
was last raised, closed when nothing waits. Who: the verifier for a step waiting
on Verify And Send, and the HR person who started it (else the company's HR
department head and backup / HR contact / Super Administrators, the Records
Audit chain). Nothing goes to the candidate automatically - a new details link
kills the old one, so HR clicks Send Link Again.
"""
import json
import uuid
from datetime import date, datetime, timezone

import job_switch
from models import HrEntity, HrLifeEvent, NexusNotification

NTYPE = "hiring_stalled"
ACTION = {"view": "hr", "sub": "hr-hiring"}
_MAX_LINES = 8


def _since(iso: str) -> str:
    return (iso or "")[:10]


def _owners(db, ev, entity) -> list:
    """The HR person who started the step, else the company's HR chain."""
    from hiring_screening import _person
    import hr_record_audit
    if _person(db, ev.created_by):
        return [ev.created_by.strip().lower()]
    return [e.lower() for e in (hr_record_audit.recipients(db, entity) if entity is not None else [])]


def _verifier(db, ev) -> str:
    import hr_packet_docs as hpd
    setting = hpd.event_setting(db, ev)
    if setting is None:
        return ""
    ctx = hpd.event_ctx(db, ev, setting, ev.created_by)
    return (hpd.resolve_role(db, ctx.get("verifier_role") or setting.verify_role or "hr", ctx) or "").lower()


def waiting(db, today: date, after_days: int, cands: dict = None) -> dict:
    """{recipient: [line, ...]} - every hiring step quiet for `after_days` or more.
    `cands`, when given, collects {recipient: {candidate id}} so a bell about
    ONE candidate opens their card (11/14/2026)."""
    from hr_life_events import CANDIDATE_KINDS, us_date
    cutoff = date.fromordinal(today.toordinal() - after_days).isoformat()
    entities = {e.id: e for e in db.query(HrEntity).all()}
    out = {}

    def add(people, line, cid=""):
        for p in dict.fromkeys(people):
            if p:
                out.setdefault(p, []).append(line)
                if cands is not None:
                    cands.setdefault(p, set()).add(cid or "")

    rows = (db.query(HrLifeEvent).filter(HrLifeEvent.kind.in_(CANDIDATE_KINDS),
                                         HrLifeEvent.status.in_(("intake", "review", "completed")))
            .order_by(HrLifeEvent.created_at).all())
    for ev in rows:
        try:
            entity = entities.get(ev.entity_id or "")
            co = f" ({entity.name})" if entity is not None and entity.name else ""
            name = ev.subject_name or "A new hire"
            what = "Offer Letter" if ev.kind == "offer" else "Hiring Packet"
            if ev.status == "intake":
                since = _since(ev.intake_sent_at or ev.created_at)
                if since and since <= cutoff:
                    expired = bool(ev.intake_expires_on) and ev.intake_expires_on < today.isoformat()
                    add(_owners(db, ev, entity),
                        f"- {name}{co}: has not sent their details form since {us_date(since)}"
                        f"{' - the link has expired' if expired else ''}. Open their card and click Send Link Again.",
                        ev.candidate_id)
            elif ev.status == "review":
                since = _since(ev.updated_at or ev.created_at)
                if since and since <= cutoff:
                    add([_verifier(db, ev)] + _owners(db, ev, entity),
                        f"- {name}{co}: the {what} has waited for Verify And Send since {us_date(since)}.",
                        ev.candidate_id)
            elif ev.kind == "offer" and any(f.get("code") == "packet_not_started" for f in (ev.flags or [])):
                since = _since(ev.completed_at or ev.updated_at)
                if since and since <= cutoff:
                    add(_owners(db, ev, entity),
                        f"- {name}{co}: signed the offer on {us_date(since)} but the hiring packet has not started. "
                        f"Fix what stopped it, then click Start Hiring Packet on their card.", ev.candidate_id)
        except Exception as e:   # noqa: BLE001 - one bad row never stops the rest
            print(f"[hiring-stalled] skipped {ev.id}: {type(e).__name__}: {e}")
    return out


def _text(lines: list) -> tuple:
    n = len(lines)
    title = f"Hiring: {n} {'Step Is' if n == 1 else 'Steps Are'} Waiting"
    body = lines[:_MAX_LINES] + ([f"- and {n - _MAX_LINES} more - open People > Hiring"] if n > _MAX_LINES else [])
    return title, "\n".join(body)


def action_for(cand_ids) -> dict:
    """One candidate waiting: their card; several: the board."""
    ids = {c for c in (cand_ids or ()) if c}
    if len(ids) == 1 and "" not in set(cand_ids or ()):
        return {"view": "hr", "sub": f"hr-hiring-{next(iter(ids))}"}
    return ACTION


def _upsert(db, recipient: str, lines: list, again_days: int, cand_ids=None) -> bool:
    row = (db.query(NexusNotification)
           .filter(NexusNotification.type == NTYPE, NexusNotification.recipient == recipient)
           .with_for_update().first())
    now = datetime.now(timezone.utc)
    if not lines:
        if row is None or row.actioned:
            return False
        row.title, row.body, row.actioned = "Hiring: Nothing Is Waiting", "Every hiring step has moved on.", True
        return True
    title, body = _text(lines)
    if row is None:
        db.add(NexusNotification(
            id=str(uuid.uuid4()), type=NTYPE, recipient=recipient, title=title, body=body, ref_id=NTYPE,
            item_name="", requested_by="", action=json.dumps(action_for(cand_ids)), actioned=False, read_by="",
            company="", created_at=now.isoformat()))
        return True
    due = (row.created_at or "")[:10] <= date.fromordinal(now.date().toordinal() - again_days).isoformat()
    if row.title == title and row.body == body and not row.actioned and not due:
        return False
    row.title, row.body, row.read_by, row.actioned = title, body, "", False
    row.action = json.dumps(action_for(cand_ids))
    row.created_at = now.isoformat()
    return True


def run_daily() -> int:
    """The morning pass. Own session and commit, like hr_record_audit.run_daily."""
    if job_switch.off("hiring_stalled"):   # Workflows > Automations switch
        return 0
    import hr_reminder_config
    from database import SessionLocal
    db = SessionLocal()
    try:
        cfg = hr_reminder_config.get_config(db)["hiringStalled"]
        if not cfg["enabled"]:
            return 0
        after = int(cfg["afterDays"])
        cands: dict = {}
        found = waiting(db, datetime.now(timezone.utc).date(), after, cands)
        open_ = {r for (r,) in db.query(NexusNotification.recipient)
                 .filter(NexusNotification.type == NTYPE, NexusNotification.actioned.is_(False))}
        sent = sum(_upsert(db, r, found.get(r, []), after, cands.get(r)) for r in sorted(set(found) | open_))
        db.commit()
        print(f"[hiring-stalled] {sum(map(len, found.values()))} waiting line(s), {sent} bell(s) raised or closed")
        return sent
    except Exception as e:   # noqa: BLE001 - never stops the morning loop
        db.rollback()
        print(f"[hiring-stalled] pass failed: {e}")
        return 0
    finally:
        db.close()
