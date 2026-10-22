"""Accounting -> Reporting -> AMA: the other side of each line, Notes, and the
GL reclass a bookkeeper approves and pushes (Charmi, Oct 22 call, change
request 13). The model and the rules are in ama_review.py; the defaults
still to be confirmed are in accounting_assumptions.py.

  - GET  /accounting/ask/offsets?entries=<entry uuids>  the other side of the
    entries on screen (each entry read from the ledger through the same proxy
    and entity limit as every Accounting read).
  - GET  /accounting/ask/gl-accounts  the chart for the GL picker (any viewer).
  - PUT  /accounting/ask/lines/note  Notes on one line.
  - POST /accounting/ask/lines/reclass  pick the GL (and a vendor or
    customer): a pending reclass, Awaiting Bookkeeper. Anyone who reaches the
    entity proposes; from then on only a bookkeeper edits it.
  - POST /accounting/ask/reviews/{id}/send-back  a bookkeeper returns it.
  - POST /accounting/ask/reviews/{id}/push  a bookkeeper approves and pushes:
    a NEW reclass entry in Intacct when AMA_PUSH_TO_INTACCT is on (through
    intacct_client.create_gl_batch), else recorded for the Intacct GL import
    file. Either way the approver and the time are kept, any question on the
    line is resolved and the line shows Resolved.
  - GET  /accounting/ask/reviews/export.csv  the recorded reclasses as an
    Intacct GL import file (bookkeepers).

Notifications here only (CLAUDE.md), one per reclass per person, updated in
place: the bookkeepers when one is waiting, the proposer when it is sent
back or pushed.
"""
import asyncio
import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import accounting_assumptions as assumptions
import ama_review
import intacct_client
import intacct_gl
import models
from auth import company_of, require_module_grant
from database import SessionLocal
from routers import accounting
from routers.accounting import _limit
from routers.accounting_ask import (_GL, _ISO, NOTIFY_TYPE, _accounts, _chart, _load_settings, _names, _reach,
                                    _r2, _short, _text, caller)

router = APIRouter(prefix="/accounting/ask", tags=["Accounting"], dependencies=[Depends(require_module_grant("accounting", "viewer"))])

_UUID = re.compile(r"^[0-9a-fA-F-]{36}$")
_PARTY = re.compile(r"^[A-Za-z0-9._ -]{1,40}$")
_READS = 6            # entry reads in flight at once
NOTIFY_ACTION = json.dumps({"view": "accounting", "sub": "ama", "label": "Open AMA"})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── The other side ──────────────────────────────────────────────────────────
async def _ama_codes(who: dict) -> set:
    settings = await asyncio.to_thread(_load_settings)
    return set(settings["accounts"]) or {a["code"] for a in (await _accounts(who, []))[0]}


@router.get("/offsets")
async def offsets(entries: str = Query(""), who: dict = Depends(caller)):
    """{offsets: {entryId: {offsets: [...], hidden}}, errors: {entryId: why}}
    for up to AMA_OFFSET_BATCH_MAX entries. An entry that cannot be read
    answers in `errors`, never a 500 for the rest."""
    ids = list(dict.fromkeys(x.strip() for x in (entries or "").split(",") if x.strip()))
    if len(ids) > assumptions.AMA_OFFSET_BATCH_MAX:
        raise HTTPException(status_code=400, detail=f"Ask for at most {assumptions.AMA_OFFSET_BATCH_MAX} entries at a time.")
    if any(not _UUID.match(i) for i in ids):
        raise HTTPException(status_code=400, detail="entries must be entry ids.")
    if not ids:
        return {"offsets": {}, "errors": {}}
    ama_codes = await _ama_codes(who)
    reach = await _reach(who)
    sem = asyncio.Semaphore(_READS)
    out, errors = {}, {}

    async def one(eid: str):
        async with sem:
            try:
                data = await accounting._acct_get("/api/internal/entry", {"id": eid})
            except HTTPException as e:
                errors[eid] = str(e.detail)
                return
        lines = data.get("lines") or []
        # An entry none of whose lines the caller reaches is not theirs to see.
        if reach is not None and not any((ln.get("location") or "") in reach for ln in lines):
            errors[eid] = "Outside your accounting access."
            return
        out[eid] = ama_review.entry_offsets(lines, ama_codes, reach)
    await asyncio.gather(*[one(i) for i in ids])
    return {"offsets": out, "errors": errors}


