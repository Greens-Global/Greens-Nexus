"""Meetings and safety on a Job (Neil, Round Two item 10, 11/05/2026, plan
https://claude.ai/artifact/EpG2gQr8KVi1ZZRaM6zVBE) - no new tables.

Safety rides Forms as they are: two form templates, Toolbox Talk and Near
Miss / Incident, seeded ONCE (`apply_once`, nexus_settings MARK, run from
main.py `_tier_seeds` like super_admins_seed) with fixed ids, published,
shared with every company (no creator = no company, form_audience). An
entry is tied to a job the way every form entry is
(`doc_form_entries.linked_project_id`). An administrator may edit, rename
or archive them like any form; nothing re-creates them once the mark is
written.

`facts` is the Safety card on the Job Overview and the weekly report's
safety lines: the last toolbox talk's day, days since the last near miss /
incident, and the daily logs the crew tagged Safety that are still open
(not yet approved). Counts and dates only - never an answer (the Insights
rule).

Meetings ride Notes (routers/construction_jobs.py `new_meeting`): a note
whose `source` is the job (kind `construction_job`), shared with the job's
people - nothing here.
"""
from __future__ import annotations

from datetime import date, datetime, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

import models

MARK = "construction.safety_forms_seeded_2026_11_06"
TOOLBOX_ID = "form-toolbox-talk"
INCIDENT_ID = "form-near-miss-incident"
# A Safety tag is open until the log is approved (models.ConstructionDailyLog.status).
OPEN_LOG = ("submitted", "processed", "needs_info")

_ATT = {"group": "attendees", "max": 50}
FORMS = (
    (TOOLBOX_ID, "Toolbox Talk", "safety", [
        {"token": "topic", "label": "Topic", "type": "text", "required": True},
        {"token": "talk_date", "label": "Date", "type": "date", "required": True},
        {"token": "presenter", "label": "Presenter", "type": "text", "required": True},
        {"token": "attendee_name", "label": "Attendee", "type": "text", "required": True,
         "section": "Attendees", "repeat": _ATT},
        {"token": "attendee_signature", "label": "Signature", "type": "signature", "required": True,
         "section": "Attendees", "repeat": _ATT},
        {"token": "talk_notes", "label": "Notes", "type": "multiline"},
    ]),
    (INCIDENT_ID, "Near Miss / Incident", "incident", [
        {"token": "incident_date", "label": "Date", "type": "date", "required": True},
        {"token": "incident_time", "label": "Time", "type": "time"},
        {"token": "location", "label": "Location", "type": "text", "required": True},
        {"token": "what_happened", "label": "What Happened", "type": "multiline", "required": True},
        {"token": "injury", "label": "Was Anyone Injured?", "type": "yesno", "required": True},
        {"token": "photos", "label": "Photos", "type": "photo"},
        {"token": "corrective_action", "label": "Corrective Action", "type": "multiline"},
    ]),
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def apply_once(db: Session) -> list | None:
    """Create and publish the two safety forms (a fixed id already there is
    left alone), then write MARK. Returns the names created, or None when the
    mark is already there. Commits."""
    from routers.documents import _clean_field_defs, _publish
    if db.get(models.NexusSetting, MARK):
        return None
    now, made = _now(), []
    for tid, name, category, fields in FORMS:
        if db.get(models.DocTemplate, tid) is not None:
            continue
        row = models.DocTemplate(
            id=tid, name=name, category=category, tags=[], content={}, requires_letterhead=False,
            letterhead_id="", merge_overrides={}, field_defs=_clean_field_defs(fields, form=True),
            department="", doc_type="form", signer_roles=[], status="active", version=1,
            created_by="", created_at=now, updated_by="", updated_at=now,
            audience="company", work_site_id="", show_on_shifts=0)
        db.add(row)
        db.flush()
        _publish(db, row, "startup")
        made.append(name)
    db.add(models.NexusSetting(key=MARK, value=now, updated_by="startup", updated_at=now))
    db.commit()
    return made


def _local_day(db: Session, project, iso: str) -> str:
    import construction_company
    try:
        at = datetime.fromisoformat((iso or "").replace("Z", "+00:00"))
    except ValueError:
        return (iso or "")[:10]
    return construction_company.local_today(db, project, now=at).isoformat()


def facts(db: Session, project, today: date) -> dict:
    """{lastToolboxTalk, lastIncident (jobsite days, '' = none), daysSinceIncident
    (None = none recorded), openSafetyTags, toolboxFormId, incidentFormId}."""
    from routers.construction import _tags
    E, L = models.DocFormEntry, models.ConstructionDailyLog
    last = dict(db.query(E.template_id, func.max(E.submitted_at))
                .filter(E.linked_project_id == project.id, E.deleted_at == "",
                        E.template_id.in_((TOOLBOX_ID, INCIDENT_ID)))
                .group_by(E.template_id).all())
    talk = _local_day(db, project, last[TOOLBOX_ID]) if last.get(TOOLBOX_ID) else ""
    incident = _local_day(db, project, last[INCIDENT_ID]) if last.get(INCIDENT_ID) else ""
    days = (today - date.fromisoformat(incident)).days if incident else None
    tags = (db.query(L.tags).filter(L.project_id == project.id, L.deleted_at == "",
                                    L.status.in_(OPEN_LOG)).all())
    return {
        "lastToolboxTalk": talk, "lastIncident": incident,
        "daysSinceIncident": max(0, days) if days is not None else None,
        "openSafetyTags": sum(1 for (t,) in tags if "safety" in _tags(t)),
        "toolboxFormId": TOOLBOX_ID, "incidentFormId": INCIDENT_ID,
    }
