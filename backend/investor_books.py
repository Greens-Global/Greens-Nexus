"""Investor Relations, live from the books (Neil, 11/11/2026) - the rules.

Greens keeps every investor's capital in Intacct as their OWN equity
accounts, in three families that share the investor's name:

    300xx  "<Name> - (E&C)"            the E&C account
    310xx  "<Name> - (Contribution)"   money they put in
    320xx  "<Name> - (Distribution)"   money paid back to them

and the deal is the Intacct entity (location) the accounts post on - Greens
Austin, LLC is entity 67000. So an investor's live capital in a deal is the
balance of their accounts on that entity, and a deal's live figures are that
entity's balance sheet and income statement. The numbers on 300xx/310xx/320xx
do not line up (Neil Kadakia is 30016 / 31010 / 32013), so the family is told
by the NAME, and a profile keeps the exact account numbers it is linked to.

Pure functions only: the routes (routers/investor_books.py) read the books
through the accounting proxy and hand the rows in here.
"""
from __future__ import annotations

import re

# Account-number prefix -> what the account holds.
KINDS = {"300": "ec", "310": "contributed", "320": "distributed"}
_SUFFIX = re.compile(r"\s*-?\s*\((?:e\s*&\s*c|contribution|distribution|undistributed cash|net income)\)\s*$", re.I)
_NOT_A_PARTNER = re.compile(r"opening\s+balance", re.I)
_CODE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.\-]{0,39}$")

BS_SECTIONS = ("asset", "liability")
PL_SECTIONS = ("revenue", "cogs", "expense", "other_expense")


def r2(x: float) -> float:
    return round(float(x or 0) + 0.0, 2)


def valid_code(code: str) -> bool:
    return bool(_CODE.match(code or ""))


def partner_kind(account_no: str, section: str = "equity", title: str = "") -> str | None:
    """'ec' / 'contributed' / 'distributed' for an investor's equity account,
    else None (any other account, or Opening Balance Equity)."""
    no = str(account_no or "").strip()
    if (section or "").lower() != "equity" or len(no) != 5 or not no.isdigit():
        return None
    if _NOT_A_PARTNER.search(title or ""):
        return None
    return KINDS.get(no[:3])


def stem(title: str) -> str:
    """'Neil Kadakia - (Contribution)' -> 'Neil Kadakia'."""
    return " ".join(_SUFFIX.sub("", str(title or "")).split())


def partner_key(name: str) -> str:
    """Matching key for a name: case, punctuation and a trailing LLC ignored
    ('Greens Global Inv 1, LLC' == 'Greens Global Inv 1')."""
    k = " ".join(re.sub(r"[^a-z0-9]+", " ", str(name or "").lower()).split())
    return re.sub(r"\s+llc$", "", k)


def partners_from_chart(accounts: list) -> list:
    """The investors in the chart of accounts, one per name:
    [{key, name, accounts: [{accountNo, title, kind, active}]}], by name."""
    out: dict[str, dict] = {}
    for a in accounts or []:
        if not isinstance(a, dict):
            continue
        no = str(a.get("account_no") or "").strip()
        title = str(a.get("title") or "")
        kind = partner_kind(no, a.get("section") or "", title)
        if not kind:
            continue
        name = stem(title) or no
        p = out.setdefault(partner_key(name), {"key": partner_key(name), "name": name, "accounts": []})
        if kind == "ec":       # the E&C title is the fullest spelling of the name
            p["name"] = name
        p["accounts"].append({"accountNo": no, "title": title, "kind": kind, "active": a.get("active") is not False})
    for p in out.values():
        p["accounts"].sort(key=lambda x: x["accountNo"])
    return sorted(out.values(), key=lambda p: p["name"].lower())


def titles(rows: list) -> dict:
    """{account_no: title} from a buckets read."""
    return {str(r.get("account_no")): r.get("title") or "" for r in rows or []}


def balances(rows: list, by_bucket: bool = False) -> dict:
    """Partner-account balances (credit - debit) from a buckets read:
    {account_no: balance}, or {bucket: {account_no: balance}} when by_bucket."""
    out: dict = {}
    for r in rows or []:
        no = str(r.get("account_no") or "")
        if not partner_kind(no, r.get("section") or "", r.get("title") or ""):
            continue
        amt = float(r.get("credit") or 0) - float(r.get("debit") or 0)
        tgt = out.setdefault(str(r.get("bucket") or ""), {}) if by_bucket else out
        tgt[no] = tgt.get(no, 0.0) + amt
    return out


