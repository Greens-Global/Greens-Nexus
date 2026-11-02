"""Field formats for the federal forms - `check(fmt, value)` answers '' when
the value is well-formed, else one sentence for the signer. Required-ness is
not its business: an empty value always passes (Nexus Sign's own required
check reports blanks). Unknown formats pass too, so a field with a format the
server does not know is never un-signable.

`mask(fmt, value)` is what everyone but the sealed PDF sees of a `sensitive`
value: the last digits of a known number format and nothing else - never the
value, whatever the format. ONE module for both the forms
package and the Nexus Sign engine (`esign_formats` re-exports it), so a
Social Security number is checked and masked the same way wherever it is
typed (Neil, 11/02/2026).
"""
import re
from datetime import date

FORMATS = ("ssn", "routing", "account", "ein", "zip", "date_mmddyyyy", "date_or_na",
           "alien_number", "i94", "passport", "money", "percent")


def digits(value) -> str:
    return re.sub(r"\D", "", str(value or ""))


def _ssn(value: str) -> str:
    raw = str(value).strip()
    if not re.fullmatch(r"\d{3}-?\d{2}-?\d{4}", raw):
        return "Enter the Social Security number as 9 digits, like 123-45-6789."
    d = digits(raw)
    area, group, serial = d[:3], d[3:5], d[5:]
    if area in ("000", "666") or area.startswith("9"):
        return "That is not a valid Social Security number: the first three digits cannot be 000, 666 or 900-999."
    if group == "00":
        return "That is not a valid Social Security number: the middle two digits cannot be 00."
    if serial == "0000":
        return "That is not a valid Social Security number: the last four digits cannot be 0000."
    return ""


def _routing(value: str) -> str:
    d = digits(value)
    if len(d) != 9 or not re.fullmatch(r"[\d\s-]+", str(value).strip()):
        return "Enter the 9-digit routing number printed at the bottom left of a check."
    n = [int(c) for c in d]
    total = 3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8])
    if total % 10 != 0:
        return "That routing number does not check out - compare it with the number on a check or your bank's website."
    return ""


def _account(value: str) -> str:
    # Digits only, like the signing screen's mask: a dash or a space in an
    # account number is a typing habit the bank will not read back.
    if not re.fullmatch(r"\d{4,17}", str(value).strip()):
        return "Enter the account number as 4 to 17 digits, with no spaces or dashes."
    return ""


def _ein(value: str) -> str:
    raw = str(value).strip()
    if not re.fullmatch(r"\d{2}-?\d{7}", raw):
        return "Enter the employer identification number as 9 digits, like 12-3456789."
    if raw[:2] == "00":
        return "That is not a valid employer identification number."
    return ""


def _zip(value: str) -> str:
    if not re.fullmatch(r"\d{5}(-\d{4})?", str(value).strip()):
        return "Enter a 5-digit ZIP code, or ZIP+4 like 92562-1234."
    return ""


def _date(value: str) -> str:
    raw = str(value).strip()
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", raw)
    if not m:
        return "Enter the date as MM/DD/YYYY."
    try:
        date(int(m.group(3)), int(m.group(1)), int(m.group(2)))
    except ValueError:
        return "That is not a real date - enter it as MM/DD/YYYY."
    return ""


def _date_or_na(value: str) -> str:
    if str(value).strip().upper().replace(".", "") in ("N/A", "NA", "NONE"):
        return ""
    err = _date(value)
    return err and "Enter the date as MM/DD/YYYY, or N/A when the document does not expire."


def _alien_number(value: str) -> str:
    raw = str(value).strip().upper().replace("-", "").replace(" ", "")
    if not re.fullmatch(r"A?\d{7,9}", raw):
        return "Enter the USCIS or A-Number as 7 to 9 digits, with or without the leading A."
    return ""


def _i94(value: str) -> str:
    raw = str(value).strip().upper().replace(" ", "")
    if not re.fullmatch(r"[0-9A-Z]{11}", raw):
        return "Enter the 11-character Form I-94 admission number."
    return ""


def _passport(value: str) -> str:
    raw = str(value).strip()
    if not 3 <= len(raw) <= 60:
        return "Enter the foreign passport number and the country that issued it."
    return ""


def _money(value: str) -> str:
    raw = str(value).strip().replace("$", "").replace(",", "").replace(" ", "")
    if not re.fullmatch(r"\d+(\.\d{1,2})?", raw):
        return "Enter a dollar amount, like 1,250.00."
    return ""


def _percent(value: str) -> str:
    raw = str(value).strip().replace("%", "").replace(" ", "")
    if not re.fullmatch(r"\d+(\.\d{1,2})?", raw) or float(raw) > 100:
        return "Enter a percent from 0 to 100."
    return ""


_CHECKS = {
    "ssn": _ssn, "routing": _routing, "account": _account, "ein": _ein, "zip": _zip,
    "date_mmddyyyy": _date, "date_or_na": _date_or_na, "alien_number": _alien_number,
    "i94": _i94, "passport": _passport, "money": _money, "percent": _percent,
}


def check(fmt: str, value) -> str:
    """'' when `value` fits `fmt` (or is blank, or `fmt` is unknown), else one
    sentence for the signer."""
    if value is None or str(value).strip() == "":
        return ""
    fn = _CHECKS.get(fmt or "")
    return fn(str(value)) if fn else ""


# Formats whose mask may show the last two digits: a glimpse that lets a
# co-signer tell two numbers apart without reading either.
_TWO_DIGIT_FORMATS = ("ein", "alien_number", "i94", "zip")
BLANK_MASK = "•••••"


def mask(fmt: str, value) -> str:
    """What a sensitive value looks like to anyone but the sealed PDF: an SSN
    as ***-**-1234, a bank number as ••••4321, an EIN / A-Number / I-94 as
    ••12, and anything else - a passport, a format the server does not know,
    no format at all - as •••••. The value itself is NEVER returned, whatever
    the format (11/02/2026: a `sensitive` box with a blank or unknown format
    used to mask to itself). A value with no digits (nothing typed yet) still
    masks to the shape, never to an empty string a screen would read as "not
    filled"."""
    if fmt == "ssn":
        return f"***-**-{(digits(value)[-4:] or '****')}"
    if fmt in ("routing", "account"):
        return f"••••{(digits(value)[-4:] or '****')}"
    if fmt in _TWO_DIGIT_FORMATS:
        tail = digits(value)[-2:]
        return f"••{tail}" if tail else BLANK_MASK
    return BLANK_MASK
