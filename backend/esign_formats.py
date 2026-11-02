"""Field formats for Nexus Sign text boxes (Neil, 11/02/2026).

A placed text field may carry `format` - one of the keys of FORMATS - and the
signing engine refuses a value that does not fit it (422 with the field id
and the sentence below), the same check the signing screen runs as the
person types. `mask` is what everyone but the stamped PDF sees of a
`sensitive` value: the last four digits and nothing else.

Pure functions, no imports from the app: the federal forms package and the
Nexus Sign router both read this one module, so a Social Security number is
checked the same way wherever it is typed.
"""
import re

FORMATS = ("ssn", "routing", "account", "ein", "zip", "date_mmddyyyy")

_SSN_AREA_BAD = {"000", "666"}
_MESSAGES = {
    "ssn": "Enter a nine-digit Social Security number, like 123-45-6789.",
    "routing": "Enter the bank's nine-digit routing number exactly as printed on the check.",
    "account": "Enter the account number: 4 to 17 digits, no spaces or dashes.",
    "ein": "Enter a nine-digit Employer Identification Number, like 12-3456789.",
    "zip": "Enter a five-digit ZIP code, or ZIP+4 like 92626-1234.",
    "date_mmddyyyy": "Enter the date as MM/DD/YYYY.",
}


def digits(value) -> str:
    return re.sub(r"\D", "", str(value or ""))


def _ssn_ok(value: str) -> bool:
    raw = str(value or "").strip()
    if not re.fullmatch(r"\d{3}-?\d{2}-?\d{4}", raw):
        return False
    d = digits(raw)
    area, group, serial = d[:3], d[3:5], d[5:]
    if area in _SSN_AREA_BAD or "900" <= area <= "999":
        return False
    return group != "00" and serial != "0000"


def _routing_ok(value: str) -> bool:
    d = str(value or "").strip()
    if not re.fullmatch(r"\d{9}", d):
        return False
    w = (3, 7, 1, 3, 7, 1, 3, 7, 1)
    return sum(int(c) * k for c, k in zip(d, w)) % 10 == 0


def _date_ok(value: str) -> bool:
    raw = str(value or "").strip()
    m = re.fullmatch(r"(\d{2})/(\d{2})/(\d{4})", raw)
    if not m:
        return False
    from datetime import date
    try:
        date(int(m.group(3)), int(m.group(1)), int(m.group(2)))
    except ValueError:
        return False
    return True


_CHECKS = {
    "ssn": _ssn_ok,
    "routing": _routing_ok,
    "account": lambda v: bool(re.fullmatch(r"\d{4,17}", str(v or "").strip())),
    "ein": lambda v: bool(re.fullmatch(r"\d{2}-?\d{7}", str(v or "").strip())),
    "zip": lambda v: bool(re.fullmatch(r"\d{5}(-\d{4})?", str(v or "").strip())),
    "date_mmddyyyy": _date_ok,
}


def check(fmt: str, value) -> str:
    """'' when `value` fits `fmt` (or `fmt` is not a known format), else the
    one sentence the person should read under the box."""
    fn = _CHECKS.get(fmt or "")
    if fn is None:
        return ""
    return "" if fn(value) else _MESSAGES[fmt]


def mask(fmt: str, value) -> str:
    """What a sensitive value looks like to anyone but the sealed PDF: an SSN
    as ***-**-1234, a bank number as ••••4321, anything else as itself. A
    value with no digits (nothing typed yet) still masks to the shape, never
    to an empty string a screen would read as "not filled"."""
    if fmt == "ssn":
        return f"***-**-{(digits(value)[-4:] or '****')}"
    if fmt in ("routing", "account"):
        return f"••••{(digits(value)[-4:] or '****')}"
    return str(value or "")
