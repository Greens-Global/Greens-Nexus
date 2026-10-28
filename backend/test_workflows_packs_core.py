"""Workflows (Oct 28 2026) - Task 6: the core pack's actions and option
sources.

  * Send A Notification: the plan names the recipients; the run writes one
    rolled-up notice per recipient and a retry never writes one twice;
  * Send An Email: off the deployed worker it records a line and sends
    nothing; on it, a retry after a failure half-way sends only to the
    people the first attempt missed (Review Focus 2);
  * Call A Webhook: a host off the allow-list is refused; the body is
    HMAC-signed with the host's secret; a 5xx is transient;
  * Post To Teams: one queued row per recipient, posted as the owner;
    refused under the Nexus run-as;
  * option sources: a string options name is served as a list.

    cd backend && python -m pytest test_workflows_packs_core.py -q
"""
import hashlib
import hmac
import json
import os
import tempfile
import time
from datetime import date

import pytest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ["NEXUS_APP_URL"] = "https://nexus.test"

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import graph_mail  # noqa: E402
import leader  # noqa: E402
import models  # noqa: E402
from workflows import catalog, settings as wf_settings  # noqa: E402
from workflows.context import RunContext  # noqa: E402
from workflows.errors import TransientError  # noqa: E402
from workflows.packs import core  # noqa: E402

ENTITY = "ent-core"
PRIYA, MAX, HANA, GAIL = ("priya.core@greensglobal.com", "max.core@greensglobal.com",
                          "hana.core@greensglobal.com", "gail.core@greensglobal.com")


@pytest.fixture(scope="module", autouse=True)
def _setup():
    assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
    models.Base.metadata.create_all(bind=database.engine)
    catalog.load_packs()
    s = database.SessionLocal()
    s.add(models.HrEntity(id=ENTITY, name="Greens Core", hr_contact_email=HANA))
    s.add(models.HrEntity(id="ent-other", name="Other Co"))
    s.add(models.HrDepartment(id="d1", company_id=ENTITY, name="Operations"))
    s.add(models.NexusEmployee(id="e-priya", work_email=PRIYA, first_name="Priya", last_name="Shah",
                               manager_email=MAX, company=ENTITY, status="active", start_date="2026-11-12",
                               department="Operations", location="Escondido"))
    s.add(models.NexusEmployee(id="e-max", work_email=MAX, first_name="Max", last_name="Miller",
                               company=ENTITY, status="active"))
    s.add(models.NexusEmployee(id="e-hana", work_email=HANA, first_name="Hana", last_name="Hill",
                               company=ENTITY, status="active"))
    s.add(models.NexusEmployee(id="e-gail", work_email=GAIL, first_name="Gail", last_name="Admin",
                               company=ENTITY, status="active"))
    s.add(models.NexusRole(email=GAIL, role="owner"))
    s.add(models.NexusRole(email=MAX, role="manager"))
    s.add(models.NexusGroup(id="g-hr-core", name="HR", allowed_modules="hr:full"))
    s.add(models.NexusGroupMember(group_id="g-hr-core", email=HANA))
    s.commit()
    s.close()
    auth._role_cache.clear()
    cache.module_grants.invalidate()
    yield
    database.engine.dispose()
    try:
        os.remove(_tmp_db.name)
    except (FileNotFoundError, PermissionError):
        pass


@pytest.fixture
def db():
    s = database.SessionLocal()
    for m in (models.NexusNotification, models.TicketTeamsMessage, models.NexusSetting):
        s.query(m).delete()
    s.commit()
    yield s
    s.rollback()
    s.close()


def _ctx(db, *, run_as=MAX, level=3, settings=None):
    priya = db.query(models.NexusEmployee).filter(models.NexusEmployee.id == "e-priya").one()
    wf = models.Workflow(id="wf-core", name="Probation Reminder", owner_email=run_as or "", company_id=ENTITY)
    user = {"email": run_as, "role": "manager", "level": level} if run_as else None
    return RunContext(db=db, workflow=wf, definition={"v": 1, "settings": settings or {}},
                      entity=catalog.ENTITIES["employee"], subject=priya,
                      payload={"subject": {}, "changes": {}, "extra": {}, "actor": HANA},
                      actor=HANA, run_as=user, today=date(2026, 10, 29), company_id=ENTITY)


# ── notify ───────────────────────────────────────────────────────────────────
def test_notify_plan_names_recipients(db):
    ctx = _ctx(db)
    line = catalog.ACTIONS["notify"].plan(ctx, {"to": [{"kind": "manager"}, {"kind": "role", "value": "hr_contact"}],
                                                "title": "Probation ends {{ subject.start_date | us_date }}"})
    assert line == "Would notify Max Miller and 1 other: Probation ends 11/12/2026"


