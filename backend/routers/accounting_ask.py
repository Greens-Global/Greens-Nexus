"""Accounting -> Reporting -> AMA, Ask My Accountant (Neil, 10/15: "AMA means
Ask My Accountant" - the screen first built under that name was Asset
Management Agreements, now Management Fees, routers/accounting_ama.py).

In bookkeeping an unclear transaction is parked in an "Ask My Accountant"
(suspense) GL account until the accountant says where it belongs; anyone can
also flag any line with a question. So this screen has two sources:

  - AMA LINES, automatically: every ledger line posted to the AMA account(s)
    in the period (default the last 12 months), per entity, read through the
    accounting app's search (`accounting._acct_get`, every read through
    `_limit`). The AMA accounts are the ones an editor picked (Settings), or,
    when none are picked, every account on the ledger whose title says "Ask
    My Accountant", "Ask Accountant" or "Suspense".
  - THREADS: a question on one ledger line (from Ledger Search, a report's
    drill-down, the journal entry, or an AMA line here), assigned to an
    accountant (a person on the curated Nexus People list who holds the
    Accounting grant and reaches the entity). Replies are kept in order.
    Open -> Answered when the assigned accountant replies -> Resolved (the
    asker, the accountant or an editor; optional "Moved To Account"). A reply
    after that reopens it. A thread on an AMA-account line whose line is no
    longer on the AMA account in the ledger (reclassed in Intacct) shows
    "Reclassed" and resolves in one click.

Notifications are created here only (CLAUDE.md), one per thread per person,
updated in place: the accountant when a question is asked or the asker
writes again; the asker when the accountant answers or someone resolves it.
No email.

Access: the Accounting grant (viewer asks and replies on the entities they
reach; editor also resolves anything and keeps the settings). A person limited
to certain entities never sees another entity's thread - 404, as if it did
not exist.
"""
import asyncio
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

import models
from auth import _LEVELS, _MODULE_LEVEL_RANK, _module_level, company_of, level_for, require_module_grant, scoped_ids
from database import SessionLocal, get_db
from routers import accounting
from routers.accounting import ACCOUNTING_SCOPE_MODULE, _limit, entity_scope

router = APIRouter(prefix="/accounting/ask", tags=["Accounting"], dependencies=[Depends(require_module_grant("accounting", "viewer"))])

STATUSES = ("Open", "Answered", "Resolved")
NOTIFY_TYPE = "acct_ama"
NOTIFY_ACTION = '{"view": "accounting", "sub": "ama", "label": "Open AMA"}'
TITLE_HINTS = ("ask my accountant", "ask accountant", "suspense")
LINE_CAP = 3000              # AMA lines read per account and period
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_GL = re.compile(r"^[A-Za-z0-9._-]{1,40}$")
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _r2(v) -> float:
    try:
        return round(float(v or 0) + 0.0, 2)
    except (TypeError, ValueError):
        return 0.0


# ── Who is calling ──────────────────────────────────────────────────────────
def caller(scope: dict = Depends(entity_scope), db: Session = Depends(get_db)) -> dict:
    """The entity scope plus whether the caller is an editor on Accounting.
    Sync on purpose: FastAPI runs it in the threadpool."""
    user = scope["user"]
    editor = user["level"] >= _LEVELS["administrator"] or _module_level(user["email"], "accounting", db) >= _MODULE_LEVEL_RANK["editor"]
    return {**scope, "editor": editor, "email": (user.get("email") or "").lower()}


async def _reach(scope: dict) -> Optional[set]:
    """Entity codes the caller may read (children included), None = all."""
    if scope["allowed"] is None:
        return None
    return await accounting._with_children(scope["allowed"]) if scope["allowed"] else set()


def _in(reach: Optional[set], code: str) -> bool:
    return reach is None or (code or "") in reach


# ── The AMA accounts (pure) ─────────────────────────────────────────────────
def is_ama_title(title: str) -> bool:
    t = (title or "").lower()
    return any(h in t for h in TITLE_HINTS)


def chart_of(buckets: dict) -> list[dict]:
    """Every account in a buckets answer, once: [{code, title}] by code."""
    seen: dict[str, str] = {}
    for r in buckets.get("rows") or []:
        code = str(r.get("account_no") or "").strip()
        if code and code not in seen:
            seen[code] = str(r.get("title") or "").strip()
    return [{"code": c, "title": seen[c]} for c in sorted(seen)]


