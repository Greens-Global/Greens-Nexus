"""Filing suggestions for an imported page, by rules alone - no AI (Neil,
11/02/2026: "we should be able to quickly add in an SOP from Word, and it
should just be organized"). The AI filer (kb_ai.suggest_meta) is off with
the rest of AI (ai_switch.py), so this is what every import gets: the page
type from the shape of the text, the departments and the collection from
names that appear in it, tags from the ones already in use. Every pick comes
with a plain reason the import screen shows, and the author can change any
of it before the page is saved. Nothing here reads or writes the database
beyond the lists it is handed."""
from __future__ import annotations

import re

_WORD = re.compile(r"[a-z][a-z0-9'&/-]*")

# Words that make a text a policy when several of them appear. Counted per
# distinct word so one repeated "must" is not a policy.
_POLICY_WORDS = ("policy", "must", "shall", "prohibited", "violation", "disciplinary", "compliance", "required to",
                 "not permitted", "zero tolerance", "terminat", "acknowledg")
_HOWTO_LEADS = ("how to", "how do i", "what to do", "setting up", "using ")
_REFERENCE_WORDS = ("list of", "reference", "glossary", "contact list", "price list", "rates", "schedule of", "matrix", "codes")
_NUMBERED = re.compile(r"(?m)^\s*(?:\d{1,2}[.)]|step\s+\d{1,2}\b)")
_TEXT_LIMIT = 6000      # the title and the opening of the text decide the filing


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").lower()).strip()


def _has_word(hay: str, needle: str) -> bool:
    """Whole-word, case-insensitive. 'HR' never matches 'three'."""
    n = _norm(needle)
    if not n:
        return False
    return re.search(r"(?<![a-z0-9])" + re.escape(n) + r"(?![a-z0-9])", hay) is not None


def page_type_for(title: str, text: str, blocks: dict | None = None) -> tuple[str, str]:
    """(page_type, reason). Steps win over everything: an SOP is a procedure
    whatever it is called. Then a policy by its words, a reference by its
    tables, a how-to by its opening; else a how-to."""
    t = _norm(title)
    body = _norm(text[:_TEXT_LIMIT])
    content = (blocks or {}).get("content") or []
    kinds = [n.get("type") for n in content if isinstance(n, dict)]
    if "steps" in kinds:
        return "sop", "It has numbered steps."
    ordered_items = sum(len(n.get("content") or []) for n in content if isinstance(n, dict) and n.get("type") == "orderedList")
    numbered_lines = len(_NUMBERED.findall(text[:_TEXT_LIMIT]))
    if ordered_items >= 3 or numbered_lines >= 3 or " procedure" in f" {t}" or t.startswith("sop"):
        return "sop", "It reads as a procedure with numbered steps."
    if "policy" in t:
        return "policy", "The title says policy."
    policy_hits = {w for w in _POLICY_WORDS if w in body}
    if len(policy_hits) >= 3:
        return "policy", "It uses the words of a policy (" + ", ".join(sorted(policy_hits)[:3]) + ")."
    tables = kinds.count("table")
    paragraphs = kinds.count("paragraph")
    if tables >= 2 and tables * 4 >= paragraphs:
        return "reference", "It is mostly tables."
    if any(w in t for w in _REFERENCE_WORDS):
        return "reference", "The title reads like a list or a reference."
    if any(t.startswith(w) for w in _HOWTO_LEADS):
        return "how_to", "The title asks how to do something."
    return "how_to", "A short answer page unless you say otherwise."


def departments_for(title: str, text: str, known: list[str], mine: str = "") -> tuple[list[str], str]:
    """Departments named in the title or the opening text, in the order they
    appear; else the importer's own department. `known` is the list People
    uses (kb_audience.options), so a stray word never becomes a department."""
    hay = _norm(title) + " \n " + _norm(text[:_TEXT_LIMIT])
    found: list[tuple[int, str]] = []
    for name in known:
        n = _norm(name)
        if not n or len(n) < 2:
            continue
        m = re.search(r"(?<![a-z0-9])" + re.escape(n) + r"(?![a-z0-9])", hay)
        if m:
            found.append((m.start(), name))
    found.sort()
    names = list(dict.fromkeys(nm for _, nm in found))[:6]
    if names:
        where = "the title" if any(_has_word(_norm(title), nm) for nm in names) else "the text"
        return names, f"{', '.join(names)}: named in {where}."
    if mine and mine in known:
        return [mine], f"{mine}: your own department, since the text names none."
    return [], "No department named in the text."


def collection_for(title: str, text: str, collections: list[dict], departments: list[str]) -> tuple[str, str]:
    """A collection named in the title or the opening text (the longest name
    wins, so 'Operations / Gate Access' beats 'Operations'); else the top
    collection of the first department; else none."""
    t = _norm(title)
    hay = t + " \n " + _norm(text[:_TEXT_LIMIT])
    best: tuple[int, int, str, str] | None = None
    for c in collections:
        name = c.get("name") or ""
        if len(_norm(name)) < 3 or not _has_word(hay, name):
            continue
        # named in the title beats named in the body; then the longer name
        key = (1 if _has_word(t, name) else 0, len(name), c.get("id") or "", name)
        if best is None or key > best:
            best = key
    if best:
        return best[2], f"Filed under {best[3]} because the {'title' if best[0] else 'text'} names it."
    for dept in departments:
        for c in collections:
            if not c.get("parent_id") and _norm(c.get("department") or "") == _norm(dept):
                return c.get("id") or "", f"Filed under {c.get('name')} for the {dept} department."
    return "", "Pick a collection; none is named in the text."


def tags_for(title: str, text: str, known: list[str], limit: int = 5) -> list[str]:
    hay = _norm(title) + " \n " + _norm(text[:_TEXT_LIMIT])
    return [t for t in known if len(_norm(t)) >= 3 and _has_word(hay, t)][:limit]


def suggest(*, title: str, text: str, blocks: dict | None = None, collections: list[dict], departments: list[str],
            tags: list[str], my_department: str = "") -> dict:
    """What the import screen prefills. Same keys the AI filer returns
    (title, summary, page_type, collection_id, tags) plus `departments` and
    a `reasons` map the screen can show beside each pick."""
    pt, why_type = page_type_for(title, text, blocks)
    depts, why_dept = departments_for(title, text, departments, my_department)
    cid, why_col = collection_for(title, text, collections, depts)
    first_line = next((ln.strip() for ln in (text or "").splitlines() if ln.strip() and _norm(ln) != _norm(title)), "")
    summary = first_line[:160] if 20 <= len(first_line) <= 300 else ""
    return {
        "title": (title or "").strip()[:300],
        "summary": summary,
        "page_type": pt,
        "collection_id": cid,
        "departments": depts,
        "tags": tags_for(title, text, tags),
        "by": "rules",
        "reasons": {"page_type": why_type, "departments": why_dept, "collection": why_col},
    }
