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
  - POST /accounting/ask/reviews/preview  a bookkeeper sees exactly what a
    push of up to AMA_PUSH_BATCH_LIMIT lines would change on the ORIGINAL
    Intacct entries (Neil, 23 Oct: "The push should edit the original").
  - POST /accounting/ask/reviews/push  {previewId, ids}: the guarded push of
    that preview - edits the original entry in Intacct when
    AMA_PUSH_TO_INTACCT is on (intacct_client.update_gl_batch, read back to
    confirm), else logs what it would send. The approver and the time are
    kept, any question on the line is resolved and the line shows Resolved.
    POST /reviews/{id}/push is the same for one line ('new_entry' mode: the
    older NEW reclass entry, or recorded for the GL import file).
  - GET  /accounting/ask/push-log  the append-only push log (bookkeepers).
  - GET  /accounting/ask/reviews/export.csv  reclasses recorded for import in
    'new_entry' mode, as an Intacct GL import file (bookkeepers).

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
            if status in (ama_review.PUSHING, ama_review.PUSHED, ama_review.CHECK):
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
    """The NEW reclass entry of 'new_entry' mode (and of every reclass
    recorded for the import file before the edit-the-original rework)."""
    return ama_review.reclass_entry({
        "amount": r.amount, "date": r.entry_date, "reclassRef": r.reclass_ref, "entryNo": r.entry_no, "reclassMemo": r.reclass_memo,
        "partyKind": r.party_kind, "partyId": r.party_id, "entityCode": r.entity_code, "departmentId": r.department_id,
        "toAccount": r.to_account, "accountNo": r.account_no,
    })


class PushBody(BaseModel):
    previewId: Optional[str] = ""
    ids: Optional[list[str]] = None


@router.post("/reviews/{review_id}/push")
async def push(review_id: str, body: Optional[PushBody] = None, who: dict = Depends(caller)):
    """A bookkeeper approves the reclass and pushes it. 'edit_original' mode
    (the default, Neil 23 Oct): the same guarded push as /reviews/push for
    this one line - it takes the preview the bookkeeper looked at.
    'new_entry' mode: a NEW reclass entry, created in Intacct with
    AMA_PUSH_TO_INTACCT on, else recorded for the GL import file."""
    if assumptions.AMA_RECLASS_MODE != "new_entry":
        return await push_batch(PushBody(previewId=(body.previewId if body else "") or "", ids=[review_id]), who)
    return await _push_new_entry(review_id, who)


async def _push_new_entry(review_id: str, who: dict):
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


# ── Edit the original: preview, then push (Neil, 23 Oct, CR-13 rework) ──────
# "CAREFUL TO GET THIS RIGHT, WE DONT WANT TO SCREW UP INTACCT DATA ...
# validated with 1 entry at a time, then 4 at a time, then 10 at a time".
#   1. At most AMA_PUSH_BATCH_LIMIT lines per preview and per push (server-side).
#   2. A preview reads each entry IN FULL and shows exactly what would change
#      (entry, line, account and vendor / customer before -> after, amounts
#      unchanged); a push must name a fresh, unused preview of the same person
#      for the same lines.
#   3. Every entry a push touches is logged before and after, append-only
#      (accounting_ama_push_log), with what Intacct answered and the entry
#      read again after the update to confirm.
#   4. Nothing is sent when the entry reads differently from the preview, the
#      period is closed, or any amount would change.
#   5. NEXUS_AMA_INTACCT_PUSH off (the default): every check runs and the log
#      keeps what WOULD be sent - nothing reaches Intacct.
CHECK = ama_review.CHECK       # the update went through but the re-read did not match
_EDITABLE = (ama_review.AWAITING, CHECK)


class PreviewBody(BaseModel):
    ids: list[str]


def _ids(raw: Optional[list]) -> list[str]:
    ids = sorted({str(i or "").strip() for i in (raw or []) if str(i or "").strip()})
    if not ids:
        raise HTTPException(status_code=400, detail="Pick the reclasses to push.")
    if len(ids) > assumptions.AMA_PUSH_BATCH_LIMIT:
        raise HTTPException(status_code=400, detail=(
            f"At most {assumptions.AMA_PUSH_BATCH_LIMIT} line{'s' if assumptions.AMA_PUSH_BATCH_LIMIT != 1 else ''} per push "
            "(AMA_PUSH_BATCH_LIMIT) while pushes to Intacct are being validated."))
    if any(not _UUID.match(i) for i in ids):
        raise HTTPException(status_code=400, detail="ids must be reclass ids.")
    return ids


