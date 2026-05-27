import os
import asyncio
import httpx
from fastapi import HTTPException
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

API_KEY = os.getenv("UNIFI_API_KEY", "")
BASE_URL = os.getenv("UNIFI_BASE_URL", "https://api.ui.com")

HEADERS = {
    "X-API-KEY": API_KEY,
    "Accept": "application/json",
}


async def unifi_get(path: str):
    url = f"{BASE_URL}{path}"
    async with httpx.AsyncClient(verify=False, timeout=15) as client:
        r = await client.get(url, headers=HEADERS)
    if r.status_code == 401:
        raise HTTPException(401, "Invalid UniFi API key")
    if r.status_code == 403:
        raise HTTPException(403, "Forbidden — check UniFi API key permissions")
    if not r.is_success:
        raise HTTPException(r.status_code, r.text)
    return r.json()


async def fetch_all():
    return await asyncio.gather(
        unifi_get("/v1/sites?pageSize=50"),
        unifi_get("/v1/devices"),
    )


def best_wan_uptime(stats: dict) -> float:
    wans = stats.get("wans", {})
    uptimes = [v.get("wanUptime", 0) for v in wans.values()]
    active = [u for u in uptimes if u > 0]
    return round(max(active), 1) if active else 0.0


def build_site_payload(site: dict, host_entry: dict) -> dict:
    site_id = site.get("siteId", "")
    host_id = site.get("hostId", "")
    name = host_entry.get("hostName") or site.get("meta", {}).get("desc") or site_id
    stats = site.get("statistics", {})
    counts = stats.get("counts", {})
    devices = host_entry.get("devices", [])

    offline_devices = [d for d in devices if d.get("status") != "online"]
    outdated_devices = [
        d for d in devices
        if d.get("firmwareStatus") not in ("upToDate", "", None)
    ]

    return {
        "siteId": site_id,
        "hostId": host_id,
        "name": name,
        "total_devices": len(devices) or counts.get("totalDevice", 0),
        "online_devices": len(devices) - len(offline_devices),
        "offline_devices": [
            {"name": d.get("name", d.get("mac", "?")), "model": d.get("model", ""), "mac": d.get("mac", "")}
            for d in offline_devices
        ],
        "outdated_devices": [
            {"name": d.get("name", d.get("mac", "?")), "model": d.get("model", ""), "version": d.get("version", ""), "firmwareStatus": d.get("firmwareStatus", "")}
            for d in outdated_devices
        ],
        "wifi_clients": counts.get("wifiClient", 0),
        "wired_clients": counts.get("wiredClient", 0),
        "wan_uptime": best_wan_uptime(stats),
        "has_internet_issues": len(stats.get("internetIssues", [])) > 0,
        "critical_notifications": counts.get("criticalNotification", 0),
    }
