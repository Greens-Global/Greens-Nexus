"""Loan terms already typed in Asset Management, offered to Accounting > Loans.

Neil, 11/19/2026. The ledger cannot say a loan's rate or maturity, so they are
typed on the loan (Charmi, 10/14). Production had 14 loans with a maturity on
1 and a rate on 1, while Asset Management had a maturity typed on 9 properties
and a rate on 6 - the same facts, in the other module. This finds, by RULES
(no AI), which property's typed debt belongs to which loan and offers the
terms the loan lacks. Nothing here saves anything: the Loans screen shows the
offer and a person accepts it.

A property is tied to a loan only inside its own ledger entity (the property's
`entityCode`, set by Link to the Ledger, and that entity's sub-entities), by
one of, in this order:

  number   the loan number typed on the property is the loan's own number, or
           sits in the loan's name ("F&M Loan #6870" carries the last four)
  lender   the lender typed on the property names the loan and only that loan
  only     the entity has one open loan, its name does not say a lender, and
           no property of that entity points anywhere else

A term is offered only where the loan has none and the property's value reads
as one value ("6.25%", "06/01/2031"); "SOFR + 2.5" or "2031" is not guessed
at. Two properties that disagree about one loan's term offer nothing for it.
"""
import re
from datetime import date
from typing import Optional