def effective_accounts(configured: list, chart: list[dict]) -> list[dict]:
    """The picked accounts (with titles from the chart), or the detected ones."""
    titles = {a["code"]: a["title"] for a in chart}
    if configured:
        return [{"code": c, "title": titles.get(c, "")} for c in configured]
    return [a for a in chart if is_ama_title(a["title"])]


# ── Ledger lines (pure) ─────────────────────────────────────────────────────
def line_out(r: dict) -> dict:
    debit, credit = _r2(r.get("debit")), _r2(r.get("credit"))
    party = r.get("vendor_name") or r.get("vendor_id") or r.get("customer_name") or r.get("customer_id") or r.get("employee_name") or r.get("employee_id") or ""
    return {
        "lineId": str(r.get("line_id") or ""), "entryId": str(r.get("entry_id") or ""), "entryNo": str(r.get("entry_no") or ""),
        "lineNo": str(r.get("line_no") or ""), "date": str(r.get("entry_date") or "")[:10],
        "entityCode": str(r.get("location") or ""), "entityName": r.get("location_name") or "",
        "accountNo": str(r.get("gl_code") or ""), "accountTitle": r.get("account_name") or "",
        "description": r.get("description") or "", "memo": r.get("memo") or "", "party": str(party),
        "journal": r.get("journal") or "", "debit": debit, "credit": credit, "amount": _r2(debit - credit),
    }


def line_key(entry_no: str, account_no: str, amount: float, day: str) -> tuple:
    """A line's identity when its id changed (a re-synced entry gets new line
    ids): entry number, account, amount and date."""
    return (str(entry_no or ""), str(account_no or ""), _r2(amount), str(day or "")[:10])


def thread_key(t: dict) -> tuple:
    return line_key(t["entryNo"], t["accountNo"], t["amount"], t["date"])


def reclassed(t: dict, read: dict) -> Optional[bool]:
    """Whether a thread's line has left the AMA account: True / False, or None
    when the read did not cover it (another account, entity or period, or the
    ledger was not read). `read` = {accounts, from, to, entities (None = all),
    ids, keys, ok}."""
    if not read.get("ok") or t["accountNo"] not in read["accounts"]:
        return None
    if not t["date"] or not (read["from"] <= t["date"] <= read["to"]):
        return None
    if read["entities"] is not None and t["entityCode"] not in read["entities"]:
        return None
    if t["lineId"] and t["lineId"] in read["ids"]:
        return False
    return thread_key(t) not in read["keys"]


# ── Shapes ──────────────────────────────────────────────────────────────────
def _names(db: Session, emails) -> dict:
    keys = {(e or "").lower() for e in emails if e}
    if not keys:
        return {}
    out = {}
    for e in db.query(models.NexusEmployee).filter(func.lower(models.NexusEmployee.work_email).in_(keys)).all():
        name = (getattr(e, "display_name", "") or "").strip() or f"{e.first_name or ''} {e.last_name or ''}".strip()
        if name:
            out[(e.work_email or "").lower()] = name
    return out


def _out(t: models.AccountingAmaThread, names: dict, replies: int = 0) -> dict:
    debit, credit = _r2(t.debit), _r2(t.credit)
    return {
        "id": t.id, "kind": "thread", "entityCode": t.entity_code or "", "entryId": t.entry_id or "", "entryNo": t.entry_no or "",
        "lineId": t.line_id or "", "lineNo": t.line_no or "", "accountNo": t.account_no or "", "accountTitle": t.account_title or "",
        "date": t.entry_date or "", "debit": debit, "credit": credit, "amount": _r2(debit - credit),
        "description": t.description or "", "memo": t.memo or "", "party": t.party or "", "journal": t.journal or "",
        "source": t.source or "question", "question": t.question or "",
        "askedBy": t.asked_by or "", "askedByName": names.get((t.asked_by or "").lower(), ""), "askedAt": t.asked_at or "",
        "accountant": t.accountant_email or "", "accountantName": names.get((t.accountant_email or "").lower(), ""),
        "status": t.status if t.status in STATUSES else "Open", "movedToAccount": t.moved_to_account or "",
        "resolvedBy": t.resolved_by or "", "resolvedAt": t.resolved_at or "", "reclassed": bool(t.reclassed_at), "reclassedAt": t.reclassed_at or "",
        "lastReplyAt": t.last_reply_at or "", "lastReplyBy": t.last_reply_by or "", "lastReplyByName": names.get((t.last_reply_by or "").lower(), ""),
        "replies": replies,
    }


