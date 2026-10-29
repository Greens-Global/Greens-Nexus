"""Ask Nexus check list (WP 4.2, Oct 29 2026): run before every AI change.

Ask Nexus answers in two steps: search picks the five best published pages
(kb_search.search), then the model answers ONLY from them (kb_ai.answer). A
change to either can quietly make answers worse, so this file holds a fixed
set of sample pages and twenty questions people really ask, each with the page
that answers it (and two that no page answers).

  * Retrieval (every CI run, no key needed - test_kb_ai_eval.py): the
    expected page is among the five search hands to the model.
  * Answers (by hand, with ANTHROPIC_API_KEY set):
        python -m kb_ai_eval --live
    each answer must be grounded and cite the expected page; the questions
    with no page must come back not grounded. Paste the summary into the PR.

Add a case whenever a real question gets a wrong answer. Pages here are
samples, not company content: keep them short and plain.
"""
from __future__ import annotations

import sys
from types import SimpleNamespace

TOP = 5   # the pages Ask Nexus hands to the model (routers/kb.py ask)


def _page(pid: str, code: str, title: str, summary: str, text: str):
    return SimpleNamespace(id=pid, doc_code=code, title=title, summary=summary, content_text=text, version="1.0",
                           verified_at="", views=0)


PAGES = [
    _page("p-movein", "OPS-001", "Move-In Walkthrough", "Hand a unit to a new tenant.",
          "Check the tenant's ID against the rental agreement. Walk the tenant to the unit and show the overlock has been "
          "removed. Give the tenant the gate code and explain the access hours, 6:00 AM to 10:00 PM. Photograph the empty "
          "unit before handover and attach the photos to the lease."),
    _page("p-moveout", "OPS-002", "Move-Out Inspection", "Close a unit when a tenant vacates.",
          "When a tenant vacates, inspect the unit within 24 hours. Check for damage, trash and left items. Photograph the "
          "unit, remove the tenant's lock code from the keypad and set the unit to available."),
    _page("p-overlock", "OPS-003", "Overlocking a Delinquent Unit", "Lock a unit that is past due.",
          "A unit becomes delinquent 5 days after rent is past due. Place the red overlock on the unit, log it in the "
          "management system and send the delinquency notice. Remove the overlock only after payment in full, including "
          "the late fee."),
    _page("p-auction", "OPS-004", "Lien Auction Process", "Sell the contents of a unit in lien.",
          "A unit goes to lien sale after 60 days past due. Send the certified lien notice, advertise the auction 14 days "
          "before it, and list the unit on the auction site. The district manager approves every auction."),
    _page("p-gate", "OPS-005", "Resetting a Tenant's Gate Code", "Give a tenant a new access code.",
          "Verify the tenant by ID or the last four digits of the card on file. Open the access control system, find the "
          "unit, and generate a new keypad code. Tell the tenant the new code in person or by phone, never by email."),
    _page("p-pto", "HR-001", "Requesting Time Off", "Ask for vacation or sick days.",
          "Request vacation at least two weeks ahead in Workday > Request Time Off. Sick days can be requested the same day. "
          "Your manager approves the request; approved days show on your Time Sheet as paid leave."),
    _page("p-punch", "HR-002", "Fixing a Missed Punch", "Correct a clock-in or clock-out you forgot.",
          "If you forgot to clock out, open Workday > Time Sheet and choose Fix a Punch on that day. Enter the real time and a "
          "reason. Your manager reviews the fix before the period is approved."),
    _page("p-mfa", "IT-001", "Locked Out of Your Account", "Reset sign-in and two-factor.",
          "If you are locked out or lost your authenticator phone, open a ticket with IT from another device or call the help "
          "desk. IT verifies you and resets two-factor; you set it up again with the Microsoft Authenticator app."),
    _page("p-laptop", "IT-002", "Reporting a Broken Laptop", "Get equipment repaired or replaced.",
          "If your laptop is damaged or not working, report it in Items > My Equipment with a photo. IT replies within one "
          "business day with a loaner or a repair plan. Never take company equipment to an outside repair shop."),
    _page("p-purchase", "FIN-001", "Buying Supplies", "Purchase requests for anything the company pays for.",
          "Anything over $100 needs a purchase request in Workday > Purchase Requests before you buy. Attach the quote; your "
          "manager approves, then accounting places the order. Under $100, use the site card and upload the receipt."),
    _page("p-autopay", "OPS-006", "Setting Up Autopay for a Tenant", "Enroll a tenant in automatic rent payments.",
          "Autopay charges the card or bank account on file on the rent due date. Enroll the tenant in the payment portal, "
          "have them sign the autopay authorization, and confirm the first charge date with them."),
    _page("p-ladder", "SAF-001", "Ladder Safety", "Working at height on site.",
          "Inspect the ladder before every use. Keep three points of contact, never stand on the top two rungs, and have "
          "someone hold the ladder above 10 feet. Report a damaged ladder and tag it out of service."),
]

