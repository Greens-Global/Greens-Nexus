"""Nexus, the Knowledge Base's AI (Oct 2026 rebuild). One name, one module.

  answer()        Ask Nexus: answers only from published pages, cites them.
  format_text()   Import: one SECTION of source text -> page blocks (the
                  router splits long sources so nothing is cut off).
  suggest_meta()  Title, type, collection, tags for an import.
  suggestions()   Edit with Nexus: changes as a list the editor applies one
                  at a time - it never replaces the page.
  translate()     Whole page to Spanish or Hindi.
  course()        Lessons and a question pool from chosen pages.

Models come from the environment (NEXUS_KB_AI_MODEL for writing, default
Sonnet 5.5; NEXUS_KB_AI_FAST_MODEL for small jobs, default Haiku 5.5). The
key is read per call. Every caller is already limited to authors by the
router, and every input is capped here.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any

import httpx

import kb_blocks

_API = "https://api.anthropic.com/v1/messages"
MAX_SECTION_CHARS = 9000
MAX_PAGE_CHARS = 60000
LANGS = {"es": "Spanish", "hi": "Hindi"}


def model() -> str:
    return os.getenv("NEXUS_KB_AI_MODEL", "claude-sonnet-5-5")


def fast_model() -> str:
    return os.getenv("NEXUS_KB_AI_FAST_MODEL", "claude-haiku-5-5")


def available() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY", ""))


class AiError(RuntimeError):
    pass


def _call(system: str, user: str, *, max_tokens: int = 4000, timeout: float = 110, use_fast: bool = False) -> str:
    key = os.getenv("ANTHROPIC_API_KEY", "")
    if not key:
        raise AiError("Nexus is not set up on this server (no API key)")
    body = {
        "model": fast_model() if use_fast else model(),
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    try:
        with httpx.Client(timeout=timeout) as c:
            r = c.post(_API, json=body, headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                                                 "content-type": "application/json"})
    except httpx.HTTPError as e:
        raise AiError(f"Nexus could not be reached: {e.__class__.__name__}") from e
    if r.status_code >= 300:
        raise AiError(f"Nexus answered {r.status_code}")
    data = r.json()
    return "".join(p.get("text", "") for p in data.get("content", []) if p.get("type") == "text")


def _json(s: str) -> Any:
    s = (s or "").strip()
    s = re.sub(r"^```(?:json)?\s*", "", s)
    s = re.sub(r"\s*```$", "", s)
    try:
        return json.loads(s)
    except ValueError:
        # the model sometimes prefixes a sentence; take the first {...} or [...]
        m = re.search(r"[\[{].*[\]}]", s, re.DOTALL)
        if not m:
            raise AiError("Nexus returned something that was not JSON")
        try:
            return json.loads(m.group(0))
        except ValueError as e:
            raise AiError("Nexus returned broken JSON") from e


_BLOCK_SCHEMA = """Return ONLY a JSON object: {"type":"doc","content":[...]} using these nodes and nothing else:
- {"type":"heading","attrs":{"level":2|3},"content":[{"type":"text","text":"..."}]}
- {"type":"paragraph","content":[{"type":"text","text":"..."}]}  (text may carry "marks":[{"type":"bold"}])
- {"type":"bulletList","content":[{"type":"listItem","content":[paragraph]}]}  and orderedList the same way
- {"type":"steps","content":[{"type":"step","attrs":{"photos":[],"warning":"","tip":"","photoRequired":false},"content":[paragraph(title), paragraph(detail)...]}]}
  Use steps for any numbered procedure. First paragraph = the instruction, later paragraphs = detail. Put a safety warning for THAT step in attrs.warning.
