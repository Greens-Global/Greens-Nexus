"""Field formats for Nexus Sign text boxes - a thin re-export of
`federal_forms.formats`, the ONE source of truth (Neil, 11/02/2026): the
forms package and the signing engine check and mask a Social Security
number, a routing number or an account number the same way, so nothing can
diverge. Import from here in the router, from `federal_forms.formats` in the
package; they are the same functions.
"""
from federal_forms.formats import FORMATS, check, digits, mask  # noqa: F401

__all__ = ["FORMATS", "check", "digits", "mask"]
