"""People > Exits (Neil, Oct 27 2026): Exits In Progress and each leaver's
final settlement statement. The gathering and the PDF are exit_statement.py.

    GET  /exit-statements                         exits in progress in my People scope
    GET  /exit-statements/{employee_id}           the live statement + where its review stands
    POST /exit-statements/{employee_id}/review    HR: Reviewed (freezes the figures)
    POST /exit-statements/{employee_id}/generate  HR: the PDF on the letterhead, kept + filed
    POST /exit-statements/{employee_id}/egnyte    HR: Retry the Egnyte copy of the PDF
    POST /exit-statements/{employee_id}/close     HR: the exit is done (off the list)
    POST /exit-statements/{employee_id}/reopen    HR: a closed exit back where it was
    POST /exit-statements/{employee_id}/mailbox-handover          HR: the shared mailbox handover is done
    POST /exit-statements/{employee_id}/items/{kind}/{row}/{outcome}  HR: Received / Lost (Return Pending)

People access (the hr grant, within hr_scope) opens the list and the
statement; money (rates, amounts) only with the hr_comp grant or as an owner
(routers/hr._has_comp), and only those people review, generate, close and
reopen - the figures are what they sign off, and nobody does it for their
own exit. A manager (Neil, 11/14/2026) sees the exits of their own direct
reports and the people they back up - the tracker and the checklist only,
never pay, the settlement, the package's contents or HR's notes - checked
per person on every read.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import exit_statement as xs
from auth import get_current_user, hr_team_limited
from database import get_db
from models import ExitStatement, HrDocument, HrLifeEvent, NexusEmployee
from routers.hr import _assert_scope, _has_comp, hr_scope, require_hr_write

router = APIRouter(prefix="/exit-statements", tags=["Exit Statements"])


def _not_team(user: dict) -> None:
    if hr_team_limited(user):
        raise HTTPException(403, "Exits are HR's - the team view of People does not show them")


def _employee(db: Session, user: dict, eid: str) -> NexusEmployee:
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
    if emp is None:
        raise HTTPException(404, "Employee not found")
    _assert_scope(emp, hr_scope(user, db))
    return emp


def _build(db: Session, user: dict, emp: NexusEmployee, money: bool) -> dict:
    try:
        return xs.build(db, user, emp, money)
    except ValueError as e:
        raise HTTPException(404, str(e))


def _row(db: Session, emp: NexusEmployee, last_day: str, lock: bool = False):
    q = (db.query(ExitStatement).filter(ExitStatement.employee_id == emp.id, ExitStatement.last_day == last_day)
         .order_by(ExitStatement.created_at.desc()))
    return (q.with_for_update() if lock else q).first()


def _need_comp(db: Session, user: dict) -> None:
    if not _has_comp(user, db):
        raise HTTPException(403, "The statement carries pay - Pay & Benefits access is needed")


def _not_own(user: dict, emp: NexusEmployee, what: str) -> str:
    me = (user.get("email") or "").lower()
    if me and me == (emp.work_email or "").lower():
        raise HTTPException(403, f"Your own exit is {what} by someone else.")
    return me


def _hr_reader(user: dict, db: Session) -> bool:
    """HR's view of Exits: the People grant (or an Administrator), outside
    the manager tier's team view."""
    from auth import _LEVELS, _module_level
    if hr_team_limited(user):
        return False
    return user.get("level", 0) >= _LEVELS["administrator"] or _module_level(user["email"], "hr", db) >= 1


def _my_people(db: Session, user: dict) -> set:
    """A manager's own view (Neil, 11/14/2026): their DIRECT reports and the
    people they are Backup Manager for - nobody further down."""
    from sqlalchemy import func
    import backup_manager
    me = (user.get("email") or "").strip().lower()
    if not me:
        return set()
    direct = {(r[0] or "").strip().lower() for r in db.query(NexusEmployee.work_email)
              .filter(func.lower(NexusEmployee.manager_email) == me).all()}
    return (direct | backup_manager.backed_up_by(db, me)) - {"", me}


