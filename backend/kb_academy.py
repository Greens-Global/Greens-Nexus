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
         "cubby-fundamentals", "customer-service-sales-fundamentals", "hands-on-check",
         "property-vendor-management",   # the seventh course (Neil, 11/07/2026) is for managers, not on the new-hire plan
         "fundamentals-of-accounting", "intacct-fundamentals", "leading-with-nexus"]   # 11/07/2026: accounting, Intacct, leaders


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
    level: str = ""
    tags: str = ""
    teaches: str = ""        # Nexus modules the course teaches ("Workday, Time Clock"), for Keeps Up (11/07/2026)
    departments: str = ""    # the department it shelves under ('' = the Academy's)


@dataclass
class Academy:
    pages: dict = field(default_factory=dict)
    courses: list = field(default_factory=list)
    plan: dict = field(default_factory=dict)
    errors: list = field(default_factory=list)  # load-time findings, reported by problems()


def digest(root: Path = ROOT) -> str:
    """A fingerprint of the whole package: every file's path and bytes. The
    content pass (kb_academy_seed.apply_content_once) runs again whenever
    it changes, so a new lesson or course in the repository reaches the
    courses nobody edited."""
    import hashlib
    h = hashlib.sha256()
    for f in sorted(p for p in root.rglob("*") if p.is_file()):
        h.update(str(f.relative_to(root)).encode())
        h.update(b"\0")
        h.update(f.read_bytes())
        h.update(b"\0")
    return h.hexdigest()


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
                    lessons.append({"type": "text", "file": L["file"], "title": meta.get("title", ""), "summary": meta.get("summary", ""),
                                    "blocks": kb_md.to_blocks(body),
                                    "teaches": [t.strip() for t in str(meta.get("teaches", "")).split(",") if t.strip()]})
                elif "page" in L:
                    lessons.append({"type": "page", "page": L["page"], "title": L.get("title", ""), "summary": L.get("summary", "")})
                else:
                    lessons.append({"type": "checkpoint", "title": L.get("checkpoint", ""), "questions": L.get("questions", [])})
                # a stable id, so a question's `lesson` can point "Reread these" at it (lessonId)
                lessons[-1]["_id"] = f"l_{slug}_{len(lessons):02d}"
            quiz = c.get("quiz") or {}
            _link_questions(lessons, [q for L in lessons for q in L.get("questions") or []] + list(quiz.get("questions") or []))
            a.courses.append(CourseSpec(slug, c["title"], c.get("description", ""), c.get("overview", []), c.get("est_minutes", 0),
                                        c.get("delivery", ""), c.get("min_reading_minutes", 0), lessons, quiz,
                                        c.get("level", ""), c.get("tags", ""), c.get("teaches", ""), c.get("departments", "")))
        except (OSError, ValueError, KeyError, TypeError) as e:
            a.errors.append(f"{d.parent.name}: cannot load ({type(e).__name__}: {e})")
    return a


def _lesson_keys(L: dict) -> set:
    """What a question's `lesson` may name: the lesson file, a page slug, or a checkpoint title."""
    return {k for k in (L.get("file"), L.get("page"), L["title"] if L["type"] == "checkpoint" else None) if k}


def _link_questions(lessons: list, qs: list) -> None:
    """Set lessonId from an authored `lesson` key; an unknown name is left unlinked for problems()."""
    ids = {k: L["_id"] for L in lessons for k in _lesson_keys(L)}
    for q in qs:
        if isinstance(q, dict) and q.get("lesson") in ids:
            q["lessonId"] = ids[q["lesson"]]


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
        if node.get("type") == "figure":
            return kb_blocks.figure_text(node).split("\n")
        out = [node["text"]] if isinstance(node.get("text"), str) else []
        for v in node.values():
            out += _all_text(v)
        return out
    if isinstance(node, list):
        return [t for v in node for t in _all_text(v)]
    return []


