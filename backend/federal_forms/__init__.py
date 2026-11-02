"""Federal onboarding forms in Nexus Sign (Neil, 11/02/2026): the W-4, the
I-9 and our direct deposit authorization, each pinned to one edition.

    from federal_forms import FORMS, prepare, check_map, widgets
    from federal_forms.formats import check
    from federal_forms.rules import validate
    from federal_forms.editions import status

`prepare(kind)` is the function (a flat PDF plus Nexus Sign fields); the
module behind it is reachable as `federal_forms.prepare_mod` when the widget
listing or the map check is what you need.
"""
from . import editions, formats, registry, rules  # noqa: F401
from . import prepare as prepare_mod
from .editions import status  # noqa: F401
from .formats import check  # noqa: F401
from .prepare import check_map, prepare, widgets  # noqa: F401
from .registry import FORMS, MERGE_KEYS  # noqa: F401
from .rules import validate  # noqa: F401

__all__ = ["FORMS", "MERGE_KEYS", "prepare", "prepare_mod", "check_map", "widgets",
           "check", "validate", "status", "editions", "formats", "registry", "rules"]
