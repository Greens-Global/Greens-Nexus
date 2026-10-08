"""Work site location from a Google Maps link (Pranshu, Sep 30).

The address search (OpenStreetMap) misses or misplaces many US addresses -
469 Bohemian Hwy, Sebastopol returned nothing at all. HR can instead paste a
Google Maps link (or plain coordinates) for the building, and the site's
geofence is centred on that exact point.

A Google Maps URL carries up to three different points, and only one of them
is the place:
  - `!3d<lat>!4d<lng>` in the `data=` blob: the PLACE itself (the red pin).
  - `?q=` / `?query=` / `/place/<lat>,<lng>`: a DROPPED PIN or typed point.
  - `@<lat>,<lng>,<zoom>z`: only where the MAP VIEW was centred - it can sit
    hundreds of metres from the pin, so it is the last resort and is flagged.
Short share links (maps.app.goo.gl, goo.gl/maps, share.google, g.co) carry no
point until they are opened; resolve_link follows their redirects on the
server, hop by hop, and ONLY to Google hosts (never an arbitrary URL - this
must not become a way to make the API fetch internal addresses).

Nothing here stores Google content in bulk: a person looks up one building
and pastes its location, the same as reading the coordinates off the map.
"""
import math
import re
from typing import Optional
from urllib.parse import parse_qs, unquote, unquote_plus, urljoin, urlparse

# How a point was found, best first. `view` = only the map's centre.
PRECISION_PLACE = "place"
PRECISION_PIN = "pin"
PRECISION_COORDS = "coordinates"
PRECISION_VIEW = "view"

_NUM = r"[-+]?\d{1,3}(?:\.\d+)?"
_COORD_PAIR = re.compile(rf"^\s*\(?\s*({_NUM})\s*[,;\s]\s*({_NUM})\s*\)?\s*$")
# 38°22'24.0"N 122°55'00.2"W - what Google Maps shows for a dropped pin
# (also with the typographic ′ ″ marks, and minutes/seconds optional).
_DMS = re.compile(
    r"(\d{1,3})\s*°\s*(?:(\d{1,2}(?:\.\d+)?)\s*['′’]\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*(?:\"|″|''|”)\s*)?([NSEW])",
    re.IGNORECASE)
_PLACE_DATA = re.compile(r"!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)")
_AT_VIEW = re.compile(r"@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,[\d.]+[zm])?")

# Hosts whose links we open to resolve a short link. Exact names, plus the
# country Google domains (google.com, google.co.in, maps.google.ca, ...).
_SHORT_HOSTS = {"maps.app.goo.gl", "goo.gl", "g.co", "share.google"}
_GOOGLE_HOST = re.compile(r"^(?:(?:www|maps|consent)\.)?google\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$")
MAX_HOPS = 6


class MapLinkError(ValueError):
    """Why a link could not be turned into a point - shown to HR as is."""


def is_google_host(host: str) -> bool:
    h = (host or "").lower().rstrip(".")
    return h in _SHORT_HOSTS or bool(_GOOGLE_HOST.match(h))


def _valid(lat: float, lng: float) -> bool:
    return (-90 <= lat <= 90 and -180 <= lng <= 180
            and not (abs(lat) < 1e-9 and abs(lng) < 1e-9)
            and math.isfinite(lat) and math.isfinite(lng))


def _pair(text: str) -> Optional[tuple]:
    """'38.3733, -122.9167' (or DMS) -> (lat, lng); None when it is not one."""
    t = unquote_plus(text or "").strip()
    m = _COORD_PAIR.match(t)
    if m:
        lat, lng = float(m.group(1)), float(m.group(2))
        return (lat, lng) if _valid(lat, lng) else None
    parts = _DMS.findall(t)
    # The WHOLE value must be the two DMS halves (never DMS text inside a URL).
    if len(parts) == 2 and not _DMS.sub("", t).strip(" ,;+\t"):
        vals = {}
        for deg, mins, secs, hemi in parts:
            v = float(deg) + float(mins or 0) / 60 + float(secs or 0) / 3600
            h = hemi.upper()
            if h in "SW":
                v = -v
            vals["lat" if h in "NS" else "lng"] = v
        if "lat" in vals and "lng" in vals and _valid(vals["lat"], vals["lng"]):
            return vals["lat"], vals["lng"]
    return None


def _result(lat, lng, precision, label="", url=""):
    return {"lat": round(lat, 7), "lng": round(lng, 7), "precision": precision,
            "label": label, "url": url}