def _rv(r: models.AccountingAmaLineReview) -> dict:
    return {"id": r.id, "lineId": r.line_id or "", "entryId": r.entry_id or "", "entryNo": r.entry_no or "", "accountNo": r.account_no or "",
            "accountTitle": r.account_title or "", "toAccount": r.to_account or "", "toAccountTitle": r.to_account_title or "",
            "amount": _r2(r.amount), "partyKind": r.party_kind or "", "partyId": r.party_id or "", "reclassRef": r.reclass_ref or "",
            "date": r.entry_date or "", "proposedBy": r.proposed_by or ""}


def _closed_through(db: Session) -> str:
    row = db.query(models.AccountingAmaSetting).filter(models.AccountingAmaSetting.entity_code == "").first()
    return ((row.closed_through if row else "") or assumptions.AMA_BOOKS_CLOSED_THROUGH or "")[:10]


def _load_for_push(ids: list[str], reach: Optional[set], me: str) -> tuple[list[dict], str]:
    db = SessionLocal()
    try:
        _must_keep(db, me)
        out = []
        for i in ids:
            r = _get_review(db, i, reach)
            if r.reclass_status not in _EDITABLE:
                raise HTTPException(status_code=409, detail={
                    ama_review.PUSHED: f"{_label(r)} was already pushed.", ama_review.PUSHING: f"{_label(r)} is being pushed right now.",
                    ama_review.SENT_BACK: f"{_label(r)} was sent back. It needs a new GL pick first."}.get(r.reclass_status, f"{_label(r)} has no reclass to push."))
            if not assumptions.AMA_BOOKKEEPER_MAY_APPROVE_OWN and (r.proposed_by or "").lower() == me:
                raise HTTPException(status_code=403, detail="Another bookkeeper has to approve a reclass you proposed.")
            out.append(_rv(r))
        return out, _closed_through(db)
    finally:
        db.close()


async def _read_one(rv: dict, use_intacct: bool) -> tuple[dict, Optional[int]]:
    """The entry an AMA line sits on, read in full: from Intacct when it is
    set up on this server, else the Nexus ledger copy (a dry run only)."""
    if not _UUID.match(rv["entryId"] or ""):
        raise HTTPException(status_code=409, detail=f"Entry {rv['entryNo'] or '?'}: the line has no ledger entry to read. Make this change in Intacct.")
    ledger = await accounting._acct_get("/api/internal/entry", {"id": rv["entryId"]})
    if not use_intacct:
        batch = ama_review.ledger_entry(ledger)
        return batch, ama_review.find_line(batch, rv)
    line = next((ln for ln in ledger.get("lines") or [] if rv["lineId"] and str(ln.get("id") or ln.get("line_id") or "") == rv["lineId"]), None)
    rec = str((line or {}).get("intacct_record_no") or "").strip()
    if not rec:
        raise HTTPException(status_code=409, detail=f"Entry {rv['entryNo']}: the Nexus ledger has no Intacct record number for this line, so it cannot be found in Intacct safely. Make this change in Intacct.")
    try:
        batch = await asyncio.to_thread(intacct_client.read_gl_batch_of_line, rec)
    except intacct_client.IntacctError as e:
        raise HTTPException(status_code=424, detail=f"Entry {rv['entryNo']}: {e}")
    return batch, ama_review.find_line(batch, rv, rec)


async def _plan(rvs: list[dict], use_intacct: bool, closed: str, me: str) -> list[dict]:
    """Each entry the lines sit on, read, checked, with its one update."""
    groups: dict[str, dict] = {}
    for rv in rvs:
        batch, idx = await _read_one(rv, use_intacct)
        key = str(batch.get("recordNo") or rv["entryId"])
        g = groups.get(key)
        if g is None:
            g = groups[key] = {"key": key, "batch": batch, "targets": [], "problems": list(ama_review.entry_problems(batch, closed)), "done": []}
        elif ama_review.fingerprint(batch) != ama_review.fingerprint(g["batch"]):
            g["problems"].append("The entry changed while it was being read. Preview again.")
        why, done = ama_review.line_problem(g["batch"], idx, rv)
        if why:
            g["problems"].append(f"{rv['reclassRef']}: {why}")
        elif idx is not None:
            if any(i == idx for i, _ in g["targets"]):
                g["problems"].append(f"{rv['reclassRef']}: another reclass is on the same line.")
            g["targets"].append((idx, rv))
            if done:
                g["done"].append(rv["id"])
    out = []
    for g in groups.values():
        b = g["batch"]
        update = ama_review.edit_update(b, g["targets"], me) if g["targets"] else {}
        if update and not ama_review.amounts_unchanged(b, update):
            g["problems"].append("The change would alter an amount or another field. Nothing was changed.")
        out.append({
            "key": g["key"], "entryNo": b.get("batchNo") or next((rv["entryNo"] for _, rv in g["targets"]), ""), "journal": b.get("journal") or "",
            "date": b.get("date") or "", "state": b.get("state") or "", "title": b.get("title") or "", "source": b.get("source") or "",
            "fingerprint": ama_review.fingerprint(b), "before": b, "update": update, "xml": intacct_client.glbatch_update_xml(update) if update else "",
            "changes": ama_review.changes_of(b, g["targets"]), "lineCount": len(b.get("lines") or []),
            "alreadyDone": len(g["done"]) == len(g["targets"]) and bool(g["targets"]), "problems": g["problems"],
            "reviewIds": sorted(rv["id"] for _, rv in g["targets"]),
        })
    return out


