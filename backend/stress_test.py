"""
Greens Nexus — Stress Test
Usage:
    python stress_test.py --token "eyJ0..." --url "https://greens-nexus-api-dev-..."
    python stress_test.py --token "eyJ0..."          # uses default dev URL
    python stress_test.py --token "eyJ0..." --users 200 --duration 30

Grab your token from browser DevTools:
    1. Open dev.nexus.greensglobal.com → DevTools (F12) → Network
    2. Click any API request → Headers → Authorization → copy everything after "Bearer "
"""

import asyncio
import argparse
import time
import statistics
import sys
from collections import defaultdict

try:
    import httpx
except ImportError:
    print("Installing httpx...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "httpx"])
    import httpx

DEFAULT_URL = "https://greens-nexus-api-dev-a6fad4brawevg8de.westus2-01.azurewebsites.net"

# Endpoints to hit — realistic mix of what employees/managers do
ENDPOINTS = [
    ("GET",  "/roles/me",               "My role",              1.0),   # every user on load
    ("GET",  "/requisitions",           "List requisitions",    0.8),
    ("GET",  "/inventory-requests",     "List inv. requests",   0.7),
    ("GET",  "/notifications",          "Get notifications",    0.6),
    ("GET",  "/hardware-assets",        "List hardware assets", 0.4),
    ("GET",  "/tasks",                  "List tasks",           0.3),
    ("GET",  "/dashboard/summary",      "Dashboard summary",    0.5),
    ("GET",  "/reviews",                "List reviews",         0.2),
]

results   = defaultdict(list)   # label → list of response times (ms)
errors    = defaultdict(int)    # label → error count
statuses  = defaultdict(int)    # status_code → count
total_req = 0
stop_flag = False


async def hit(client: httpx.AsyncClient, method: str, url: str, label: str):
    global total_req
    t0 = time.perf_counter()
    try:
        if method == "GET":
            r = await client.get(url, timeout=10.0)
        else:
            r = await client.post(url, timeout=10.0)
        elapsed = (time.perf_counter() - t0) * 1000
        results[label].append(elapsed)
        statuses[r.status_code] += 1
        total_req += 1
        if r.status_code >= 500:
            errors[label] += 1
    except Exception as e:
        elapsed = (time.perf_counter() - t0) * 1000
        errors[label] += 1
        statuses["timeout/err"] += 1
        total_req += 1


async def virtual_user(base_url: str, token: str, user_id: int, duration: int):
    """Simulates one concurrent user for `duration` seconds."""
    import random
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type":  "application/json",
    }
    async with httpx.AsyncClient(headers=headers, base_url=base_url) as client:
        deadline = time.time() + duration
        while time.time() < deadline and not stop_flag:
            # Pick an endpoint weighted by its usage probability
            weights   = [e[3] for e in ENDPOINTS]
            total_w   = sum(weights)
            rand      = random.uniform(0, total_w)
            cumulative = 0
            chosen    = ENDPOINTS[0]
            for ep in ENDPOINTS:
                cumulative += ep[3]
                if rand <= cumulative:
                    chosen = ep
                    break

            method, path, label, _ = chosen
            await hit(client, method, base_url + path, label)

            # Think time: 0.5–2s between requests (realistic user)
            await asyncio.sleep(random.uniform(0.5, 2.0))