# (question, expected page id or None when no page answers it)
CASES = [
    ("how do i give a new tenant their unit", "p-movein"),
    ("what are the gate access hours", "p-movein"),
    ("customer is moving out what do I check", "p-moveout"),
    ("when do we put an overlock on a unit", "p-overlock"),
    ("tenant paid, can I take the lock off", "p-overlock"),      # KNOWN GAP, see below
    ("how many days past due before a lien sale", "p-auction"),
    ("who approves an auction", "p-auction"),
    ("tenant forgot their gate code", "p-gate"),
    ("can I email a tenant their new access code", "p-gate"),
    ("how do I request PTO", "p-pto"),
    ("can I take a sick day today", "p-pto"),
    ("I forgot to clock out yesterday", "p-punch"),
    ("lost my phone with the authenticator app", "p-mfa"),
    ("locked out of my account", "p-mfa"),
    ("my laptop screen is broken", "p-laptop"),
    ("how do I buy a printer for the office", "p-purchase"),
    ("tenant wants auto pay", "p-autopay"),
    ("is it ok to stand on the top of the ladder", "p-ladder"),
    ("what is the wifi password for the warehouse", None),
    ("when is the company holiday party", None),
]


# Questions search gets wrong today, with why. The CI test fails if one starts
# passing (move it out of here) or a new one starts failing (fix search or
# add it here with a reason a reviewer can judge).
KNOWN_GAPS = {
    "tenant paid, can I take the lock off":
        "The time-off page really says 'paid' and 'off', so plain word matching ranks it first; the overlock page "
        "matches only through the synonym 'overlock'. Needs ranking that weighs a domain word over filler.",
}


def retrieve(question: str, db=None) -> list[str]:
    """The page ids Ask Nexus would hand to the model, best first."""
    import kb_search
    return [r["id"] for r in kb_search.search(db, PAGES, question, limit=TOP)["results"]]


def check_retrieval(db=None) -> list[dict]:
    """One row per answerable case: {question, expected, got, ok}."""
    out = []
    for q, want in CASES:
        if want is None:
            continue
        got = retrieve(q, db)
        out.append({"question": q, "expected": want, "got": got, "ok": want in got, "known_gap": q in KNOWN_GAPS})
    return out


def check_answers() -> list[dict]:
    """Calls the model once per case (needs ANTHROPIC_API_KEY)."""
    import kb_ai
    by_id = {p.id: p for p in PAGES}
    out = []
    for q, want in CASES:
        ids = retrieve(q)
        pages = [{"id": i, "code": by_id[i].doc_code, "title": by_id[i].title, "version": by_id[i].version,
                  "verified_at": "", "text": by_id[i].content_text} for i in ids]
        try:
            a = kb_ai.answer(q, pages)
            ok = (not a["grounded"]) if want is None else (a["grounded"] and want in a["sources"])
            out.append({"question": q, "expected": want, "grounded": a["grounded"], "sources": a["sources"], "ok": ok,
                        "answer": a["answer"][:160]})
        except Exception as e:  # noqa: BLE001 - one failure is a row, not a crash
            out.append({"question": q, "expected": want, "ok": False, "answer": f"{type(e).__name__}: {e}"})
    return out


def main(argv: list[str]) -> int:
    live = "--live" in argv
    rows = check_answers() if live else check_retrieval()
    for r in rows:
        print(("PASS " if r["ok"] else "FAIL ") + f"{r['question']!r} -> expected {r['expected']}"
              + (f", got {r.get('got')}" if not live else f", grounded={r.get('grounded')} sources={r.get('sources')}")
              + (f"\n     {r['answer']}" if live else ""))
    passed = sum(1 for r in rows if r["ok"])
    gaps = sum(1 for r in rows if not r["ok"] and r.get("known_gap"))
    print()
    print(f"{'Answers' if live else 'Retrieval'}: {passed} of {len(rows)} pass" + (f" ({gaps} known gap)" if gaps else ""))
    return 0 if passed + gaps == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
