"""Approximate location of an IP address, for the sign-in notice (Neil, 11/02/2026).

`lookup(ip)` -> "Laguna Niguel, CA, US", or "" when nothing can be said:
  - a private, loopback, link-local or Cloudflare address (our own proxies)
    has no location worth printing;
  - the lookup is a LOCAL MaxMind GeoLite2-City database at NEXUS_GEOIP_DB,
    read through the `geoip2` package - no outbound HTTP, no paid service, no
    key in the repo. Both are optional: without the package or the file every
    answer is "" and the notice simply leaves the location out. The package
    is imported lazily, inside a try, so nothing here is a requirement
    (Neil decides whether to create the MaxMind account).
Answers are cached per address in process for a day.
"""
import ipaddress
import os
import time

import client_ip

_DAY = 86400
_cache: dict = {}          # ip -> (answer, expires_at)
_reader = {"db": "", "obj": None}   # one open reader per database path


def _skip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return True
    if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_multicast \
            or addr.is_reserved or addr.is_unspecified:
        return True
    return client_ip.is_cloudflare(ip)


def _open_reader(path: str):
    if _reader["db"] == path and _reader["obj"] is not None:
        return _reader["obj"]
    try:
        import geoip2.database   # optional package - never in requirements.txt
    except Exception:            # noqa: BLE001 - not installed: no location, no error
        return None
    try:
        obj = geoip2.database.Reader(path)
    except Exception:            # noqa: BLE001 - missing or unreadable file
        return None
    _reader["db"], _reader["obj"] = path, obj
    return obj


def _resolve(ip: str) -> str:
    path = os.getenv("NEXUS_GEOIP_DB", "").strip()
    if not path or not os.path.exists(path):
        return ""
    reader = _open_reader(path)
    if reader is None:
        return ""
    try:
        rec = reader.city(ip)
    except Exception:            # noqa: BLE001 - address not in the database
        return ""
    city = (getattr(getattr(rec, "city", None), "name", "") or "").strip()
    region = ""
    try:
        region = (rec.subdivisions.most_specific.iso_code or rec.subdivisions.most_specific.name or "").strip()
    except Exception:            # noqa: BLE001
        region = ""
    country = (getattr(getattr(rec, "country", None), "iso_code", "") or "").strip()
    return ", ".join(p for p in (city, region, country) if p)


def lookup(ip: str) -> str:
    """'City, Region, CC' for a public address when a GeoLite2 database is
    configured and the `geoip2` package is installed; '' otherwise. Never raises."""
    ip = (ip or "").strip()
    if not ip or _skip(ip):
        return ""
    now = time.time()
    hit = _cache.get(ip)
    if hit and hit[1] > now:
        return hit[0]
    try:
        answer = _resolve(ip)
    except Exception:            # noqa: BLE001 - a lookup must never break a sign-in
        answer = ""
    if len(_cache) > 5000:
        _cache.clear()
    _cache[ip] = (answer, now + _DAY)
    return answer
