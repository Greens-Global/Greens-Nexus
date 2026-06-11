import csv
import io
import re
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from unifi_client import fetch_all, build_site_payload
from auth import get_current_user, require_level

# Supervisor+ to match the IT module's UI gating — network topology and
# device exports are not for every authenticated employee. (UI gating alone
# is not security: anyone logged in could call the API directly.)
router = APIRouter(prefix="/unifi", tags=["UniFi Network"], dependencies=[Depends(get_current_user), Depends(require_level(2))])


def _build_maps(sites_raw, devices_raw, hosts_raw):
    host_map = {e["hostId"]: e for e in devices_raw.get("data", [])}
    detail_map = {h["id"]: h for h in hosts_raw.get("data", [])}
    return host_map, detail_map


@router.get("/overview")
async def unifi_overview():
    sites_raw, devices_raw, hosts_raw = await fetch_all()
    host_map, detail_map = _build_maps(sites_raw, devices_raw, hosts_raw)
    result = [
        build_site_payload(
            s,
            host_map.get(s.get("hostId", ""), {}),
            detail_map.get(s.get("hostId", ""), None),
        )
        for s in sites_raw.get("data", [])
    ]
    return {"data": result}


@router.get("/stats")
async def unifi_stats(siteId: str):
    sites_raw, devices_raw, hosts_raw = await fetch_all()
    site = next((s for s in sites_raw.get("data", []) if s.get("siteId") == siteId), None)
    if not site:
        raise HTTPException(404, f"Site {siteId} not found")
    host_map, detail_map = _build_maps(sites_raw, devices_raw, hosts_raw)
    host_id = site.get("hostId", "")
    host_entry = host_map.get(host_id, {})
    host_detail = detail_map.get(host_id, None)
    payload = build_site_payload(site, host_entry, host_detail)
    return {
        **payload,
        "devices": host_entry.get("devices", []),
    }


@router.get("/export/csv")
async def unifi_export_csv(siteId: str):
    sites_raw, devices_raw, hosts_raw = await fetch_all()
    site = next((s for s in sites_raw.get("data", []) if s.get("siteId") == siteId), None)
    if not site:
        raise HTTPException(404, f"Site {siteId} not found")
    host_map, _ = _build_maps(sites_raw, devices_raw, hosts_raw)
    host_id = site.get("hostId", "")
    host_entry = host_map.get(host_id, {})
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


