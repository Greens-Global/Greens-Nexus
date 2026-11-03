"""The ONE readable gloss on a browser's User-Agent string (Neil, 11/02/2026).

'Windows 10/11 - Chrome', 'iOS - Safari', 'macOS - Firefox'. It used to live
twice - on the Nexus Sign certificate (services/certificate.py) and the
signer's device line (routers/esign.py) - and the new sign-in notice is a
third reader, so it is one function now and both of those import it.

Best effort and deliberately coarse: the raw UA is kept verbatim wherever it
is recorded, this is only the human line beside it. It never guesses - an
unrecognized agent is reported as such rather than mislabeled.
"""

_OS_PATTERNS = [   # order matters - see the iPhone note below
    ("Windows NT 10.0", "Windows 10/11"), ("Windows NT 11", "Windows 11"),
    # iOS/iPadOS agents say "like Mac OS X", so they MUST be matched before
    # the desktop token or every iPhone signature is certified as a Mac.
    ("iPhone", "iOS"), ("iPad", "iPadOS"), ("Android", "Android"),
    ("Mac OS X", "macOS"), ("CrOS", "ChromeOS"), ("Linux", "Linux"),
]
_BROWSER_PATTERNS = [   # order matters - Edge/Chrome both say "Chrome"
    ("Edg/", "Edge"), ("OPR/", "Opera"), ("Chrome/", "Chrome"),
    ("Firefox/", "Firefox"), ("Safari/", "Safari"),
]


def summarize(ua: str) -> str:
    """'Windows 10/11 - Chrome' from a User-Agent string; '' for none."""
    ua = (ua or "").strip()
    if not ua:
        return ""
    os_name = next((label for token, label in _OS_PATTERNS if token in ua), "")
    browser = next((label for token, label in _BROWSER_PATTERNS if token in ua), "")
    if os_name and browser:
        return f"{os_name} - {browser}"
    return os_name or browser or "Unrecognized user agent"
