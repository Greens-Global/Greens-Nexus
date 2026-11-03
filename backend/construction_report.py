"""Weekly report generation - the executive deliverable.

SECTION SET matches the supplied sample report (Sagar, Aug 5): four sections on
page one, then a photo log. `sections` is keyed jsonb precisely so a renamed
heading does not invalidate stored content - which is what made replacing the
earlier fifteen-section guess cheap.

THE THREE-PART SECTION SHAPE is the important design here. Every section stores:
    ai_text   what the model wrote
    text      what the manager made it
    sources   the log and media ids it was derived from
Losing any one breaks a different thing. Drop ai_text and "regenerate" cannot
show what changed. Drop text and the manager's edit is gone. Drop sources and
nobody can answer "where did this number come from" three months later, in a
meeting, about a report that went to an investor.

A report is built from APPROVED logs only. A submitted-but-unreviewed log has
not had a second person look at it, and the whole review gate exists so that
nothing reaches an executive unchecked.
"""
import json
import os
from datetime import date, datetime, timedelta

import httpx

import models

_API = "https://api.anthropic.com/v1/messages"
_MODEL = "claude-opus-5"
_TIMEOUT = 180

# Order is the report's running order. Keys are stable; labels are display only.
#
# THESE FOUR ARE THE SUPPLIED SAMPLE REPORT, not an invention. An earlier version
# of this file had fifteen sections built from a written description because the
# sample "was referenced repeatedly but never supplied" (the note this docstring
# used to carry). The sample arrived on Aug 5 and disagreed: one "Summary of
# Progress" rather than five separate narrative headings, RFIs and submittals
# COMBINED under one heading, and no stats table, no per-section daily-log
# listing, no separate executive summary page.
#
# Three of the four are row-derived, and that is the point of the format: the
# only prose the model writes is the progress summary. A milestone date or an
# RFI number restated by a model is a transcription error waiting to be quoted
# in a claim.
SECTIONS = [
    ("summary_of_progress", "Summary of Progress:"),
    ("rfis_and_submittals", "RFI's and Submittals"),
    ("cost_exposures", "Cost Exposures"),
    ("critical_milestones", "Critical Milestones"),
    # Real health (Neil, 11/03/2026, plan phase 3): four more row-derived
    # sections after the sample's four - where the job stands (Late / At
    # Risk / On Track, from construction_health), the punch list, the change
    # orders and the weather and other delays the crew logged. Every line is
    # assembled from rows; nothing is written by a model.
    ("job_health", "Schedule and Health"),
    ("punch_list", "Punch List"),
    ("change_orders", "Change Orders"),
    ("weather_and_delays", "Weather and Delays"),
]

HEALTH_WORDS = {"late": "Late", "at_risk": "At Risk", "on_track": "On Track", "complete": "Complete"}
CO_WORDS = {"draft": "Draft", "awaiting_approval": "Awaiting Approval", "sent": "Sent", "signed": "Signed",
            "declined": "Declined", "void": "Void"}

# The one section the model writes. Everything else is assembled from rows.
_NARRATIVE = ("summary_of_progress",)


def week_bounds(week_start: str) -> tuple:
    d = date.fromisoformat(week_start)
    return week_start, (d + timedelta(days=6)).isoformat()


def _us(iso) -> str:
    """'2026-10-04' -> '10/04/2026' for report text people read."""
    try:
        return date.fromisoformat(str(iso or "")[:10]).strftime("%m/%d/%Y")
    except ValueError:
        return str(iso or "")


def _now() -> str:
    from datetime import timezone
    return datetime.now(timezone.utc).isoformat()


