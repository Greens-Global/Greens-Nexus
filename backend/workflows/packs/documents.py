"""Documents pack (Forms & Checklists, Neil 11/02/2026 - plan Task 2): one
entity, `form_entry` (a filled form, models.DocFormEntry), and the two
things that happen to it:

  * `form.submitted` - routers/forms.py `submit_entry`, right after the row
    is added, inside the request's transaction (a retry on the same
    entryKey returns the first entry and emits nothing);
  * `form.reviewed`  - routers/forms.py `review_entry`, after the status
    change, with `changes.status` from / to.

Both carry the answers FLAT in `extra` - each token at the top level, plus
`form` (the title) and, on a review, `decision` and `note` - so a workflow
reads `{{ event.odometer }}` or `{{ event.form }}` straight through
workflows/context.py (`event.<key>` resolves from a flat `extra`). The
reserved keys win over a token of the same name. The answers are the
cleaned, validated, computed set the server stored - a hidden field's
stale value never rides along.

`site` and `category` are derived (the work site's name, the template's
category) through properties attached to the model. `visible_to` is
form_audience's one reach rule (the submitter, their manager, a manager of
the site's team, HR for the company, an administrator). Building on the
events takes a manager, the Documents grant or an administrator - the
people who review entries.
"""
from __future__ import annotations

from sqlalchemy import select

import models
from workflows.catalog import F, entity, event
from workflows.packs._people import (_conn, attach_property, company_hr_contacts, emails, has_grant, is_admin,
                                     is_manager, person_manager)

MODULE = "documents"
GRANT = "documents"      # the module id in RoleContext.jsx MODULES ("Documents")

ENTRY_STATUSES = [("submitted", "Submitted"), ("reviewed", "Reviewed"), ("follow_up", "Needs Follow-Up"),
                  ("closed", "Closed")]
SOURCES = [("web", "Web"), ("phone", "Phone")]


# ── derived attributes ───────────────────────────────────────────────────────
def _one_column(row, table, where_col, where_val, col):
    conn = _conn(row)
    if conn is None or not where_val:
        return ""
    t = table.__table__
    return conn.execute(select(t.c[col]).where(t.c[where_col] == where_val)).scalar() or ""


def _site_name(row) -> str:
    return str(_one_column(row, models.HrWorkSite, "id", row.work_site_id or "", "name"))


def _category(row) -> str:
    return str(_one_column(row, models.DocTemplate, "id", row.template_id or "", "category"))


attach_property(models.DocFormEntry, "wf_site_name", _site_name)
attach_property(models.DocFormEntry, "wf_category", _category)


# ── access ───────────────────────────────────────────────────────────────────
def may_use(db, user) -> bool:
    if not user:
        return False
    return is_admin(user) or is_manager(user) or has_grant(db, user, GRANT)


def _visible(db, user, row) -> bool:
    if not user or row is None:
        return False
    import form_audience
    return bool(form_audience.viewer_reach(db, user)(row))


# ── people ───────────────────────────────────────────────────────────────────
def _submitter(db, row) -> list[str]:
    return emails(row.submitted_by)


def _manager(db, row) -> list[str]:
    return person_manager(db, row.submitted_by)


def _reviewer(db, row) -> list[str]:
    return emails(row.reviewer_email)


def _hr_contact(db, row) -> list[str]:
    return company_hr_contacts(db, row.company or "")


# ── entity ───────────────────────────────────────────────────────────────────
entity("form_entry", label="Form Entry", model=models.DocFormEntry, module=MODULE,
       company=lambda row: row.company or "",
       # Documents > Forms, the entry open beside the list - the same detail the review bell carries.
       link=lambda row: {"view": "documents", "sub": "documents-forms", "entryId": row.id},
       people={"self": _submitter, "manager": _manager, "reviewer": _reviewer, "hr_contact": _hr_contact},
       people_labels={"self": "Submitter", "reviewer": "Reviewer", "hr_contact": "HR Contact"},
       fields=[
           F("title", "Form", "text"),
           F("status", "Status", "select", options=ENTRY_STATUSES),
           F("submitted_by", "Submitted By", "person"),
           F("site", "Site", "text", path="wf_site_name"),
           F("category", "Category", "text", path="wf_category"),
           F("company", "Company", "select", options="companies"),
           F("submitted_at", "Submitted At", "datetime"),
           F("source", "Source", "select", options=SOURCES),
           F("reviewer_email", "Reviewer", "person"),
           F("reviewed_at", "Reviewed At", "datetime"),
           F("review_note", "Review Note", "text"),
           F("linked_ticket_id", "Linked Ticket", "text"),
           F("linked_task_id", "Linked Task", "text"),
       ],
       label_of=lambda row: f"{row.title or 'Form'} - {row.submitted_by or ''}".strip(" -"),
       visible_to=_visible)

SAMPLE_ENTRY = {
    "title": "Vehicle Check", "status": "submitted", "submitted_by": "priya.shah@greensglobal.com",
    "site": "Escondido Yard", "category": "vehicle", "company": "", "submitted_at": "2026-11-02T15:10:00+00:00",
    "source": "phone", "reviewer_email": "", "reviewed_at": "", "review_note": "", "linked_ticket_id": "",
    "linked_task_id": "",
}
SAMPLE_ANSWERS = {"odometer": 48210, "injury": False, "fuel_level": "3/4", "tires": [{"tire_psi": 32}, {"tire_psi": 34}]}


def _full(subject: dict, changes: dict = None, extra: dict = None, actor: str = "") -> dict:
    return {"subject": subject, "changes": changes or {}, "extra": extra or {}, "actor": actor}


# ── events ───────────────────────────────────────────────────────────────────
event("form.submitted", entity="form_entry", label="Form Is Submitted", module=MODULE, group="Forms",
      may_use=may_use,
      sample=_full(SAMPLE_ENTRY, extra={**SAMPLE_ANSWERS, "form": "Vehicle Check"},
                   actor="priya.shah@greensglobal.com"))
event("form.reviewed", entity="form_entry", label="Form Is Reviewed", module=MODULE, group="Forms",
      changes=("status",), may_use=may_use,
      sample=_full(dict(SAMPLE_ENTRY, status="follow_up", reviewer_email="max.miller@greensglobal.com",
                        reviewed_at="2026-11-02T17:40:00+00:00", review_note="Check the rear tires"),
                   changes={"status": {"from": "submitted", "to": "follow_up"}},
                   extra={**SAMPLE_ANSWERS, "form": "Vehicle Check", "decision": "follow_up",
                          "note": "Check the rear tires"},
                   actor="max.miller@greensglobal.com"))