def _msg_out(m: models.AccountingAmaMessage, names: dict) -> dict:
    return {"id": m.id, "kind": m.kind or "reply", "body": m.body or "", "author": m.author_email or "",
            "authorName": names.get((m.author_email or "").lower(), ""), "at": m.created_at or ""}


def _short(s: str, n: int = 140) -> str:
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[: n - 3].rstrip() + "..."


def _line_label(t: models.AccountingAmaThread) -> str:
    amount = _r2((t.debit or 0) - (t.credit or 0))
    parts = [f"Entry {t.entry_no}" if t.entry_no else "", f"GL {t.account_no}" if t.account_no else "", f"${abs(amount):,.2f}" if amount else ""]
    return " · ".join(p for p in parts if p) or "a ledger line"


# ── Notifications: one per thread per person, updated in place ─────────────
def _notify(db: Session, t: models.AccountingAmaThread, recipient: str, title: str, body: str, by: str) -> None:
    recipient = (recipient or "").lower()
    if not recipient or recipient == (by or "").lower():
        return
    row = (db.query(models.NexusNotification)
           .filter(models.NexusNotification.type == NOTIFY_TYPE, models.NexusNotification.ref_id == t.id,
                   models.NexusNotification.recipient == recipient)
           .with_for_update().first())
    now = _now()
    if row:
        row.title, row.body, row.requested_by, row.created_at = title, body, by, now
        row.read_by, row.closed_by, row.actioned, row.action = "", "", False, NOTIFY_ACTION
        return
    db.add(models.NexusNotification(
        id=str(uuid.uuid4()), type=NOTIFY_TYPE, recipient=recipient, title=title, body=body, ref_id=t.id,
        item_name=_line_label(t), requested_by=by, action=NOTIFY_ACTION, actioned=False, read_by="",
        company=company_of(recipient, db), created_at=now,
    ))


# ── Settings ────────────────────────────────────────────────────────────────
def _settings(db: Session) -> dict:
    rows = db.query(models.AccountingAmaSetting).all()
    base = next((r for r in rows if (r.entity_code or "") == ""), None)
    return {
        "accounts": [str(a) for a in (base.accounts if base and isinstance(base.accounts, list) else [])],
        "accountants": {(r.entity_code or ""): [str(e).lower() for e in (r.accountants or []) if e] for r in rows if r.accountants},
    }


def _load_settings() -> dict:
    db = SessionLocal()
    try:
        return _settings(db)
    finally:
        db.close()


async def _chart(scope: dict) -> list[dict]:
    """Every account with activity on the ledger the caller reads, from the
    start of the books - one buckets read, cached by the proxy."""
    location, locations = await _limit(scope, None, None)
    data = await accounting._acct_get("/api/internal/reports/buckets", {
        "to": date.today().isoformat(), "by": "total", "location": location, "locations": locations})
    return chart_of(data)


async def _accounts(scope: dict, configured: list) -> tuple[list[dict], Optional[str]]:
    try:
        chart = await _chart(scope)
    except HTTPException as e:
        if configured:
            return [{"code": c, "title": ""} for c in configured], str(e.detail)
        return [], str(e.detail)
    return effective_accounts(configured, chart), None


# ── Reading the ledger ──────────────────────────────────────────────────────
async def _ama_lines(scope: dict, entity: Optional[str], from_: str, to: str, accounts: list[str]) -> list[dict]:
    location, locations = await _limit(scope, entity or None, None)
    out: list[dict] = []
    for acct in accounts:
        offset = 0
        while offset < LINE_CAP:
            d = await accounting._acct_get("/api/internal/search", {
                "account": acct, "location": location, "locations": locations, "from": from_, "to": to,
                "offset": offset, "limit": 1000})
            rows = d.get("rows") or []
            out.extend(line_out(r) for r in rows if str(r.get("gl_code") or acct) == acct)
            offset += len(rows)
            if not rows or offset >= int(d.get("total") or 0):
                break
    return out