def gather(db, project, week_start: str) -> dict:
    """Everything the week actually contains. Pure reads - no AI, no writes.

    Separated from drafting so the rollup is testable and so a regenerate does
    not re-query on a different basis than the original."""
    start, end = week_bounds(week_start)
    logs = (db.query(models.ConstructionDailyLog)
            .filter(models.ConstructionDailyLog.project_id == project.id,
                    models.ConstructionDailyLog.log_date >= start,
                    models.ConstructionDailyLog.log_date <= end,
                    models.ConstructionDailyLog.status == "approved",
                    models.ConstructionDailyLog.deleted_at == "")
            .order_by(models.ConstructionDailyLog.log_date).all())
    log_ids = [l.id for l in logs]
    media = (db.query(models.ConstructionMedia)
             .filter(models.ConstructionMedia.daily_log_id.in_(log_ids or [""]),
                     models.ConstructionMedia.deleted_at == "",
                     models.ConstructionMedia.duplicate_of == "").all()) if log_ids else []
    # Milestones come from the job's task project once it has one (Neil,
    # 11/03/2026 - construction_tasks; the old rows were moved in and kept).
    import construction_tasks
    milestones = construction_tasks.task_milestones(db, project)
    if milestones is None:
        milestones = (db.query(models.ConstructionMilestone)
                      .filter(models.ConstructionMilestone.project_id == project.id,
                              models.ConstructionMilestone.deleted_at == "").all())
    rfis = (db.query(models.ConstructionRfi)
            .filter(models.ConstructionRfi.project_id == project.id,
                    models.ConstructionRfi.deleted_at == "").all())
    subs = (db.query(models.ConstructionSubmittal)
            .filter(models.ConstructionSubmittal.project_id == project.id,
                    models.ConstructionSubmittal.deleted_at == "").all())

    # Job photos (the timeline's, no daily log) taken this week join the
    # approved logs' (11/03/2026), and the before / after pairs among them.
    import construction_field
    tz = construction_field._zone(db, project)
    job_photos = [m for m in db.query(models.ConstructionMedia).filter(
        models.ConstructionMedia.project_id == project.id, models.ConstructionMedia.daily_log_id == "",
        models.ConstructionMedia.deleted_at == "", models.ConstructionMedia.kind == "photo").all()
        if start <= construction_field.local_day_of(m.taken_at or m.uploaded_at or "", tz) <= end]
    media = media + [m for m in job_photos if m.id not in {x.id for x in media}]
    in_week = {m.id for m in media}
    pairs = [pr for pr in db.query(models.ConstructionPhotoPair).filter(
        models.ConstructionPhotoPair.project_id == project.id, models.ConstructionPhotoPair.deleted_at == "").all()
        if pr.before_media_id in in_week and pr.after_media_id in in_week]
    health = _health(db, project, milestones, rfis)
    punch = _punch(db, project)
    cos = (db.query(models.ConstructionChangeOrder)
           .filter(models.ConstructionChangeOrder.project_id == project.id,
                   models.ConstructionChangeOrder.deleted_at == "").all())
    delays = construction_field.delay_summary(logs)
    import construction_labor
    worked = construction_labor.hours(db, project, date_from=start, date_to=end)

    photos = [m for m in media if m.kind == "photo"]
    videos = [m for m in media if m.kind == "video"]
    return {
        "logs": logs, "media": media, "photos": photos, "videos": videos,
        "milestones": milestones, "rfis": rfis, "submittals": subs,
        "pairs": pairs, "health": health, "punch": punch, "changeOrders": cos, "delays": delays,
        "labor": worked, "today": health.get("today") or end,
        "stats": {
            "logs": len(logs),
            "photos": len(photos),
            "videos": len(videos),
            # Crew-days, not headcount: the same six people on five days is
            # thirty crew-days of exposure, which is the number a schedule
            # argument actually turns on.
            "crewDays": sum(l.crew_size or 0 for l in logs),
            "hours": round(sum(l.hours_worked or 0.0 for l in logs), 1),
            "safetyFlags": sum(len(l.ai_safety_flags or []) for l in logs),
            "delayFlags": sum(len(l.ai_delay_flags or []) for l in logs),
            "openRfis": len([r for r in rfis if r.status == "open"]),
            "pendingSubmittals": len([s for s in subs if s.status in ("pending", "submitted")]),
            # Real health (11/03/2026): from the rows, never the crew's guess.
            "health": health.get("state") or "",
            "crewDaysPunched": len(worked.get("rows") or []),
            "hoursPunched": worked.get("total") or 0,
            "punchOpen": punch.get("open", 0), "punchDone": punch.get("done", 0),
            "punchVerified": punch.get("verified", 0),
            "delayHours": delays.get("total", 0), "weatherDelayHours": delays.get("weather", 0),
            "changeOrdersSigned": len([c for c in cos if c.status == "signed"]),
            "changeOrdersPending": len([c for c in cos if c.status in ("draft", "awaiting_approval", "sent")]),
            "pairs": len(pairs),
        },
        "weekStart": start, "weekEnd": end,
    }