@router.get("/gl-accounts")
async def gl_accounts(who: dict = Depends(caller)):
    """The GL picker's list: every account on the ledger the caller reads,
    the AMA accounts left out (a reclass moves a line OFF them)."""
    ama_codes = await _ama_codes(who)
    return {"accounts": [a for a in await _chart(who) if a["code"] not in ama_codes]}


# ── Bodies ──────────────────────────────────────────────────────────────────
class LineBody(BaseModel):
    entityCode: str
    entryId: Optional[str] = ""
    entryNo: Optional[str] = ""
    lineId: Optional[str] = ""
    accountNo: Optional[str] = ""
    accountTitle: Optional[str] = ""
    date: Optional[str] = ""
    amount: Optional[float] = 0.0
    description: Optional[str] = ""
    departmentId: Optional[str] = ""


class NoteBody(LineBody):
    note: Optional[str] = ""


class ReclassBody(LineBody):
    toAccount: str
    toAccountTitle: Optional[str] = ""
    partyKind: Optional[str] = ""          # '' | vendor | customer
    partyId: Optional[str] = ""
    partyName: Optional[str] = ""
    memo: Optional[str] = ""


class SendBackBody(BaseModel):
    note: Optional[str] = ""


def _line_fields(b: LineBody) -> dict:
    entity = _text(b.entityCode, 40)
    if not entity:
        raise HTTPException(status_code=400, detail="The line has no entity.")
    day = _text(b.date, 10)
    if day and not _ISO.match(day):
        raise HTTPException(status_code=400, detail="The line's date must be a date (YYYY-MM-DD).")
    amount = _r2(b.amount)
    return {
        "line_ref": ama_review.line_ref(_text(b.lineId, 80), _text(b.entryNo, 80), _text(b.accountNo, 40), amount, day),
        "entity_code": entity, "entry_id": _text(b.entryId, 80), "entry_no": _text(b.entryNo, 80), "line_id": _text(b.lineId, 80),
        "account_no": _text(b.accountNo, 40), "account_title": _text(b.accountTitle, 200), "entry_date": day, "amount": amount,
        "description": _text(b.description, 1000), "department_id": _text(b.departmentId, 40),
    }


def _get_or_new(db: Session, fields: dict, lock: bool = True) -> models.AccountingAmaLineReview:
    q = db.query(models.AccountingAmaLineReview).filter(models.AccountingAmaLineReview.line_ref == fields["line_ref"])
    r = (q.with_for_update() if lock else q).first()
    if r is None:
        r = models.AccountingAmaLineReview(id=str(uuid.uuid4()), history=[], reclass_status="", note="", **fields)
        db.add(r)
    return r