# Words in a lender's name that do not say WHICH lender.
_GENERIC = {
    "bank", "banks", "the", "of", "and", "na", "n", "a", "national", "association", "loan", "loans", "mortgage", "note",
    "notes", "payable", "np", "credit", "union", "fsb", "trust", "savings", "financial", "finance", "services", "inc",
    "llc", "corp", "co", "company", "lp", "federal", "group", "lender", "lending", "line", "loc", "term", "to", "due", "for",
}
_MONTHS = {m: i + 1 for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"])}
_MONTHS.update({k[:3]: v for k, v in list(_MONTHS.items())})
_MONTHS["sept"] = 9


def snapshot_value(payload: dict, *labels: str) -> str:
    """The first non-empty value among `labels` in an asset's snapshot (the
    grouped sheet: [{group, fields: [{label, value}]}])."""
    want = [_norm_label(x) for x in labels]
    found = {}
    for g in (payload or {}).get("snapshot") or []:
        for f in (g or {}).get("fields") or []:
            key = _norm_label((f or {}).get("label"))
            val = str((f or {}).get("value") or "").strip()
            if key in want and val and key not in found:
                found[key] = val
    for w in want:
        if w in found:
            return found[w]
    return ""


def _norm_label(s) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()


def parse_day(text: str) -> Optional[str]:
    """A typed date as YYYY-MM-DD, or None when it is not one whole date."""
    t = str(text or "").strip()
    if not t:
        return None
    m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", t)
    if m:
        return _iso(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = re.fullmatch(r"(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})", t)
    if m:                                   # US order: month, day, year
        y = int(m.group(3))
        return _iso(y + 2000 if y < 100 else y, int(m.group(1)), int(m.group(2)))
    m = re.fullmatch(r"([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})", t)
    if m and m.group(1).lower() in _MONTHS:
        return _iso(int(m.group(3)), _MONTHS[m.group(1).lower()], int(m.group(2)))
    return None


def _iso(y: int, m: int, d: int) -> Optional[str]:
    try:
        return date(y, m, d).isoformat() if 1990 <= y <= 2100 else None
    except ValueError:
        return None


def parse_rate(text: str) -> Optional[float]:
    """A typed rate as a number of percent ("6.25%" -> 6.25), or None when
    the text is not one plain rate (an index plus a spread, a range)."""
    t = str(text or "").strip().lower()
    if not t or "+" in t or " to " in t or re.search(r"\d\s*-\s*\d", t):
        return None
    nums = re.findall(r"\d+(?:\.\d+)?", t)
    if len(nums) != 1:
        return None
    v = float(nums[0])
    return round(v, 4) if 0 < v < 30 else None


def parse_rate_type(*texts: str) -> str:
    t = " ".join(str(x or "") for x in texts).lower()
    if re.search(r"\b(variable|floating|adjustable|arm)\b", t):
        return "variable"
    return "fixed" if re.search(r"\bfixed\b", t) else ""


def _digits(s) -> str:
    return re.sub(r"[^0-9a-z]", "", str(s or "").lower())


def _words(s) -> set:
    """The words of a lender or loan name that tell lenders apart."""
    text = re.sub(r"\b([a-z])&([a-z])\b", r"\1\2", str(s or "").lower())      # "F&M" is one word
    return {w for w in re.findall(r"[a-z]+", text) if len(w) >= 2 and w not in _GENERIC}


def _loan_text(loan: dict) -> str:
    return " ".join(str(loan.get(k) or "") for k in ("lender", "glTitle", "loanNo", "loanNumber"))


def _number_hit(prop: dict, loan: dict) -> bool:
    typed = _digits(prop.get("loanNumber"))
    if len(typed) < 4:
        return False
    own = _digits(loan.get("loanNumber"))
    if own and own == typed:
        return True
    groups = set(re.findall(r"\d{4,}", _loan_text(loan)))       # "#6870" in "F&M Loan #6870"
    tail = re.sub(r"\D", "", str(prop.get("loanNumber") or ""))[-4:]
    return typed in {_digits(g) for g in groups} or (len(tail) == 4 and tail in groups)


def _lender_hit(prop: dict, loan: dict) -> bool:
    mine, theirs = _words(prop.get("lender")), _words(" ".join(str(loan.get(k) or "") for k in ("lender", "glTitle")))
    return bool(mine) and bool(theirs) and (mine <= theirs or theirs <= mine)


def _pick(prop: dict, loans: list) -> tuple:
    """(loan, why) for the one loan of `loans` this property's debt is, or (None, '')."""
    by_number = [l for l in loans if _number_hit(prop, l)]
    if len(by_number) == 1:
        return by_number[0], "number"
    if by_number:
        return None, ""
    by_lender = [l for l in loans if _lender_hit(prop, l)]
    if len(by_lender) == 1:
        return by_lender[0], "lender"
    if by_lender:
        return None, ""
    if len(loans) == 1 and not _words(" ".join(str(loans[0].get(k) or "") for k in ("lender", "glTitle"))):
        return loans[0], "only"
    return None, ""


def suggest(loans: list, props: list, reach: dict) -> list:
    """The offers. `loans`: [{id, lender, glTitle, loanNo, loanNumber,
    entityCode, ratePct, maturity, closed}]. `props`: [{id, name, entityCode,
    lender, loanNumber, maturity, rate, rateType}] with the typed text as it
    stands. `reach`: {entityCode: set of that entity and its sub-entities}.
    -> [{loanId, propertyId, propertyName, why, maturity?, ratePct?, rateType?}],
    one per loan, only with a term the loan lacks."""
    open_loans = [l for l in loans if l.get("id") and not l.get("closed")]
    found = {}          # loan id -> [(prop, why)]
    for p in props:
        code = str(p.get("entityCode") or "").strip()
        if not code or not (str(p.get("lender") or "").strip() or str(p.get("loanNumber") or "").strip()
                            or str(p.get("maturity") or "").strip() or str(p.get("rate") or "").strip()):
            continue
        inside = reach.get(code) or {code}
        mine = [l for l in open_loans if str(l.get("entityCode") or "") in inside]
        loan, why = _pick(p, mine)
        if loan is not None:
            found.setdefault(str(loan["id"]), []).append((p, why))
    by_id = {str(l["id"]): l for l in open_loans}
    rank = {"number": 0, "lender": 1, "only": 2}
    out = []
    for lid, hits in found.items():
        loan = by_id[lid]
        hits.sort(key=lambda h: (rank[h[1]], str(h[0].get("name") or "")))
        offer = {}
        if not loan.get("maturity"):
            days = {d for d in (parse_day(p.get("maturity")) for p, _ in hits) if d}
            if len(days) == 1:
                offer["maturity"] = days.pop()
        if loan.get("ratePct") is None:
            rates = {r for r in (parse_rate(p.get("rate")) for p, _ in hits) if r is not None}
            if len(rates) == 1:
                offer["ratePct"] = rates.pop()
                kinds = {k for k in (parse_rate_type(p.get("rateType"), p.get("rate")) for p, _ in hits) if k}
                if len(kinds) == 1:
                    offer["rateType"] = kinds.pop()
        if not offer:
            continue
        # The property named is the best-tied one that carries an offered term.
        src, why = next(((p, w) for p, w in hits
                         if ("maturity" in offer and parse_day(p.get("maturity")) == offer["maturity"])
                         or ("ratePct" in offer and parse_rate(p.get("rate")) == offer["ratePct"])), hits[0])
        out.append({"loanId": lid, "propertyId": str(src.get("id") or ""), "propertyName": str(src.get("name") or ""), "why": why, **offer})
    out.sort(key=lambda o: (o["propertyName"].lower(), o["loanId"]))
    return out


def property_row(prop_id: str, payload: dict) -> dict:
    """What `suggest` reads from one asset's stored payload."""
    p = payload or {}
    return {
        "id": prop_id, "name": str(p.get("name") or ""), "entityCode": str(p.get("entityCode") or "").strip(),
        "lender": snapshot_value(p, "Lender"), "loanNumber": snapshot_value(p, "Loan Number", "Loan #"),
        "maturity": snapshot_value(p, "Maturity Date", "Maturity"), "rate": snapshot_value(p, "Interest Rate", "Rate"),
        "rateType": snapshot_value(p, "Rate Type"),
    }
