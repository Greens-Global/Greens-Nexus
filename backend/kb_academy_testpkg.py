"""The minimal Storage Academy package the KB academy tests build (not a test file)."""
import json
from pathlib import Path

import kb_academy

SLUGS = kb_academy.ORDER


def _q(i):
    return {"type": "single", "q": f"Question {i}?", "options": ["A", "B"], "answer": [0], "explanation": "Because."}


def _pkg(tmp_path: Path, mutate=None) -> Path:
    cfg = {"plan": {"name": "P", "description": "d", "due_days": 30, "courses": list(SLUGS)},
           "page": "---\ntitle: Gate Codes\nsummary: s\npage_type: policy\ntags: a, b\n---\n\n## Codes\n\nText.\n",
           "lesson": "---\ntitle: Welcome Aboard\nsummary: s\n---\n\n## Hi\n\nHello there.\n",
           "lessons": [{"file": "01.md"}, {"page": "gate-codes", "title": "Gate Codes", "summary": "s"},
                       {"checkpoint": "Checkpoint: One", "questions": [_q(1), _q(2)]}],
           "quiz": {"passPct": 80, "drawCount": 25, "maxTries": 3, "questions": [_q(i) for i in range(45)]}}
    if mutate:
        mutate(cfg)
    (tmp_path / "pages").mkdir()
    (tmp_path / "pages" / "gate-codes.md").write_text(cfg["page"], encoding="utf-8")
    (tmp_path / "plan.json").write_text(json.dumps(cfg["plan"]), encoding="utf-8")
    for n, slug in enumerate(SLUGS, 1):
        d = tmp_path / "courses" / f"{n:02d}-{slug}"
        (d / "lessons").mkdir(parents=True)
        (d / "lessons" / "01.md").write_text(cfg["lesson"], encoding="utf-8")
        c = {"slug": slug, "title": "Course", "description": "d", "overview": ["o"], "est_minutes": kb_academy.EST_MINUTES[slug], "delivery": "online",
             "min_reading_minutes": 0, "lessons": cfg["lessons"], "quiz": cfg["quiz"]}
        if slug == "hands-on-check":
            c.update(delivery="in_person", quiz={})
        (d / "course.json").write_text(json.dumps(c), encoding="utf-8")
    return tmp_path