def print_results(n_users: int, duration: int, elapsed: float):
    print("\n" + "═" * 65)
    print(f"  STRESS TEST RESULTS — {n_users} concurrent users × {duration}s")
    print("═" * 65)
    print(f"\n  Total requests : {total_req}")
    print(f"  Duration       : {elapsed:.1f}s")
    print(f"  Throughput     : {total_req / elapsed:.1f} req/s\n")

    print(f"  {'Endpoint':<28} {'Req':>5} {'Err':>5} {'P50 ms':>8} {'P95 ms':>8} {'Max ms':>8}")
    print("  " + "─" * 63)

    all_times = []
    total_errors = 0
    for method, path, label, _ in ENDPOINTS:
        times = results[label]
        errs  = errors[label]
        total_errors += errs
        all_times.extend(times)
        if not times:
            print(f"  {label:<28} {'0':>5} {'—':>5} {'—':>8} {'—':>8} {'—':>8}")
            continue
        times_sorted = sorted(times)
        p50 = statistics.median(times_sorted)
        p95 = times_sorted[int(len(times_sorted) * 0.95)]
        mx  = max(times_sorted)
        err_str = f"{errs}" if errs == 0 else f"⚠ {errs}"
        print(f"  {label:<28} {len(times):>5} {err_str:>5} {p50:>7.0f}  {p95:>7.0f}  {mx:>7.0f}")

    if all_times:
        all_sorted = sorted(all_times)
        p50_all = statistics.median(all_sorted)
        p95_all = all_sorted[int(len(all_sorted) * 0.95)]
        p99_all = all_sorted[int(len(all_sorted) * 0.99)]
        print("  " + "─" * 63)
        print(f"  {'OVERALL':<28} {total_req:>5} {total_errors:>5} {p50_all:>7.0f}  {p95_all:>7.0f}  {max(all_sorted):>7.0f}")
        print(f"\n  P99 response time: {p99_all:.0f} ms")

    print(f"\n  HTTP status breakdown:")
    for code, count in sorted(statuses.items(), key=lambda kv: str(kv[0])):
        icon = "✅" if str(code).startswith("2") else ("⚠️" if str(code).startswith("4") else "❌")
        print(f"    {icon} {code}: {count} requests")

    print("\n  VERDICT:")
    if all_times:
        p95_all = sorted(all_times)[int(len(all_times) * 0.95)]
        error_rate = total_errors / max(total_req, 1) * 100
        if p95_all < 500 and error_rate < 1:
            print(f"  ✅ PASS — P95 {p95_all:.0f}ms, error rate {error_rate:.1f}%")
            print(f"     App handles {n_users} concurrent users comfortably.")
        elif p95_all < 1500 and error_rate < 5:
            print(f"  ⚠️  BORDERLINE — P95 {p95_all:.0f}ms, error rate {error_rate:.1f}%")
            print(f"     App survives {n_users} users but latency is elevated.")
        else:
            print(f"  ❌ FAIL — P95 {p95_all:.0f}ms, error rate {error_rate:.1f}%")
            print(f"     App is struggling under {n_users} concurrent users.")
    print("═" * 65 + "\n")


async def run(base_url: str, token: str, n_users: int, duration: int):
    print(f"\n  🚀 Starting stress test")
    print(f"     Target   : {base_url}")
    print(f"     Users    : {n_users} concurrent")
    print(f"     Duration : {duration}s")
    print(f"     Ramp-up  : all users start simultaneously\n")

    # Quick connectivity check
    try:
        async with httpx.AsyncClient() as c:
            r = await c.get(base_url + "/", timeout=5.0)
            print(f"  ✅ API reachable (status {r.status_code})")
    except Exception as e:
        print(f"  ❌ Cannot reach API: {e}")
        return

    t0 = time.time()
    tasks = [
        asyncio.create_task(virtual_user(base_url, token, i, duration))
        for i in range(n_users)
    ]

    # Progress ticker
    async def ticker():
        while True:
            await asyncio.sleep(5)
            elapsed = time.time() - t0
            if elapsed >= duration:
                break
            rps = total_req / elapsed if elapsed > 0 else 0
            print(f"  [{elapsed:>4.0f}s] {total_req} requests  {rps:.1f} req/s", flush=True)

    await asyncio.gather(*tasks, asyncio.create_task(ticker()))
    elapsed = time.time() - t0
    print_results(n_users, duration, elapsed)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Greens Nexus stress test")
    parser.add_argument("--token",    required=True, help="Azure AD JWT token (Bearer value)")
    parser.add_argument("--url",      default=DEFAULT_URL, help="API base URL")
    parser.add_argument("--users",    type=int, default=50,  help="Concurrent virtual users (default 50)")
    parser.add_argument("--duration", type=int, default=30,  help="Test duration in seconds (default 30)")
    args = parser.parse_args()

    token = args.token.replace("Bearer ", "").strip()
    asyncio.run(run(args.url, token, args.users, args.duration))
