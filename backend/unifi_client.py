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
    async with httpx.AsyncClient(timeout=15) as client:
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
        unifi_get("/v1/hosts?pageSize=50"),
    )


def best_wan_uptime(stats: dict) -> float:
    wans = stats.get("wans", {})
    uptimes = [v.get("wanUptime", 0) for v in wans.values()]
    active = [u for u in uptimes if u > 0]
    return round(max(active), 1) if active else 0.0


def build_site_payload(site: dict, host_entry: dict, host_detail: dict = None) -> dict:
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

    # Per-WAN uptime + issues
    wans_raw = stats.get("wans", {})
    wans = {
        k: {
            "uptime": v.get("wanUptime", 0),
            "issues": v.get("wanIssues", []),
            "external_ip": v.get("externalIp", ""),
        }
        for k, v in wans_raw.items()
    }

    # ISP + quality metrics
    isp = stats.get("ispInfo", {})
    percentages = stats.get("percentages", {})

    # From hosts endpoint (reportedState)
    internet_issues_5min = []
    wan_ports = []
    location = {}
    firmware_version = ""
    direct_connect_domain = ""

    if host_detail:
        reported = host_detail.get("reportedState", {})
        internet_issues_5min = reported.get("internetIssues5min", {}).get("periods", [])
        raw_wans = reported.get("wans", [])
        if isinstance(raw_wans, list):
            wan_ports = [
                {
                    "type": w.get("type", ""),
                    "plugged": w.get("plugged", False),
                    "ip": w.get("ipv4", ""),
                    "speed": w.get("speedType", ""),
                    "interface": w.get("interface", ""),
                }
                for w in raw_wans
            ]
        location = reported.get("location", {})
        firmware_version = reported.get("hardware", {}).get("firmwareVersion", "")
        direct_connect_domain = reported.get("directConnectDomain", "")

    return {
        "siteId": site_id,
        "hostId": host_id,
        "name": name,
        # devices
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
        # clients
        "wifi_clients": counts.get("wifiClient", 0),
        "wired_clients": counts.get("wiredClient", 0),
        # WAN
        "wan_uptime": best_wan_uptime(stats),
        "wans": wans,
        "wan_ports": wan_ports,
        # internet issues
        "has_internet_issues": len(stats.get("internetIssues", [])) > 0,
        "internet_issues": stats.get("internetIssues", []),
        "internet_issues_5min": internet_issues_5min,
        # counts
        "critical_notifications": counts.get("criticalNotification", 0),
        "offline_wired_devices": counts.get("offlineWiredDevice", 0),
        "offline_wifi_devices": counts.get("offlineWifiDevice", 0),
        "pending_updates": counts.get("pendingUpdateDevice", 0),
        "total_wired_devices": counts.get("wiredDevice", 0),
        "total_wifi_devices": counts.get("wifiDevice", 0),
        # quality
        "tx_retry_pct": round(percentages.get("txRetry", 0), 1),
        # ISP
        "isp_name": isp.get("name", ""),
        "isp_asn": isp.get("asn", 0),
        # location / hardware
        "location": location,
        "firmware_version": firmware_version,
        "direct_connect_domain": direct_connect_domain,
    }