def _commit(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Someone saved this line at the same moment. Reload and try again.")


def _detail(db: Session, r: models.AccountingAmaLineReview) -> dict:
    return ama_review.review_out(r, _names(db, ama_review.review_names(r)))


def _get_review(db: Session, review_id: str, reach: Optional[set], lock: bool = False) -> models.AccountingAmaLineReview:
    q = db.query(models.AccountingAmaLineReview).filter(models.AccountingAmaLineReview.id == review_id)
    r = (q.with_for_update() if lock else q).first()
    if not r or (reach is not None and (r.entity_code or "") not in reach):
        raise HTTPException(status_code=404, detail="Reclass not found.")
    return r


def _label(r: models.AccountingAmaLineReview) -> str:
    parts = [f"Entry {r.entry_no}" if r.entry_no else "", f"${abs(_r2(r.amount)):,.2f}" if r.amount else ""]
    return " · ".join(p for p in parts if p) or "a ledger line"


def _notify(db: Session, r: models.AccountingAmaLineReview, recipient: str, title: str, body: str, by: str) -> None:
    """One bell per reclass per person, updated in place (CLAUDE.md)."""
    recipient = (recipient or "").lower()
    if not recipient or recipient == (by or "").lower():
        return
    row = (db.query(models.NexusNotification)
           .filter(models.NexusNotification.type == NOTIFY_TYPE, models.NexusNotification.ref_id == r.id,
                   models.NexusNotification.recipient == recipient)
           .with_for_update().first())
    now = _now()
    if row:
        row.title, row.body, row.requested_by, row.created_at = title, body, by, now
        row.read_by, row.closed_by, row.actioned = "", "", False
        return
    db.add(models.NexusNotification(
        id=str(uuid.uuid4()), type=NOTIFY_TYPE, recipient=recipient, title=title, body=body, ref_id=r.id,
        item_name=_label(r), requested_by=by, action=NOTIFY_ACTION, actioned=False, read_by="",
        company=company_of(recipient, db), created_at=now,
    ))


def _resolve_threads(db: Session, r: models.AccountingAmaLineReview, by: str, text: str, now: str) -> None:
    """A pushed reclass answers any open question on the same line."""
    q = db.query(models.AccountingAmaThread).filter(models.AccountingAmaThread.status != "Resolved")
    q = q.filter(models.AccountingAmaThread.line_id == r.line_id) if r.line_id else q.filter(
        models.AccountingAmaThread.entry_no == r.entry_no, models.AccountingAmaThread.account_no == r.account_no,
        models.AccountingAmaThread.entry_date == r.entry_date)
    for t in q.with_for_update().all():
        if not r.line_id and _r2((t.debit or 0) - (t.credit or 0)) != _r2(r.amount):
            continue
        t.status, t.moved_to_account, t.resolved_by, t.resolved_at, t.updated_at = "Resolved", r.to_account, by, now, now
        db.add(models.AccountingAmaMessage(id=str(uuid.uuid4()), thread_id=t.id, author_email=by, kind="event", body=text, created_at=now))


# ── Notes ───────────────────────────────────────────────────────────────────
@router.put("/lines/note")
async def save_note(body: NoteBody, who: dict = Depends(caller)):
    """Notes on one line - anyone who reaches its entity; the bookkeeper sees
    them in the grid and on the reclass."""
    fields = _line_fields(body)
    await _limit(who, fields["entity_code"], None)      # 403 outside the caller's entities
    note = _text(body.note, 4000)
    me = who["email"]

    def work():
        db = SessionLocal()
        try:
            r = _get_or_new(db, fields)
            if (r.note or "") != note:
                now = _now()
                r.note, r.note_by, r.note_at, r.updated_at = note, me, now, now
            _commit(db)
            return _detail(db, r)
        finally:
            db.close()
    return await asyncio.to_thread(work)


# ── The reclass ─────────────────────────────────────────────────────────────
@router.post("/lines/reclass")
async def propose(body: ReclassBody, who: dict = Depends(caller)):
    """Pick the GL (and a vendor or customer) for an AMA line: a pending
    reclass, Awaiting Bookkeeper. Once it waits, only a bookkeeper changes it
    (the answerer can never push - Charmi, 34:42)."""
    fields = _line_fields(body)
    await _limit(who, fields["entity_code"], None)
    to = _text(body.toAccount, 40)
    if not _GL.match(to):
        raise HTTPException(status_code=400, detail="Pick the GL account.")
    kind = (body.partyKind or "").strip().lower()
    if kind not in ("", "vendor", "customer"):
        raise HTTPException(status_code=400, detail="The counterparty is a vendor or a customer.")
    party = _text(body.partyId, 40) if kind else ""
    if kind and not _PARTY.match(party):
        raise HTTPException(status_code=400, detail=f"Pick the {kind}.")
    if not fields["amount"]:
        raise HTTPException(status_code=400, detail="The line has no amount to reclass.")
    ama_codes = await _ama_codes(who)
    if fields["account_no"] not in ama_codes:
        raise HTTPException(status_code=400, detail="Only a line on an Ask My Accountant account is reclassed here.")
    if to in ama_codes:
        raise HTTPException(status_code=400, detail="Pick the account the line belongs on, not an Ask My Accountant account.")
    title = _text(body.toAccountTitle, 200)
    try:
        chart = {a["code"]: a["title"] for a in await _chart(who)}
    except HTTPException:
        chart = None       # the ledger is not answering: the number's shape is checked, the bookkeeper checks the rest
    if chart is not None:
        if to not in chart:
            raise HTTPException(status_code=400, detail=f"{to} is not an account on the ledger.")
        title = chart[to] or title
    me = who["email"]

    def work():
        db = SessionLocal()
        try:
            keeper = ama_review.is_bookkeeper(db, me)
            r = _get_or_new(db, fields)
            status = r.reclass_status or ""
            if status in (ama_review.PUSHING, ama_review.PUSHED):
                raise HTTPException(status_code=409, detail="This reclass has already gone to Intacct.")
            if status == ama_review.AWAITING and not keeper:
                raise HTTPException(status_code=403, detail="This reclass is with the bookkeeper. Only a bookkeeper can change it now.")
            now = _now()
            r.to_account, r.to_account_title = to, title
            r.party_kind, r.party_id, r.party_name = kind, party, _text(body.partyName, 200) if kind else ""
            r.reclass_memo = _text(body.memo, 1000)
            r.reclass_ref = r.reclass_ref or ama_review.new_reclass_ref()
            r.push_error, r.updated_at = "", now
            name = _names(db, [me]).get(me) or me
            party_txt = f", {kind} {party}" if kind else ""
            if status == ama_review.AWAITING:
                ama_review.log(r, me, f"Changed to GL {to}{party_txt}", now)
            else:
                r.reclass_status, r.proposed_by, r.proposed_at, r.review_note = ama_review.AWAITING, me, now, ""
                ama_review.log(r, me, f"Proposed GL {to}{party_txt}", now)
                for k in ama_review.bookkeepers(db):
                    _notify(db, r, k, f"AMA Reclass Awaiting Bookkeeper: {_label(r)}",
                            f"{name} picked GL {to}{(' ' + title) if title else ''}{party_txt}. Review and push it to Intacct.", me)
            _commit(db)
            return _detail(db, r)
        finally:
            db.close()
    return await asyncio.to_thread(work)


def _must_keep(db: Session, me: str) -> None:
    if not ama_review.is_bookkeeper(db, me):
        raise HTTPException(status_code=403, detail="Only a bookkeeper can approve, send back or push a reclass.")


@router.post("/reviews/{review_id}/send-back")
async def send_back(review_id: str, body: SendBackBody, who: dict = Depends(caller)):
    reach = await _reach(who)
    me = who["email"]
    note = _text(body.note, 1000)

    def work():
        db = SessionLocal()
        try:
            _must_keep(db, me)
            r = _get_review(db, review_id, reach, lock=True)
            if r.reclass_status != ama_review.AWAITING:
                raise HTTPException(status_code=409, detail="Only a reclass awaiting the bookkeeper can be sent back.")
            now = _now()
            r.reclass_status, r.review_note, r.updated_at = ama_review.SENT_BACK, note, now
            ama_review.log(r, me, "Sent back" + (f": {note}" if note else ""), now)
            name = _names(db, [me]).get(me) or me
            _notify(db, r, r.proposed_by, f"AMA Reclass Sent Back: {_label(r)}", f"{name} sent it back" + (f": {_short(note)}" if note else "."), me)
            db.commit()
            return _detail(db, r)
        finally:
            db.close()
    return await asyncio.to_thread(work)


def _entry_of(r: models.AccountingAmaLineReview) -> dict:
    if assumptions.AMA_RECLASS_MODE != "new_entry":
        raise HTTPException(status_code=500, detail="An AMA push only ever creates a new reclass entry (AMA_RECLASS_MODE).")
    return ama_review.reclass_entry({
        "amount": r.amount, "date": r.entry_date, "reclassRef": r.reclass_ref, "entryNo": r.entry_no, "reclassMemo": r.reclass_memo,
        "partyKind": r.party_kind, "partyId": r.party_id, "entityCode": r.entity_code, "departmentId": r.department_id,
        "toAccount": r.to_account, "accountNo": r.account_no,
    })


@router.post("/reviews/{review_id}/push")
async def push(review_id: str, who: dict = Depends(caller)):
    """A bookkeeper approves the reclass and pushes it: a NEW reclass entry
    (never an edit of the original). With AMA_PUSH_TO_INTACCT on it is
    created in Intacct; off, it is recorded for the GL import file. The
    approver and the time are kept and the line moves to Resolved."""
    reach = await _reach(who)
    me = who["email"]
    live = bool(assumptions.AMA_PUSH_TO_INTACCT)
    if live and not intacct_client.configured():
        raise HTTPException(status_code=503, detail="Pushing to Intacct is switched on, but Intacct is not configured on this server (INTACCT_* settings).")

    def claim():
        db = SessionLocal()
        try:
            _must_keep(db, me)
            r = _get_review(db, review_id, reach, lock=True)
            stale = (r.reclass_status == ama_review.PUSHING and r.push_started_at
                     and r.push_started_at < (datetime.now(timezone.utc) - timedelta(minutes=assumptions.AMA_PUSH_STALE_MINUTES)).isoformat())
            if r.reclass_status != ama_review.AWAITING and not stale:
                raise HTTPException(status_code=409, detail={
                    ama_review.PUSHED: "This reclass was already pushed.", ama_review.PUSHING: "This reclass is being pushed right now.",
                    ama_review.SENT_BACK: "This reclass was sent back. It needs a new GL pick first."}.get(r.reclass_status, "There is no reclass to push."))
            if not assumptions.AMA_BOOKKEEPER_MAY_APPROVE_OWN and (r.proposed_by or "").lower() == me:
                raise HTTPException(status_code=403, detail="Another bookkeeper has to approve a reclass you proposed.")
            entry = _entry_of(r)
            if not intacct_gl.balanced([entry]):
                raise HTTPException(status_code=400, detail="The reclass entry does not balance.")
            if live:
                r.reclass_status, r.push_started_at, r.push_error = ama_review.PUSHING, _now(), ""
                db.commit()
            return entry
        finally:
            db.close()
    entry = await asyncio.to_thread(claim)

    record, error = "", ""
    if live:
        try:
            record = await asyncio.to_thread(intacct_client.create_gl_batch, entry)
        except intacct_client.IntacctError as e:
            error = str(e)

    def finish():
        db = SessionLocal()
        try:
            r = _get_review(db, review_id, reach, lock=True)
            now = _now()
            if error:
                r.reclass_status, r.push_error, r.push_started_at, r.updated_at = ama_review.AWAITING, error[:500], "", now
                ama_review.log(r, me, f"Push failed: {error}", now)
                db.commit()
                return None
            r.reclass_status, r.approved_by, r.approved_at, r.updated_at = ama_review.PUSHED, me, now, now
            r.push_mode, r.intacct_ref, r.push_error = ("intacct" if live else "import"), record, ""
            what = (f"Pushed to Intacct as a new reclass entry{(' ' + record) if record else ''}" if live
                    else "Approved and recorded for the Intacct import file")
            ama_review.log(r, me, f"{what} - GL {r.to_account}", now)
            _resolve_threads(db, r, me, f"Resolved - reclassed to account {r.to_account} ({r.reclass_ref})", now)
            name = _names(db, [me]).get(me) or me
            _notify(db, r, r.proposed_by, f"AMA Reclass Pushed: {_label(r)}", f"{name} approved it - {what.lower()}, GL {r.to_account}.", me)
            db.commit()
            return _detail(db, r)
        finally:
            db.close()
    out = await asyncio.to_thread(finish)
    if out is None:
        raise HTTPException(status_code=424, detail=f"Intacct did not take the reclass: {error}")
    return out


@router.get("/reviews/export.csv")
async def export_csv(id: Optional[str] = None, who: dict = Depends(caller)):
    """The approved reclasses recorded for import (or one, by id, whatever
    how it was pushed) as an Intacct GL import file - bookkeepers."""
    reach = await _reach(who)
    me = who["email"]

    def work():
        db = SessionLocal()
        try:
            _must_keep(db, me)
            if id:
                rows = [_get_review(db, id, reach)]
                if rows[0].reclass_status != ama_review.PUSHED:
                    raise HTTPException(status_code=409, detail="Only an approved reclass goes into the import file.")
            else:
                rows = [r for r in db.query(models.AccountingAmaLineReview)
                        .filter(models.AccountingAmaLineReview.reclass_status == ama_review.PUSHED,
                                models.AccountingAmaLineReview.push_mode == "import")
                        .order_by(models.AccountingAmaLineReview.approved_at).all()
                        if reach is None or (r.entity_code or "") in reach]
            return intacct_gl.to_csv([_entry_of(r) for r in rows])
        finally:
            db.close()
    text = await asyncio.to_thread(work)
    return Response(content=text, media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="ama-reclasses-intacct-gl.csv"'})