# ── Thread DB work (all run in a thread) ────────────────────────────────────
def _threads(reach: Optional[set]) -> list[dict]:
    db = SessionLocal()
    try:
        rows = db.query(models.AccountingAmaThread).order_by(models.AccountingAmaThread.asked_at.desc()).all()
        rows = [t for t in rows if _in(reach, t.entity_code)]
        counts = dict(db.query(models.AccountingAmaMessage.thread_id, func.count(models.AccountingAmaMessage.id))
                      .filter(models.AccountingAmaMessage.kind == "reply").group_by(models.AccountingAmaMessage.thread_id).all())
        names = _names(db, [e for t in rows for e in (t.asked_by, t.accountant_email, t.last_reply_by)])
        return [_out(t, names, counts.get(t.id, 0)) for t in rows]
    finally:
        db.close()


def _mark_reclassed(changes: dict) -> None:
    """{thread_id: True | False}: stamp or clear reclassed_at."""
    if not changes:
        return
    db = SessionLocal()
    try:
        for t in db.query(models.AccountingAmaThread).filter(models.AccountingAmaThread.id.in_(list(changes))).all():
            t.reclassed_at = _now() if changes[t.id] else ""
        db.commit()
    finally:
        db.close()


def _get_thread(db: Session, thread_id: str, reach: Optional[set], lock: bool = False) -> models.AccountingAmaThread:
    q = db.query(models.AccountingAmaThread).filter(models.AccountingAmaThread.id == thread_id)
    t = (q.with_for_update() if lock else q).first()
    if not t or not _in(reach, t.entity_code):
        raise HTTPException(status_code=404, detail="Question not found.")
    return t


def _detail(db: Session, t: models.AccountingAmaThread) -> dict:
    msgs = (db.query(models.AccountingAmaMessage).filter(models.AccountingAmaMessage.thread_id == t.id)
            .order_by(models.AccountingAmaMessage.created_at, models.AccountingAmaMessage.id).all())
    names = _names(db, [t.asked_by, t.accountant_email, t.last_reply_by, *[m.author_email for m in msgs]])
    return {**_out(t, names, sum(1 for m in msgs if m.kind == "reply")), "messages": [_msg_out(m, names) for m in msgs]}


def _add_msg(db: Session, t: models.AccountingAmaThread, author: str, kind: str, body: str, at: str) -> None:
    db.add(models.AccountingAmaMessage(id=str(uuid.uuid4()), thread_id=t.id, author_email=author, kind=kind, body=body, created_at=at))


def _can_close(t: models.AccountingAmaThread, who: dict) -> bool:
    me = who["email"]
    return who["editor"] or me in ((t.asked_by or "").lower(), (t.accountant_email or "").lower())


def _accountant_ok(db: Session, email: str, entity: str, reach_of) -> None:
    """The accountant is on the curated Nexus People list, holds the Accounting
    grant (or is an administrator) and reaches the entity."""
    emp = db.query(models.NexusEmployee).filter(func.lower(models.NexusEmployee.work_email) == email).first()
    if not emp or (emp.status or "active") in ("inactive", "offboarded"):
        raise HTTPException(status_code=400, detail="Pick the accountant from the Nexus People list.")
    if level_for(email, db) < _LEVELS["administrator"]:
        if _module_level(email, "accounting", db) < _MODULE_LEVEL_RANK["viewer"]:
            raise HTTPException(status_code=400, detail="That person does not have Accounting access, so they could not see the question.")
        allowed = scoped_ids(email, ACCOUNTING_SCOPE_MODULE, db)
        if allowed is not None and entity not in reach_of(allowed):
            raise HTTPException(status_code=400, detail="That person's Accounting access does not include this entity.")


async def _reach_fn(email: str):
    """A sync check of another person's entity reach, built with the ledger's
    entity tree read up front (the tree read is async, the DB check is not)."""
    data = await accounting._acct_get("/api/internal/reports/locations", {})
    entities = data.get("entities") or []

    def reach_of(codes: set) -> set:
        out = set(codes)
        grew = True
        while grew:
            grew = False
            for e in entities:
                code = e.get("code") or ""
                if code and code not in out and (e.get("parent_code") in out or any(code.startswith(f"{c}-") for c in out)):
                    out.add(code)
                    grew = True
        return out
    return reach_of


# ── Bodies ──────────────────────────────────────────────────────────────────
class AskBody(BaseModel):
    entityCode: str
    question: str
    accountant: str
    entryId: Optional[str] = ""
    entryNo: Optional[str] = ""
    lineId: Optional[str] = ""
    lineNo: Optional[str] = ""
    accountNo: Optional[str] = ""
    accountTitle: Optional[str] = ""
    date: Optional[str] = ""
    debit: Optional[float] = 0.0
    credit: Optional[float] = 0.0
    description: Optional[str] = ""
    memo: Optional[str] = ""
    party: Optional[str] = ""
    journal: Optional[str] = ""


