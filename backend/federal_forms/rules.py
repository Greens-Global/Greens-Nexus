"""Per-form conditional rules - what a required flag on one box cannot say.

`validate(kind, role, values)` returns `[{"field": id, "message": sentence}]`,
empty when the values hold together for that signer's part of the form.
Field ids are the ones the maps give (`maps/*.json`); a check value counts as
on when it is truthy in the way Nexus Sign stores it ("true", "on", "1", True).
"""

ON_WORDS = ("1", "true", "on", "yes", "x", "checked")


def _on(v) -> bool:
    if v is True or v == 1:
        return True
    return str(v or "").strip().lower() in ON_WORDS


def _filled(v) -> bool:
    return str(v or "").strip() != ""


def _num(v) -> float | None:
    raw = str(v or "").strip().replace("$", "").replace("%", "").replace(",", "")
    try:
        return float(raw) if raw else None
    except ValueError:
        return None


def _w4(role: str, v: dict) -> list:
    if role != "employee":
        return []
    picked = [k for k in ("filing_single", "filing_joint", "filing_head") if _on(v.get(k))]
    if len(picked) != 1:
        return [{"field": "filing_single",
                 "message": "Check exactly one filing status in Step 1(c)."}]
    return []


def _i9_employee(v: dict) -> list:
    statuses = ("citizen_us", "citizen_national", "citizen_lpr", "citizen_alien")
    picked = [k for k in statuses if _on(v.get(k))]
    if len(picked) != 1:
        return [{"field": "citizen_us",
                 "message": "Check exactly one citizenship or immigration status."}]
    if picked[0] == "citizen_lpr" and not _filled(v.get("lpr_a_number")):
        return [{"field": "lpr_a_number",
                 "message": "A lawful permanent resident enters the USCIS or A-Number."}]
    if picked[0] == "citizen_alien" and not any(
            _filled(v.get(k)) for k in ("alien_a_number", "alien_i94", "alien_passport")):
        return [{"field": "alien_a_number",
                 "message": "Enter one of: USCIS A-Number, Form I-94 admission number, "
                            "or foreign passport number and country of issuance."}]
    return []


_DOC_PARTS = (("title", "document title"), ("authority", "issuing authority"),
              ("number", "document number"), ("expiry", "expiration date (or N/A)"))


def _doc(v: dict, prefix: str) -> tuple:
    """(any part filled, [missing parts as (field, message)])"""
    present = [p for p, _ in _DOC_PARTS if _filled(v.get(f"{prefix}_{p}"))]
    missing = [(f"{prefix}_{p}", f"Enter the {what}.") for p, what in _DOC_PARTS
               if not _filled(v.get(f"{prefix}_{p}"))]
    return bool(present), missing


def _i9_hr(v: dict) -> list:
    errs = []
    a_any, a_missing = _doc(v, "a1")
    b_any, b_missing = _doc(v, "b")
    c_any, c_missing = _doc(v, "c")
    if a_any and (b_any or c_any):
        errs.append({"field": "b_title" if b_any else "c_title",
                     "message": "Record either one List A document or one List B and one "
                                "List C document, not both."})
    elif a_any:
        errs.extend({"field": f, "message": m} for f, m in a_missing)
    elif b_any or c_any:
        errs.extend({"field": f, "message": m} for f, m in b_missing)
        errs.extend({"field": f, "message": m} for f, m in c_missing)
    else:
        errs.append({"field": "a1_title",
                     "message": "Record the document the employee presented: one List A "
                                "document, or one List B and one List C document."})
    if not _filled(v.get("first_day")):
        errs.append({"field": "first_day",
                     "message": "Enter the employee's first day of employment."})
    return errs


def _i9(role: str, v: dict) -> list:
    if role == "employee":
        return _i9_employee(v)
    if role == "hr":
        return _i9_hr(v)
    return []


def _account(v: dict, prefix: str, label: str) -> tuple:
    """(any part filled, errors) for one bank account block."""
    keys = {"bank": "bank name", "routing": "routing number", "account": "account number"}
    present = [k for k in keys if _filled(v.get(f"{prefix}_{k}"))]
    types = [k for k in ("checking", "savings") if _on(v.get(f"{prefix}_type_{k}"))]
    any_part = bool(present or types)
    errs = [{"field": f"{prefix}_{k}", "message": f"Enter the {what} for {label}."}
            for k, what in keys.items() if not _filled(v.get(f"{prefix}_{k}"))]
    if len(types) != 1:
        errs.append({"field": f"{prefix}_type_checking",
                     "message": f"Check Checking or Savings for {label}."})
    return any_part, errs


def _direct_deposit(role: str, v: dict) -> list:
    if role != "employee":
        return []
    _, errs = _account(v, "dd1", "Account 1")
    second, errs2 = _account(v, "dd2", "Account 2")
    split_given = any(_filled(v.get(k)) for k in ("dd2_amount", "dd2_percent", "dd1_percent"))
    if not second and not split_given:
        return errs
    errs.extend(errs2)
    amount, p1, p2 = _num(v.get("dd2_amount")), _num(v.get("dd1_percent")), _num(v.get("dd2_percent"))
    if amount is not None and amount > 0:
        if p1 is not None or p2 is not None:
            errs.append({"field": "dd2_amount",
                         "message": "Give Account 2 a fixed amount or a percent, not both."})
    elif p1 is None and p2 is None:
        errs.append({"field": "dd2_amount",
                     "message": "Say how much goes to Account 2: a fixed amount per pay "
                                "period, or percents for both accounts totaling 100."})
    elif round((p1 or 0) + (p2 or 0), 2) != 100:
        errs.append({"field": "dd2_percent",
                     "message": "The percents for Account 1 and Account 2 must total 100."})
    return errs


_RULES = {"w4": _w4, "i9": _i9, "direct_deposit": _direct_deposit}


def validate(kind: str, role: str, values: dict | None) -> list:
    fn = _RULES.get(kind)
    if not fn:
        return []
    return fn(role or "", dict(values or {}))