def _health(db, project, milestones, rfis) -> dict:
    """construction_health on the job's rows and the jobsite's today."""
    import construction_company
    import construction_health
    L = models.ConstructionDailyLog
    from sqlalchemy import func
    last = (db.query(func.max(L.log_date)).filter(L.project_id == project.id, L.deleted_at == "",
                                                  L.status != "draft").scalar()) or ""
    return construction_health.health(project, milestones=milestones or [], rfis=rfis or [],
                                      last_log_date=last, today=construction_company.local_today(db, project))


def _punch(db, project) -> dict:
    """The job's punch counts from its task project ({} counts 0 without one)."""
    import construction_tasks
    tp = construction_tasks.task_project(db, project)
    if tp is None:
        return {"open": 0, "done": 0, "verified": 0, "total": 0}
    sec = construction_tasks.punch_section(db, tp, create=False)
    ver = construction_tasks.verified_status(db, tp, create=False)
    return construction_tasks.punch_counts(construction_tasks.project_tasks(db, tp),
                                           sec.id if sec else "", ver.id if ver else "")


def _days_open(r, today: str) -> int:
    try:
        since = date.fromisoformat((getattr(r, "submitted_on", "") or getattr(r, "created_at", "") or "")[:10])
        return max(0, (date.fromisoformat(today[:10]) - since).days)
    except ValueError:
        return 0


def _money(v) -> str:
    v = float(v or 0)
    return f"{'-' if v < 0 else '+'}${abs(v):,.2f}"


def money_sections(report, with_cost: bool) -> dict:
    """The report's sections for one reader: with_cost (routers.construction.
    _may_see_cost) gets the change orders' dollar lines in place of the
    stored counts-only text - unless a manager edited that section."""
    sections = dict(report.sections or {})
    if not with_cost:
        return sections
    m = next((x for x in (report.cost_exposure or []) if isinstance(x, dict) and x.get("kind") == "change_orders"), None)
    sec = sections.get("change_orders")
    if m and sec and (sec.get("text") or "") == (m.get("plain") or ""):
        sections["change_orders"] = {**sec, "text": m.get("money") or sec.get("text"), "ai_text": m.get("money") or sec.get("ai_text")}
    return sections


def report_pairs(db, report) -> list:
    """[(pair, before, after)] for the pairs a report keeps, both photos live."""
    out = []
    for pid in (getattr(report, "pair_ids", None) or []):
        pr = db.get(models.ConstructionPhotoPair, pid)
        if pr is None or pr.deleted_at or pr.project_id != report.project_id:
            continue
        a = db.get(models.ConstructionMedia, pr.before_media_id)
        b = db.get(models.ConstructionMedia, pr.after_media_id)
        if a is None or b is None or a.deleted_at or b.deleted_at:
            continue
        out.append((pr, a, b))
    return out