@router.get("")
def list_exits(include_closed: bool = False, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if _hr_reader(user, db):
        money = _has_comp(user, db)
        return {"exits": xs.exits_in_progress(db, hr_scope(user, db), include_closed, money=money),
                "canSeeMoney": money, "managerView": False, "today": xs._today()}
    # A manager sees the exits of their own people - the tracker only, never
    # pay, the settlement or the package's contents.
    mine = _my_people(db, user)
    if not mine:
        raise HTTPException(403, "Exits are HR's - you have no direct reports leaving")
    return {"exits": xs.exits_in_progress(db, None, include_closed, money=False, only_emails=mine),
            "canSeeMoney": False, "managerView": True, "today": xs._today()}


def _tracker_row(db: Session, emp: NexusEmployee, money: bool) -> dict:
    em = (emp.work_email or "").strip().lower()
    rows = xs.exits_in_progress(db, None, True, money=money, only_emails={em}) if em else []
    return next((r for r in rows if r["employeeId"] == emp.id), None) or {}


@router.get("/{eid}")
def get_statement(eid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if not _hr_reader(user, db):
        # A manager's own people only - checked here per person, never
        # trusted from the list: the tracker and the checklist, nothing more.
        emp = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
        if emp is None or (emp.work_email or "").strip().lower() not in _my_people(db, user):
            raise HTTPException(404, "Not found")
        tracker = _tracker_row(db, emp, False)
        if not tracker:
            raise HTTPException(404, "No exit in progress for this person.")
        return {"statement": None, "tracker": tracker, "checklist": xs._checklist(db, emp),
                "review": None, "canSeeMoney": False, "managerView": True}
    emp = _employee(db, user, eid)
    money = _has_comp(user, db)
    st = _build(db, user, emp, money)
    # The fingerprint is always of the full figures, so a stale review shows
    # to everyone, money or not.
    fp = xs.fingerprint(st if money else _build(db, user, emp, True))
    return {"statement": st, "tracker": _tracker_row(db, emp, money), "checklist": st["checklist"],
            "review": xs.ser_row(db, _row(db, emp, st["lastDay"]), fp, money),
            "canSeeMoney": money, "managerView": False}


class NoteIn(BaseModel):
    note: str = ""


@router.post("/{eid}/review")
def review(eid: str, body: NoteIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Reviewed: the figures as they are now are frozen with their
    fingerprint; anything that changes them afterwards shows the review as
    stale until it is reviewed again."""
    _not_team(user)
    _need_comp(db, user)
    emp = _employee(db, user, eid)
    me = _not_own(user, emp, "reviewed")
    st = _build(db, user, emp, True)
    row = _row(db, emp, st["lastDay"], lock=True)
    if row is None:
        row = xs.new_row(emp, st)
        db.add(row)
    if row.status == "closed":
        raise HTTPException(409, "This exit is closed")
    row.status, row.snapshot, row.fingerprint = "reviewed", st, xs.fingerprint(st)
    row.reviewed_by, row.reviewed_at = me, xs._now()
    # A new review needs a new PDF; the document and the Egnyte path are kept
    # so the next Generate writes over them - one copy per statement.
    row.generated_at = row.generated_by = ""
    xs.log(row, me, "reviewed", (body.note or "").strip()[:500])
    db.commit()
    return xs.ser_row(db, row, row.fingerprint, True)


def _file(db: Session, row: ExitStatement, emp: NexusEmployee, blob: bytes, name: str, me: str) -> None:
    """Filed only once the Egnyte copy is in (11/14/2026). Egnyte not
    connected = the copy in Nexus is the filing."""
    from services import egnyte as svc
    try:
        configured = svc.configured()
    except Exception:  # noqa: BLE001
        configured = False
    if not configured:
        row.status = "filed"
        return
    ok, got = xs.file_to_egnyte(db, row, emp, blob, name)
    if ok:
        row.status = "filed"
        xs.log(row, me, "egnyte_filed", got)
    else:
        row.status = "reviewed"
        xs.log(row, me, "egnyte_failed", got)


@router.post("/{eid}/generate")
def generate(eid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """The PDF of the REVIEWED statement on the company letterhead: kept in
    the person's HR documents (kind 'settlement', comp-gated) and copied to
    their Egnyte folder. One document per statement: generating again
    replaces the PDF in the SAME document and writes over the same Egnyte
    file - never a second copy."""
    from routers.esign import _DOC_BUCKET, _storage_put
    _not_team(user)
    _need_comp(db, user)
    emp = _employee(db, user, eid)
    me = _not_own(user, emp, "generated")
    live = _build(db, user, emp, True)
    row = _row(db, emp, live["lastDay"], lock=True)
    if row is None or row.status not in ("reviewed", "filed"):
        raise HTTPException(409, "Mark the statement Reviewed first")
    if row.fingerprint != xs.fingerprint(live):
        raise HTTPException(409, "The figures changed since it was reviewed - review it again first")
    from routers.reimbursements import _name as name_of
    blob = xs.render_pdf(db, row.snapshot or live, name_of(db, row.reviewed_by), row.reviewed_at)
    doc = db.query(HrDocument).filter(HrDocument.id == row.document_id).first() if row.document_id else None
    name = doc.file_name if doc is not None else xs.file_name(row.snapshot or live)
    path = (doc.storage_path if doc is not None else "") or row.pdf_path or f"{emp.id}/settlement-{uuid.uuid4()}.pdf"
    put = _storage_put(_DOC_BUCKET, path, blob, "application/pdf", upsert=True)
    if not put.is_success:
        raise HTTPException(502, "The PDF could not be stored - try again")
    if doc is None:
        doc = HrDocument(id=str(uuid.uuid4()), employee_id=emp.id, kind="settlement", file_name=name,
                         storage_path=path, size_bytes=len(blob), uploaded_by=me, created_at=xs._now())
        db.add(doc)
    else:
        doc.size_bytes, doc.uploaded_by = len(blob), me
    row.document_id, row.pdf_path = doc.id, path
    row.generated_by, row.generated_at = me, xs._now()
    xs.log(row, me, "generated", name)
    _file(db, row, emp, blob, name, me)
    db.commit()
    return {"review": xs.ser_row(db, row, row.fingerprint, True), "documentId": doc.id, "fileName": name}


@router.post("/{eid}/egnyte")
def retry_egnyte(eid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Retry: the PDF already kept in Nexus goes to Egnyte (same file)."""
    from routers.esign import _DOC_BUCKET, _storage_fetch
    _not_team(user)
    _need_comp(db, user)
    emp = _employee(db, user, eid)
    me = _not_own(user, emp, "filed")
    st = _build(db, user, emp, False)
    row = _row(db, emp, st["lastDay"], lock=True)
    doc = db.query(HrDocument).filter(HrDocument.id == row.document_id).first() if row and row.document_id else None
    if row is None or doc is None or row.status == "closed":
        raise HTTPException(409, "Generate the PDF first")
    got = _storage_fetch(_DOC_BUCKET, doc.storage_path)
    if not got.is_success:
        raise HTTPException(502, "The PDF could not be read from storage - generate it again")
    _file(db, row, emp, got.content, doc.file_name, me)
    db.commit()
    out = xs.ser_row(db, row, row.fingerprint, True)
    if row.status != "filed":
        raise HTTPException(502, f"Still not copied to Egnyte: {out['egnyteError'] or 'try again later'}")
    return out


@router.post("/{eid}/close")
def close(eid: str, body: NoteIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """The exit is done - off Exits In Progress. Before the statement is
    filed a note says why. Pay & Benefits holders only, never their own
    (the same rule as Review and Generate); the screen holds to confirm."""
    _not_team(user)
    _need_comp(db, user)
    emp = _employee(db, user, eid)
    me = _not_own(user, emp, "closed")
    st = _build(db, user, emp, False)
    row = _row(db, emp, st["lastDay"], lock=True)
    note = (body.note or "").strip()[:500]
    if (row is None or row.status != "filed") and len(note) < 3:
        raise HTTPException(400, "The statement is not filed - add a note saying why the exit is closed")
    if row is None:
        row = xs.new_row(emp, st)
        db.add(row)
    if row.status == "closed":
        raise HTTPException(409, "Already closed")
    before = row.status
    row.status, row.closed_by, row.closed_at = "closed", me, xs._now()
    xs.log(row, me, "closed", note, before=before)
    db.commit()
    return xs.ser_row(db, row, row.fingerprint, True)


@router.post("/{eid}/reopen")
def reopen(eid: str, body: NoteIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Reopen: a closed exit goes back to the status it had when it was
    closed (Open, Reviewed or Filed) and onto the list again."""
    _not_team(user)
    _need_comp(db, user)
    emp = _employee(db, user, eid)
    me = _not_own(user, emp, "reopened")
    st = _build(db, user, emp, False)
    row = _row(db, emp, st["lastDay"], lock=True)
    if row is None or row.status != "closed":
        raise HTTPException(409, "This exit is not closed")
    last = next((h for h in reversed(row.history or []) if h.get("action") == "closed"), {})
    back = last.get("before") or ("filed" if row.document_id and row.egnyte_path else
                                  "reviewed" if row.fingerprint else "open")
    if back not in ("open", "reviewed", "filed"):
        back = "open"
    row.status, row.closed_by, row.closed_at = back, "", ""
    xs.log(row, me, "reopened", (body.note or "").strip()[:500])
    db.commit()
    return xs.ser_row(db, row, row.fingerprint, True)


class HandoverIn(BaseModel):
    done: bool = True


@router.post("/{eid}/mailbox-handover")
def mailbox_handover(eid: str, body: HandoverIn, user: dict = Depends(require_hr_write),
                     db: Session = Depends(get_db)):
    """Mailbox Handover Pending (Neil, 11/14/2026): their mailbox is kept as
    a shared mailbox - the Exchange steps are done by hand in the admin
    center, and HR ticks them done here. Kept on the separation event."""
    _not_team(user)
    emp = _employee(db, user, eid)
    ex = xs.exit_of(db, emp)
    ev = (db.query(HrLifeEvent).filter(HrLifeEvent.id == ex["eventId"]).with_for_update().first()
          if ex and ex.get("eventId") else None)
    if ev is None or ((ev.inputs or {}).get("offboarding") or {}).get("mailboxAction") != "share":
        raise HTTPException(409, "Their mailbox is not being kept as a shared mailbox")
    me = (user.get("email") or "").lower()
    ev.inputs = {**(ev.inputs or {}), "mailbox_handover_done": bool(body.done),
                 "mailbox_handover_by": me if body.done else "", "mailbox_handover_at": xs._now() if body.done else ""}
    db.flush()
    xs.record(db, emp, me, "mailbox_handover_done" if body.done else "mailbox_handover_reopened",
              "Shared mailbox handover done" if body.done else "Shared mailbox handover marked not done")
    db.commit()
    return {"mailboxHandover": xs.mailbox_handover(ev)}


class ItemOutcomeIn(BaseModel):
    photo_url:  str = ""
    photo_name: str = ""
    note:       str = ""


@router.post("/{eid}/items/{kind}/{row_id}/{outcome}")
def item_outcome(eid: str, kind: str, row_id: str, outcome: str, body: ItemOutcomeIn,
                 user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Received / Lost for an item still out with someone who left (Return
    Pending) - from their exit. Items' own rules (routers/items.settle_return_pending)."""
    from routers.items import settle_return_pending
    _not_team(user)
    emp = _employee(db, user, eid)
    if not (emp.work_email or "").strip():
        raise HTTPException(404, "Not found")
    out = settle_return_pending(db, kind, row_id, outcome=outcome, actor_email=user["email"],
                                photo_url=body.photo_url, photo_name=body.photo_name, note=body.note,
                                holder=emp.work_email)
    db.commit()
    return out
