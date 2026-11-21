"""The guarantee record on a loan (Neil, 11/21/2026) - Accounting > Loans.

The loans knew their balance, rate and maturity, but nothing said who stands
behind each one. For a family office that is the question a lender, an
auditor and the family itself ask first: which loans are recourse, who
guaranteed them, for how much, and when the guarantee falls away.

Two things are kept beside the loan (`accounting_loan_settings`, like the
rest of what Nexus adds to a loan - the accounting app's `fin_loans` takes no
new columns):

  recourse    '' (not recorded) | full | limited | non_recourse
  guarantors  a short list, each {name, kind, amount, burnOff}:
                kind     full       the whole loan
                         limited    up to `amount` (required, above zero)
                         carve_out  the non-recourse carve-outs only
                                    ("bad boy" acts), no amount
                burnOff  the terms it steps down or falls away on, in the
                         loan documents' own words

A guarantor is a NAME as the guaranty states it (a person, a trust, an
entity) - not a Nexus person, so never a people picker. Typed, never worked
out: nothing here adds guarantees up, because several guarantors of one loan
are usually jointly liable for the same dollars and a sum would overstate it.
"""

RECOURSE = ("full", "limited", "non_recourse")
KINDS = ("full", "limited", "carve_out")
MAX_GUARANTORS = 12
NAME_MAX = 120
BURN_OFF_MAX = 300


class GuaranteeError(ValueError):
    """What was sent cannot be kept; the message is for the person."""


def clean_recourse(value) -> str:
    v = str(value or "").strip()
    if v and v not in RECOURSE:
        raise GuaranteeError("Recourse is Full Recourse, Limited Recourse or Non-Recourse.")
    return v


def clean_guarantors(value) -> list:
    """The list as it is stored. None or [] = no guarantors."""
    if value in (None, ""):
        return []
    if not isinstance(value, list):
        raise GuaranteeError("The guarantors are a list.")
    if len(value) > MAX_GUARANTORS:
        raise GuaranteeError(f"A loan keeps {MAX_GUARANTORS} guarantors at most.")
    out = []
    for g in value:
        if not isinstance(g, dict):
            raise GuaranteeError("Each guarantor needs a name.")
        name = " ".join(str(g.get("name") or "").split())[:NAME_MAX]
        if not name:
            raise GuaranteeError("Each guarantor needs a name.")
        kind = str(g.get("kind") or "full").strip()
        if kind not in KINDS:
            raise GuaranteeError("A guarantee is Full, Limited or Carve-Outs Only.")
        amount = None
        if kind == "limited":
            try:
                amount = round(float(g.get("amount")), 2)
            except (TypeError, ValueError):
                amount = None
            if amount is None or amount != amount or amount in (float("inf"), float("-inf")) or amount <= 0:
                raise GuaranteeError(f"{name}: a limited guarantee needs its amount.")
        out.append({"name": name, "kind": kind, "amount": amount, "burnOff": " ".join(str(g.get("burnOff") or "").split())[:BURN_OFF_MAX]})
    return out


def view(setting: dict) -> dict:
    """What a loan row carries: {"recourse", "guarantors"} - a stored value
    that no longer reads (an old shape, a hand edit) shows as not recorded
    rather than breaking the loans list."""
    s = setting or {}
    try:
        recourse = clean_recourse(s.get("recourse"))
    except GuaranteeError:
        recourse = ""
    rows = s.get("guarantors")
    out = []
    for g in rows if isinstance(rows, list) else []:
        try:
            out.extend(clean_guarantors([g]))
        except GuaranteeError:
            continue
    return {"recourse": recourse, "guarantors": out}
