"""The Knowledge Base as a graph (Neil, 11/02/2026: "graph RAG ... connect
the data very smartly"). The links already exist in the data - a page's
See Also picks, the pages it embeds, the course that teaches it, the
collection it sits in, the departments it applies to, its tags - so the
graph needs no model to build and no index to keep: it is walked at read
time, inside the reader's wall, from the pages a search found.

Two uses, both without AI:
  * Ask Nexus and search hand the model (or, with AI off, the reader) the
    pages that match PLUS the pages those link to, each with a plain reason
    ("See Also from Gate Access", "Taught with it in Site Opening"). A
    question whose answer spans a policy, two SOPs and a course gets all of
    them, not the one page that happened to share the most words.
  * A page's rail shows the pages around it that nobody picked by hand.

The answer step (kb_ai.answer) stays behind the AI switch; this only changes
what it is handed. Every candidate goes through kb_access.readable, so a
walk never surfaces a title the reader may not see."""
from __future__ import annotations

from collections import defaultdict

from sqlalchemy.orm import Session

import kb_blocks
import kb_core
import models

# One hop. Scores say how strong a link is; the reasons are what a reader sees.
W_SEE_ALSO = 3.0
W_EMBED = 3.0
W_COURSE = 2.0
W_COLLECTION = 0.6
W_DEPARTMENT = 0.4
W_TAG = 0.5
_MAX_POOL = 2000


def _ids(csv: str) -> list[str]:
    return [x.strip() for x in (csv or "").split(",") if x.strip()]


def _tags(d: models.KbDocument) -> set[str]:
    return {t.strip().lower() for t in (d.tags or "").split(",") if t.strip()}


def _course_map(db: Session) -> dict[str, list[tuple[str, str]]]:
    """page id -> [(course id, course title)] for published courses."""
    out: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for c in db.query(models.KbCourse).filter(models.KbCourse.status == "published").all():
        for L in kb_core.lessons_of(c):
            pid = L.get("docId")
            if pid:
                out[pid].append((c.id, c.title or ""))
    return out


def neighbors(db: Session, seeds: list[models.KbDocument], pool: list[models.KbDocument], limit: int = 6) -> list[dict]:
    """Pages one link away from `seeds`, best first, each with `why`.
    `pool` is the readable, published set the caller already built; a page
    outside it is never returned, however strongly it links."""
    if not seeds or not pool:
        return []
    seed_ids = {s.id for s in seeds}
    by_id = {d.id: d for d in pool[:_MAX_POOL]}
    courses = _course_map(db)
    score: dict[str, float] = defaultdict(float)
    why: dict[str, list[str]] = defaultdict(list)

    weak_seen: set[tuple[str, str]] = set()

    def add(pid: str, w: float, reason: str, kind: str = "") -> None:
        """A strong link (See Also, embed, course) counts every time it is
        found; a weak one (collection, department, tag) counts once per page,
        so a shelf of forty pages never outranks the one page a seed links to."""
        if pid in seed_ids or pid not in by_id:
            return
        if kind:
            if (pid, kind) in weak_seen:
                return
            weak_seen.add((pid, kind))
        score[pid] += w
        if reason not in why[pid] and len(why[pid]) < 3:
            why[pid].append(reason)

    # reverse links need one pass over the pool: who points at a seed?
    for d in by_id.values():
        if d.id in seed_ids:
            continue
        for rid in _ids(d.related_ids):
            if rid in seed_ids:
                add(d.id, W_SEE_ALSO, f"Lists {by_id[rid].title if rid in by_id else 'it'} under See Also")
        if d.blocks and any(e in seed_ids for e in kb_blocks.embedded_page_ids(kb_blocks.loads(d.blocks))):
            add(d.id, W_EMBED, "Embeds it")

    for s in seeds:
        for rid in _ids(s.related_ids):
            add(rid, W_SEE_ALSO, f"See Also on {s.title}")
        if s.blocks:
            for eid in kb_blocks.embedded_page_ids(kb_blocks.loads(s.blocks)):
                add(eid, W_EMBED, f"Embedded in {s.title}")
        for cid, ctitle in courses.get(s.id, []):
            for pid, lst in courses.items():
                if any(c == cid for c, _ in lst):
                    add(pid, W_COURSE, f"Taught with it in {ctitle}")
        s_depts = set(kb_core.departments_of(s))
        s_tags = _tags(s)
        for d in by_id.values():
            if d.id in seed_ids:
                continue
            if s.collection_id and d.collection_id == s.collection_id:
                add(d.id, W_COLLECTION, "Same collection", kind="collection")
            shared_d = s_depts & set(kb_core.departments_of(d))
            if shared_d:
                add(d.id, W_DEPARTMENT, "Applies to " + ", ".join(sorted(shared_d)[:2]), kind="department")
            shared_t = s_tags & _tags(d)
            if shared_t:
                add(d.id, W_TAG * len(shared_t), "Tagged " + ", ".join(sorted(shared_t)[:2]), kind="tag")

    ranked = sorted(score.items(), key=lambda kv: (-kv[1], (by_id[kv[0]].title or "").lower()))
    out = []
    for pid, sc in ranked[:limit]:
        d = by_id[pid]
        out.append({"id": d.id, "code": d.doc_code or "", "title": d.title, "page_type": d.page_type or "how_to",
                    "version": d.version or "", "score": round(sc, 2), "why": "; ".join(why[pid])})
    return out