_SYSTEM = """You write the weekly construction report that a project manager reviews and an executive or investor reads. Your input is a week of daily logs that a manager has already approved.

This document can end up attached to a pay application or a delay claim. Write accordingly:

- Every statement must trace to the logs you were given. If the logs do not support a claim, leave it out. Do not round up, do not smooth over a bad week, and do not infer that work is complete because it was photographed.
- Never invent a percentage, a quantity, a cost, or an inspection outcome. If the evidence contains no number, the sentence contains no number.
- Distinguish completed from ongoing. "Footings poured at the north wall" is completed; "formwork continuing on the east elevation" is ongoing. A reader making a schedule decision needs that line to be exact.
- Upcoming work comes from what the crews said is next, not from what you assume follows.
- Summary of Progress is a BULLET LIST, one activity per bullet, in the register of the sample report: "Completed waterproofing on walls.", "Continued quality control review of MEP, structural, and civil designs.", "Ongoing coordination with utility providers (electrical, gas, and communications)." Lead each bullet with its state - Completed, Continued, Ongoing, Finished, Excavated, Re-bidding - so a reader scanning only the first word knows what moved. One sentence each, ending in a period. Do not number them and do not nest them.
- Report safety and delay flags plainly, without softening. A manager can edit tone; they cannot recover a risk you decided not to mention.
- A thin week is a thin report. If four days had no logs, say the week is sparsely documented rather than padding it.

Tone: plain professional English, past tense for what happened, American spelling. Never use em dashes; use plain hyphens. No marketing language, no "successfully", no "we are pleased to report".

The executive summary is the only section written for someone who will read nothing else: three or four sentences covering where the project stands, what moved this week, and what needs a decision."""

_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "description": "Report title, e.g. 'Week of Aug 4 - Foundation'"},
        # An array, not a paragraph: the sample report's Summary of Progress is a
        # bullet list, one activity per line, and asking for prose and then
        # splitting it produces bullets that read like broken sentences.
        "summary_of_progress": {
            "type": "array",
            "items": {"type": "string"},
            "description": "One bullet per activity. Each stands alone as a complete statement.",
        },
        "executive_summary": {"type": "string"},
        "risks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "risk": {"type": "string"},
                    "severity": {"type": "string", "enum": ["low", "medium", "high"]},
                    "mitigation": {"type": "string"},
                },
                "required": ["risk", "severity", "mitigation"],
                "additionalProperties": False,
            },
        },
        "recommendations": {"type": "array", "items": {"type": "string"}},
        "sparse": {"type": "boolean", "description": "True when the week is thinly documented."},
    },
    "required": ["title", "summary_of_progress", "executive_summary", "risks",
                 "recommendations", "sparse"],
    "additionalProperties": False,
}


def _evidence(project, data: dict) -> str:
    """The prompt payload. Captions rather than images: the photos were already
    described at capture time, and re-sending 40 images per week would multiply
    the cost of every regenerate for no added signal."""
    p = [f"Project: {project.name}",
         f"Phase: {project.phase or 'not set'}",
         f"Week: {_us(data['weekStart'])} to {_us(data['weekEnd'])}",
         f"Approved daily logs: {data['stats']['logs']}",
         f"Crew-days: {data['stats']['crewDays']}   Hours: {data['stats']['hours']}",
         ""]
    for l in data["logs"]:
        p.append(f"--- {_us(l.log_date)} ({l.author_email}) ---")
        if l.notes_raw:
            p.append(f"Worker note: {l.notes_raw}")
        if l.ai_summary:
            p.append(f"Summary: {l.ai_summary}")
        for w in (l.ai_work_completed or []):
            p.append(f"  done: {w.get('activity','')} [{w.get('trade','')}] @ {w.get('location','')}")
        for s in (l.ai_safety_flags or []):
            p.append(f"  SAFETY ({s.get('severity','')}): {s.get('issue','')}")
        for d in (l.ai_delay_flags or []):
            p.append(f"  DELAY: {d.get('cause','')} ({d.get('impact_days',0)} days)")
        for n in (l.ai_next_work or []):
            p.append(f"  next: {n}")
        p.append("")
    caps = [m.caption or m.ai_caption for m in data["media"] if (m.caption or m.ai_caption)]
    if caps:
        p.append("Media captions this week:")
        p += [f"  - {c}" for c in caps[:60]]
    if not data["logs"]:
        p.append("(No approved logs this week. Say so plainly and set sparse=true.)")
    return "\n".join(p)


