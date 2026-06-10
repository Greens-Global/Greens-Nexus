"""
Standalone test: does UniFi cloud credential login expose port_table?
Run with: python test_unifi_cloud.py

Set env vars before running:
  UNIFI_USERNAME=your@email.com
  UNIFI_PASSWORD=yourpassword
  UNIFI_HOST_ID=<hostId from existing API>  (optional, uses first found)
"""
import os, json, httpx, asyncio
from dotenv import load_dotenv

load_dotenv()

USERNAME  = os.getenv("UNIFI_USERNAME", "")
PASSWORD  = os.getenv("UNIFI_PASSWORD", "")
API_KEY   = os.getenv("UNIFI_API_KEY", "")

if not USERNAME or not PASSWORD:
    print("Set UNIFI_USERNAME and UNIFI_PASSWORD in backend/.env first.")
    exit(1)


async def main():
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as c:

        # ── Step 1: login to account.ui.com ──────────────────────────────
        print("\n[1] Logging in to account.ui.com ...")
        r = await c.post(
            "https://account.ui.com/api/auth/login",
            json={"username": USERNAME, "password": PASSWORD, "rememberMe": True},
            headers={"Content-Type": "application/json"}
        )
        print(f"    Status: {r.status_code}")
        if r.status_code not in (200, 201):
            print(f"    Error: {r.text[:300]}")
            return

        # Token is either in JSON body or cookie
        token = r.cookies.get("TOKEN") or r.cookies.get("token") or ""
        try:
            body = r.json()
            token = token or body.get("token", "")
            print(f"    User: {body.get('email') or body.get('username','?')}")
        except Exception:
            pass
        print(f"    Token obtained: {'YES' if token else 'NO (check cookie names below)'}")
        print(f"    Cookies: {dict(r.cookies)}")

        if not token:
            # Try cookie from headers directly
            set_cookie = r.headers.get("set-cookie", "")
            print(f"    set-cookie header: {set_cookie[:200]}")
            return

        auth_headers = {"Cookie": f"TOKEN={token}", "X-Csrf-Token": token}

        # ── Step 2: get list of consoles/hosts ───────────────────────────
        print("\n[2] Fetching consoles ...")
        r2 = await c.get(
            "https://api.ui.com/v1/hosts?pageSize=50",
            headers={"X-API-KEY": API_KEY}
        )
        hosts = r2.json().get("data", []) if r2.status_code == 200 else []
        if not hosts:
            print("    No hosts via API key — trying cloud endpoint ...")
            r2b = await c.get("https://account.ui.com/api/consoles", headers=auth_headers)
            print(f"    Status: {r2b.status_code}  body: {r2b.text[:200]}")
            return

        host = hosts[0]
        host_id = host.get("id", "")
        host_name = host.get("reportedState", {}).get("hostname", host_id[:16])
        print(f"    Using host: {host_name}  id: {host_id[:24]}...")

        # ── Step 3: try cloud proxy endpoints ────────────────────────────
        base_proxy = f"https://unifi.ui.com/proxy/network"
        # Also try the console-specific proxy
        console_proxy = f"https://unifi.ui.com/consoles/{host_id}/proxy/network"

        endpoints_to_try = [
            (base_proxy,    "/api/s/default/stat/device"),
            (console_proxy, "/api/s/default/stat/device"),
            (console_proxy, "/api/s/default/stat/sta"),
            (console_proxy, "/api/self"),
        ]

        for base, path in endpoints_to_try:
            url = base + path
            print(f"\n[3] GET {url[:80]}...")
            try:
                r3 = await c.get(url, headers=auth_headers)
                print(f"    Status: {r3.status_code}")
                if r3.status_code == 200:
                    data = r3.json()
                    items = data.get("data", data) if isinstance(data, dict) else data
                    if isinstance(items, list) and items:
                        first = items[0]
                        has_port_table = "port_table" in first
                        print(f"    Items: {len(items)}  has_port_table: {has_port_table}")
                        if has_port_table:
                            print(f"    ✅ PORT TABLE FOUND! First device port count: {len(first['port_table'])}")
                            print(json.dumps(first["port_table"][0], indent=2))
                        else:
                            print(f"    Keys on first item: {list(first.keys())[:10]}")
                    else:
                        print(f"    Response: {str(data)[:200]}")
                else:
                    print(f"    Body: {r3.text[:150]}")
            except Exception as e:
                print(f"    Exception: {e}")

        print("\n[done]")


asyncio.run(main())
