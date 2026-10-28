"""The caller's real IP address, for the rate limiter and the audit trail.

X-Forwarded-For is a list that every proxy APPENDS to, so only its right-hand
end was written by somebody we trust. The left-hand end is whatever the caller
sent: reading the FIRST hop (Sep 30 review) let anybody pick their own
rate-limit bucket and write any IP they liked into the audit log.

How requests reach the API:
  - Azure App Service's front end appends the address that opened the TCP
    connection to it, so the LAST hop is never the caller's own words.
  - The hosted app (dev + prod) calls the API through the Cloudflare Pages
    Function /api proxy (frontend/functions/api/[[path]].js), which sets
    X-Forwarded-For to the visitor address Cloudflare gave IT, so the request
    reaches Azure from a Cloudflare address carrying the real visitor.
  - Anything else (curl at the azurewebsites.net origin, a local dev server)
    arrives directly.

So: walk X-Forwarded-For from the right, skipping Cloudflare addresses (the
proxies we trust); the first other address is the caller. When the hop that
reached Azure is Cloudflare, CF-Connecting-IP - set by Cloudflare, not by the
caller - is preferred, unless it is itself a Cloudflare address (a Worker's
subrequest can carry Cloudflare's own Worker address there). No header at all:
the socket peer.

Cloudflare's ranges are https://www.cloudflare.com/ips/ (they change rarely;
NEXUS_CLOUDFLARE_IPS, comma-separated CIDRs, replaces the built-in list).

The edge secret (release review, Oct 27 2026): a Cloudflare address is not
proof the request came through OUR Pages Functions - anybody can run a Worker
that sets X-Forwarded-For / CF-Connecting-IP to any value. So when
NEXUS_EDGE_SECRET is set, the forwarded headers are believed only on a request
carrying X-Nexus-Edge with that value (functions/api and functions/careers send
it from the Pages env var of the same name; compared in constant time). Without
it the caller is the direct peer: the last X-Forwarded-For hop, which Azure's
front end wrote, else the socket. NEXUS_EDGE_SECRET unset keeps the old rule
(logged once) so nothing changes before the secret is configured on both sides.

rate_key() is what the per-IP limiters count on: an IPv6 address is keyed on
its /64 (one subscriber's whole allocation), so rotating through the 2^64
addresses a home line gets does not buy a fresh bucket each time.
"""
import hmac
import ipaddress
import os
from functools import lru_cache

EDGE_HEADER = "x-nexus-edge"
_warned = {"unset": False}

_CLOUDFLARE_DEFAULT = (
    "173.245.48.0/20,103.21.244.0/22,103.22.200.0/22,103.31.4.0/22,141.101.64.0/18,"
    "108.162.192.0/18,190.93.240.0/20,188.114.96.0/20,197.234.240.0/22,198.41.128.0/17,"
    "162.158.0.0/15,104.16.0.0/13,104.24.0.0/14,172.64.0.0/13,131.0.72.0/22,"
    "2400:cb00::/32,2606:4700::/32,2803:f800::/32,2405:b500::/32,2405:8100::/32,"
    "2a06:98c0::/29,2c0f:f248::/32"
)


@lru_cache(maxsize=4)
def _networks(raw: str) -> tuple:
    nets = []
    for part in raw.split(","):
        part = part.strip()
        if part:
            try:
                nets.append(ipaddress.ip_network(part, strict=False))
            except ValueError:
                pass
    return tuple(nets)


def _cloudflare_networks() -> tuple:
    return _networks(os.getenv("NEXUS_CLOUDFLARE_IPS", "").strip() or _CLOUDFLARE_DEFAULT)


def strip_port(addr: str) -> str:
    """Azure writes the client port into X-Forwarded-For ('1.2.3.4:56789',
    '[2001:db8::1]:443'); the address is what is wanted."""
    addr = (addr or "").strip()
    if addr.startswith("["):                      # bracketed IPv6
        return addr.split("]")[0].lstrip("[")
    if addr.count(":") == 1:                      # IPv4:port (bare IPv6 has 2+)
        return addr.split(":")[0]
    return addr


def is_cloudflare(addr: str) -> bool:
    try:
        ip = ipaddress.ip_address(strip_port(addr))
    except ValueError:
        return False
    return any(ip in net for net in _cloudflare_networks())


def _edge_trusted(request) -> bool:
    """Did this request come through our own Pages Functions? None = no
    secret configured (the old rule applies)."""
    secret = os.getenv("NEXUS_EDGE_SECRET", "").strip()
    if not secret:
        if not _warned["unset"]:
            _warned["unset"] = True
            print("[client_ip] NEXUS_EDGE_SECRET is not set - forwarded IP headers are trusted from any "
                  "Cloudflare address; set it on the API and the Pages project")
        return None
    got = (request.headers.get(EDGE_HEADER) or "").strip()
    return bool(got) and hmac.compare_digest(got.encode(), secret.encode())


def client_ip(request) -> str:
    """The best address we can vouch for (see the module docstring)."""
    hops = [strip_port(h) for h in (request.headers.get("x-forwarded-for") or "").split(",") if h.strip()]
    if not hops:
        return request.client.host if request.client else ""
    if _edge_trusted(request) is False:
        # Not from our edge: only the hop Azure's front end appended is ours.
        return hops[-1]
    if is_cloudflare(hops[-1]):
        cf = strip_port(request.headers.get("cf-connecting-ip") or "")
        if cf and _is_ip(cf) and not is_cloudflare(cf):
            return cf
    for hop in reversed(hops):
        if not is_cloudflare(hop):
            return hop
    return hops[0]


def _is_ip(addr: str) -> bool:
    try:
        ipaddress.ip_address(addr)
        return True
    except ValueError:
        return False


def rate_key(ip: str) -> str:
    """The per-IP limiters' bucket for an address: IPv4 as is, IPv6 by its
    /64 network (see the module docstring)."""
    ip = strip_port(ip or "")
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if addr.version == 6:
        if addr.ipv4_mapped:
            return str(addr.ipv4_mapped)
        return str(ipaddress.ip_network(f"{addr}/64", strict=False))
    return ip
