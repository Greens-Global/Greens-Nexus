"""Storage Academy content package: load it from kb_seed/academy and validate it.

Layout and authoring rules: kb_seed/academy/README.md. problems() is the
content test - an empty list means the package imports exactly as authored.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

import kb_blocks
import kb_md

ROOT = Path(__file__).parent / "kb_seed" / "academy"
ORDER = ["nexus-fundamentals", "self-storage-fundamentals", "rv-boat-storage-fundamentals",
         "cubby-fundamentals", "customer-service-sales-fundamentals", "hands-on-check"]


@dataclass
class PageSpec:
    slug: str
    title: str
    summary: str
    page_type: str
    tags: list
    blocks: dict


@dataclass
class CourseSpec:
    slug: str
    title: str
    description: str
    overview: list
    est_minutes: int
    delivery: str
    min_reading_minutes: int
    lessons: list
    quiz: dict


@dataclass
class Academy:
    pages: dict = field(default_factory=dict)
    courses: list = field(default_factory=list)
    plan: dict = field(default_factory=dict)
    errors: list = field(default_factory=list)  # load-time findings, reported by problems()


def load(root: Path = ROOT) -> Academy:
    a = Academy()
    try:
        a.plan = json.loads((root / "plan.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        a.errors.append(f"plan.json: {e}")
    for f in sorted((root / "pages").glob("*.md")):
        meta, body = kb_md.parse(f.read_text(encoding="utf-8"))
        if not meta.get("title"):
            a.errors.append(f"page {f.stem}: front matter has no title")
        try:
            blocks = kb_md.to_blocks(body)
        except ValueError as e:
            a.errors.append(f"page {f.stem}: {e}")
            continue
        a.pages[f.stem] = PageSpec(f.stem, meta.get("title", ""), meta.get("summary", ""), meta.get("page_type", "reference"),
                                   [t.strip() for t in meta.get("tags", "").split(",") if t.strip()], blocks)
    for d in sorted((root / "courses").glob("*/course.json")):
        try:
            c = json.loads(d.read_text(encoding="utf-8"))
            slug = c["slug"]
            lessons = []
            for L in c.get("lessons", []):
                if "file" in L:
                    meta, body = kb_md.parse((d.parent / "lessons" / L["file"]).read_text(encoding="utf-8"))
                    if not meta.get("title"):
                        a.errors.append(f"{slug}/{L['file']}: front matter has no title")
                    lessons.append({"type": "text", "title": meta.get("title", ""), "summary": meta.get("summary", ""),
                                    "blocks": kb_md.to_blocks(body)})
                elif "page" in L:
                    lessons.append({"type": "page", "page": L["page"], "title": L.get("title", ""), "summary": L.get("summary", "")})
                else:
                    lessons.append({"type": "checkpoint", "title": L.get("checkpoint", ""), "questions": L.get("questions", [])})
            a.courses.append(CourseSpec(slug, c["title"], c.get("description", ""), c.get("overview", []), c.get("est_minutes", 0),
                                        c.get("delivery", ""), c.get("min_reading_minutes", 0), lessons, c.get("quiz") or {}))
        except (OSError, ValueError, KeyError, TypeError) as e:
            a.errors.append(f"{d.parent.name}: cannot load ({type(e).__name__}: {e})")
    return a


def _texts(node) -> list[str]:
    """Every paragraph's text in a block tree (for the one-line callout check)."""
    out = []
    if isinstance(node, dict):
        if node.get("type") == "paragraph":
            out.append("".join(c.get("text", "") for c in node.get("content", []) if isinstance(c, dict)))
        for v in node.values():
            out += _texts(v)
    elif isinstance(node, list):
        for v in node:
            out += _texts(v)
    return out


def _all_text(node) -> list[str]:
    if isinstance(node, dict):
        out = [node["text"]] if isinstance(node.get("text"), str) else []
        for v in node.values():
            out += _all_text(v)
        return out
    if isinstance(node, list):
        return [t for v in node for t in _all_text(v)]
    return []


_SMALL = {"a", "an", "the", "and", "or", "but", "for", "nor", "of", "on", "in", "to", "at", "by", "as", "vs"}
_BANNED = re.compile(r"[\u2014\u2013]|\b\d{4}-\d{2}-\d{2}\b|(?i:time ?card|timesheet)|\bGlobal Admin\b|\bIT Admin\b")
# Global Constraints, pinned in code so a course.json cannot lower them.
MIN_READING = {"nexus-fundamentals": 70, "self-storage-fundamentals": 120, "rv-boat-storage-fundamentals": 100,
               "cubby-fundamentals": 95, "customer-service-sales-fundamentals": 120, "hands-on-check": 5}
EST_MINUTES = {"nexus-fundamentals": 120, "self-storage-fundamentals": 210, "rv-boat-storage-fundamentals": 180,
               "cubby-fundamentals": 180, "customer-service-sales-fundamentals": 210, "hands-on-check": 90}


def _title_case(t: str) -> bool:
    return all(w[0].isupper() or not w[0].isalpha() or (i and w.lower() in _SMALL)
               for i, w in enumerate(t.split()))