class ReplyBody(BaseModel):
    body: str


class ResolveBody(BaseModel):
    movedToAccount: Optional[str] = ""
    note: Optional[str] = ""


class AssignBody(BaseModel):
    accountant: str


class SettingsBody(BaseModel):
    accounts: Optional[list[str]] = None                 # None = leave as is; [] = find by title
    accountants: Optional[dict[str, list[str]]] = None   # {entity ('' = every entity): [emails]}


def _text(s: Optional[str], n: int) -> str:
    return (s or "").strip()[:n]


# ── Endpoints ───────────────────────────────────────────────────────────────
@router.get("/items")
async def list_items(entity: Optional[str] = None, from_: Optional[str] = Query(None, alias="from"), to: Optional[str] = None,
                     who: dict = Depends(caller)):
    """The AMA screen: every question the caller may see (any date) and every
    line on the AMA account(s) in the period that has no question yet, with
    the counts per status. `from` / `to` default to the last 12 months. A
    ledger read that fails still answers the questions, with `ledgerError`."""
    today = date.today()
    to = to or today.isoformat()
    from_ = from_ or (today - timedelta(days=365)).isoformat()
    if not _ISO.match(from_) or not _ISO.match(to) or from_ > to:
        raise HTTPException(status_code=400, detail="Pick a period: from and to as dates, from first.")
    entity = (entity or "").strip() or None
    location, locations = await _limit(who, entity, None)    # 403 outside the caller's entities
    reach = await _reach(who)
    within = await accounting._with_children({entity}) if entity else None
    threads = await asyncio.to_thread(_threads, reach)
    if within is not None:
        threads = [t for t in threads if t["entityCode"] in within]

    settings = await asyncio.to_thread(_load_settings)
    accounts, ledger_error = await _accounts(who, settings["accounts"])
    codes = [a["code"] for a in accounts]
    lines: list[dict] = []
    read_ok = False
    if codes:
        try:
            lines = await _ama_lines(who, entity, from_, to, codes)
            read_ok = True
        except HTTPException as e:
            ledger_error = str(e.detail)
    # The entities the read surely covered: the ones it asked for by code
    # (whether the ledger adds their sub-entities is its business, so a
    # sub-entity's thread is never called reclassed on a parent's read), or
    # everything when it asked for no entity.
    covered = (set(_csv(locations)) | ({location} if location else set())) if (location or locations) else None
    read = {"ok": read_ok, "accounts": set(codes), "from": from_, "to": to, "entities": covered,
            "ids": {ln["lineId"] for ln in lines if ln["lineId"]}, "keys": {line_key(ln["entryNo"], ln["accountNo"], ln["amount"], ln["date"]) for ln in lines}}

    changes = {}
    for t in threads:
        state = reclassed(t, read)
        if state is None or state == t["reclassed"]:
            continue
        changes[t["id"]] = state
        t["reclassed"] = state
    await asyncio.to_thread(_mark_reclassed, changes)

    asked_ids = {t["lineId"] for t in threads if t["lineId"]}
    asked_keys = {thread_key(t) for t in threads}
    rows = list(threads)
    for ln in lines:
        if (ln["lineId"] and ln["lineId"] in asked_ids) or line_key(ln["entryNo"], ln["accountNo"], ln["amount"], ln["date"]) in asked_keys:
            continue
        rows.append({**ln, "id": f"line:{ln['lineId'] or '|'.join(map(str, line_key(ln['entryNo'], ln['accountNo'], ln['amount'], ln['date'])))}",
                     "kind": "line", "source": "ama", "status": "Open", "question": "", "askedBy": "", "askedByName": "", "askedAt": "",
                     "accountant": "", "accountantName": "", "movedToAccount": "", "reclassed": False, "lastReplyAt": "", "lastReplyBy": "",
                     "lastReplyByName": "", "replies": 0})
    counts = {s: sum(1 for r in rows if r["status"] == s) for s in STATUSES}
    counts["All"] = len(rows)
    return {"from": from_, "to": to, "entity": entity or "", "accounts": accounts, "autoDetected": not settings["accounts"],
            "ledgerError": ledger_error, "rows": rows, "counts": counts, "canEdit": who["editor"], "me": who["email"]}


