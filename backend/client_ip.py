"""The caller's real IP address, for the rate limiter and the audit trail.

X-Forwarded-For is a list that every proxy APPENDS to, so only its right-hand
end was written by somebody we trust. The left-hand end is whatever the caller
sent: reading the FIRST hop (Sep 30 review) let anybody pick their own
rate-limit bucket and write any IP they liked into the audit log.

Deployment: Azure App Service. Its front end appends the address of whoever
opened the TCP connection to it, so the LAST hop is trustworthy - that is the
client, or Cloudflare when the request came through Cloudflare. Only in that
second case is CF-Connecting-IP believed: Cloudflare overwrites that header
with the visitor's address, but a caller who reaches the Azure origin directly
can send any CF-Connecting-IP they like, so it counts only when the hop that
reached Azure really is a Cloudflare address. Locally (no proxy) it is the
socket peer.

Cloudflare's ranges are https://www.cloudflare.com/ips/ (they change rarely;
NEXUS_CLOUDFLARE_IPS, comma-separated CIDRs, replaces the built-in list).
"""
import ipaddress
import os
from functools import lru_cache

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


def client_ip(request) -> str:
    """The best address we can vouch for (see the module docstring)."""
    hops = [h.strip() for h in (request.headers.get("x-forwarded-for") or "").split(",") if h.strip()]
    peer = strip_port(hops[-1]) if hops else (request.client.host if request.client else "")
    if peer and is_cloudflare(peer):
        cf = strip_port(request.headers.get("cf-connecting-ip") or "")
        if cf:
            return cf
    return peer
