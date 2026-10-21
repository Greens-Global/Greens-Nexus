"""One turn at a time for OpenStreetMap Nominatim (Oct 21 2026).

Nominatim's usage policy allows at most ONE request a second from us in
total. Two background loops ask it now - the asset map (asset_geocode.py) and
the Operations Customer Map (ops_customer_geo.py) - and both run on the one
leader process, each in its own thread. Pacing each loop on its own would let
them add up to two a second, so every background lookup waits here first:

    nominatim_pace.wait_turn()     # returns once our last request is >= MIN_GAP_SECONDS old

The lock is held while waiting, so callers line up one behind the other; the
time is taken after the wait, so the next caller measures from this call.
"""
import threading
import time

MIN_GAP_SECONDS = 1.1        # a little over one second, for clock jitter

_lock = threading.Lock()
_last = 0.0                  # time.monotonic() of the last request let through


def wait_turn() -> None:
    """Block until this process may send its next Nominatim request."""
    global _last
    with _lock:
        gap = MIN_GAP_SECONDS - (time.monotonic() - _last)
        if gap > 0:
            time.sleep(gap)
        _last = time.monotonic()