def draft(project, data: dict) -> dict:
    """The AI narrative. Raises on failure - the caller decides what to store."""
    key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    body = {
        "model": _MODEL, "max_tokens": 12000, "system": _SYSTEM,
        "messages": [{"role": "user", "content": [{"type": "text", "text": _evidence(project, data)}]}],
        "thinking": {"type": "adaptive"},
        # max effort: this is the document that leaves the company.
        "output_config": {"effort": "max", "format": {"type": "json_schema", "schema": _SCHEMA}},
        # See construction_ai._call - safety incidents and site hazards are the
        # report's actual subject matter, and a refusal here fails a manager's
        # Generate button on the deliverable itself.
        "fallbacks": "default",
    }
    with httpx.Client(timeout=_TIMEOUT) as c:
        r = c.post(_API, headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                                  "anthropic-beta": "server-side-fallback-2026-07-01",
                                  "content-type": "application/json"}, json=body)
    if r.status_code >= 400:
        raise RuntimeError(f"Anthropic {r.status_code}: {r.text[:300]}")
    out = r.json()
    if out.get("stop_reason") == "refusal":
        raise RuntimeError("Anthropic declined this request")
    text = next((b.get("text", "") for b in out.get("content", []) if b.get("type") == "text"), "")
    if not text:
        raise RuntimeError("Anthropic returned no text block")
    return json.loads(text)


def configured() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY", "").strip())


def draft_offline(project, data: dict) -> dict:
    """The report without a model. Same return shape as draft().

    Follows the old per-page help (routers/help.py, removed Oct 2026), which returned `_fallback()` and tagged the result
    `source='fallback'` rather than failing when no key is set. Before this,
    generate_report answered 502 with no key at all - so the module could not be
    exercised on a laptop, and a manager could not produce the week's report if
    the Anthropic API was down on a Friday afternoon.

    Only Summary of Progress is affected. The other three sections were always
    assembled from rows, so they come out identical either way - which is most of
    the document, and exactly the part that must not be paraphrased.

    Bullets are the workers' own words, one per approved log, deliberately NOT
    massaged into report register. A reader must be able to tell at a glance that
    nothing wrote this."""
    bullets = []
    for l in data["logs"]:
        line = (l.notes_raw or "").strip().replace("\n", " ")
        if not line:
            done = [w.get("activity", "") for w in (l.ai_work_completed or []) if w.get("activity")]
            line = ", ".join(done)
        if line:
            if not line.endswith("."):
                line += "."
            bullets.append(f"{_us(l.log_date)}: {line}")
    if not bullets:
        bullets = ["No approved daily logs were filed for this week."]
    week = f"{_us(data['weekStart'])} to {_us(data['weekEnd'])}"
    return {
        "title": f"Construction Update - week of {_us(data['weekStart'])}",
        "summary_of_progress": bullets,
        "executive_summary": (
            f"{project.name}, {week}. {data['stats']['logs']} approved daily log(s), "
            f"{data['stats']['crewDays']} crew-days, {data['stats']['hours']} hours. "
            "Written without AI assistance - the daily notes are reproduced as filed."),
        "risks": [], "recommendations": [],
        "sparse": data["stats"]["logs"] < 3,
        "source": "fallback",
    }


def _section(ai_text: str, sources: list) -> dict:
    return {"ai_text": ai_text or "", "text": ai_text or "", "sources": sources,
            "edited_by": "", "edited_at": ""}