- {"type":"callout","attrs":{"kind":"warning"|"tip"|"note"|"safety"},"content":[paragraph or bulletList]}
- {"type":"table","content":[{"type":"tableRow","content":[{"type":"tableHeader","content":[paragraph]}...]}, {"type":"tableRow","content":[{"type":"tableCell","content":[paragraph]}...]}]}
- {"type":"image","attrs":{"src":"[[IMG3]]","alt":"..."}} ONLY where the source has an [[IMG#]] marker; keep the marker as src.
- {"type":"checklist","content":[{"type":"checkItem","attrs":{"checked":false},"content":[{"type":"text","text":"..."}]}]}
Keep the author's wording. Do not invent facts. Do not add an introduction. Fix obvious typos only."""


def format_text(section: str, *, title: str = "", page_type: str = "", position: str = "") -> dict:
    """One section of source text -> blocks. Raises AiError; the caller keeps
    the raw text when that happens."""
    section = (section or "")[:MAX_SECTION_CHARS]
    system = ("You turn company source material into a clean Knowledge Base page for Greens Global, a self-storage operator. "
              + _BLOCK_SCHEMA + "\nAmerican English. Title Case for headings. Dates as MM/DD/YYYY.")
    user = (f"Page title: {title or '(none yet)'}\nPage type: {page_type or 'unknown'} (how_to | sop | policy | reference)\n"
            f"This is {position or 'a section'} of the source.\n[[TABLE]]...[[/TABLE]] blocks are tables, rows separated by newlines, cells by |.\n\nSOURCE:\n\"\"\"\n{section}\n\"\"\"")
    out = _json(_call(system, user, max_tokens=8000))
    if not isinstance(out, dict) or out.get("type") != "doc":
        raise AiError("Nexus did not return a page")
    return out


def suggest_meta(text: str, *, collections: list[dict], tags: list[str]) -> dict:
    text = (text or "")[:8000]
    cols = ", ".join(f"{c['id']}={c['name']}" for c in collections[:60])
    system = ("Suggest filing metadata for a Knowledge Base page. Return ONLY JSON: "
              '{"title": str (Title Case, under 80 chars, no date prefix), "summary": str (one sentence, under 140 chars), '
              '"page_type": "how_to"|"sop"|"policy"|"reference", "collection_id": str or "", "tags": [up to 6 short lowercase tags]}. '
              "how_to = a short answer; sop = numbered procedure; policy = rules people must agree to; reference = lists, tables, facts.")
    user = f"Collections (id=name): {cols or '(none)'}\nExisting tags: {', '.join(tags[:80]) or '(none)'}\n\nTEXT:\n{text}"
    out = _json(_call(system, user, max_tokens=500, timeout=60, use_fast=True))
    if not isinstance(out, dict):
        raise AiError("No suggestion")
    pt = out.get("page_type") if out.get("page_type") in ("how_to", "sop", "policy", "reference") else ""
    cid = out.get("collection_id") if any(c["id"] == out.get("collection_id") for c in collections) else ""
    return {"title": str(out.get("title") or "")[:200], "summary": str(out.get("summary") or "")[:300],
            "page_type": pt, "collection_id": cid,
            "tags": [str(t).strip().lower()[:40] for t in (out.get("tags") or []) if str(t).strip()][:6]}


def suggestions(blocks: dict, instruction: str, *, title: str = "") -> list[dict]:
    """Edit with Nexus. Returns [{index, action: replace|insert_after|delete,
    reason, block}] against TOP-LEVEL block indexes of the current page. The
    editor shows each one and the author accepts or rejects it."""
    content = [n for n in (blocks.get("content") or []) if isinstance(n, dict)]
    numbered = "\n".join(f"[{i}] ({n.get('type')}) {kb_blocks.node_text(n)[:600]}" for i, n in enumerate(content))[:MAX_PAGE_CHARS]
    system = ("You are editing a Knowledge Base page as SUGGESTIONS, never a rewrite. Return ONLY a JSON array of changes, "
              'each {"index": int, "action": "replace"|"insert_after"|"delete", "reason": short str, "block": node or null}. '
              "index refers to the numbered top-level blocks. Make the fewest changes that satisfy the request. "
              "For replace / insert_after, block must be a node in this schema:\n" + _BLOCK_SCHEMA)
    user = f"Page: {title}\nREQUEST: {instruction[:2000]}\n\nCURRENT BLOCKS:\n{numbered}"
    out = _json(_call(system, user, max_tokens=6000))
    if not isinstance(out, list):
        raise AiError("Nexus returned no suggestions")
    res = []
    for s in out[:40]:
        if not isinstance(s, dict):
            continue
        try:
            idx = int(s.get("index"))
        except (TypeError, ValueError):
            continue
        action = s.get("action")
        if action not in ("replace", "insert_after", "delete") or idx < 0 or idx >= max(1, len(content)):
            continue
        block = s.get("block") if action != "delete" else None
        if action != "delete":
            fixed = kb_blocks.sanitize({"type": "doc", "content": [block] if isinstance(block, dict) else []})
            if not fixed["content"] or kb_blocks.is_blank(fixed):
                continue
            block = fixed["content"][0]
        res.append({"index": idx, "action": action, "reason": str(s.get("reason") or "")[:300], "block": block,
                    "before": kb_blocks.node_text(content[idx])[:600] if idx < len(content) else "",
                    "after": kb_blocks.node_text(block)[:600] if block else ""})
    return res


def translate(blocks: dict, title: str, lang: str) -> dict:
    """Whole page -> {title, blocks} in the language. Node structure and
    attrs are kept; only text changes."""
    if lang not in LANGS:
        raise AiError("Unsupported language")
    src = kb_blocks.dumps(blocks)
    if len(src) > MAX_PAGE_CHARS * 2:
        raise AiError("This page is too long to translate in one go")
    system = (f"Translate the text inside this TipTap JSON page into {LANGS[lang]}. Keep every node, attribute, mark and the "
              "structure exactly; translate only the \"text\" values and attrs.warning / attrs.tip / attrs.alt. Keep product "
              'names (Nexus, Ramp, Egnyte). Return ONLY JSON: {"title": str, "blocks": {doc}}.')
    out = _json(_call(system, f"TITLE: {title}\nPAGE:\n{src}", max_tokens=12000, timeout=170))
    if not isinstance(out, dict) or not isinstance(out.get("blocks"), dict):
        raise AiError("Nexus did not return a translation")
    return {"title": str(out.get("title") or title)[:300], "blocks": kb_blocks.sanitize(out["blocks"], image_ok=lambda u: True)}


def answer(question: str, pages: list[dict]) -> dict:
    """pages: [{id, code, title, version, verified_at, text}] already chosen
    by search. Returns {answer, sources:[ids], grounded}."""
    question = (question or "")[:1000]
    if not pages:
        return {"answer": "", "sources": [], "grounded": False}
    ctx = "\n\n".join(f"[{i + 1}] {p['code'] or ''} {p['title']} (v{p['version']})\n{p['text'][:5000]}" for i, p in enumerate(pages[:5]))
    system = ("You are Nexus, the Greens Global knowledge assistant. Answer the question using ONLY the pages given. "
              "Cite the pages you used as [1], [2] after the sentence they support. If the pages do not answer it, say so in one "
              "sentence and do not guess. Be brief: a short paragraph or a short numbered list. American English, MM/DD/YYYY. "
              'Return ONLY JSON: {"answer": str, "sources": [page numbers used], "grounded": bool}.')
    out = _json(_call(system, f"QUESTION: {question}\n\nPAGES:\n{ctx}", max_tokens=700, timeout=45))
    if not isinstance(out, dict):
        raise AiError("No answer")
    used = []
    for n in out.get("sources") or []:
        try:
            i = int(n) - 1
        except (TypeError, ValueError):
            continue
        if 0 <= i < len(pages[:5]):
            used.append(pages[i]["id"])
    return {"answer": str(out.get("answer") or "").strip(), "sources": used, "grounded": bool(out.get("grounded")) and bool(used)}


def course(pages: list[dict], *, title_hint: str = "", questions: int = 15) -> dict:
    """pages: [{id, title, version, text}] -> {title, description, overview,
    est_minutes, lessons:[{title, docId?, blocks?}], questions:[...]}. Runs
    in two calls when there is a lot of material so it never cuts off."""
    material = "\n\n".join(f"PAGE {p['id']} - {p['title']} (v{p['version']})\n{p['text'][:7000]}" for p in pages[:8])
    system = ("You build a short training course for self-storage staff from Knowledge Base pages. Return ONLY JSON: "
              '{"title": str, "description": str (one sentence), "overview": [3-5 outcomes], "est_minutes": int, '
              '"lessons": [{"title": str, "docId": the PAGE id this lesson teaches, "summary": str (2 sentences for the lesson intro)}]}. '
              "One lesson per page unless a page clearly has two topics. Title Case titles.")
    out = _json(_call(system, f"Course title hint: {title_hint or '(none)'}\n\n{material}", max_tokens=2500, timeout=90))
    if not isinstance(out, dict):
        raise AiError("No course")
    lessons = []
    for L in out.get("lessons") or []:
        if not isinstance(L, dict):
            continue
        did = str(L.get("docId") or "")
        lessons.append({"title": str(L.get("title") or "Lesson")[:200], "docId": did if any(p["id"] == did for p in pages) else "",
                        "summary": str(L.get("summary") or "")[:600]})
    q_system = ("Write quiz questions that check understanding of the pages. Return ONLY a JSON array of "
                '{"type": "single"|"multi"|"tf", "q": str, "options": [4 strings (2 for tf: "True","False")], '
                '"answer": [indexes of correct options], "explanation": str that points to WHERE in which page to reread, never stating the answer, '
                '"docId": the PAGE id it comes from}. No trick questions; each must be answerable from the text.')
    qs = _json(_call(q_system, f"Write {questions} questions.\n\n{material}", max_tokens=4000, timeout=110))
    questions_out = []
    for q in qs if isinstance(qs, list) else []:
        if not isinstance(q, dict):
            continue
        t = q.get("type") if q.get("type") in ("single", "multi", "tf") else "single"
        opts = [str(o)[:300] for o in (q.get("options") or [])][:6]
        if t == "tf":
            opts = ["True", "False"]
        if len(opts) < 2:
            continue
        ans = q.get("answer")
        if isinstance(ans, int):
            ans = [ans]
        ans = sorted({int(a) for a in (ans or []) if isinstance(a, int) and 0 <= a < len(opts)})
        if not ans:
            continue
        if t != "multi":
            ans = ans[:1]
        questions_out.append({"type": t, "q": str(q.get("q") or "")[:600], "options": opts, "answer": ans,
                              "explanation": str(q.get("explanation") or "")[:400],
                              "docId": str(q.get("docId") or "") if any(p["id"] == str(q.get("docId") or "") for p in pages) else ""})
    return {"title": str(out.get("title") or title_hint or "New Course")[:200],
            "description": str(out.get("description") or "")[:400],
            "overview": [str(o)[:200] for o in (out.get("overview") or [])][:6],
            "est_minutes": max(5, int(out.get("est_minutes") or 15)) if str(out.get("est_minutes") or "").isdigit() else 15,
            "lessons": lessons, "questions": questions_out}


def split_sections(text: str, max_chars: int = MAX_SECTION_CHARS) -> list[dict]:
    """Split a long source at headings / blank lines into sections small
    enough for one call each, so a 40-page manual is read in full. Returns
    [{title, text}]."""
    text = (text or "").replace("\r\n", "\n")
    if len(text) <= max_chars:
        return [{"title": "", "text": text}]
    paras = re.split(r"\n\s*\n", text)
    sections: list[dict] = []
    cur: list[str] = []
    cur_len = 0
    cur_title = ""
    for p in paras:
        p = p.strip("\n")
        is_heading = len(p) < 90 and "\n" not in p and (p.isupper() or re.match(r"^(\d+(\.\d+)*\.?\s+)?[A-Z][^.]{2,80}$", p))
        if (is_heading and cur_len > max_chars * 0.4) or cur_len + len(p) > max_chars:
            if cur:
                sections.append({"title": cur_title, "text": "\n\n".join(cur)})
            cur, cur_len, cur_title = [], 0, (p if is_heading else "")
        cur.append(p)
        cur_len += len(p) + 2
    if cur:
        sections.append({"title": cur_title, "text": "\n\n".join(cur)})
    return sections or [{"title": "", "text": text[:max_chars]}]