def _quiz_problems(where: str, qs: list, norm_fn) -> list[str]:
    out = []
    for i, q in enumerate(qs):
        tag = f"{where} q{i + 1}"
        if q.get("type") == "photo":
            out.append(f"{tag}: photo questions are not allowed")
        if q.get("type") == "short" and any(re.search(r"\d", str(k)) for k in q.get("keywords") or []):
            out.append(f"{tag}: short question keywords contain a digit (use single choice)")
        if q.get("type") == "multi" and len(q.get("answer") or []) < 2:
            out.append(f"{tag}: multi question needs two or more answers (use single)")
        if len(str(q.get("q", ""))) > 600:
            out.append(f"{tag}: question over 600 characters")
        if len(str(q.get("explanation", ""))) > 400:
            out.append(f"{tag}: explanation over 400 characters")
        if len(q.get("options") or []) > 6:
            out.append(f"{tag}: more than 6 options")
        if any(len(str(o)) > 300 for o in q.get("options") or []):
            out.append(f"{tag}: option over 300 characters")
        for s in [q.get("q", ""), q.get("explanation", "")] + list(q.get("options") or []):
            if _BANNED.search(str(s)):
                out.append(f"{tag}: banned copy {_BANNED.search(str(s)).group(0)!r}")
    norm = norm_fn({"questions": qs})["questions"]
    if len(norm) != len(qs):
        out.append(f"{where}: normalizer changed the question count ({len(qs)} -> {len(norm)})")
        return out
    for i, (q, n) in enumerate(zip(qs, norm)):
        want_opts = list(q.get("options") or [])
        if q.get("type") == "tf" and not want_opts:
            want_opts = ["True", "False"]
        if (q.get("type", "single"), list(q.get("answer") or []), want_opts) != (n["type"], n["answer"], n["options"]):
            out.append(f"{where} q{i + 1}: normalizer changes its type, answer or options")
    return out


def problems(a: Academy) -> list[str]:
    from routers.kb_training import _norm_quiz  # lazy: importing the router needs the app environment
    import kb_media
    out = list(a.errors)

    def changed(blocks) -> bool:   # the importer stores what sanitize keeps; nothing may be dropped silently
        return kb_blocks.sanitize(blocks, image_ok=kb_media.is_storage_url) != blocks
    slugs = [c.slug for c in a.courses]
    if a.plan.get("courses") != ORDER or slugs != ORDER:
        out.append(f"plan/course slugs are not the six courses in order: plan={a.plan.get('courses')} courses={slugs}")
    for p in a.pages.values():
        if not _title_case(p.title):
            out.append(f"page {p.slug}: title not in Title Case")
        texts = [p.title, p.summary] + _all_text(p.blocks)
        out += [f"page {p.slug}: banned copy {m.group(0)!r}" for t in texts if (m := _BANNED.search(t))]
        if "cubby-filled" in p.tags and any("[Greens to fill]" in t for t in texts):
            out.append(f"page {p.slug}: [Greens to fill] left in a page Cubby data can fill")
        if any(t.startswith("> [!") for t in _texts(p.blocks)):
            out.append(f"page {p.slug}: callout written on one line, not converted")
        if changed(p.blocks):
            out.append(f"sanitize changes page {p.slug}")
    for c in a.courses:
        if len(c.lessons) > 60:
            out.append(f"{c.slug}: more than 60 lessons")
        minutes = 0
        for L in c.lessons:
            if not L["title"].strip():
                out.append(f"{c.slug}: a {L['type']} lesson has an empty title")
            elif not _title_case(L["title"]):
                out.append(f"{c.slug}: lesson title not in Title Case: {L['title']!r}")
            texts = [L["title"], L.get("summary", "")] + (_all_text(L["blocks"]) if L["type"] == "text" else [])
            out += [f"{c.slug} {L['title']!r}: banned copy {m.group(0)!r}" for t in texts if (m := _BANNED.search(t))]
            if L["type"] == "text":
                minutes += kb_blocks.reading_minutes(L["blocks"])
                if changed(L["blocks"]):
                    out.append(f"sanitize changes {c.slug} {L['title']!r}")
                if any(t.startswith("> [!") for t in _texts(L["blocks"])):
                    out.append(f"{c.slug} {L['title']!r}: callout written on one line, not converted")
            elif L["type"] == "page":
                if L["page"] not in a.pages:
                    out.append(f"{c.slug}: lesson page {L['page']!r} does not exist")
                else:
                    minutes += kb_blocks.reading_minutes(a.pages[L["page"]].blocks)
            else:
                qs = L["questions"]
                if len(qs) > 10:
                    out.append(f"{c.slug} {L['title']!r}: checkpoint has more than 10 questions")
                out += _quiz_problems(f"{c.slug} {L['title']!r}", qs, _norm_quiz)
        need = max(c.min_reading_minutes, MIN_READING.get(c.slug, 0))
        if minutes < need:
            out.append(f"{c.slug}: reading minutes {minutes} below {need}")
        if c.slug in EST_MINUTES and c.est_minutes != EST_MINUTES[c.slug]:
            out.append(f"{c.slug}: est_minutes {c.est_minutes} must be {EST_MINUTES[c.slug]}")
        qs = c.quiz.get("questions") or []
        if c.delivery != "in_person":
            dc = c.quiz.get("drawCount", 0)
            if len(qs) < 45:
                out.append(f"{c.slug}: quiz bank has {len(qs)} questions, needs 45 or more")
            if not 25 <= dc <= 40 or dc > len(qs):
                out.append(f"{c.slug}: drawCount {dc} must be 25-40 and within the bank")
        out += _quiz_problems(f"{c.slug} quiz", qs, _norm_quiz)
        for s in [c.title, c.description] + list(c.overview):
            if _BANNED.search(str(s)):
                out.append(f"{c.slug}: banned copy {_BANNED.search(str(s)).group(0)!r}")
    return out