def _csv(v: Optional[str]) -> list[str]:
    return [x.strip() for x in (v or "").split(",") if x.strip()]


@router.get("/threads/{thread_id}")
async def get_thread(thread_id: str, who: dict = Depends(caller)):
    reach = await _reach(who)

    def work():
        db = SessionLocal()
        try:
            return _detail(db, _get_thread(db, thread_id, reach))
        finally:
            db.close()
    return await asyncio.to_thread(work)


@router.post("/threads", status_code=201)
async def ask(body: AskBody, who: dict = Depends(caller)):
    """Ask a question on one ledger line. A line that already has an open
    question gets this one as a new message on it (one thread per line)."""
    entity = _text(body.entityCode, 40)
    question = _text(body.question, 4000)
    accountant = _text(body.accountant, 200).lower()
    if not entity:
        raise HTTPException(status_code=400, detail="The line has no entity.")
    if not question:
        raise HTTPException(status_code=400, detail="Type the question.")
    if not _EMAIL.match(accountant):
        raise HTTPException(status_code=400, detail="Pick the accountant.")
    if body.date and not _ISO.match(body.date[:10]):
        raise HTTPException(status_code=400, detail="The line's date must be a date (YYYY-MM-DD).")
    await _limit(who, entity, None)       # 403 outside the caller's entities
    reach_of = await _reach_fn(accountant)
    settings = await asyncio.to_thread(_load_settings)
    ama_codes = set(settings["accounts"]) or {a["code"] for a in (await _accounts(who, []))[0]}
    me = who["email"]

    def work():
        db = SessionLocal()
        try:
            _accountant_ok(db, accountant, entity, reach_of)
            now = _now()
            line_id = _text(body.lineId, 80)
            t = None
            if line_id:
                t = (db.query(models.AccountingAmaThread)
                     .filter(models.AccountingAmaThread.line_id == line_id, models.AccountingAmaThread.status != "Resolved")
                     .with_for_update().first())
            merged = t is not None
            if t is None:
                t = models.AccountingAmaThread(
                    id=str(uuid.uuid4()), entity_code=entity, entry_id=_text(body.entryId, 80), entry_no=_text(body.entryNo, 80),
                    line_id=line_id, line_no=_text(body.lineNo, 40), account_no=_text(body.accountNo, 40), account_title=_text(body.accountTitle, 200),
                    entry_date=_text(body.date, 10), debit=_r2(body.debit), credit=_r2(body.credit), description=_text(body.description, 1000),
                    memo=_text(body.memo, 1000), party=_text(body.party, 200), journal=_text(body.journal, 24),
                    source="ama" if _text(body.accountNo, 40) in ama_codes else "question",
                    question=question, asked_by=me, asked_at=now, accountant_email=accountant, status="Open", updated_at=now,
                )
                db.add(t)
                _add_msg(db, t, me, "question", question, now)
            else:
                t.status, t.updated_at, t.last_reply_at, t.last_reply_by = "Open", now, now, me
                _add_msg(db, t, me, "reply", question, now)
            asker = _names(db, [me]).get(me) or me
            _notify(db, t, t.accountant_email, f"AMA Question: {_line_label(t)}", f"{asker} asked: {_short(question)}", me)
            db.commit()
            return {**_detail(db, t), "merged": merged}
        finally:
            db.close()
    return await asyncio.to_thread(work)


@router.post("/threads/{thread_id}/messages")
async def reply(thread_id: str, body: ReplyBody, who: dict = Depends(caller)):
    """A reply. From the assigned accountant it answers the question
    (Answered) and tells the asker; from anyone else it (re)opens it and
    tells the accountant - and the asker, when someone else wrote."""
    text = _text(body.body, 4000)
    if not text:
        raise HTTPException(status_code=400, detail="Type the reply.")
    reach = await _reach(who)
    me = who["email"]

    def work():
        db = SessionLocal()
        try:
            t = _get_thread(db, thread_id, reach, lock=True)
            now = _now()
            _add_msg(db, t, me, "reply", text, now)
            t.last_reply_at, t.last_reply_by, t.updated_at = now, me, now
            name = _names(db, [me]).get(me) or me
            if me == (t.accountant_email or "").lower():
                t.status = "Answered"
                _notify(db, t, t.asked_by, f"AMA Answered: {_line_label(t)}", f"{name} answered: {_short(text)}", me)
            else:
                t.status = "Open"
                t.resolved_by = t.resolved_at = ""
                _notify(db, t, t.accountant_email, f"AMA Question: {_line_label(t)}", f"{name} wrote: {_short(text)}", me)
                if me != (t.asked_by or "").lower():
                    _notify(db, t, t.asked_by, f"AMA Reply: {_line_label(t)}", f"{name} wrote: {_short(text)}", me)
            db.commit()
            return _detail(db, t)
        finally:
            db.close()
    return await asyncio.to_thread(work)


