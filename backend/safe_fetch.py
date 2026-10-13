"""Server-side fetches of a URL somebody else chose (code review, Oct 2026).

Three features download an image from a URL the server did not write: the
document export (a `src` in the document's stored JSON), the QA workbook (an
evidence URL on a result) and the AI auto-photo (a URL a model returned, plus
the og:image its page points at). Each used a bare httpx.get, so any of them
could be aimed at 169.254.169.254, localhost or a private range and made to
read an internal service back out (server-side request forgery). The rule
lives here, once:

  * http / https only;
  * the host must resolve ONLY to public addresses - checked on EVERY hop,
    because redirects are followed by hand (never follow_redirects=True: httpx
    would walk a public URL's 302 straight into the private range);
  * a small hop limit, a size cap enforced WHILE streaming, a total deadline;
  * TLS verification always on.

Two modes, picked by the caller:

  fetch(url)                       any public host (AI auto-photo, link preview)
  fetch(url, only_prefixes=(...))  only URLs under prefixes this deployment
                                   configured itself - its own Supabase storage,
                                   its own frontend. Nothing else is requested
                                   at all, redirects included.

DNS rebinding: checking a name and then letting the HTTP client resolve it
again leaves a window in which the answer can change to a private address. In
the public mode the connection is therefore PINNED to the address that was
checked - the request goes to that IP, with the real name in the Host header
and in the TLS SNI / certificate check (httpx's `sni_hostname` extension).
That holds for a direct connection; behind an outbound HTTP proxy
(HTTPS_PROXY) the proxy is what connects, so there the pin is only as good as
the proxy. The prefix mode does not resolve or pin: the host comes from this
deployment's own settings (SUPABASE_URL, NEXUS_APP_URL), not from the caller.

Everything here is blocking (DNS + network). Call it from a sync endpoint or a
worker thread, never straight from the event loop.
"""
import ipaddress
import os
import socket
import time
from urllib.parse import urljoin

import httpx

MAX_IMAGE_BYTES = 15 * 1024 * 1024   # the upload widgets cap far below this; a photo never needs more
MAX_HOPS = 4                         # redirects followed before giving up
_REDIRECTS = (301, 302, 303, 307, 308)


class FetchRefused(Exception):
    """The URL (or a redirect on the way) is not one the server may fetch, or
    the response broke a limit. Never a network error - those stay httpx's."""


class Fetched:
    """What came back: the final URL as written (not the pinned IP form), the
    status, the headers and the whole body, already under the size cap."""
    __slots__ = ("url", "status_code", "headers", "content")

    def __init__(self, url, status_code, headers, content):
        self.url, self.status_code, self.headers, self.content = url, status_code, headers, content

    @property
    def content_type(self) -> str:
        return self.headers.get("content-type", "").split(";")[0].strip().lower()

    @property
    def text(self) -> str:
        charset = httpx.Response(200, headers={"content-type": self.headers.get("content-type", "")}).charset_encoding
        try:
            return self.content.decode(charset or "utf-8", errors="replace")
        except LookupError:
            return self.content.decode("utf-8", errors="replace")


def public_addresses(hostname: str) -> list:
    """Every address `hostname` resolves to, IPv4 first - or [] when it does
    not resolve or ANY of them is not public (RFC1918, loopback, link-local
    incl. the 169.254.169.254 cloud metadata endpoint, IPv6 ::1 / fc00::/7 /
    fe80::/10, carrier-grade NAT...). ip.is_global is False for all of those.
    One private answer among public ones refuses the lot: which one the
    connection would land on is the attacker's choice, not ours."""
    try:
        infos = socket.getaddrinfo(hostname, None)
    except (socket.gaierror, UnicodeError):
        return []
    out = []
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0].split("%", 1)[0])
        except ValueError:
            return []
        mapped = getattr(ip, "ipv4_mapped", None)   # ::ffff:10.0.0.1 is 10.0.0.1
        if not (mapped or ip).is_global:
            return []
        if str(ip) not in out:
            out.append(str(ip))
    return sorted(out, key=lambda a: ":" in a)


def resolves_to_public_ip(hostname: str) -> bool:
    return bool(public_addresses(hostname))


