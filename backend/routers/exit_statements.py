"""People > Exits (Neil, Oct 27 2026): Exits In Progress and each leaver's
final settlement statement. The gathering and the PDF are exit_statement.py.

    GET  /exit-statements                         exits in progress in my People scope
    GET  /exit-statements/{employee_id}           the live statement + where its review stands
    POST /exit-statements/{employee_id}/review    HR: Reviewed (freezes the figures)
    POST /exit-statements/{employee_id}/generate  HR: the PDF on the letterhead, kept + filed
    POST /exit-statements/{employee_id}/close     HR: the exit is done (off the list)

People access (the hr grant, within hr_scope) opens the list and the
statement; money (rates, amounts) only with the hr_comp grant or as an owner
(routers/hr._has_comp), and only those people review and generate - the
figures are what they sign off. The manager tier's team view of People never
sees exits.
"""
import threading
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import exit_statement as xs
from auth import hr_team_limited
from database import get_db
from models import ExitStatement, HrDocument, NexusEmployee
from routers.hr import _assert_scope, _has_comp, hr_scope, require_hr_read, require_hr_write

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


@router.get("")
def list_exits(include_closed: bool = False, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    _not_team(user)
    return {"exits": xs.exits_in_progress(db, hr_scope(user, db), include_closed), "canSeeMoney": _has_comp(user, db)}


@router.get("/{eid}")
def get_statement(eid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    _not_team(user)
    emp = _employee(db, user, eid)
    money = _has_comp(user, db)
    st = _build(db, user, emp, money)
    # The fingerprint is always of the full figures, so a stale review shows
    # to everyone, money or not.
    fp = xs.fingerprint(st if money else _build(db, user, emp, True))
    return {"statement": st, "review": xs.ser_row(db, _row(db, emp, st["lastDay"]), fp, money),
            "canSeeMoney": money}


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
    me = (user.get("email") or "").lower()
    if me and me == (emp.work_email or "").lower():
        raise HTTPException(403, "Your own final settlement is reviewed by someone else.")
    st = _build(db, user, emp, True)
    row = _row(db, emp, st["lastDay"], lock=True)
    if row is None:
        row = xs.new_row(emp, st)
        db.add(row)
    if row.status == "closed":
        raise HTTPException(409, "This exit is closed")
    row.status, row.snapshot, row.fingerprint = "reviewed", st, xs.fingerprint(st)
    row.reviewed_by, row.reviewed_at = me, xs._now()
    row.document_id = row.pdf_path = row.generated_at = row.generated_by = ""
    xs.log(row, me, "reviewed", (body.note or "").strip()[:500])
    db.commit()
    return xs.ser_row(db, row, row.fingerprint, True)


@router.post("/{eid}/generate")
def generate(eid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """The PDF of the REVIEWED statement on the company letterhead: kept in
    the person's HR documents (kind 'settlement', comp-gated) and filed to
    their Egnyte folder best-effort on a thread."""
    from routers.esign import _DOC_BUCKET, _storage_put
    _not_team(user)
    _need_comp(db, user)
    emp = _employee(db, user, eid)
    me = (user.get("email") or "").lower()
    if me and me == (emp.work_email or "").lower():
        raise HTTPException(403, "Your own final settlement is generated by someone else.")
    live = _build(db, user, emp, True)
    row = _row(db, emp, live["lastDay"], lock=True)
    if row is None or row.status not in ("reviewed", "filed"):
        raise HTTPException(409, "Mark the statement Reviewed first")
    if row.fingerprint != xs.fingerprint(live):
        raise HTTPException(409, "The figures changed since it was reviewed - review it again first")
    from routers.reimbursements import _name as name_of
    blob = xs.render_pdf(db, row.snapshot or live, name_of(db, row.reviewed_by), row.reviewed_at)
    name = xs.file_name(row.snapshot or live)
    path = f"{emp.id}/settlement-{uuid.uuid4()}.pdf"
    put = _storage_put(_DOC_BUCKET, path, blob, "application/pdf", upsert=True)
    if not put.is_success:
        raise HTTPException(502, "The PDF could not be stored - try again")
    doc = HrDocument(id=str(uuid.uuid4()), employee_id=emp.id, kind="settlement", file_name=name,
                     storage_path=path, size_bytes=len(blob), uploaded_by=me, created_at=xs._now())
    db.add(doc)
    row.status, row.document_id, row.pdf_path = "filed", doc.id, path
    row.generated_by, row.generated_at = me, xs._now()
    xs.log(row, me, "generated", name)
    db.commit()
    try:
        from services import egnyte as svc
        if svc.configured():
            threading.Thread(target=xs.file_to_egnyte, args=(row.id, blob, name), daemon=True).start()
    except Exception as e:  # noqa: BLE001
        print(f"[exit-statement] Egnyte not started for {row.id}: {e}")
    return {"review": xs.ser_row(db, row, row.fingerprint, True), "documentId": doc.id, "fileName": name}


@router.post("/{eid}/close")
def close(eid: str, body: NoteIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """The exit is done - off Exits In Progress. Before the statement is
    filed a note says why."""
    _not_team(user)
    emp = _employee(db, user, eid)
    me = (user.get("email") or "").lower()
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
    row.status, row.closed_by, row.closed_at = "closed", me, xs._now()
    xs.log(row, me, "closed", note)
    db.commit()
    return xs.ser_row(db, row, row.fingerprint, _has_comp(user, db))