@router.post("/threads/{thread_id}/resolve")
async def resolve(thread_id: str, body: ResolveBody, who: dict = Depends(caller)):
    """Resolved, by the asker, the accountant or an editor - with the account
    it was moved to, when there is one."""
    moved = _text(body.movedToAccount, 40)
    if moved and not _GL.match(moved):
        raise HTTPException(status_code=400, detail="Moved To Account is a GL account number.")
    note = _text(body.note, 2000)
    reach = await _reach(who)
    me = who["email"]

    def work():
        db = SessionLocal()
        try:
            t = _get_thread(db, thread_id, reach, lock=True)
            if not _can_close(t, who):
                raise HTTPException(status_code=403, detail="Only the person who asked, the accountant or an Accounting editor can resolve it.")
            now = _now()
            t.status, t.moved_to_account, t.resolved_by, t.resolved_at, t.updated_at = "Resolved", moved, me, now, now
            event = "Resolved" + (f" - moved to account {moved}" if moved else "") + (" (reclassed in the ledger)" if t.reclassed_at else "")
            _add_msg(db, t, me, "event", event + (f". {note}" if note else ""), now)
            name = _names(db, [me]).get(me) or me
            text = f"{name} resolved it" + (f" - moved to account {moved}" if moved else "") + "."
            _notify(db, t, t.asked_by, f"AMA Resolved: {_line_label(t)}", text, me)
            _notify(db, t, t.accountant_email, f"AMA Resolved: {_line_label(t)}", text, me)
            db.commit()
            return _detail(db, t)
        finally:
            db.close()
    return await asyncio.to_thread(work)


@router.post("/threads/{thread_id}/reopen")
async def reopen(thread_id: str, who: dict = Depends(caller)):
    reach = await _reach(who)
    me = who["email"]

    def work():
        db = SessionLocal()
        try:
            t = _get_thread(db, thread_id, reach, lock=True)
            if not _can_close(t, who):
                raise HTTPException(status_code=403, detail="Only the person who asked, the accountant or an Accounting editor can reopen it.")
            now = _now()
            t.status, t.resolved_by, t.resolved_at, t.updated_at = "Open", "", "", now
            _add_msg(db, t, me, "event", "Reopened", now)
            name = _names(db, [me]).get(me) or me
            _notify(db, t, t.accountant_email, f"AMA Question: {_line_label(t)}", f"{name} reopened the question.", me)
            db.commit()
            return _detail(db, t)
        finally:
            db.close()
    return await asyncio.to_thread(work)


@router.put("/threads/{thread_id}/accountant")
async def assign(thread_id: str, body: AssignBody, who: dict = Depends(caller)):
    """Hand the question to another accountant: the asker, the current
    accountant or an editor."""
    accountant = _text(body.accountant, 200).lower()
    if not _EMAIL.match(accountant):
        raise HTTPException(status_code=400, detail="Pick the accountant.")
    reach = await _reach(who)
    reach_of = await _reach_fn(accountant)
    me = who["email"]

    def work():
        db = SessionLocal()
        try:
            t = _get_thread(db, thread_id, reach, lock=True)
            if not _can_close(t, who):
                raise HTTPException(status_code=403, detail="Only the person who asked, the accountant or an Accounting editor can reassign it.")
            _accountant_ok(db, accountant, t.entity_code or "", reach_of)
            if accountant == (t.accountant_email or "").lower():
                return _detail(db, t)
            now = _now()
            t.accountant_email, t.updated_at = accountant, now
            names = _names(db, [me, accountant])
            _add_msg(db, t, me, "event", f"Assigned to {names.get(accountant) or accountant}", now)
            _notify(db, t, accountant, f"AMA Question: {_line_label(t)}",
                    f"{names.get(me) or me} assigned you the question: {_short(t.question)}", me)
            db.commit()
            return _detail(db, t)
        finally:
            db.close()
    return await asyncio.to_thread(work)