def test_notify_run_upserts_one_notice_per_recipient(db):
    ctx = _ctx(db)
    params = {"to": [{"kind": "manager"}, {"kind": "hr_contact"}, {"kind": "self"}],
              "title": "Probation ends {{ subject.start_date | us_date }}", "body": "Please review {{ subject.name }}",
              "priority": True}
    out = catalog.ACTIONS["notify"].run(ctx, params)
    db.commit()
    assert sorted(out["sent"]) == sorted([MAX, HANA, PRIYA])
    assert out["line"].startswith("Notified Max Miller and 2 others: Probation ends 11/12/2026")
    rows = db.query(models.NexusNotification).all()
    assert {r.recipient for r in rows} == {MAX, HANA, PRIYA}
    one = next(r for r in rows if r.recipient == MAX)
    assert one.ref_id == "wf:wf-core:e-priya" and one.body == "Please review Priya Shah" and one.priority == 1
    assert json.loads(one.action) == {"view": "hr", "sub": "people:e-priya"}
    # a retry with the first attempt's output sends to nobody twice
    ctx.step_output = {"sent": [MAX, HANA]}
    catalog.ACTIONS["notify"].run(ctx, params)
    db.commit()
    assert db.query(models.NexusNotification).count() == 3


def test_notify_respects_the_recipient_cap(db):
    ctx = _ctx(db, settings={"maxRecipients": 1})
    out = catalog.ACTIONS["notify"].run(ctx, {"to": [{"kind": "manager"}, {"kind": "hr_contact"}], "title": "Hi"})
    assert out["sent"] == [MAX] and "1 left out" in out["line"]


# ── email ────────────────────────────────────────────────────────────────────
def test_email_run_not_deployed_records_line_and_sends_nothing(db, monkeypatch):
    monkeypatch.setattr(leader, "is_deployed_worker", lambda: False)
    calls = []
    monkeypatch.setattr(graph_mail, "send_mail", lambda **kw: calls.append(kw))
    ctx = _ctx(db)
    out = catalog.ACTIONS["email"].run(ctx, {"to": [{"kind": "manager"}], "subject": "Hello {{ subject.name }}",
                                             "body": "Starts {{ subject.start_date | us_date }}"})
    assert out["line"] == "Email not sent (not the deployed worker)" and out["sent"] == [] and calls == []
    assert out["wouldSend"] == [MAX] and out["subject"] == "Hello Priya Shah"


def test_email_retry_skips_people_already_sent(db, monkeypatch):
    monkeypatch.setattr(leader, "is_deployed_worker", lambda: True)
    monkeypatch.setattr(graph_mail, "DEFAULT_FROM_EMAIL", "nexus@greensglobal.com")
    calls = []
    failed = []

    def _send(**kw):
        if len(calls) == 1 and not failed:      # the second send of the first attempt fails, once
            failed.append(True)
            raise graph_mail.GraphMailError("Graph down")
        calls.append(kw)
    monkeypatch.setattr(graph_mail, "send_mail", _send)
    ctx = _ctx(db)
    params = {"to": [{"kind": "manager"}, {"kind": "hr_contact"}, {"kind": "self"}],
              "subject": "Hello {{ subject.name }}", "body": "Welcome"}
    with pytest.raises(graph_mail.GraphMailError):
        catalog.ACTIONS["email"].run(ctx, params)
    assert ctx.step_output["sent"] == [MAX]          # the first went out, the second raised
    calls.clear()
    out = catalog.ACTIONS["email"].run(ctx, params)  # the retry carries the same step_output
    assert [c["to"] for c in calls] == [[HANA], [PRIYA]]
    assert out["sent"] == [MAX, HANA, PRIYA]
    html = calls[0]["html"]
    assert "Hello Priya Shah" in html and "https://nexus.test/hr/people:e-priya" in html
    assert 'Sent by the workflow "Probation Reminder"' in html


# ── webhook ──────────────────────────────────────────────────────────────────
def test_webhook_refuses_host_not_allowlisted(db):
    ctx = _ctx(db, run_as=GAIL, level=5)
    reason = catalog.ACTIONS["webhook"].allowed(ctx, {"url": "https://hooks.example.com/x"})
    assert "allow-list" in reason
    assert "https://" in catalog.ACTIONS["webhook"].allowed(ctx, {"url": "http://hooks.example.com/x"})
    with pytest.raises(PermissionError):
        catalog.ACTIONS["webhook"].run(ctx, {"url": "https://hooks.example.com/x"})