def members(bal: dict, titles: dict, investor_of: dict) -> list:
    """One row per member of a deal from its partner-account balances.

    bal: {account_no: balance}; titles: {account_no: title};
    investor_of: {account_no: (investor_id, display_name)} for linked accounts.
    A linked investor's accounts add up under the profile; an unlinked one's
    under the name in the books (investorId ''). Members whose accounts are
    all zero are left out. `balance` is the member's capital account; the
    membership percentage is not in the books (it is the operating
    agreement's, kept on the Nexus commitment)."""
    groups: dict = {}
    for no, amt in bal.items():
        kind = KINDS.get(no[:3])
        if not kind:
            continue
        linked = investor_of.get(no)
        if linked:
            key, inv_id, name = ("i", linked[0]), linked[0], linked[1]
        else:
            name = stem(titles.get(no, "")) or no
            key, inv_id = ("p", partner_key(name)), ""
        g = groups.setdefault(key, {"investorId": inv_id, "name": name, "accounts": [],
                                    "ec": 0.0, "contributed": 0.0, "distributed": 0.0, "balance": 0.0})
        g["accounts"].append(no)
        g[kind] += amt
        g["balance"] += amt
    rows = [g for g in groups.values() if any(abs(g[k]) >= 0.005 for k in ("ec", "contributed", "distributed"))]
    for g in rows:
        g["distributed"] = -g["distributed"]       # paid out reads as a positive figure
        for k in ("ec", "contributed", "distributed", "balance"):
            g[k] = r2(g[k])
        g["accounts"].sort()
    rows.sort(key=lambda g: (-g["balance"], g["name"].lower()))
    return rows


def property_figures(bs_rows: list, pl_rows: list) -> dict:
    """The entity's live figures: balance sheet from the start of the books
    (assets, liabilities, book equity = assets - liabilities, cash in the
    bank accounts) and this year's revenue and net income. `cashAccounts` /
    `revenueAccounts` / `pnlAccounts` list the accounts behind the figures for
    the drill-down."""
    assets = liabilities = cash = 0.0
    cash_accts = []
    for r in bs_rows or []:
        sec = (r.get("section") or "").lower()
        dr = float(r.get("debit") or 0) - float(r.get("credit") or 0)
        if sec == "asset":
            assets += dr
            if r.get("bank_kind"):
                cash += dr
                cash_accts.append(str(r.get("account_no") or ""))
        elif sec == "liability":
            liabilities -= dr
    revenue = net = 0.0
    rev_accts, pl_accts = [], []
    for r in pl_rows or []:
        sec = (r.get("section") or "").lower()
        if sec not in PL_SECTIONS:
            continue
        cr = float(r.get("credit") or 0) - float(r.get("debit") or 0)
        net += cr
        pl_accts.append(str(r.get("account_no") or ""))
        if sec == "revenue":
            revenue += cr
            rev_accts.append(str(r.get("account_no") or ""))
    return {
        "assets": r2(assets), "liabilities": r2(liabilities), "bookEquity": r2(assets - liabilities),
        "cash": r2(cash), "revenueYtd": r2(revenue), "netIncomeYtd": r2(net),
        "cashAccounts": sorted(set(cash_accts)), "revenueAccounts": sorted(set(rev_accts)),
        "pnlAccounts": sorted(set(pl_accts)),
    }


_TYPE_WORDS = (("ira", r"\bira\b"), ("trust", r"\btrust|\btr\b"), ("partnership", r"\bflp\b|p'?ship|partners?\b|\blp\b"),
               ("llc", r"\bllc\b|\bltd\b|\binc\b|pvt|\bcorp"))


def entity_type_of(name: str) -> str:
    """A profile's investor type from the name in the books - a starting
    point the GP can change."""
    low = str(name or "").lower()
    for t, pat in _TYPE_WORDS:
        if re.search(pat, low):
            return t
    return "individual"