@router.get("/settings")
async def get_settings(who: dict = Depends(caller)):
    """The AMA accounts (picked, or found by title) and the accountants per
    entity ('' = every entity) for the entities the caller reaches, plus the
    accountant the caller last asked - the Ask dialog's default."""
    reach = await _reach(who)
    me = who["email"]

    def work():
        db = SessionLocal()
        try:
            s = _settings(db)
            last = (db.query(models.AccountingAmaThread.accountant_email).filter(models.AccountingAmaThread.asked_by == me)
                    .order_by(models.AccountingAmaThread.asked_at.desc()).first())
            people = {e for v in s["accountants"].values() for e in v} | ({last[0]} if last and last[0] else set())
            return s, (last[0] if last else ""), _names(db, people)
        finally:
            db.close()
    s, last, names = await asyncio.to_thread(work)
    accounts, error = await _accounts(who, s["accounts"])
    accountants = {k: [{"email": e, "name": names.get(e, "")} for e in v] for k, v in s["accountants"].items() if k == "" or _in(reach, k)}
    return {"accounts": accounts, "configured": s["accounts"], "autoDetected": not s["accounts"], "ledgerError": error,
            "accountants": accountants, "lastAccountant": last, "lastAccountantName": names.get(last, ""), "canEdit": who["editor"]}


@router.get("/chart")
async def chart(who: dict = Depends(caller)):
    """Every account on the ledger, for picking the AMA accounts (editors);
    `detected` marks the ones whose title reads as Ask My Accountant."""
    if not who["editor"]:
        raise HTTPException(status_code=403, detail="Picking the AMA accounts takes the editor level on Accounting.")
    return {"accounts": [{**a, "detected": is_ama_title(a["title"])} for a in await _chart(who)]}


@router.put("/settings")
async def put_settings(body: SettingsBody, who: dict = Depends(caller)):
    """Editors: the AMA accounts (everyone shares one chart of accounts, so a
    person limited to certain entities cannot change them), and the
    accountants per entity - '' (every entity) also needs unlimited access."""
    if not who["editor"]:
        raise HTTPException(status_code=403, detail="The AMA settings take the editor level on Accounting.")
    limited = who["allowed"] is not None
    accounts = None
    if body.accounts is not None:
        if limited:
            raise HTTPException(status_code=403, detail="Your accounting access is limited to certain entities, and the AMA accounts are shared by all of them.")
        accounts = []
        for c in body.accounts:
            c = (c or "").strip()
            if not c:
                continue
            if not _GL.match(c):
                raise HTTPException(status_code=400, detail=f"{c!r} is not a GL account number.")
            if c not in accounts:
                accounts.append(c)
    per_entity: dict[str, list[str]] = {}
    reach = await _reach(who)
    for ent, emails in (body.accountants or {}).items():
        ent = (ent or "").strip()[:40]
        if ent == "" and limited:
            raise HTTPException(status_code=403, detail="Your accounting access is limited to certain entities; set the accountants of those entities.")
        if ent and not _in(reach, ent):
            raise HTTPException(status_code=403, detail=f"Your accounting access does not include entity {ent}.")
        clean = []
        for e in emails or []:
            e = (e or "").strip().lower()
            if not _EMAIL.match(e):
                raise HTTPException(status_code=400, detail=f"{e!r} is not an email address.")
            if e not in clean:
                clean.append(e)
        per_entity[ent] = clean
    me = who["email"]

    def work():
        db = SessionLocal()
        try:
            for e in {x for v in per_entity.values() for x in v}:
                if not db.query(models.NexusEmployee).filter(func.lower(models.NexusEmployee.work_email) == e).first():
                    raise HTTPException(status_code=400, detail=f"{e} is not on the Nexus People list.")
            now = _now()
            touched = dict(per_entity)
            if accounts is not None:
                touched.setdefault("", None)
            for ent, emails in touched.items():
                row = db.query(models.AccountingAmaSetting).filter(models.AccountingAmaSetting.entity_code == ent).with_for_update().first()
                if not row:
                    row = models.AccountingAmaSetting(entity_code=ent, accounts=[], accountants=[])
                    db.add(row)
                if ent == "" and accounts is not None:
                    row.accounts = accounts
                if emails is not None:
                    row.accountants = emails
                row.updated_by, row.updated_at = me, now
            db.commit()
        finally:
            db.close()
    await asyncio.to_thread(work)
    return await get_settings(who)