def _milestone_line(m) -> str:
    """"All columns complete 06/30/2026" - the sample's shape: what, then when.

    Prefers the ACTUAL date once one is set, because a hit milestone is reported
    by the day it landed, not the day it was aimed at. Always MM/DD/YYYY
    (11/03/2026 - US formats everywhere; "6/30/27" read as a typo)."""
    when = (m.actual_date or m.target_date or "").strip()
    if when:
        when = _us(when)
    label = (m.name or "").strip() or "Unnamed milestone"
    return f"{label} {when}".strip()


def assemble(db, project, data: dict, ai: dict) -> dict:
    """AI narrative + row-derived sections -> the stored `sections` map.

    Row-derived sections are NOT written by the model. Handing it a milestone
    table and asking it to restate one introduces transcription errors into the
    only part of the report that is already exact.

    Every section gets real `text`. That is a fix, not a detail: these three used
    to be stored with sources and an empty string, and construction_pdf skips a
    section whose text is empty - so Critical Milestones, RFIs and Submittals,
    and Cost Exposures never appeared in a single rendered report. Three of the
    four sections in the sample document were silently missing.

    One line per bullet; the PDF splits on newlines."""
    log_src = [{"type": "log", "id": l.id} for l in data["logs"]]

    s = {}
    # The model returns bullets as a list; store them as lines so `text` stays a
    # plain string that a manager can edit in one textarea.
    bullets = ai.get("summary_of_progress") or []
    if isinstance(bullets, str):
        bullets = [b for b in bullets.split("\n") if b.strip()]
    s["summary_of_progress"] = _section("\n".join(b.strip() for b in bullets if b.strip()), log_src)

    # RFIs and submittals share one heading in the sample, RFIs first.
    # Open RFIs by age, oldest first, each with its status (11/03/2026): an
    # RFI's lag is what costs schedule. Answered and closed ones follow.
    today = data.get("today") or data["weekEnd"]
    live = [r for r in data["rfis"] if (r.status or "open") != "void"]
    live.sort(key=lambda r: (0 if (r.status or "open") == "open" else 1, -_days_open(r, today)))

    def _rfi_line(r):
        head = f"RFI# {r.number or '(no number)'}- {r.subject or 'Untitled'}".strip()
        st = (r.status or "open").title()
        if (r.status or "open") == "open":
            age = _days_open(r, today)
            bits = [st, f"{age} day{'s' if age != 1 else ''} open"]
            due = getattr(r, "due_on", "") or ""
            if due:
                bits.append(("overdue since " if due < today[:10] else "due ") + _us(due))
            return f"{head} ({', '.join(bits)})"
        return f"{head} ({st})"
    rfi_lines = [_rfi_line(r) for r in live]
    sub_lines = [f"Submittal-{x.number or '(no number)'}-{x.title or 'Untitled'}".strip()
                 for x in data["submittals"]]
    s["rfis_and_submittals"] = _section(
        "\n".join(rfi_lines + sub_lines) or "None currently.",
        [{"type": "rfi", "id": r.id} for r in data["rfis"]]
        + [{"type": "submittal", "id": x.id} for x in data["submittals"]])

    # "None currently." is what the sample prints for an empty week, and it is a
    # meaningfully different statement from an absent heading: it says somebody
    # looked, which is the whole reason the section is printed at all.
    #
    # Always the default on generate. Cost exposure is not derivable from daily
    # logs and is not something the model may guess at - a manager types it into
    # this section afterwards, and their edit lands in `text` and survives.
    s["cost_exposures"] = _section("None currently.", [])

    s["critical_milestones"] = _section(
        "\n".join(_milestone_line(m) for m in sorted(
            data["milestones"], key=lambda m: (m.actual_date or m.target_date or "9999")))
        or "None currently.",
        [{"type": "milestone", "id": m.id} for m in data["milestones"]])

    h = data.get("health") or {}
    if h:
        lines = [f"Status: {HEALTH_WORDS.get(h.get('state'), 'On Track')}"
                 + (f" - {'; '.join(h.get('reasons') or [])}" if h.get("reasons") else "")]
        pct = round(project.percent_complete or 0)
        exp = h.get("expectedPercent")
        lines.append(f"Percent complete: {pct}%" + (f" (the schedule expects {exp}%)" if exp is not None else ""))
        if project.target_finish_on:
            lines.append(f"Target finish: {_us(project.target_finish_on)}")
        nxt = h.get("nextMilestone")
        if nxt:
            lines.append(f"Next milestone: {nxt.get('name') or 'Milestone'} {_us(nxt.get('targetDate'))} "
                         f"(in {nxt.get('days')} day{'s' if nxt.get('days') != 1 else ''})")
        hit = [m for m in data["milestones"] if (m.status or "") == "hit"
               and data["weekStart"] <= (m.actual_date or "")[:10] <= data["weekEnd"]]
        for m in hit:
            lines.append(f"Milestone reached: {m.name} {_us(m.actual_date)}")
        st = data["stats"]
        lines.append(f"Crew-days from Time Clock punches: {st.get('crewDaysPunched', 0)} "
                     f"({st.get('hoursPunched', 0)} hours)")
        s["job_health"] = _section("\n".join(lines), [{"type": "milestone", "id": m.id} for m in data["milestones"]])
    else:
        s["job_health"] = _section("None currently.", [])

    pc = data.get("punch") or {}
    s["punch_list"] = _section(
        (f"{pc.get('open', 0)} open, {pc.get('done', 0)} done, {pc.get('verified', 0)} verified "
         f"({pc.get('total', 0)} in all)") if pc.get("total") else "None currently.", [])

    # Money is per reader (review H1, 11/03/2026): the STORED text carries
    # counts and days only - a crew member reads published reports. The
    # dollar version of the same lines is kept in `cost_exposure` (never in
    # report_to_dict) and swapped in by money_sections() for a reader who may
    # see the contract value.
    cos = sorted(data.get("changeOrders") or [], key=lambda c: c.number or "")
    plain, money = [], []
    for c in cos:
        if c.status == "void":
            continue
        bits = [CO_WORDS.get(c.status, c.status.title())]
        if c.status == "signed" and c.signed_at:
            bits.append(_us(c.signed_at))
        if c.schedule_impact_days:
            bits.append(f"{c.schedule_impact_days:+d} day{'s' if abs(c.schedule_impact_days) != 1 else ''}")
        head = f"{c.number or 'CO'} {c.title or 'Change Order'}"
        plain.append(f"{head} ({', '.join(bits)})")
        money.append(f"{head} - {_money(c.amount)} ({', '.join(bits)})")
    signed_n = len([c for c in cos if c.status == "signed"])
    pending_n = len([c for c in cos if c.status in ("draft", "awaiting_approval", "sent")])
    signed = sum(c.amount or 0 for c in cos if c.status == "signed")
    pending = sum(c.amount or 0 for c in cos if c.status in ("draft", "awaiting_approval", "sent"))
    if plain:
        plain.append(f"Approved changes: {signed_n} signed; pending: {pending_n}")
        money.append(f"Approved changes: {_money(signed)}; pending: {_money(pending)}")
    s["change_orders"] = _section("\n".join(plain) or "None currently.",
                                  [{"type": "change_order", "id": c.id} for c in cos])
    data["changeOrderMoney"] = {"plain": "\n".join(plain) or "None currently.",
                                "money": "\n".join(money) or "None currently."}

    d = data.get("delays") or {}
    import construction_field
    dl = []
    if d.get("total"):
        dl.append(f"Weather delays: {d.get('weather', 0):g} hours")
        for cause, hrs in sorted((d.get("byCause") or {}).items()):
            if cause != "weather":
                dl.append(f"{construction_field.DELAY_LABEL.get(cause, cause.title())} delays: {hrs:g} hours")
        for x in d.get("lines") or []:
            note = f" - {x['note']}" if x.get("note") else ""
            dl.append(f"{_us(x['date'])}: {construction_field.DELAY_LABEL.get(x['cause'], x['cause'])}, "
                      f"{x['hours']:g} hours{note}")
    s["weather_and_delays"] = _section("\n".join(dl) or "No delays logged.",
                                       [{"type": "log", "id": lg.id} for lg in data["logs"] if (getattr(lg, "delays", None) or [])])
    return s


