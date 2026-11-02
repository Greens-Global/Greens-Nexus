"""The edition watch (Neil, 11/02/2026): once a day, is the bundled W-4 or
I-9 still the edition to send?

`run_daily()` reads `editions.status` for every form and, the first day a
form reads expiring or expired, bells every HR contact and administrator
once - `ref_id = "fedform:<kind>:<state>"`, so the same state never bells
twice and the next state (expiring -> expired) bells once more. Sending an
expired edition is refused by the packet builder and the send route whether
or not anyone read the bell; the bell is the heads-up, not the gate.

Runs inside `reminders.reminders_loop` in a thread, gated by
`job_switch.off("federal_forms")` (Workflows > Automations), with its own
session and commit so a problem here never touches the other passes.
"""
import json
import uuid
from datetime import datetime, timezone

import job_switch

from . import editions
from .registry import FORMS

JOB_KEY = "federal_forms"
REF_PREFIX = "fedform:"
# Where the bell lands: Settings > Hiring & Onboarding > Federal Forms - the
# group itself (`<subject>:<group>`, AdminConsole's resolveSub), where the
# edition status rows live.
ACTION = {"view": "admin", "sub": "hiring:federal-forms", "label": "Open Settings"}


def _title(kind: str, st: dict) -> str:
    title = FORMS[kind]["title"]
    if st["state"] == "expired":
        return f"{title} Edition Expired - Sending Is Paused"
    if kind == "w4":
        return f"{int(FORMS[kind]['edition']) + 1} Form W-4 Due In January"
    return f"{title} Edition Expires {st['expires']}"


def recipients(db) -> list:
    """Every company's HR contact plus every administrator and owner, once each."""
    from models import HrEntity, NexusRole
    out = set()
    for ent in db.query(HrEntity).all():
        for e in (ent.hr_contact_email or "").split(","):
            if e.strip():
                out.add(e.strip().lower())
    for r in db.query(NexusRole).filter(NexusRole.role.in_(("owner", "administrator"))).all():
        if r.email:
            out.add(r.email.strip().lower())
    return sorted(out)


def run_daily(db=None) -> int:
    """One pass. Returns the bells written. Own session when none is given."""
    if job_switch.off(JOB_KEY):
        return 0
    from database import SessionLocal
    from models import NexusNotification
    from notify_company import notification_company
    own = db is None
    db = db or SessionLocal()
    written = 0
    try:
        people = None
        for kind in FORMS:
            st = editions.status(kind)
            if st["state"] not in ("expiring", "expired"):
                continue
            ref = f"{REF_PREFIX}{kind}:{st['state']}"
            if people is None:
                people = recipients(db)
            have = {n.recipient for n in db.query(NexusNotification).filter(NexusNotification.ref_id == ref).all()}
            for to in people:
                if to in have:
                    continue
                db.add(NexusNotification(
                    id=str(uuid.uuid4()), type="custom_alert", recipient=to, title=_title(kind, st),
                    body=st["message"], ref_id=ref, item_name="", requested_by="federal-forms",
                    action=json.dumps(ACTION), actioned=False, read_by="",
                    company=notification_company(db, to),
                    created_at=datetime.now(timezone.utc).isoformat(),
                    priority=1 if st["state"] == "expired" else 0))
                written += 1
        db.commit()
        return written
    except Exception as e:   # noqa: BLE001 - one pass never stops the loop
        db.rollback()
        print(f"[federal-forms] edition watch failed: {e}")
        return 0
    finally:
        if own:
            db.close()
