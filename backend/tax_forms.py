"""The lines an account may be mapped to on each tax form (Accounting >
Reports > Tax, routers/accounting_tax_lines.py).

The forms themselves - their line numbers, names, order and sums - live in
ONE data file per form under frontend/src/components/accounting/taxForms/
(schedule_c.json, schedule_e.json, form_1065.json, form_1120.json,
ca_568.json, form_1040.json), read by the one tax engine (taxForms/engine.js).
The API only needs to know which line ids it may store, so it keeps that list
here; test_tax_forms.py holds the two together (a line added to a form's file
fails the test until it is added here, and the other way round).

Schedule C first (Neil, Viral, 10/27 triage item 18); the rest 11/19/2026
(Charmi, Teams: "We need Sch C, Sch E, 1040, 1065, form 568, 1120").
"""

SKIP = "skip"

_SCHEDULE_C = (
    "1 2 4 6 8 9 10 11 12 13 14 15 16a 16b 17 18 19 20a 20b 21 22 23 24a 24b 25 26 27a 27b 30"
)
_SCHEDULE_E = "3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 28h 28k 28g 28i"
_FORM_1065 = (
    "1a 1b 2 4 5 6 7 9 10 11 12 13 14 15 16a 17 18 19 20 21 "
    "r2 r3 r4 r5 r6 r7 r8 r9 r10 r11 r12 r13 r14 r15 "
    "k3a k3b k5 k6a k7 k8 k9a k10 k11 k12 k13a k13b k13d "
    "l1 l2a l2b l3 l4 l5 l6 l7a l7b l8 l9a l9b l10a l10b l11 l12a l12b l13 "
    "l15 l16 l17 l18 l19a l19b l20 l21"
)
_FORM_1120 = (
    "1a 1b 2 4 5 6 7 8 9 10 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 "
    "l1 l2a l2b l3 l4 l5 l6 l7 l8 l9 l10a l10b l11a l11b l12 l13a l13b l14 "
    "l16 l17 l18 l19 l20 l21 l22 l23 l24 l25 l26 l27"
)
_CA_568 = "1a 1b 2 4 5 6 7 9 10 11 12 13 14 15 16a 17 18 19 20 rent rentexp"
# The 1040's rows are the entities: each files on Schedule C or Schedule E.
_FORM_1040 = "schedule_c schedule_e"

FORMS: dict[str, set[str]] = {
    form: set(lines.split()) | {SKIP}
    for form, lines in {
        "schedule_c": _SCHEDULE_C,
        "schedule_e": _SCHEDULE_E,
        "form_1065": _FORM_1065,
        "form_1120": _FORM_1120,
        "ca_568": _CA_568,
        "form_1040": _FORM_1040,
    }.items()
}
