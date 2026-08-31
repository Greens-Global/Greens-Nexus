"""The Asana integration's kill switch, on its own so every module can ask.

Severed Aug 27 2026, hardened Aug 31: the endpoints were already gated, but the
gate lived in `asana_sync`, which imports `asana_import`, `asana_oauth` and
(lazily) `asana_rescue` - so those three could not ask the question back without
a circular import, and each of them owns a door to the network. This module has
no imports of its own, so all four can use the same answer.

The rule the sever rests on: **no bytes leave this process for Asana, and none
are read back, unless NEXUS_ASANA_ENABLED says so.** Every function that opens a
socket to Asana checks this first, so a caller that forgets an endpoint gate
still cannot reach the network. The code, the models and every AsanaTaskLink row
are deliberately kept - restoring the link is this one variable, with no
migration and no re-import.
"""
import os


def is_asana_enabled() -> bool:
    """Whether the Asana integration is live at all in this deployment."""
    return os.getenv("NEXUS_ASANA_ENABLED", "").lower() in ("1", "true", "yes")


# What every outbound door says when it refuses. One wording so the reason is
# recognizable in a log wherever it surfaces.
DISABLED_MSG = ("Asana integration is disabled (NEXUS_ASANA_ENABLED is not set), "
                "so no request was made.")
