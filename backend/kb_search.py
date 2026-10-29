"""Knowledge Base search (Oct 2026 rebuild): on the server, over published
pages only, inside the caller's company wall.

Postgres: `to_tsvector('english', title + summary + content_text)` ranked
with ts_rank_cd, a title boost, a verified-recently boost, and prefix
matching so "unit key" finds "Unit keys". SQLite (local, tests): the same
scoring in Python. Both run the query through the synonym groups the Help
widget uses ("pto" finds "time off", "sop" finds "procedure") and offer a
did-you-mean from the page vocabulary when a word is one typo away.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from sqlalchemy import text as sql_text
from sqlalchemy.orm import Session

import models

SYNONYM_GROUPS = [
    ["time off", "pto", "vacation", "leave", "day off", "holiday", "sick", "sick day", "absence"],
    ["punch", "clock", "clock in", "clock out", "punch in", "punch out", "time clock", "timeclock", "check in"],
    ["break", "lunch", "lunch break"],
    ["time sheet", "timesheet", "timecard", "time card", "hours", "paycheck", "pay", "payroll", "pay period", "overtime"],
    ["shift", "shifts", "schedule", "roster", "rota"],
    ["item", "equipment", "laptop", "device", "hardware", "tool", "tools", "asset", "gear"],
    ["key", "keys", "lock", "locks", "padlock", "lockout", "overlock", "cylinder"],
    ["unit", "units", "locker", "space", "storage unit", "cubicle"],
    ["tenant", "tenants", "customer", "customers", "renter", "occupant"],
    ["move in", "movein", "move-in", "walkthrough", "walk through", "handover", "hand over"],
    ["move out", "moveout", "move-out", "vacate", "vacating"],
    ["gate", "gate code", "keypad", "access code", "entry code"],
    ["camera", "cameras", "cctv", "surveillance", "footage"],
    ["auction", "lien", "delinquent", "past due", "late fee", "collections"],
    ["rent", "rate", "rates", "pricing", "price", "discount", "promotion", "promo"],
    ["lease", "agreement", "contract", "rental agreement", "sign up", "signup"],
    ["payment", "pay rent", "autopay", "auto pay", "card", "credit card", "ach", "refund"],
    ["borrow", "checkout", "check out", "loan"],
    ["return", "give back", "hand back"],
    ["broken", "damaged", "not working", "faulty", "defective"],
    ["lost", "missing", "stolen"],
    ["purchase", "buy", "order", "procure", "requisition"],
    ["sign in", "log in", "login", "mfa", "two factor", "authenticator", "locked out"],
    ["password", "credential", "credentials", "passcode", "vault"],
    ["network", "vpn", "wifi", "internet", "connection", "outage"],
    ["ticket", "tickets", "help desk", "helpdesk", "issue", "incident"],
    ["signature", "sign", "esign", "e sign", "nexus sign", "signed"],
    ["document", "documents", "form", "pdf", "template"],
    ["file", "files", "folder", "upload", "egnyte", "download"],
    ["sop", "sops", "policy", "policies", "procedure", "playbook", "guide", "handbook", "manual", "how to", "howto"],
    ["course", "training", "learn", "lesson", "quiz", "onboarding", "certificate"],
    ["task", "tasks", "todo", "to do", "checklist"],
    ["safety", "hazard", "ppe", "injury", "incident report", "accident", "first aid"],
    ["fire", "extinguisher", "alarm", "evacuation", "emergency"],
    ["weather", "storm", "hurricane", "snow", "flood", "closure"],
    ["clean", "cleaning", "janitorial", "sweep", "trash", "pest", "pests"],
    ["maintenance", "repair", "fix", "vendor", "work order"],
    ["employee", "new hire", "staff", "coworker", "onboard"],
    ["manager", "supervisor", "boss", "approver", "reports to"],
    ["approve", "approval", "approvals", "reject", "decline"],
    ["accounting", "finance", "invoice", "expense", "reimbursement", "receipt"],
    ["marketing", "review", "reviews", "google review", "rating", "ads", "leads"],
    ["forgot", "forgotten", "missed", "wrong", "mistake", "correction"],
]
_STOP = {"the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "at", "by", "with", "is", "are", "how",
         "do", "i", "we", "you", "my", "our", "what", "when", "where", "does", "can", "should", "it", "this", "that"}
_WORD = re.compile(r"[a-z0-9]+")


def _stem(w: str) -> str:
    """A light English stem: good enough for ranking, deterministic."""
    w = w.lower()
    for suf in ("ings", "ing", "ies", "ied", "ers", "er", "ed", "es", "s"):
        if len(w) > len(suf) + 3 and w.endswith(suf):
            if suf == "ies" or suf == "ied":
                return w[:-3] + "y"
            return w[:-len(suf)]
    return w


def tokens(s: str) -> list[str]:
    return [t for t in _WORD.findall((s or "").lower()) if t not in _STOP]


_SYN: dict[str, set[str]] = {}
for _g in SYNONYM_GROUPS:
    _stems = {_stem(x) for x in _g}
    for _x in _g:
        _SYN.setdefault(_stem(_x), set()).update(_stems)
        for _w in _x.split():
            if len(_x.split()) > 1:
                _SYN.setdefault(_stem(_w), set()).add(_stem(_x))


def expand(q: str) -> tuple[list[str], list[str]]:
    """(query stems, synonym stems) for a query."""
    base = [_stem(t) for t in tokens(q)]
    syn: set[str] = set()
    ql = " ".join(tokens(q))
    for g in SYNONYM_GROUPS:
        for phrase in g:
            if len(phrase.split()) > 1 and phrase in ql:
                syn.update(_stem(x) for x in g)
    for b in base:
        syn.update(_SYN.get(b, ()))
    syn -= set(base)
    return base, sorted(syn)


# ----------------------------------------------------------------- scoring

def _score_text(title: str, summary: str, body: str, base: list[str], syn: list[str],
                verified_at: str, views: int) -> float:
    if not base:
        return 0.0
    t_toks = {_stem(x) for x in tokens(title)}
    s_toks = {_stem(x) for x in tokens(summary)}
    b_toks = {_stem(x) for x in tokens(body)}
    hit = 0.0
    for b in base:
        if b in t_toks:
            hit += 3.0
        elif any(x.startswith(b) for x in t_toks):
            hit += 2.0
        elif b in s_toks:
            hit += 1.5
        elif b in b_toks:
            hit += 1.0
        elif any(x.startswith(b) for x in b_toks):
            hit += 0.6
    if hit == 0:
        for s in syn:
            if s in t_toks:
                hit += 1.2
            elif s in b_toks or s in s_toks:
                hit += 0.5
        if hit == 0:
            return 0.0
    else:
        for s in syn:
            if s in t_toks or s in b_toks:
                hit += 0.25
    covered = sum(1 for b in base if b in t_toks or b in s_toks or b in b_toks or any(x.startswith(b) for x in b_toks))
    score = hit * (0.6 + 0.4 * covered / len(base))
    if verified_at:
        try:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(verified_at[:10] + "T00:00:00+00:00")).days
            if age < 180:
                score *= 1.1
        except ValueError:
            pass
    score += min(views or 0, 500) / 2000.0
    return score


def snippet(body: str, base: list[str], width: int = 180) -> str:
    body = re.sub(r"\s+", " ", body or "")
    if not body:
        return ""
    low = body.lower()
    pos = -1
    for b in base:
        i = low.find(b)
        if i >= 0 and (pos < 0 or i < pos):
            pos = i
    if pos < 0:
        return body[:width].rstrip() + ("..." if len(body) > width else "")
    start = max(0, pos - width // 3)
    end = min(len(body), start + width)
    s = body[start:end].strip()
    return ("..." if start > 0 else "") + s + ("..." if end < len(body) else "")


def did_you_mean(q: str, vocab: set[str]) -> str:
    """One-typo fixes against the page vocabulary ("unti" -> "unit")."""
    out = []
    changed = False
    for w in _WORD.findall((q or "").lower()):
        if len(w) < 4 or w in vocab:
            out.append(w)
            continue
        best = ""
        for v in vocab:
            if abs(len(v) - len(w)) > 1 or v[0] != w[0]:
                continue
            if _edit1(w, v):
                best = v
                break
        if best:
            out.append(best)
            changed = True
        else:
            out.append(w)
    return " ".join(out) if changed else ""


def _edit1(a: str, b: str) -> bool:
    if a == b:
        return False
    if len(a) == len(b):
        diff = [i for i in range(len(a)) if a[i] != b[i]]
        if len(diff) == 1:
            return True
        if len(diff) == 2 and diff[1] == diff[0] + 1 and a[diff[0]] == b[diff[1]] and a[diff[1]] == b[diff[0]]:
            return True
        return False
    if len(a) + 1 == len(b):
        a, b = b, a
    # a is longer by one
    for i in range(len(a)):
        if a[:i] + a[i + 1:] == b:
            return True
    return False


# ----------------------------------------------------------------- query

def search(db: Session, pages: list[models.KbDocument], q: str, limit: int = 30) -> dict:
    """Rank the given (already walled, already published-filtered) pages.
    Returns {results:[{id, score, snippet}], also_matched:[...], did_you_mean}."""
    base, syn = expand(q)
    results = []
    vocab: set[str] = set()
    for d in pages:
        title = d.title or ""
        body = d.content_text or ""
        vocab.update(_WORD.findall(title.lower()))
        sc = _score_text(title, d.summary or "", body, base, syn, d.verified_at or "", d.views or 0)
        if sc > 0:
            results.append((sc, d))
    results.sort(key=lambda x: (-x[0], (x[1].title or "").lower()))
    out = [{"id": d.id, "score": round(sc, 3), "snippet": snippet(d.content_text or "", base)} for sc, d in results[:limit]]
    also = [s.replace("_", " ") for s in syn if any(s in (d.content_text or "").lower() or s in (d.title or "").lower() for _, d in results[:limit])][:6]
    dym = did_you_mean(q, vocab) if not out else ""
    return {"results": out, "also_matched": also, "did_you_mean": dym, "stems": base}


def pg_candidates(db: Session, q: str, limit: int = 200) -> list[str] | None:
    """On Postgres, narrow to candidate ids with full-text search before the
    Python ranking; None = not Postgres (rank everything)."""
    if db.bind is None or db.bind.dialect.name != "postgresql":
        return None
    base, syn = expand(q)
    terms = [t for t in base if t]
    if not terms:
        return []
    parts = [f"{t}:*" for t in terms] + [f"{s.split()[0]}:*" for s in syn if s]
    tsq = " | ".join(dict.fromkeys(parts))
    try:
        rows = db.execute(sql_text(
            "SELECT id FROM kb_documents WHERE status = 'approved' AND "
            "to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(content_text,'')) "
            "@@ to_tsquery('english', :q) LIMIT :n"), {"q": tsq, "n": limit}).fetchall()
        return [r[0] for r in rows]
    except Exception:  # noqa: BLE001 - a bad tsquery falls back to Python ranking
        db.rollback()
        return None


def log_miss(db: Session, q: str, results: int, user_email: str, source: str = "kb", floor: int = 3) -> None:
    """Remember a search that found nothing good (Health screen). `floor`:
    a search with at least this many results is not a miss (the Knowledge
    Base counts under three; the Help panel counts only none at all, and
    passes 10**6 for "always", e.g. searched and then filed a ticket)."""
    q = (q or "").strip()[:200]
    if not q or results >= floor:
        return
    source = source or "kb"
    day = datetime.now(timezone.utc).date().isoformat()
    same_box = models.KbSearchLog.source == source
    if source == "kb":   # rows from before the column read as the Knowledge Base's
        same_box = same_box | (models.KbSearchLog.source == None)  # noqa: E711
    row = (db.query(models.KbSearchLog)
           .filter(models.KbSearchLog.query == q.lower(), models.KbSearchLog.day == day, same_box)
           .first())
    if row:
        row.count = (row.count or 0) + 1
        row.results = max(row.results or 0, results)
        row.last_user = user_email
    else:
        import uuid
        db.add(models.KbSearchLog(id=uuid.uuid4().hex, query=q.lower(), day=day, count=1, results=results,
                                  last_user=user_email, source=source))


def misses(db: Session, days: int = 30, limit: int = 20, sources: tuple[str, ...] | None = None) -> list[dict]:
    """Top missed searches, one row per (query, search box). `sources` narrows
    it (the Help Signals list reads the Help Center's boxes only)."""
    since = (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()
    rows = db.query(models.KbSearchLog).filter(models.KbSearchLog.day >= since).all()
    agg: dict[tuple, dict] = {}
    for r in rows:
        src = r.source or "kb"
        if sources and src not in sources:
            continue
        a = agg.setdefault((r.query, src), {"query": r.query, "source": src, "count": 0, "last_day": "", "results": 0})
        a["count"] += r.count or 0
        a["last_day"] = max(a["last_day"], r.day or "")
        a["results"] = max(a["results"], r.results or 0)
    out = sorted(agg.values(), key=lambda a: (-a["count"], a["query"]))
    return out[:limit]