def test_webhook_signs_body(db, monkeypatch):
    import httpx
    wf_settings.save(db, "", {"webhookHosts": ["hooks.example.com"]}, GAIL, secrets={"hooks.example.com": "s3cret"})
    db.commit()
    assert wf_settings.webhook_secret(db, "hooks.example.com") == "s3cret"
    assert wf_settings.public(db)["webhookSecretsSet"] == ["hooks.example.com"]
    ctx = _ctx(db, run_as=GAIL, level=5)
    assert catalog.ACTIONS["webhook"].allowed(ctx, {"url": "https://hooks.example.com/x"}) == ""
    seen = {}

    class _Resp:
        status_code = 200
        text = "ok"

    def _post(url, *, content, headers, timeout):
        seen.update(url=url, content=content, headers=headers, timeout=timeout)
        return _Resp()
    monkeypatch.setattr(httpx, "post", _post)
    out = catalog.ACTIONS["webhook"].run(ctx, {"url": "https://hooks.example.com/x",
                                               "payload": '{"person": "{{ subject.name }}"}'})
    assert out["status"] == 200 and seen["timeout"] == 10
    body = json.loads(seen["content"])
    assert body["payload"] == {"person": "Priya Shah"} and body["subject"]["id"] == "e-priya"
    assert body["workflow"]["name"] == "Probation Reminder"
    # L2: the signature covers "<timestamp>.<body>" and the timestamp travels
    # with the call, so a captured call cannot be replayed later
    stamp = seen["headers"]["X-Nexus-Timestamp"]
    assert stamp.isdigit() and abs(int(stamp) - int(time.time())) < 60
    expect = "sha256=" + hmac.new(b"s3cret", f"{stamp}.".encode() + seen["content"], hashlib.sha256).hexdigest()
    assert seen["headers"]["X-Nexus-Signature"] == expect
    assert expect != "sha256=" + hmac.new(b"s3cret", seen["content"], hashlib.sha256).hexdigest()

    class _Down(_Resp):
        status_code = 503
    monkeypatch.setattr(httpx, "post", lambda *a, **k: _Down())
    with pytest.raises(TransientError):
        catalog.ACTIONS["webhook"].run(ctx, {"url": "https://hooks.example.com/x"})


def test_webhook_fails_when_the_kept_secret_cannot_be_read(db, monkeypatch):
    """L2: a secret that is set but cannot be decrypted (the key changed)
    fails the step - never a call signed with an empty key."""
    import httpx
    import secret_box
    wf_settings.save(db, "", {"webhookHosts": ["hooks.example.com"]}, GAIL, secrets={"hooks.example.com": "s3cret"})
    db.commit()

    def _broken(_raw):
        raise ValueError("bad key")
    monkeypatch.setattr(secret_box, "decrypt", _broken)
    with pytest.raises(wf_settings.SecretUnreadable):
        wf_settings.webhook_secret(db, "hooks.example.com")
    monkeypatch.setattr(httpx, "post", lambda *a, **k: pytest.fail("the call must not go out"))
    ctx = _ctx(db, run_as=GAIL, level=5)
    with pytest.raises(wf_settings.SecretUnreadable):
        catalog.ACTIONS["webhook"].run(ctx, {"url": "https://hooks.example.com/x"})
    wf_settings.save(db, "", {"webhookHosts": []}, GAIL)
    db.commit()
    assert wf_settings.webhook_secret(db, "hooks.example.com") == ""      # none kept: no secret, no failure


# ── teams ────────────────────────────────────────────────────────────────────
def test_teams_queues_a_row_per_recipient(db):
    ctx = _ctx(db)
    out = catalog.ACTIONS["teams"].run(ctx, {"to": [{"kind": "self"}, {"kind": "hr_contact"}, {"kind": "manager"}],
                                             "message": "Welcome {{ subject.name }}"})
    db.commit()
    rows = db.query(models.TicketTeamsMessage).all()
    assert {r.requester_email for r in rows} == {PRIYA, HANA}      # never a message to the poster
    assert all(r.agent_email == MAX and r.kind == "workflow" and r.sent == 0 and r.ticket_id == "" for r in rows)
    assert "Welcome Priya Shah" in rows[0].html and "Sent by Nexus" in rows[0].html
    assert out["sent"] == [PRIYA, HANA]


def test_teams_not_allowed_for_nexus(db):
    ctx = _ctx(db, run_as=None)
    assert catalog.ACTIONS["teams"].allowed(ctx, {}) == "Post To Teams needs a person's identity"
    with pytest.raises(PermissionError):
        catalog.ACTIONS["teams"].run(ctx, {"to": [{"kind": "self"}], "message": "x"})
    assert catalog.ACTIONS["teams"].needs_person and not catalog.ACTIONS["notify"].needs_person
    assert not catalog.ACTIONS["email"].needs_person and catalog.ACTIONS["webhook"].admin_only


# ── option sources ───────────────────────────────────────────────────────────
def test_option_sources_are_served_in_the_catalog(db):
    cat = catalog.serialize(db, {"email": GAIL, "role": "owner", "level": 5})
    emp = next(e for e in cat["entities"] if e["key"] == "employee")
    company = next(f for f in emp["fields"] if f["key"] == "company")
    assert {"value": ENTITY, "label": "Greens Core"} in company["options"]
    dept = next(f for f in emp["fields"] if f["key"] == "department")
    assert dept["options"] == [{"value": "Operations", "label": "Operations"}]
    assert core._hr_letter_templates(db)[0] == {"value": "employment_verification", "label": "Employment Verification"}
    assert catalog.options_for(db, "task_projects") == "task_projects"   # the builder loads those itself
