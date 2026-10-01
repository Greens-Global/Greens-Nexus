"""A location's postal address, read from its Google Maps link (Neil, Oct 1).

The pasted Google Maps link is the one way a location is placed, and its
address comes from the same link - HR should never retype it, and it must read
the way a US address is written:

    25260 N Centre City Pkwy, Escondido, CA 92026

not the OpenStreetMap display form that had been saved on some sites
("25260, North Centre City Parkway, Escondido, San Diego County, California,
92026, United States" - Neil: "this is not how addresses are in the United
States").

Two sources, best first:
  1. The link itself. A Google place link names the place in its path
     (/maps/place/<name>/...). For an address search that segment IS the
     address; for a business it is the business name, sometimes followed by
     the address ("Greens Storage, 25260 N Centre ..."). The address part is
     used as Google wrote it, and a business name is offered as the location's
     name.
  2. A reverse lookup of the point (OpenStreetMap Nominatim), formatted from
     its structured parts - never its display string. One request per pasted
     link, on the worker thread the route already runs on.

Nothing found -> "": the form then asks HR to type the address.
"""
import re
from typing import Optional

US_STATES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA",
    "colorado": "CO", "connecticut": "CT", "delaware": "DE", "district of columbia": "DC",
    "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID", "illinois": "IL",
    "indiana": "IN", "iowa": "IA", "kansas": "KS", "kentucky": "KY", "louisiana": "LA",
    "maine": "ME", "maryland": "MD", "massachusetts": "MA", "michigan": "MI", "minnesota": "MN",
    "mississippi": "MS", "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK", "oregon": "OR",
    "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
    "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT", "virginia": "VA",
    "washington": "WA", "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
    "puerto rico": "PR", "guam": "GU", "us virgin islands": "VI",
}

# "<number> <street>" - where the street part of an address begins.
_STREET_START = re.compile(r"^\s*\d+[A-Za-z]?(?:-\d+)?\s+\S")
# "..., CA 92026" / "..., California 92026-1234" at the end of a US address.
_STATE_ZIP = re.compile(r",\s*([A-Za-z .]+?)\s+(\d{5}(?:-\d{4})?)\s*$")
_SPACES = re.compile(r"\s+")


def _tidy(text: str) -> str:
    return _SPACES.sub(" ", (text or "").replace("+", " ")).strip(" ,")


def _abbrev_state(name: str) -> str:
    n = _tidy(name)
    if len(n) == 2 and n.isalpha():
        return n.upper()
    return US_STATES.get(n.lower(), n)


def address_from_label(label: str) -> tuple:
    """(address, place_name) read from a Google Maps place label.

    "25260 N Centre City Pkwy, Escondido, CA 92026" -> (that, "")
    "Greens Storage, 25260 N Centre City Pkwy, Escondido, CA 92026"
        -> ("25260 N Centre City Pkwy, Escondido, CA 92026", "Greens Storage")
    "Greens Storage" -> ("", "Greens Storage")
    An address must have a street number and at least a city after it."""
    text = _tidy(label)
    # A dropped pin's "label" is its coordinates (38°22'24.0"N 122°55'00.2"W
    # or 38.37, -122.91) - neither an address nor a name.
    if not text or "°" in text or re.fullmatch(r"[-+]?\d+(?:\.\d+)?\s*,\s*[-+]?\d+(?:\.\d+)?", text):
        return "", ""
    parts = [p.strip() for p in text.split(",") if p.strip()]
    for i, part in enumerate(parts):
        if _STREET_START.match(part) and len(parts) - i >= 2:
            addr = ", ".join(parts[i:])
            # "..., United States" / "..., USA" is noise on a US address.
            addr = re.sub(r",\s*(United States(?: of America)?|USA|US)\s*$", "", addr, flags=re.I)
            m = _STATE_ZIP.search(addr)
            if m:
                addr = addr[:m.start()] + f", {_abbrev_state(m.group(1))} {m.group(2)}"
            return addr, ", ".join(parts[:i])
    return "", text


def format_address(parts: dict) -> str:
    """A postal address from Nominatim's structured `address` parts.

    US: "25260 North Centre City Parkway, Escondido, CA 92026".
    Elsewhere: "<number> <road>, <city>, <state> <postcode>, <country>".
    Missing pieces are left out; no street at all -> ""."""
    p = parts or {}
    road = _tidy(p.get("road") or p.get("pedestrian") or p.get("footway") or "")
    if not road:
        return ""
    number = _tidy(p.get("house_number") or "")
    street = f"{number} {road}".strip()
    city = _tidy(p.get("city") or p.get("town") or p.get("village") or p.get("hamlet")
                 or p.get("suburb") or p.get("municipality") or "")
    code = _tidy(p.get("postcode") or "")
    if (p.get("country_code") or "").lower() == "us":
        state = _abbrev_state(p.get("state") or "")
        tail = " ".join(x for x in (state, code) if x)
        return ", ".join(x for x in (street, city, tail) if x)
    state = _tidy(p.get("state") or "")
    tail = " ".join(x for x in (state, code) if x)
    return ", ".join(x for x in (street, city, tail, _tidy(p.get("country") or "")) if x)


def _nominatim_reverse(lat: float, lng: float) -> Optional[dict]:
    import httpx
    with httpx.Client(timeout=6.0, headers={
            "User-Agent": "GreensNexus/1.0 (location setup; one lookup per pasted link)",
            "Accept": "application/json"}) as c:
        r = c.get("https://nominatim.openstreetmap.org/reverse",
                  params={"format": "jsonv2", "lat": f"{lat:.6f}", "lon": f"{lng:.6f}",
                          "zoom": 18, "addressdetails": 1})
        return r.json() if r.status_code == 200 else None


def reverse_address(lat: float, lng: float, fetch=None) -> str:
    """The formatted address at a point, or "" (no street there, or the lookup
    failed - never an error: HR can still type it). `fetch(lat, lng) -> dict`
    is injectable for tests."""
    try:
        hit = (fetch or _nominatim_reverse)(lat, lng)
    except Exception:
        return ""
    return format_address((hit or {}).get("address") or {}) if isinstance(hit, dict) else ""


def address_for(point: dict, fetch=None) -> dict:
    """{"address", "placeName"} for a resolved link point (maps_link result)."""
    address, place = address_from_label(point.get("label") or "")
    if not address:
        address = reverse_address(point["lat"], point["lng"], fetch=fetch)
    return {"address": address, "placeName": place}
