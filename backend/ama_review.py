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
    then on, sends it back, or previews and pushes it. The push EDITS THE
    ORIGINAL Intacct entry (Neil, 23 Oct - AMA_RECLASS_MODE 'edit_original'):
    the AMA line moves to the chosen GL on the same entry, every other field
    and every amount exactly as read (see "Editing the original entry").
    Pushed = the line is Resolved. The older 'new_entry' mode (a NEW reclass
    entry, its own AMA line known by AMA_RECLASS_TAG + its R- reference) is
    kept only behind that switch.
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
CHECK = "Check In Intacct"     # the original was updated but did not read back as sent (CR-13 rework)
RECLASS_STATUSES = (AWAITING, SENT_BACK, PUSHING, PUSHED, CHECK)


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


# ── Editing the original entry (pure, CR-13 rework) ──────────────────────────
# Neil, 23 Oct: "The push should edit the original and the change should be
# visible on the other end. CAREFUL TO GET THIS RIGHT". An entry is read in
# full (intacct_client.read_gl_batch_of_line, or ledger_entry below when the
# push is off and Intacct is not set up), checked, and turned into ONE update
# that sends every line back exactly as read except the account (and the
# vendor / customer) of the AMA line(s). The same update is what the preview
# shows, what the push sends, and what the log keeps.
_UNCLEARED = {"", "f", "false", "no", "n", "uncleared", "not cleared", "notcleared"}


def ledger_entry(data: dict) -> dict:
    """The Nexus ledger copy of an entry (/api/internal/entry) in the shape
    intacct_client reads Intacct's in - only ever for a dry run."""
    entry = data.get("entry") or {}
    intacct = data.get("intacct") or []
    lines = []
    for i, ln in enumerate(data.get("lines") or []):
        g = next((x for x in intacct if x.get("record_no") and x.get("record_no") == ln.get("intacct_record_no")), {}) or {}
        debit, credit = _r2(ln.get("debit")), _r2(ln.get("credit"))
        tr, amount = (1, debit) if debit else (-1, credit)
        carry = {"ACCOUNTNO": str(ln.get("gl_code") or ""), "TR_TYPE": str(tr), "TRX_AMOUNT": f"{amount:.2f}",
                 "DESCRIPTION": ln.get("description") or g.get("memo") or "", "LOCATION": str(ln.get("location") or ""),
                 "DEPARTMENT": str(ln.get("department") or ""), "VENDORID": g.get("vendor_id") or "", "CUSTOMERID": g.get("customer_id") or "",
                 "PROJECTID": g.get("project_id") or "", "CLASSID": g.get("class_id") or "", "ITEMID": g.get("item_id") or "",
                 "EMPLOYEEID": g.get("employee_id") or ""}
        lines.append({
            "recordNo": str(ln.get("intacct_record_no") or ln.get("id") or ""), "ledgerId": str(ln.get("id") or ln.get("line_id") or ""),
            "lineNo": str(ln.get("line_no") or i + 1), "accountNo": str(ln.get("gl_code") or ""), "accountTitle": ln.get("account_name") or "",
            "trType": tr, "amount": amount, "location": str(ln.get("location") or ""), "department": str(ln.get("department") or ""),
            "memo": carry["DESCRIPTION"], "vendorId": carry["VENDORID"], "customerId": carry["CUSTOMERID"], "currency": "", "baseCurrency": "",
            "cleared": "", "carry": {k: v for k, v in carry.items() if str(v).strip()}, "uncarried": [],
        })
    batch_no = next((g.get("batch_no") for g in intacct if g.get("batch_no")), "")
    return {"recordNo": str(batch_no or entry.get("id") or ""), "batchNo": str(entry.get("entry_no") or ""),
            "journal": next((g.get("journal") for g in intacct if g.get("journal")), "") or entry.get("journal") or "",
            "date": str(entry.get("entry_date") or "")[:10], "title": entry.get("narration") or "", "state": "", "module": "",
            "whenModified": str(entry.get("updated_at") or ""), "modifiedBy": "", "carry": {}, "uncarried": [], "lines": lines, "source": "ledger"}


def fingerprint(batch: dict) -> str:
    """A hash of everything read about the entry: any change in Intacct
    between the preview and the push gives a different one."""
    import hashlib
    import json
    keep = {k: v for k, v in batch.items() if k != "source"}
    return hashlib.sha256(json.dumps(keep, sort_keys=True, default=str).encode("utf-8")).hexdigest()


def signed(line: dict) -> float:
    return _r2(line.get("amount")) * (1 if int(line.get("trType") or 1) > 0 else -1)