def _public(entry: dict) -> dict:
    """A planned entry as the screen sees it (no raw read)."""
    return {k: entry[k] for k in ("key", "entryNo", "journal", "date", "state", "title", "source", "changes", "lineCount", "alreadyDone", "problems", "update")}


def _live_and_source() -> tuple[bool, bool]:
    live = bool(assumptions.AMA_PUSH_TO_INTACCT)
    use_intacct = intacct_client.configured()
    if live and not use_intacct:
        raise HTTPException(status_code=503, detail="Pushing to Intacct is switched on, but Intacct is not configured on this server (INTACCT_* settings).")
    if assumptions.AMA_RECLASS_MODE != "edit_original":
        raise HTTPException(status_code=409, detail="This server pushes reclasses as new entries (AMA_RECLASS_MODE=new_entry); there is nothing to preview.")
    return live, use_intacct


@router.post("/reviews/preview")
async def preview(body: PreviewBody, who: dict = Depends(caller)):
    """Exactly what a push of these lines would change in Intacct - read, not
    written. {previewId (null when anything stops it), live, source, limit,
    expiresAt, entries: [{entryNo, journal, date, changes: [{lineNo,
    accountBefore -> accountAfter, vendor / customer before -> after,
    amount}], problems, update}]}."""
    ids = _ids(body.ids)
    live, use_intacct = _live_and_source()
    reach = await _reach(who)
    me = who["email"]
    rvs, closed = await asyncio.to_thread(_load_for_push, ids, reach, me)
    plan = await _plan(rvs, use_intacct, closed, me)
    ok = all(not e["problems"] for e in plan)
    now = datetime.now(timezone.utc)
    expires = (now + timedelta(minutes=assumptions.AMA_PREVIEW_TTL_MINUTES)).isoformat()
    preview_id = None
    if ok:
        preview_id = str(uuid.uuid4())

        def save():
            db = SessionLocal()
            try:
                db.add(models.AccountingAmaPushPreview(
                    id=preview_id, created_by=me, created_at=now.isoformat(), expires_at=expires, review_ids=ids,
                    source="intacct" if use_intacct else "ledger", live=live,
                    entries=[{k: e[k] for k in ("key", "entryNo", "fingerprint", "before", "update", "changes", "reviewIds", "alreadyDone")} for e in plan]))
                db.commit()
            finally:
                db.close()
        await asyncio.to_thread(save)
    return {"previewId": preview_id, "ok": ok, "live": live, "source": "intacct" if use_intacct else "ledger",
            "limit": assumptions.AMA_PUSH_BATCH_LIMIT, "expiresAt": expires if ok else "", "entries": [_public(e) for e in plan]}


def _log(db: Session, **kw) -> None:
    """One append-only push-log row."""
    db.add(models.AccountingAmaPushLog(id=str(uuid.uuid4()), at=_now(), **kw))


