"""Weather for the dashboard's Weather widget (Neil, Sep 29 2026).

Forecasts come from Open-Meteo (free, no key, no account) and city search
from its geocoding API; a place name for "my location" from OpenStreetMap's
Nominatim. Everything goes through here rather than from the browser, so:
  - coordinates are rounded to 2 decimals (~1 km) before they leave Nexus -
    a forecast needs no more, and a person's exact position never does;
  - nothing about the caller is stored or logged;
  - one cached answer serves everyone in the same ~1 km cell for 10 minutes,
    which keeps us far inside both providers' fair-use limits.

The routes are plain `def` (FastAPI runs them in its thread pool), so the
outbound HTTP never blocks the event loop - see CLAUDE.md.
"""
import threading
import time
from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from auth import get_current_user

router = APIRouter(prefix="/weather", tags=["weather"])

_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
_GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse"
# Nominatim's policy asks for an identifying User-Agent.
_UA = {"User-Agent": "GreensNexus/1.0 (https://nexus.greensglobal.com)"}
_FORECAST_TTL = 10 * 60
_NAME_TTL = 24 * 3600
_SEARCH_TTL = 6 * 3600
_TIMEOUT = 8.0
UNAVAILABLE = "Weather is unavailable right now - try again in a few minutes."

_cache: dict = {}
_lock = threading.Lock()


def _cached(key, ttl: int, fetch):
    now = time.time()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    value = fetch()
    with _lock:
        if len(_cache) > 2000:   # a bounded memo, not a store
            _cache.clear()
        _cache[key] = (now, value)
    return value


def _coords(lat: float, lon: float) -> tuple:
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise HTTPException(400, "That location is not valid.")
    return round(lat, 2), round(lon, 2)


def _get(url: str, params: dict, headers: dict = None) -> dict:
    try:
        r = httpx.get(url, params=params, headers=headers, timeout=_TIMEOUT)
        r.raise_for_status()
        return r.json()
    except (httpx.HTTPError, ValueError):
        raise HTTPException(502, UNAVAILABLE)


def _shape(raw: dict, units: str) -> dict:
    """Open-Meteo's column arrays -> the widget's rows."""
    cur, hourly, daily = raw.get("current") or {}, raw.get("hourly") or {}, raw.get("daily") or {}
    now_hour = (cur.get("time") or "")[:13]   # "2026-09-29T19"
    times = hourly.get("time") or []
    start = next((i for i, t in enumerate(times) if t[:13] >= now_hour), 0)
    hours = [{"time": times[i], "temp": hourly["temperature_2m"][i], "code": hourly["weather_code"][i],
              "isDay": bool(hourly["is_day"][i]), "precipChance": hourly["precipitation_probability"][i]}
             for i in range(start, min(start + 12, len(times)))]
    days = [{"date": d, "high": daily["temperature_2m_max"][i], "low": daily["temperature_2m_min"][i],
             "code": daily["weather_code"][i], "precipChance": daily["precipitation_probability_max"][i]}
            for i, d in enumerate(daily.get("time") or [])]
    def first(k):
        return (daily.get(k) or [None])[0]

    metric = units == "metric"
    return {
        "timezone": raw.get("timezone") or "",
        "units": {"temp": "°C" if metric else "°F", "wind": "km/h" if metric else "mph",
                  "precip": "mm" if metric else "in"},
        "current": {"time": cur.get("time"), "temp": cur.get("temperature_2m"),
                    "feelsLike": cur.get("apparent_temperature"), "humidity": cur.get("relative_humidity_2m"),
                    "isDay": bool(cur.get("is_day")), "precip": cur.get("precipitation"),
                    "code": cur.get("weather_code"), "wind": cur.get("wind_speed_10m"),
                    "windDir": cur.get("wind_direction_10m")},
        "today": {"high": first("temperature_2m_max"), "low": first("temperature_2m_min"),
                  "precipChance": first("precipitation_probability_max"), "uvMax": first("uv_index_max"),
                  "sunrise": first("sunrise"), "sunset": first("sunset")},
        "hourly": hours,
        "daily": days,
        "fetchedAt": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


@router.get("")
def forecast(lat: float, lon: float, units: str = Query("imperial", pattern="^(imperial|metric)$"),
             user: dict = Depends(get_current_user)):
    """Current conditions, the next 12 hours and 7 days, in the location's
    own time zone."""
    la, lo = _coords(lat, lon)
    metric = units == "metric"
    params = {
        "latitude": la, "longitude": lo, "timezone": "auto", "forecast_days": 7,
        "current": "temperature_2m,apparent_temperature,relative_humidity_2m,is_day,precipitation,"
                   "weather_code,wind_speed_10m,wind_direction_10m",
        "hourly": "temperature_2m,precipitation_probability,weather_code,is_day",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,"
                 "sunrise,sunset,uv_index_max",
        "temperature_unit": "celsius" if metric else "fahrenheit",
        "wind_speed_unit": "kmh" if metric else "mph",
        "precipitation_unit": "mm" if metric else "inch",
    }
    return _cached(("fc", la, lo, units), _FORECAST_TTL, lambda: _shape(_get(_FORECAST_URL, params), units))


@router.get("/places")
def places(q: str = Query(..., min_length=2, max_length=80), user: dict = Depends(get_current_user)):
    """City search for picking a location by hand."""
    q = q.strip()

    def fetch():
        raw = _get(_GEOCODE_URL, {"name": q, "count": 8, "language": "en", "format": "json"})
        return [{"name": r.get("name") or "", "region": r.get("admin1") or "", "country": r.get("country") or "",
                 "countryCode": r.get("country_code") or "", "lat": r.get("latitude"), "lon": r.get("longitude")}
                for r in raw.get("results") or [] if r.get("latitude") is not None]
    return {"places": _cached(("q", q.lower()), _SEARCH_TTL, fetch)}


@router.get("/place-name")
def place_name(lat: float, lon: float, user: dict = Depends(get_current_user)):
    """A readable name ("Escondido, CA") for the caller's own location. Best
    effort - a lookup failure returns an empty name, never an error, since
    the forecast itself does not need it."""
    la, lo = _coords(lat, lon)

    def fetch():
        try:
            raw = _get(_REVERSE_URL, {"lat": la, "lon": lo, "format": "jsonv2", "zoom": 10,
                                      "addressdetails": 1, "accept-language": "en"}, headers=_UA)
        except HTTPException:
            return ""
        a = raw.get("address") or {}
        city = a.get("city") or a.get("town") or a.get("village") or a.get("hamlet") or a.get("county") or ""
        region = a.get("state") or ""
        if (a.get("country_code") or "").lower() == "us":
            code = (a.get("ISO3166-2-lvl4") or "").split("-")[-1]
            region = code or region
        else:
            region = region or a.get("country") or ""
        return ", ".join(x for x in (city, region) if x)
    return {"name": _cached(("name", la, lo), _NAME_TTL, fetch)}