def find_line(batch: dict, rv: dict, intacct_record: str = "") -> Optional[int]:
    """The index of a review's AMA line in the entry: by its Intacct record
    number (from the ledger copy), else its ledger line id, else the one line
    on the AMA account with the same signed amount. None when not exactly one."""
    lines = batch.get("lines") or []
    if intacct_record:
        hits = [i for i, ln in enumerate(lines) if str(ln.get("recordNo")) == str(intacct_record)]
        return hits[0] if len(hits) == 1 else None
    if rv.get("lineId"):
        hits = [i for i, ln in enumerate(lines) if ln.get("ledgerId") and ln.get("ledgerId") == rv["lineId"]]
        if len(hits) == 1:
            return hits[0]
    hits = [i for i, ln in enumerate(lines)
            if ln.get("accountNo") in (rv["accountNo"], rv["toAccount"]) and abs(signed(ln) - _r2(rv["amount"])) < 0.005]
    return hits[0] if len(hits) == 1 else None


def entry_problems(batch: dict, closed_through: str) -> list[str]:
    """Why this entry may not be edited from Nexus at all ([] = it may)."""
    out = []
    lines = batch.get("lines") or []
    if len(lines) < 2:
        out.append("The entry has fewer than two lines.")
    if any(not str((ln.get("carry") or {}).get(k) or "").strip() for ln in lines for k in ("ACCOUNTNO", "TR_TYPE", "TRX_AMOUNT")):
        out.append("A line of the entry was read without its account, side or amount. Nothing was changed.")
    if batch.get("uncarried"):
        out.append(f"The entry carries {', '.join(batch['uncarried'])}, which Nexus does not send back. Make this change in Intacct.")
    odd = sorted({f for ln in lines for f in ln.get("uncarried") or []})
    if odd:
        out.append(f"A line carries {', '.join(odd)}, which Nexus does not send back. Make this change in Intacct.")
    if batch.get("state") and batch["state"] not in assumptions.AMA_EDIT_STATES:
        out.append(f"The entry is {batch['state']} in Intacct; only {' or '.join(assumptions.AMA_EDIT_STATES)} entries are edited from Nexus.")
    if (batch.get("module") or "") not in assumptions.AMA_EDIT_MODULES:
        out.append(f"The entry was posted by Intacct's {batch['module']} module; change it there.")
    if any(ln.get("currency") and ln.get("baseCurrency") and ln["currency"] != ln["baseCurrency"] for ln in lines):
        out.append("The entry has a line in a foreign currency. Make this change in Intacct.")
    if assumptions.AMA_EDIT_REFUSE_CLEARED and any(str(ln.get("cleared") or "").strip().lower() not in _UNCLEARED for ln in lines):
        out.append("A line of the entry is reconciled (cleared). Make this change in Intacct so the reconciliation is not disturbed.")
    day = str(batch.get("date") or "")[:10]
    if closed_through and day and day <= closed_through:
        out.append(f"The entry is dated {day[5:7]}/{day[8:10]}/{day[:4]}, in a closed period (books closed through {closed_through[5:7]}/{closed_through[8:10]}/{closed_through[:4]}).")
    return out


def line_problem(batch: dict, idx: Optional[int], rv: dict) -> tuple[str, bool]:
    """(why this line cannot be changed, already_done). Already done = the
    line is already on the picked account (the change was made in Intacct)."""
    if idx is None:
        return "The AMA line could not be found exactly once on the entry. Make this change in Intacct.", False
    ln = batch["lines"][idx]
    if abs(signed(ln) - _r2(rv["amount"])) >= 0.005:
        return f"The line's amount in the entry ({signed(ln):,.2f}) is not the AMA line's ({_r2(rv['amount']):,.2f}). Nothing was changed.", False
    if ln.get("accountNo") == rv["toAccount"] and _party_done(ln, rv):
        return "", True
    if ln.get("accountNo") != rv["accountNo"]:
        return f"The line is on account {ln.get('accountNo')} now, not the AMA account {rv['accountNo']}. It was changed elsewhere.", False
    return "", False


def _party_done(ln: dict, rv: dict) -> bool:
    kind = rv.get("partyKind") or ""
    return not kind or (ln.get("vendorId") if kind == "vendor" else ln.get("customerId")) == rv.get("partyId")


def edit_update(batch: dict, targets: list[tuple[int, dict]], by: str) -> dict:
    """The one update for an entry: every line as read, the target lines on
    their new account (and vendor / customer). Amounts never change."""
    by_idx = dict(targets)
    lines = []
    for i, ln in enumerate(batch["lines"]):
        carry = dict(ln.get("carry") or {})
        rv = by_idx.get(i)
        if rv:
            carry["ACCOUNTNO"] = rv["toAccount"]
            if rv.get("partyKind") == "vendor":
                carry["VENDORID"] = rv["partyId"]
            elif rv.get("partyKind") == "customer":
                carry["CUSTOMERID"] = rv["partyId"]
        lines.append(carry)
    header = dict(batch.get("carry") or {})
    refs = ", ".join(f"{rv['reclassRef']} line {batch['lines'][i].get('lineNo') or i + 1} {rv['accountNo']} to {rv['toAccount']}" for i, rv in targets)
    return {"recordNo": batch["recordNo"], "header": header, "state": batch.get("state") or "",
            "historyComment": f"{assumptions.AMA_RECLASS_TAG}: {refs}. Approved in Nexus by {by}.", "lines": lines}