@router.post("/reviews/push")
async def push_batch(body: PushBody, who: dict = Depends(caller)):
    """Push the lines of one preview: each entry is read again and must match
    the preview exactly, then (switch on) the original entry is updated in
    Intacct and read back to confirm; (switch off) what would be sent is
    logged and nothing leaves Nexus. Stops at the first entry that does not
    go through; that line and the ones after it stay with the bookkeeper."""
    ids = _ids(body.ids)
    live, use_intacct = _live_and_source()
    reach = await _reach(who)
    me = who["email"]
    preview_id = (body.previewId or "").strip()

    def keeper():
        db = SessionLocal()
        try:
            _must_keep(db, me)
        finally:
            db.close()
    await asyncio.to_thread(keeper)      # 403 for anyone else, before anything about previews
    if not preview_id:
        raise HTTPException(status_code=428, detail="Preview the change first - the push sends only what the preview showed.")

    def claim():
        db = SessionLocal()
        try:
            _must_keep(db, me)
            p = db.query(models.AccountingAmaPushPreview).filter(models.AccountingAmaPushPreview.id == preview_id).with_for_update().first()
            if not p or (p.created_by or "").lower() != me:
                raise HTTPException(status_code=428, detail="Preview the change first - this preview is not yours or does not exist.")
            if p.used_at:
                raise HTTPException(status_code=409, detail="This preview was already used. Preview again.")
            if (p.expires_at or "") < _now():
                raise HTTPException(status_code=409, detail="This preview is out of date. Preview again.")
            if sorted(p.review_ids or []) != ids:
                raise HTTPException(status_code=409, detail="The lines to push are not the ones previewed. Preview again.")
            if bool(p.live) != live or p.source != ("intacct" if use_intacct else "ledger"):
                raise HTTPException(status_code=409, detail="The push switch changed since the preview. Preview again.")
            rows = []
            for i in ids:
                r = _get_review(db, i, reach, lock=True)
                stale = (r.reclass_status == ama_review.PUSHING and r.push_started_at
                         and r.push_started_at < (datetime.now(timezone.utc) - timedelta(minutes=assumptions.AMA_PUSH_STALE_MINUTES)).isoformat())
                if r.reclass_status not in _EDITABLE and not stale:
                    raise HTTPException(status_code=409, detail=f"{_label(r)} is {r.reclass_status or 'not waiting'} - only a reclass awaiting the bookkeeper is pushed.")
                if not assumptions.AMA_BOOKKEEPER_MAY_APPROVE_OWN and (r.proposed_by or "").lower() == me:
                    raise HTTPException(status_code=403, detail="Another bookkeeper has to approve a reclass you proposed.")
                rows.append(_rv(r))
                if live:
                    r.reclass_status, r.push_started_at, r.push_error = ama_review.PUSHING, _now(), ""
            p.used_at = _now()
            db.commit()
            return rows, list(p.entries or []), _closed_through(db)
        finally:
            db.close()
    rvs, planned, closed = await asyncio.to_thread(claim)
    by_id = {rv["id"]: rv for rv in rvs}

    results, stop = [], False
    for entry in planned:
        group = [by_id[i] for i in entry.get("reviewIds") or [] if i in by_id]
        if stop:
            results.append({"entry": entry, "rvs": group, "outcome": "not_tried", "error": "Not tried - an earlier entry in this push did not go through."})
            continue
        res = {"entry": entry, "rvs": group, "outcome": "", "error": "", "response": "", "after": {}, "sent": {}, "xml": "", "before": {}}
        try:
            fresh = await _plan(group, use_intacct, closed, me)
        except HTTPException as e:
            fresh, res["outcome"], res["error"] = [], "failed", str(e.detail)
        if not res["outcome"]:
            f = fresh[0] if len(fresh) == 1 else None
            res["before"] = f["before"] if f else {}
            if f is None or f["fingerprint"] != entry["fingerprint"] or f["update"] != entry["update"]:
                res["outcome"], res["error"] = "stale", "The entry changed in Intacct since the preview. Nothing was sent - preview again."
            elif f["problems"]:
                res["outcome"], res["error"] = "failed", " ".join(f["problems"])
            elif f["alreadyDone"]:
                res["outcome"] = "already_done"
            else:
                res["sent"], res["xml"] = f["update"], intacct_client.glbatch_update_xml(f["update"])
                if not live:
                    res["outcome"] = "dry_run"
                else:
                    try:
                        res["response"] = await asyncio.to_thread(intacct_client.update_gl_batch, f["update"])
                    except intacct_client.IntacctError as e:
                        res["outcome"], res["error"] = "failed", str(e)
                    if not res["outcome"]:
                        try:
                            after = await asyncio.to_thread(intacct_client.reread_gl_batch, f["update"]["recordNo"])
                            res["after"] = after
                            off = ama_review.verify_after(f["update"], after)
                            res["outcome"], res["error"] = ("unconfirmed", " ".join(off)) if off else ("edited", "")
                        except intacct_client.IntacctError as e:
                            res["outcome"], res["error"] = "unconfirmed", f"Intacct took the update, but reading the entry back failed: {e}"
        if res["outcome"] not in ("edited", "already_done", "dry_run"):
            stop = True
        results.append(res)

    def finish():
        db = SessionLocal()
        try:
            name = _names(db, [me]).get(me) or me
            out = []
            for res in results:
                entry = res["entry"]
                if res["outcome"] != "not_tried":
                    _log(db, by=me, preview_id=preview_id, review_ids=[rv["id"] for rv in res["rvs"]], entry_key=entry["key"], entry_no=entry.get("entryNo") or "",
                         mode="live" if live else "dry_run", source="intacct" if use_intacct else "ledger", before=res.get("before") or {},
                         sent=res.get("sent") or {}, sent_xml=res.get("xml") or "", response=str(res.get("response") or ""), after=res.get("after") or {},
                         outcome=res["outcome"], error=res["error"])
                for rv in res["rvs"]:
                    r = _get_review(db, rv["id"], reach, lock=True)
                    now = _now()
                    change = next((c for c in entry.get("changes") or [] if c["reviewId"] == rv["id"]), {})
                    what = f"entry {entry.get('entryNo') or entry['key']} line {change.get('lineNo', '?')}: {rv['accountNo']} to {rv['toAccount']}"
                    r.updated_at, r.push_started_at = now, ""
                    if res["outcome"] in ("edited", "already_done"):
                        r.reclass_status, r.approved_by, r.approved_at = ama_review.PUSHED, me, now
                        r.push_mode, r.intacct_ref, r.push_error = "edit", entry["key"], ""
                        event = (f"Edited the original entry in Intacct - {what}" if res["outcome"] == "edited"
                                 else f"Already on {rv['toAccount']} in Intacct - {what}; marked pushed")
                        ama_review.log(r, me, event, now)
                        _resolve_threads(db, r, me, f"Resolved - moved to account {r.to_account} on the original entry ({r.reclass_ref})", now)
                        _notify(db, r, r.proposed_by, f"AMA Reclass Pushed: {_label(r)}", f"{name} approved it - {event[0].lower()}{event[1:]}.", me)
                    elif res["outcome"] == "dry_run":
                        r.reclass_status, r.push_error = ama_review.AWAITING, ""
                        ama_review.log(r, me, f"Dry run (the Intacct push is switched off) - would change {what}; nothing was sent", now)
                    elif res["outcome"] == "unconfirmed":
                        r.reclass_status, r.push_error = CHECK, res["error"][:500]
                        ama_review.log(r, me, f"Intacct took the update but the entry read back differently - check entry {entry.get('entryNo') or entry['key']} in Intacct: {res['error']}", now)
                    else:
                        r.reclass_status, r.push_error = ama_review.AWAITING, res["error"][:500]
                        ama_review.log(r, me, f"Push {'not tried' if res['outcome'] == 'not_tried' else 'stopped'}: {res['error']}", now)
                    out.append(r)
            db.commit()
            return [_detail(db, r) for r in out]
        finally:
            db.close()
    reviews = await asyncio.to_thread(finish)
    summary = [{"entryNo": res["entry"].get("entryNo") or "", "key": res["entry"]["key"], "outcome": res["outcome"], "error": res["error"]} for res in results]
    if any(s["outcome"] in ("failed", "stale", "unconfirmed") for s in summary) and len(ids) == 1:
        bad = summary[0]
        raise HTTPException(status_code=424 if bad["outcome"] != "stale" else 409, detail=bad["error"] or "The push did not go through.")
    return {"dryRun": not live, "results": summary, "reviews": reviews, **({"review": reviews[0]} if len(reviews) == 1 else {})}


@router.get("/push-log")
async def push_log(review: Optional[str] = None, who: dict = Depends(caller)):
    """The push log (newest first) - bookkeepers. `review` narrows it to one
    reclass. Read-only: the log is never changed."""
    reach = await _reach(who)
    me = who["email"]

    def work():
        db = SessionLocal()
        try:
            _must_keep(db, me)
            if review:
                _get_review(db, review, reach)
            q = db.query(models.AccountingAmaPushLog).order_by(models.AccountingAmaPushLog.at.desc())
            rows = [x for x in q.limit(500).all() if not review or review in (x.review_ids or [])][:100]
            names = _names(db, [x.by for x in rows])
            return [{"at": x.at, "by": x.by, "byName": names.get((x.by or "").lower(), ""), "entryKey": x.entry_key, "entryNo": x.entry_no,
                     "mode": x.mode, "source": x.source, "outcome": x.outcome, "error": x.error, "response": x.response,
                     "sent": x.sent or {}, "reviewIds": x.review_ids or []} for x in rows]
        finally:
            db.close()
    return {"log": await asyncio.to_thread(work)}


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
