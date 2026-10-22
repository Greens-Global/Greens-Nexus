"""Ask My Accountant: the other side of each line, Notes and the GL reclass a
bookkeeper approves (Charmi, Oct 22 call, change request 13).

Pure helpers and the DB reads both AMA routers share
(routers/accounting_ask.py lists the lines, routers/accounting_ask_review.py
writes). The defaults Charmi still has to confirm live in
accounting_assumptions.py and are read from there at call time.

  - THE OTHER SIDE: an AMA line's offsetting accounts are the entry's lines
    that are not on an AMA account, on the opposite side of the AMA line
    (a $3,000 debit to AMA came from the bank line credited $3,000). Read per
    entry from the ledger, for the lines on screen.
  - NOTES: free text per ledger line, kept in Nexus.
  - RECLASS: a GL account (and a vendor or customer) picked for the line is a
    pending reclass, "Awaiting Bookkeeper". Only a bookkeeper edits it from
    then on, sends it back, or approves and pushes it. The push is a NEW
    reclass entry (never an edit of the original): to the chosen GL on the
    AMA line's side, off the AMA account on the other. Pushed = the line is
    Resolved, and the reclass entry's own line on the AMA account (known by
    AMA_RECLASS_TAG + its R- reference) shows Resolved too.
"""
import re
import uuid
from datetime import date, datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

import accounting_assumptions as assumptions
import models

AWAITING = "Awaiting Bookkeeper"
SENT_BACK = "Sent Back"
PUSHING = "Pushing"
PUSHED = "Pushed"
RECLASS_STATUSES = (AWAITING, SENT_BACK, PUSHING, PUSHED)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _r2(v) -> float:
    try:
        return round(float(v or 0) + 0.0, 2)
    except (TypeError, ValueError):
        return 0.0


# ── Which line ───────────────────────────────────────────────────────────────
def line_ref(line_id: str, entry_no: str, account_no: str, amount, day: str) -> str:
    """The line's id, else its entry / account / amount / date (the same key
    accounting_ask.line_key matches a re-synced line by)."""
    if (line_id or "").strip():
        return str(line_id).strip()[:80]
    return "k:" + "|".join((str(entry_no or ""), str(account_no or ""), f"{_r2(amount):.2f}", str(day or "")[:10]))[:200]


def row_ref(r: dict) -> str:
    return line_ref(r.get("lineId"), r.get("entryNo"), r.get("accountNo"), r.get("amount"), r.get("date"))


def new_reclass_ref() -> str:
    return "R-" + uuid.uuid4().hex[:8]


def _tag_re():
    return re.compile(re.escape(assumptions.AMA_RECLASS_TAG) + r"\s+(R-[0-9a-f]{8})", re.I)


def reclass_ref_of(line: dict) -> Optional[str]:
    """The R- reference when this ledger line belongs to a reclass entry Nexus
    pushed (its description or memo carries the tag), else None."""
    m = _tag_re().search(f"{line.get('description') or ''} {line.get('memo') or ''}")
    return m.group(1).lower().replace("r-", "R-") if m else None


# ── The other side (pure) ────────────────────────────────────────────────────
def entry_offsets(lines: list[dict], ama_codes: set, reach: Optional[set]) -> dict:
    """An entry's non-AMA lines, one per account and entity, net signed amount
    (debit - credit), largest first: {offsets: [{accountNo, accountTitle,
    entityCode, amount}], hidden: lines left out because their entity is
    outside the caller's access}."""
    merged: dict[tuple, dict] = {}
    hidden = 0
    for ln in lines or []:
        code = str(ln.get("gl_code") or ln.get("account_no") or "").strip()
        if not code or code in ama_codes:
            continue
        ent = str(ln.get("location") or "")
        if reach is not None and ent not in reach:
            hidden += 1
            continue
        k = (code, ent)
        o = merged.setdefault(k, {"accountNo": code, "accountTitle": str(ln.get("account_name") or ln.get("title") or ""), "entityCode": ent, "amount": 0.0})
        o["amount"] = _r2(o["amount"] + _r2(ln.get("debit")) - _r2(ln.get("credit")))
    offsets = sorted((o for o in merged.values() if o["amount"]), key=lambda o: (-abs(o["amount"]), o["accountNo"]))
    return {"offsets": offsets, "hidden": hidden}


# ── The reclass entry (pure) ─────────────────────────────────────────────────
def reclass_entry(rv: dict, today: Optional[date] = None) -> dict:
    """The NEW entry a push creates (assumptions.AMA_RECLASS_MODE is
    "new_entry"; the original is never edited), in intacct_gl's shape:
    the chosen GL on the AMA line's own side, the AMA account on the other,
    both in the line's entity and department."""
    amount = _r2(rv["amount"])
    a = abs(amount)
    day = rv["date"] if assumptions.AMA_RECLASS_DATE == "original" and rv.get("date") else (today or date.today()).isoformat()
    desc = f"{assumptions.AMA_RECLASS_TAG} {rv['reclassRef']} of {rv.get('entryNo') or 'line'}"
    memo = (rv.get("reclassMemo") or desc)[:1000]
    party = {"vendor_id": rv.get("partyId") or ""} if rv.get("partyKind") == "vendor" else {"customer_id": rv.get("partyId") or ""} if rv.get("partyKind") == "customer" else {}

    def side(debit: bool) -> dict:
        return {"debit": a, "credit": None} if debit else {"debit": None, "credit": a}
    base ={"location_id": rv.get("entityCode") or "", "dept_id": rv.get("departmentId") or "", "source_entity": rv.get("entityCode") or ""}
    return {
        "journal": assumptions.AMA_RECLASS_JOURNAL, "date": day, "description": desc, "reference_no": rv["reclassRef"],
        "state": assumptions.AMA_RECLASS_STATE,
        "lines": [
            {"line_no": 1, "acct_no": rv["toAccount"], "memo": memo, **base, **party, **side(amount > 0)},
            {"line_no": 2, "acct_no": rv["accountNo"], "memo": desc, **base, **side(amount < 0)},
        ],
    }