def amounts_unchanged(batch: dict, update: dict) -> bool:
    """Same number of lines, and each line's side and amount exactly as read."""
    before, after = batch.get("lines") or [], update.get("lines") or []
    if len(before) != len(after):
        return False
    for b, a in zip(before, after):
        if str((b.get("carry") or {}).get("TR_TYPE")) != str(a.get("TR_TYPE")) or str((b.get("carry") or {}).get("TRX_AMOUNT")) != str(a.get("TRX_AMOUNT")):
            return False
        for k in (b.get("carry") or {}):
            if k not in ("ACCOUNTNO", "VENDORID", "CUSTOMERID") and (b["carry"][k] != a.get(k)):
                return False
    return True


def changes_of(batch: dict, targets: list[tuple[int, dict]]) -> list[dict]:
    """What the preview lists: each line that changes, before -> after."""
    out = []
    for i, rv in targets:
        ln = batch["lines"][i]
        kind = rv.get("partyKind") or ""
        out.append({
            "reviewId": rv["id"], "reclassRef": rv["reclassRef"], "lineNo": ln.get("lineNo") or str(i + 1), "recordNo": ln.get("recordNo") or "",
            "accountBefore": ln.get("accountNo") or "", "accountBeforeTitle": ln.get("accountTitle") or rv.get("accountTitle") or "",
            "accountAfter": rv["toAccount"], "accountAfterTitle": rv.get("toAccountTitle") or "",
            "vendorBefore": ln.get("vendorId") or "", "vendorAfter": rv["partyId"] if kind == "vendor" else (ln.get("vendorId") or ""),
            "customerBefore": ln.get("customerId") or "", "customerAfter": rv["partyId"] if kind == "customer" else (ln.get("customerId") or ""),
            "amount": signed(ln), "location": ln.get("location") or "", "department": ln.get("department") or "", "memo": ln.get("memo") or "",
        })
    return out


def verify_after(update: dict, after: dict) -> list[str]:
    """What does not match when the entry is read again after the update
    ([] = Intacct holds exactly what was sent)."""
    sent, got = update.get("lines") or [], after.get("lines") or []
    if len(sent) != len(got):
        return [f"Intacct shows {len(got)} lines on the entry, {len(sent)} were sent."]
    out = []
    for n, (s, g) in enumerate(zip(sent, got), start=1):
        if (g.get("accountNo") or "") != (s.get("ACCOUNTNO") or ""):
            out.append(f"Line {n}: account {g.get('accountNo')} in Intacct, {s.get('ACCOUNTNO')} sent.")
        if abs(_r2(g.get("amount")) - _r2(s.get("TRX_AMOUNT"))) >= 0.005 or str(g.get("trType")) != str(s.get("TR_TYPE")):
            out.append(f"Line {n}: amount or side differs from what was sent.")
        for key, field in (("vendorId", "VENDORID"), ("customerId", "CUSTOMERID")):
            if (g.get(key) or "") != (s.get(field) or ""):
                out.append(f"Line {n}: {field} {g.get(key) or '(none)'} in Intacct, {s.get(field) or '(none)'} sent.")
    return out


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


def seed_bookkeepers(db: Session) -> tuple[list[str], list[str]]:
    """The team's names (AMA_BOOKKEEPER_SEED_NAMES) matched to the Nexus People
    list: (emails, names that matched nobody or more than one person). A
    "First Last" name matches first and last name; a bare first name matches
    the first name. Only live, active people with a work email count."""
    people = [p for p in db.query(models.NexusEmployee).all()
              if not (p.deleted_at or "") and (p.status or "active") not in ("inactive", "offboarded") and (p.work_email or "").strip()]
    found, unmatched = [], []
    for name in assumptions.AMA_BOOKKEEPER_SEED_NAMES:
        parts = name.lower().split()
        if not parts:
            continue
        first, last = parts[0], " ".join(parts[1:])
        hits = {p.work_email.strip().lower() for p in people
                if (p.first_name or "").strip().lower() == first and (not last or (p.last_name or "").strip().lower() == last)}
        if len(hits) == 1:
            e = hits.pop()
            if e not in found:
                found.append(e)
        else:
            unmatched.append(name)
    return found, unmatched


def bookkeeper_source(db: Session) -> str:
    """Where the bookkeepers come from: settings | env | seed."""
    if configured_bookkeepers(db):
        return "settings"
    return "env" if assumptions.AMA_BOOKKEEPERS_FALLBACK else "seed"


def bookkeepers(db: Session) -> list[str]:
    """The Bookkeepers list in AMA Settings, else the environment fallback,
    else the team's names matched on the People list (never hard-coded
    emails - Neil, 23 Oct: "we don't want to hardcode or limit that")."""
    return configured_bookkeepers(db) or list(assumptions.AMA_BOOKKEEPERS_FALLBACK) or seed_bookkeepers(db)[0]


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
