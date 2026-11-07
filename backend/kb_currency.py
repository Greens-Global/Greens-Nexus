"""Keeps Up (Neil, 11/07/2026): a course "automatically stays current as
the modules evolve".

A course says which Nexus modules it teaches (`kb_courses.teaches`:
"Workday, Time Clock"; a lesson may say its own in `teaches`). Every day
the pass below reads What's New for Released entries about those modules
that are newer than the course's last review (`reviewed_at`, else its
publish) and, when it finds any, writes them into `review_flag` and bells
the course owner once. The author then either edits and publishes (a
publish is a review) or clicks Mark Reviewed. Learners never see the
flag; they see "Reviewed <date>" on the course home.

The same tag powers the Help panel's Learn This Screen card
(`GET /kb/learn?module=`) - `teaches(course, module)` below is the one
matching rule for both.
"""
from __future__ import annotations

import json
import re

import kb_core
import models

_NORM = re.compile(r"[^a-z0-9]+")
# Words a What's New module name and a course tag may use for one thing.
_ALIASES = {
    "timeclock": "workday", "timesheet": "workday", "timesheets": "workday", "timeoff": "workday", "myhr": "workday", "askhr": "workday",
    "helpcenter": "help", "support": "help", "knowledgebase": "training", "kb": "training", "learning": "training", "courses": "training",
    "itemmanagement": "items", "inventory": "items", "equipment": "items",
    "shiftplanner": "shifts", "schedule": "shifts", "scheduling": "shifts", "team": "shifts",
    "assetmanagement": "assets", "propertyasset": "assets", "property": "assets", "maintenance": "assets",
    "ticketdesk": "tickets", "reportaproblem": "tickets",
    "home": "dashboard", "bell": "dashboard", "notifications": "dashboard",
    "vendors": "accounting", "intacct": "accounting", "finance": "accounting",
}


def us_date(iso: str) -> str:
    """MM/DD/YYYY from an ISO timestamp or day; the copy rule."""
    d = (iso or "")[:10]
    return f"{d[5:7]}/{d[8:10]}/{d[0:4]}" if len(d) == 10 and d[4] == "-" else iso


def norm(name: str) -> str:
    key = _NORM.sub("", (name or "").lower())
    return _ALIASES.get(key, key)


def same_module(a: str, b: str) -> bool:
    """Two module names mean the same screen: equal after normalizing, or
    one is the other's prefix ("Workday" and "Workday Time Sheet")."""
    x, y = norm(a), norm(b)
    return bool(x and y) and (x == y or x.startswith(y) or y.startswith(x))


def teaches(course: models.KbCourse, module: str) -> bool:
    return any(same_module(t, module) for t in (course.teaches or "").split(",") if t.strip())


def _released(db) -> list[dict]:
    """Every Released What's New entry as {id, title, module, at}."""
    out = []
    for e in db.query(models.TaskChangelogEntry).all():
        p = e.payload if isinstance(e.payload, dict) else {}
        if p.get("status") != "Released" or not p.get("module"):
            continue
        out.append({"id": e.id, "title": str(p.get("title") or "Update")[:200], "module": str(p.get("module") or "")[:60],
                    "at": str(p.get("releasedAt") or e.created_at or "")})
    return out


def changes_for(course: models.KbCourse, released: list[dict]) -> list[dict]:
    since = course.reviewed_at or course.published_at or ""
    return sorted([r for r in released if r["at"] > since and teaches(course, r["module"])], key=lambda r: r["at"])


def run(db) -> int:
    """The daily pass: flag every published course a newer What's New entry
    touches; bell the owner once per new set. Returns courses flagged."""
    released = _released(db)
    if not released:
        return 0
    flagged = 0
    for c in db.query(models.KbCourse).filter(models.KbCourse.status == "published").all():
        if not (c.teaches or "").strip():
            continue
        changes = changes_for(c, released)
        if not changes:
            if c.review_flag:
                c.review_flag = ""
            continue
        flag = {"since": c.reviewed_at or c.published_at or "", "changes": [{k: r[k] for k in ("id", "title", "module", "at")} for r in changes[-8:]]}
        had = json.loads(c.review_flag) if c.review_flag else {}
        if {r["id"] for r in had.get("changes") or []} != {r["id"] for r in flag["changes"]}:
            c.review_flag = json.dumps(flag)
            c.updated_at = kb_core.now()
            newest = changes[-1]
            kb_core.notify(db, recipient=(c.owner_email or "").lower(), ntype="kb_review_request", title="Course May Need a Review",
                           body=f"What's New released \"{newest['title']}\" in {newest['module']} on {us_date(newest['at'])}; {c.title} teaches {newest['module']}.",
                           ref_id=c.id, item_name=c.title, sub=f"builder:{c.id}", dedupe_today=True)
        flagged += 1
    db.commit()
    return flagged