# ── Shapes ───────────────────────────────────────────────────────────────────
def review_out(r: models.AccountingAmaLineReview, names: dict) -> dict:
    n = lambda e: names.get((e or "").lower(), "")  # noqa: E731
    return {
        "id": r.id, "lineRef": r.line_ref, "entityCode": r.entity_code or "", "entryId": r.entry_id or "", "entryNo": r.entry_no or "",
        "lineId": r.line_id or "", "accountNo": r.account_no or "", "accountTitle": r.account_title or "", "date": r.entry_date or "",
        "amount": _r2(r.amount), "description": r.description or "", "departmentId": r.department_id or "",
        "note": r.note or "", "noteBy": r.note_by or "", "noteByName": n(r.note_by), "noteAt": r.note_at or "",
        "status": r.reclass_status or "", "reclassRef": r.reclass_ref or "",
        "toAccount": r.to_account or "", "toAccountTitle": r.to_account_title or "",
        "partyKind": r.party_kind or "", "partyId": r.party_id or "", "partyName": r.party_name or "", "reclassMemo": r.reclass_memo or "",
        "proposedBy": r.proposed_by or "", "proposedByName": n(r.proposed_by), "proposedAt": r.proposed_at or "",
        "reviewNote": r.review_note or "",
        "approvedBy": r.approved_by or "", "approvedByName": n(r.approved_by), "approvedAt": r.approved_at or "",
        "pushMode": r.push_mode or "", "intacctRef": r.intacct_ref or "", "pushError": r.push_error or "",
        "history": list(r.history or []),
    }


def review_names(r: models.AccountingAmaLineReview) -> list:
    return [r.note_by, r.proposed_by, r.approved_by, *[h.get("by") for h in (r.history or []) if isinstance(h, dict)]]


def log(r: models.AccountingAmaLineReview, by: str, event: str, at: Optional[str] = None) -> None:
    r.history = [*(r.history or []), {"at": at or _now(), "by": by, "event": event[:500]}]


# ── Bookkeepers ──────────────────────────────────────────────────────────────
def configured_bookkeepers(db: Session) -> list[str]:
    row = db.query(models.AccountingAmaSetting).filter(models.AccountingAmaSetting.entity_code == "").first()
    return [str(e).lower() for e in ((row.bookkeepers if row else None) or []) if e]


def bookkeepers(db: Session) -> list[str]:
    """The Bookkeepers list in AMA Settings, else the environment fallback."""
    return configured_bookkeepers(db) or list(assumptions.AMA_BOOKKEEPERS_FALLBACK)


def is_bookkeeper(db: Session, email: str) -> bool:
    return bool(email) and email.lower() in bookkeepers(db)


# ── On the AMA list ──────────────────────────────────────────────────────────
def load_reviews(db: Session, reach: Optional[set], names_of) -> list[dict]:
    """Every review the caller reaches; `names_of(db, emails)` is
    accounting_ask._names (the People list names the questions use)."""
    rows = [r for r in db.query(models.AccountingAmaLineReview).all() if reach is None or (r.entity_code or "") in reach]
    names = names_of(db, [e for r in rows for e in review_names(r)])
    return [review_out(r, names) for r in rows]


def apply_reviews(rows: list[dict], reviews: list[dict]) -> None:
    """Each AMA row gets its Notes and reclass (`note`, `reclass`). A pushed
    reclass resolves a bare line; the reclass entry's own AMA line is Resolved
    too (`reclassOf` names the line it moved)."""
    by_ref = {rv["lineRef"]: rv for rv in reviews}
    pushed = {rv["reclassRef"]: rv for rv in reviews if rv["status"] == PUSHED and rv["reclassRef"]}
    for r in rows:
        rv = by_ref.get(row_ref(r))
        r["note"] = rv["note"] if rv else ""
        r["reclass"] = rv if rv and rv["status"] else None
        if rv and rv["status"] == PUSHED and r.get("kind") == "line":
            r["status"] = "Resolved"
            r["movedToAccount"] = rv["toAccount"]
            r["resolvedBy"], r["resolvedAt"] = rv["approvedBy"], rv["approvedAt"]
        ref = reclass_ref_of(r)
        if ref and ref in pushed and r.get("kind") == "line":
            r["status"] = "Resolved"
            r["reclassOf"] = pushed[ref]["entryNo"] or pushed[ref]["lineRef"]
