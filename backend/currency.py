"""Pay currencies (Pranshu, Oct 13: "I can select any currency, not just a
few of them"). Any ISO 4217 code is accepted; the few with a symbol nobody
misreads print it ("$85,000.00"), every other one prints its code
("CAD 85,000.00") - "$" alone would make Canadian dollars read as US ones."""
import re

SYMBOLS = {"USD": "$", "INR": "₹", "EUR": "€", "GBP": "£", "JPY": "¥"}


def is_currency(code) -> bool:
    return bool(re.fullmatch(r"[A-Z]{3}", str(code or "")))


def money_prefix(code) -> str:
    code = str(code or "USD").upper()
    return SYMBOLS.get(code) or f"{code} "