def parse_point(text: str) -> dict:
    """The site point in a pasted value: plain coordinates, or a FULL Google
    Maps URL. Raises MapLinkError with a plain-language reason. A short link
    must go through resolve_link first (needs_resolving tells)."""
    raw = (text or "").strip()
    if not raw:
        raise MapLinkError("Paste a Google Maps link or coordinates.")
    direct = _pair(raw)
    if direct:
        return _result(direct[0], direct[1], PRECISION_COORDS)
    url = raw if re.match(r"^https?://", raw, re.I) else ("https://" + raw if re.match(r"^[\w.-]+\.[a-z]{2,}/", raw, re.I) else "")
    if not url:
        raise MapLinkError("That is not a Google Maps link or a pair of coordinates. "
                           "In Google Maps, open the place and use Share - Copy link, or right-click the building and copy its coordinates.")
    p = urlparse(url)
    if not is_google_host(p.hostname or ""):
        raise MapLinkError("Only Google Maps links are accepted (google.com/maps or maps.app.goo.gl).")
    if (p.hostname or "").lower() in _SHORT_HOSTS:
        raise MapLinkError("This short link has to be opened first.")
    qs = parse_qs(p.query)
    # Consent interstitial (EU/cookie wall) wraps the real link.
    if (p.hostname or "").lower().startswith("consent.") and qs.get("continue"):
        return parse_point(qs["continue"][0])
    path = unquote(p.path or "")
    label = ""
    m = re.search(r"/place/([^/]+)", path)
    if m and not _pair(m.group(1)):
        label = unquote_plus(m.group(1)).strip()
    full = unquote(url)

    # 1. The place itself (last !3d!4d pair - earlier ones can be a route stop).
    hits = _PLACE_DATA.findall(full)
    for lat_s, lng_s in reversed(hits):
        lat, lng = float(lat_s), float(lng_s)
        if _valid(lat, lng):
            return _result(lat, lng, PRECISION_PLACE, label, url)
    # 2. A dropped pin / typed point: ?q= ?query= ?destination= or /place|search/<pt>.
    for key in ("q", "query", "destination", "daddr"):
        for v in qs.get(key, []):
            pt = _pair(v)
            if pt:
                return _result(pt[0], pt[1], PRECISION_PIN, label, url)
    for seg in re.findall(r"/(?:place|search|dir)/([^/@]+)", path):
        pt = _pair(seg)
        if pt:
            return _result(pt[0], pt[1], PRECISION_PIN, label, url)
    # 3. Only the map view's centre - usable, but flagged for a visual check.
    for key in ("ll", "center", "sll"):
        for v in qs.get(key, []):
            pt = _pair(v)
            if pt:
                return _result(pt[0], pt[1], PRECISION_VIEW, label, url)
    m = _AT_VIEW.search(path) or _AT_VIEW.search(full)
    if m:
        lat, lng = float(m.group(1)), float(m.group(2))
        if _valid(lat, lng):
            return _result(lat, lng, PRECISION_VIEW, label, url)
    raise MapLinkError("This link does not say where the place is (it is a search, not a place). "
                       "In Google Maps, click the building so its pin shows, then Share - Copy link. "
                       "Or right-click the building and click the coordinates to copy them.")


def needs_resolving(text: str) -> bool:
    raw = (text or "").strip()
    if not re.match(r"^https?://", raw, re.I):
        raw = "https://" + raw
    host = (urlparse(raw).hostname or "").lower()
    return host in _SHORT_HOSTS


def resolve_link(text: str, fetch=None) -> dict:
    """parse_point, opening a short link first. `fetch(url) -> (status,
    location_header)` is injectable for tests; the default uses httpx without
    following redirects, so every hop's host is checked before it is opened."""
    raw = (text or "").strip()
    if not needs_resolving(raw):
        return parse_point(raw)
    fetch = fetch or _http_head
    url = raw if re.match(r"^https?://", raw, re.I) else "https://" + raw
    for _ in range(MAX_HOPS):
        p = urlparse(url)
        if p.scheme not in ("http", "https") or not is_google_host(p.hostname or ""):
            raise MapLinkError("The link led away from Google Maps, so it was not used.")
        if (p.hostname or "").lower() not in _SHORT_HOSTS:
            out = parse_point(url)
            out["shortUrl"] = raw
            return out
        try:
            status, location = fetch(url)
        except Exception:
            raise MapLinkError("Could not open the short link right now. Try again, or open it in your "
                               "browser and paste the full address from the address bar.")
        if not (300 <= int(status) < 400) or not location:
            raise MapLinkError("This short link did not lead to a Google Maps place. It may have expired - "
                               "copy a fresh link from Google Maps.")
        url = urljoin(url, location)
    raise MapLinkError("The short link redirected too many times.")


def _http_head(url: str):
    import httpx
    # GET (some shorteners do not redirect a HEAD), no redirects followed, no
    # body read, short timeout. Plain sync client: the route is a def, so it
    # already runs on a worker thread, never on the event loop.
    with httpx.Client(follow_redirects=False, timeout=6.0,
                      headers={"User-Agent": "Mozilla/5.0 (GreensNexus work-site setup)"}) as c:
        with c.stream("GET", url) as r:
            return r.status_code, r.headers.get("location", "")


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin(math.radians(lat2 - lat1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(a))