def generate(db, project, week_start: str, actor_email: str, use_ai: bool = True):
    """Create or regenerate the draft for one week.

    A PUBLISHED report is never overwritten - regenerating produces a new version
    that will supersede it, because an executive may already be holding a link to
    the old one and silently changing what that link resolves to is how a report
    stops being trustworthy. The published one STAYS published (and visible to
    its executives) until the new version is itself published - publish_report
    marks it superseded then (11/03/2026); before, a regenerate hid the week's
    report from everyone until a manager got round to publishing again.

    `use_ai=False` (the construction_ai switch is off) writes the draft
    without the model even when AI is on for the server."""
    data = gather(db, project, week_start)
    # No key is a first-class state, not an error - the row-derived three
    # quarters of this document do not need a model at all.
    ai = draft(project, data) if (use_ai and configured()) else draft_offline(project, data)
    start, end = data["weekStart"], data["weekEnd"]

    existing = (db.query(models.ConstructionWeeklyReport)
                .filter(models.ConstructionWeeklyReport.project_id == project.id,
                        models.ConstructionWeeklyReport.week_start == start,
                        models.ConstructionWeeklyReport.deleted_at == "")
                .order_by(models.ConstructionWeeklyReport.version.desc()).first())

    from routers.construction import gen_id
    from sqlalchemy import func
    now = _now()
    # A new row takes the next version past EVERY row of the week, removed
    # ones included: (project, week, version) is unique (11/03/2026).
    top = (db.query(func.max(models.ConstructionWeeklyReport.version))
           .filter(models.ConstructionWeeklyReport.project_id == project.id,
                   models.ConstructionWeeklyReport.week_start == start).scalar()) or 0
    if existing and existing.status in ("published", "superseded"):
        r = models.ConstructionWeeklyReport(
            id=gen_id(), project_id=project.id, week_start=start, week_end=end,
            version=top + 1, supersedes_id=existing.id,
            created_at=now)
        db.add(r)
    elif existing:
        r = existing
    else:
        r = models.ConstructionWeeklyReport(
            id=gen_id(), project_id=project.id, week_start=start, week_end=end,
            version=top + 1, created_at=now)
        db.add(r)

    r.title = ai.get("title") or f"Week of {_us(start)}"
    r.sections = assemble(db, project, data, ai)
    r.section_order = [k for k, _ in SECTIONS]
    r.stats = data["stats"]
    r.daily_log_ids = [l.id for l in data["logs"]]
    r.media_ids = [m.id for m in data["media"]]
    r.pair_ids = [pr.id for pr in data.get("pairs") or []]
    # The change orders' dollar lines, for readers who may see money only.
    keep = [x for x in (r.cost_exposure or []) if not (isinstance(x, dict) and x.get("kind") == "change_orders")]
    r.cost_exposure = keep + [{"kind": "change_orders", **(data.get("changeOrderMoney") or {})}]
    r.milestone_ids = [m.id for m in data["milestones"]]
    r.rfi_ids = [x.id for x in data["rfis"]]
    r.submittal_ids = [x.id for x in data["submittals"]]
    r.risks = ai.get("risks") or []
    r.recommendations = ai.get("recommendations") or []
    r.executive_summary = ai.get("executive_summary") or ""
    r.status = "draft"
    r.ai_model = _MODEL if ai.get("source") != "fallback" else "fallback (no AI)"
    r.generated_by = actor_email
    r.generated_at = now
    r.modified_at = now
    return r