_SMALL = {"a", "an", "the", "and", "or", "but", "for", "nor", "of", "on", "in", "to", "at", "by", "as", "vs"}
_LESSON_NUM = re.compile(r"\b[Ll]essons?\W{0,4}\d+")  # the player counts pages and checkpoints, so file numbers mislead


def _lesson_num(where: str, texts) -> list[str]:
    return [f"{where}: names a lesson by number ({m.group(0)!r}); use its title" for t in texts if (m := _LESSON_NUM.search(str(t)))]


_BANNED = re.compile(r"[\u2014\u2013]|\b\d{4}-\d{2}-\d{2}\b|(?i:time ?card|timesheet)|\bGlobal Admin\b|\bIT Admin\b")
GLOSSARY = "academy-glossary"
# Global Constraints, pinned in code so a course.json cannot lower them.
MIN_READING = {"nexus-fundamentals": 70, "self-storage-fundamentals": 100, "rv-boat-storage-fundamentals": 80,
               "cubby-fundamentals": 80, "customer-service-sales-fundamentals": 90, "hands-on-check": 5,
               "property-vendor-management": 60, "fundamentals-of-accounting": 50, "intacct-fundamentals": 35, "leading-with-nexus": 70}
EST_MINUTES = {"nexus-fundamentals": 120, "self-storage-fundamentals": 170, "rv-boat-storage-fundamentals": 140,
               "cubby-fundamentals": 150, "customer-service-sales-fundamentals": 170, "hands-on-check": 90,
               "property-vendor-management": 120, "fundamentals-of-accounting": 100, "intacct-fundamentals": 80, "leading-with-nexus": 150}


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
        out += _lesson_num(tag, [q.get("q", ""), q.get("explanation", "")] + list(q.get("options") or []))
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
    plan_courses = a.plan.get("courses") or []
    if slugs != ORDER or [s for s in ORDER if s in plan_courses] != plan_courses or not plan_courses:
        out.append(f"plan/course slugs are not the courses in order: plan={plan_courses} courses={slugs}")
    for p in a.pages.values():
        if not _title_case(p.title):
            out.append(f"page {p.slug}: title not in Title Case")
        texts = [p.title, p.summary] + _all_text(p.blocks)
        out += _lesson_num(f"page {p.slug}", texts + _texts(p.blocks))
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
            out += _lesson_num(f"{c.slug} {L['title']!r}", texts + (_texts(L["blocks"]) if L["type"] == "text" else []))
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
                elif L["page"] != GLOSSARY:   # the shared glossary is looked up, not read through
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
            if not 15 <= dc <= 40 or dc > len(qs):
                out.append(f"{c.slug}: drawCount {dc} must be 15-40 and within the bank")
        out += _quiz_problems(f"{c.slug} quiz", qs, _norm_quiz)
        known = set().union(*(_lesson_keys(L) for L in c.lessons)) if c.lessons else set()
        for q in qs + [q for L in c.lessons for q in L.get("questions") or []]:
            if q.get("lesson") and q["lesson"] not in known:
                out.append(f"{c.slug}: question {str(q.get('q', ''))[:60]!r} names lesson {q['lesson']!r}, which is not in the course")
        for s in [c.title, c.description] + list(c.overview):
            if _BANNED.search(str(s)):
                out.append(f"{c.slug}: banned copy {_BANNED.search(str(s)).group(0)!r}")
        if c.level not in ("foundations", "core", "advanced"):
            out.append(f"{c.slug}: level {c.level!r} must be foundations, core or advanced")
        for L in c.lessons:
            if L["type"] == "text":
                for b in L["blocks"].get("content") or []:
                    if b.get("type") == "figure":
                        for name in kb_blocks.figure_drawings(b):
                            if name not in kb_blocks.DRAWING_NAMES:
                                out.append(f"{c.slug} {L['title']!r}: no drawing named {name!r}")
    return out
