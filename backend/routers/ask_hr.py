"""Ask HR's HR side (Oct 27 2026) - hr_tickets.py has the why.

Open to any signed-in user and SCOPED server-side: an HR contact need not
hold the HR module grant or a ticket desk grant, so neither router's gate
fits. Every answer is only what the caller reads as HR
(ticket_confidential.is_hr_for / may_read); someone who is HR nowhere gets
empty lists.

    GET  /ask-hr/access   - {hrDesk}: is the caller HR for any company
    GET  /ask-hr/desk     - the HR desk: confidential HR tickets they work
    GET  /ask-hr/earlier  - Earlier Requests (hr_self_requests), read-only
    POST /ask-hr/migrate  - move any open old request into a ticket (also
                            run at startup; idempotent)
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

import hr_tickets
import ticket_confidential
from auth import get_current_user
from database import get_db

router = APIRouter(prefix="/ask-hr", tags=["Ask HR"], dependencies=[Depends(get_current_user)])


def _hr_somewhere(db: Session, user: dict) -> bool:
    comps = ticket_confidential.hr_companies(db, user)
    return comps is None or bool(comps)


@router.get("/access")
def ask_hr_access(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return {"hrDesk": _hr_somewhere(db, user)}


@router.get("/desk")
def ask_hr_desk(open_only: bool = False, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    from routers.tickets import _for_viewer, ticket_to_dict
    from ticket_notify import _name_of
    out = []
    for t in hr_tickets.desk_tickets(db, user, open_only):
        d = _for_viewer(db, t, user, ticket_to_dict(t))
        d["requesterName"] = _name_of(db, t.requester_email or "") or (t.requester_email or "")
        d["askHrKind"] = hr_tickets.kind_of(t)
        out.append(d)
    return out


@router.get("/earlier")
def ask_hr_earlier(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return hr_tickets.earlier_for_hr(db, user)


@router.post("/migrate")
def ask_hr_migrate(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """An administrator (or a Full HR grant) runs the move by hand - the
    startup pass does the same; a second run finds nothing to do."""
    import auth
    me = (user.get("email") or "").lower()
    if not (int(user.get("level", 0) or 0) >= auth._LEVELS["administrator"]
            or auth._module_level(me, "hr", db) >= auth._MODULE_LEVEL_RANK["full"]):
        raise HTTPException(403, "Only an administrator or a Full HR grant can move Ask HR requests.")
    return hr_tickets.migrate_open(db)
