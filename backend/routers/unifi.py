import csv
import io
import re
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from unifi_client import fetch_all, build_site_payload

router = APIRouter(prefix="/unifi", tags=["UniFi Network"])


@router.get("/overview")
async def unifi_overview():
    sites_raw, devices_raw = await fetch_all()
    host_map = {e["hostId"]: e for e in devices_raw.get("data", [])}
    result = [
        build_site_payload(s, host_map.get(s.get("hostId", ""), {}))
        for s in sites_raw.get("data", [])
    ]
    return {"data": result}


@router.get("/stats")
async def unifi_stats(siteId: str):
    sites_raw, devices_raw = await fetch_all()
    site = next((s for s in sites_raw.get("data", []) if s.get("siteId") == siteId), None)
    if not site:
        raise HTTPException(404, f"Site {siteId} not found")
    host_id = site.get("hostId", "")
    host_entry = next((e for e in devices_raw.get("data", []) if e.get("hostId") == host_id), {})
    payload = build_site_payload(site, host_entry)
    devices = host_entry.get("devices", [])
    return {
        "total_devices": payload["total_devices"],
        "online_devices": payload["online_devices"],
        "offline_devices": len(payload["offline_devices"]),
        "total_clients": payload["wifi_clients"] + payload["wired_clients"],
        "wireless_clients": payload["wifi_clients"],
        "wired_clients": payload["wired_clients"],
        "devices": devices,
    }


@router.get("/export/csv")
async def unifi_export_csv(siteId: str):
    sites_raw, devices_raw = await fetch_all()
    site = next((s for s in sites_raw.get("data", []) if s.get("siteId") == siteId), None)
    if not site:
        raise HTTPException(404, f"Site {siteId} not found")
    host_id = site.get("hostId", "")
    host_entry = next((e for e in devices_raw.get("data", []) if e.get("hostId") == host_id), {})
    site_name = host_entry.get("hostName") or site.get("meta", {}).get("desc") or siteId
    devices = host_entry.get("devices", [])
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Site", "Name", "Model", "MAC Address", "IP Address", "Status", "Firmware Version", "Firmware Status", "Product Line", "Is Console", "Startup Time", "Adoption Time"])
    for d in devices:
        writer.writerow([site_name, d.get("name", ""), d.get("model", ""), d.get("mac", ""), d.get("ip", ""), d.get("status", ""), d.get("version", ""), d.get("firmwareStatus", ""), d.get("productLine", ""), "Yes" if d.get("isConsole") else "No", d.get("startupTime", ""), d.get("adoptionTime", "")])
    safe_name = re.sub(r"[^a-zA-Z0-9_-]", "_", site_name)
    output.seek(0)
    return StreamingResponse(iter([output.getvalue()]), media_type="text/csv", headers={"Content-Disposition": f"attachment; filename={safe_name}_inventory.csv"})