def _new_client(timeout: float) -> httpx.Client:
    # One place builds the client, so the tests can swap in a MockTransport.
    return httpx.Client(timeout=timeout, follow_redirects=False)


def fetch(url: str, *, headers: dict = None, timeout: float = 10.0,
          max_bytes: int = MAX_IMAGE_BYTES, max_hops: int = MAX_HOPS,
          only_prefixes: tuple = None) -> Fetched:
    """GET `url` under the rules in the module docstring. Returns the final
    response whatever its status (the caller decides what a 404 means); raises
    FetchRefused for a URL / redirect / size it will not take and httpx's own
    errors for the network."""
    deadline = time.monotonic() + timeout * 3
    with _new_client(timeout) as client:
        for _hop in range(max_hops + 1):
            try:
                parsed = httpx.URL(url)
            except (httpx.InvalidURL, TypeError) as e:
                raise FetchRefused(f"not a URL: {e}") from None
            if parsed.scheme not in ("http", "https") or not parsed.host:
                raise FetchRefused("only http and https URLs are fetched")
            send_headers, extensions, target = dict(headers or {}), {}, parsed
            if only_prefixes is not None:
                if not url.startswith(tuple(only_prefixes)):
                    raise FetchRefused("not one of this deployment's own URLs")
            else:
                addresses = public_addresses(parsed.host)
                if not addresses:
                    raise FetchRefused("host does not resolve to a public address")
                # Pin: connect to the address just checked, not to whatever the
                # name resolves to a moment later (see DNS rebinding above).
                name = parsed.raw_host.decode("ascii")
                send_headers["Host"] = parsed.netloc.decode("ascii").rsplit("@", 1)[-1]
                if parsed.scheme == "https":
                    extensions["sni_hostname"] = name
                target = parsed.copy_with(host=addresses[0], username=None, password=None)
            with client.stream("GET", target, headers=send_headers, extensions=extensions) as resp:
                location = resp.headers.get("location")
                if resp.status_code in _REDIRECTS and location:
                    url = urljoin(url, location)   # checked like the first URL, next time round
                    continue
                declared = resp.headers.get("content-length", "")
                if declared.isdigit() and int(declared) > max_bytes:
                    raise FetchRefused("response is larger than the cap")
                body = bytearray()
                for chunk in resp.iter_bytes():
                    body += chunk
                    if len(body) > max_bytes:
                        raise FetchRefused("response is larger than the cap")
                    if time.monotonic() > deadline:
                        raise FetchRefused("response took too long")
                return Fetched(url, resp.status_code, resp.headers, bytes(body))
    raise FetchRefused("too many redirects")


def fetch_image(url: str, *, octet_ok: bool = False, **kwargs):
    """The bytes of an image at `url`, or None - never raises. The response
    must be a 2xx that says it is an image; `octet_ok` also takes the generic
    application/octet-stream storage hands back for an upload that came with
    no type (the caller's own decoder is the real check there)."""
    try:
        got = fetch(url, **kwargs)
    except (FetchRefused, httpx.HTTPError):
        return None
    if not 200 <= got.status_code < 300:
        return None
    ctype = got.content_type
    if ctype.startswith("image/") or (octet_ok and ctype in ("", "application/octet-stream", "binary/octet-stream")):
        return got.content
    return None


def storage_prefix() -> str:
    """Where this deployment's own Supabase storage objects live ('' when no
    storage is configured). Covers the canonical /object/public/ URL the
    database stores and the /object/sign/ URL a private bucket is read by."""
    base = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
    return f"{base}/storage/v1/object/" if base else ""


def own_image(url: str, *, also_prefixes: tuple = (), **kwargs):
    """An image from the app's OWN storage (or another prefix the caller vouches
    for, e.g. the frontend's static assets), or None. A URL anywhere else is
    not requested at all. Objects in a private bucket are read through a signed
    URL, the same way every other server-side reader does (files.fetchable_url)."""
    prefixes = tuple(p for p in (storage_prefix(), *also_prefixes) if p)
    if not url or not prefixes or not url.startswith(prefixes):
        return None
    try:
        from routers.files import fetchable_url
        url = fetchable_url(url)
    except Exception:
        return None   # storage would not sign it: there is nothing to read
    return fetch_image(url, octet_ok=True, only_prefixes=prefixes, **kwargs)
