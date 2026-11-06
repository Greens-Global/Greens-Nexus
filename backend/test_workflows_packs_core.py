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
    for m in (models.NexusNotification, models.TicketTeamsMessage, models.NexusSetting, models.NexusPersonPref,
              models.WorkflowMessage, models.Workflow):
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


# ── text message ─────────────────────────────────────────────────────────────
@pytest.fixture
def phones(db):
    """Priya and Max have phones, Hana has none; restored after the test."""
    nums = {"e-priya": "(949) 555-0101", "e-max": "+91 98765 43210", "e-hana": ""}
    for eid, num in nums.items():
        db.get(models.NexusEmployee, eid).phone = num
    db.commit()
    yield
    for eid in nums:
        db.get(models.NexusEmployee, eid).phone = ""
    db.commit()


SMS_PARAMS = {"to": [{"kind": "self"}, {"kind": "manager"}, {"kind": "hr_contact"}],
              "message": "Probation ends {{ subject.start_date | us_date }}"}


def _sentdm(monkeypatch, answers=None):
    import sentdm
    calls = []
    monkeypatch.setattr(sentdm, "api_key", lambda: "test-key")
    answers = list(answers or [])

    def _send(phone, text):
        calls.append((phone, text))
        return answers.pop(0) if answers else (True, "")
    monkeypatch.setattr(sentdm, "send_text", _send)
    return calls


def test_sms_plan_names_who_is_texted_and_who_is_not(db, phones, monkeypatch):
    _sentdm(monkeypatch)
    line = catalog.ACTIONS["sms"].plan(_ctx(db), SMS_PARAMS)
    assert line.startswith("Would text Priya Shah and 1 other: Greens Core: Probation ends 11/12/2026")
    assert "Not texted: Hana Hill (no phone on file)" in line


def test_sms_text_names_the_company_links_the_record_and_is_capped(db):
    ctx = _ctx(db)
    text = core.sms_text(ctx, {"message": "Hello  {{ subject.name }}\nsee this"})
    assert text == "Greens Core: Hello Priya Shah see this Open: https://nexus.test/hr/people:e-priya"
    assert core.sms_text(ctx, {"message": "Hi", "link": False}) == "Greens Core: Hi"
    long = core.sms_text(ctx, {"message": "x" * 2000})
    assert len(long) <= core.SMS_MAX and long.endswith("Open: https://nexus.test/hr/people:e-priya")


def test_sms_run_texts_each_phone_once_and_skips_opted_out(db, phones, monkeypatch):
    monkeypatch.setattr(leader, "is_deployed_worker", lambda: True)
    calls = _sentdm(monkeypatch)
    db.add(models.NexusPersonPref(email=MAX, workflow_sms=0))
    db.commit()
    ctx = _ctx(db)
    out = catalog.ACTIONS["sms"].run(ctx, SMS_PARAMS)
    assert [c[0] for c in calls] == ["+19495550101"]
    assert out["sent"] == [PRIYA]
    assert out["line"].startswith("Texted Priya Shah. Not texted: ")
    assert "Max Miller (texts turned off)" in out["line"] and "Hana Hill (no phone on file)" in out["line"]
    calls.clear()
    out = catalog.ACTIONS["sms"].run(ctx, SMS_PARAMS)     # a retry carries the same step_output
    assert calls == [] and out["sent"] == [PRIYA]


def test_sms_outage_is_retried_without_texting_anyone_twice(db, phones, monkeypatch):
    monkeypatch.setattr(leader, "is_deployed_worker", lambda: True)
    calls = _sentdm(monkeypatch, answers=[(True, ""), (False, "sent.dm returned 503 busy")])
    ctx = _ctx(db)
    with pytest.raises(TransientError):
        catalog.ACTIONS["sms"].run(ctx, SMS_PARAMS)
    assert ctx.step_output["sent"] == [PRIYA]
    calls.clear()
    out = catalog.ACTIONS["sms"].run(ctx, SMS_PARAMS)
    assert [c[0] for c in calls] == ["+919876543210"] and out["sent"] == [PRIYA, MAX]


def test_sms_bad_number_is_reported_not_retried(db, phones, monkeypatch):
    monkeypatch.setattr(leader, "is_deployed_worker", lambda: True)
    _sentdm(monkeypatch, answers=[(True, ""), (False, "sent.dm returned 400 invalid number")])
    out = catalog.ACTIONS["sms"].run(_ctx(db), SMS_PARAMS)
    assert out["sent"] == [PRIYA] and out["failed"][0]["email"] == MAX
    assert "Max Miller (failed: sent.dm returned 400 invalid number)" in out["line"]
    _sentdm(monkeypatch, answers=[(False, "sent.dm returned 400 a"), (False, "sent.dm returned 400 b")])
    ctx = _ctx(db)
    ctx.step_output = {}
    with pytest.raises(RuntimeError, match="No text went out"):
        catalog.ACTIONS["sms"].run(ctx, SMS_PARAMS)


def test_sms_not_deployed_or_not_set_up_or_switched_off(db, phones, monkeypatch):
    import sentdm
    monkeypatch.setattr(leader, "is_deployed_worker", lambda: False)
    calls = _sentdm(monkeypatch)
    out = catalog.ACTIONS["sms"].run(_ctx(db), SMS_PARAMS)
    assert out["line"] == "Text not sent (not the deployed worker)" and calls == []
    assert out["wouldSend"] == [PRIYA, MAX]
    monkeypatch.setattr(leader, "is_deployed_worker", lambda: True)
    monkeypatch.setattr(sentdm, "api_key", lambda: "")
    with pytest.raises(RuntimeError, match="not set up"):
        catalog.ACTIONS["sms"].run(_ctx(db), SMS_PARAMS)
    assert "(texting is not set up on this server)" in catalog.ACTIONS["sms"].plan(_ctx(db), SMS_PARAMS)
    wf_settings.save(db, ENTITY, {"textMessages": False}, GAIL)
    db.commit()
    ctx = _ctx(db)
    assert catalog.ACTIONS["sms"].allowed(ctx, {}) == "Text messages are turned off in Settings > Workflows"
    with pytest.raises(PermissionError):
        catalog.ACTIONS["sms"].run(ctx, SMS_PARAMS)
    assert wf_settings.get(db, "ent-other")["textMessages"] is True     # one company's switch only
    assert not catalog.ACTIONS["sms"].needs_person                    # Nexus may text, like it emails


def test_profile_switch_turns_workflow_texts_off_and_on(db, phones, monkeypatch):
    from routers import roles
    me = {"email": PRIYA.upper(), "role": "employee", "level": 1}
    assert roles.my_text_prefs(me, db) == {"workflowTexts": True, "phone": True}
    assert roles.save_my_text_prefs(roles.TextPrefIn(workflowTexts=False), me, db)["workflowTexts"] is False
    monkeypatch.setattr(leader, "is_deployed_worker", lambda: True)
    calls = _sentdm(monkeypatch)
    out = catalog.ACTIONS["sms"].run(_ctx(db), {"to": [{"kind": "self"}], "message": "Hi"})
    assert calls == [] and "Priya Shah (texts turned off)" in out["line"]
    assert roles.save_my_text_prefs(roles.TextPrefIn(workflowTexts=True), me, db)["workflowTexts"] is True
    assert roles.my_text_prefs({"email": HANA}, db) == {"workflowTexts": True, "phone": False}


# ── quiet hours, the daily limit, summaries (11/05/2026) ─────────────────────
from datetime import datetime, timedelta, timezone  # noqa: E402

from workflows import outbox  # noqa: E402

PT = outbox.PACIFIC


def _pt(y, m, d, h, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=PT).astimezone(timezone.utc)


@pytest.fixture
def california(db):
    """Priya works in California (HR put her on the California rule)."""
    emp = db.get(models.NexusEmployee, "e-priya")
    emp.compensation = {"overtimeRule": "ca"}
    db.commit()
    yield
    emp = db.get(models.NexusEmployee, "e-priya")
    emp.compensation = {}
    db.commit()


@pytest.fixture
def workflow_row(db):
    db.add(models.Workflow(id="wf-core", name="Probation Reminder", owner_email=MAX, company_id=ENTITY))
    db.commit()


def test_quiet_hours_are_9_pm_to_8_am_pacific():
    assert outbox.quiet_until(_pt(2026, 11, 5, 22, 30)) == _pt(2026, 11, 6, 8)
    assert outbox.quiet_until(_pt(2026, 11, 5, 21)) == _pt(2026, 11, 6, 8)
    assert outbox.quiet_until(_pt(2026, 11, 6, 7, 59)) == _pt(2026, 11, 6, 8)
    assert outbox.quiet_until(_pt(2026, 11, 6, 8)) is None
    assert outbox.quiet_until(_pt(2026, 11, 6, 20, 59)) is None


def test_a_california_text_in_quiet_hours_waits_for_8_am(db, phones, california, workflow_row, monkeypatch):
    monkeypatch.setattr(leader, "is_deployed_worker", lambda: True)
    calls = _sentdm(monkeypatch)
    night = _pt(2026, 11, 5, 23)
    monkeypatch.setattr(outbox, "now_utc", lambda: night)
    assert outbox.in_california(db, PRIYA) and not outbox.in_california(db, MAX)
    plan = catalog.ACTIONS["sms"].plan(_ctx(db), SMS_PARAMS)
    assert "Priya Shah in California would be texted at 8:00 AM Pacific (quiet hours)" in plan
    out = catalog.ACTIONS["sms"].run(_ctx(db), SMS_PARAMS)
    assert [c[0] for c in calls] == ["+919876543210"]                 # Max (not California) at once
    assert out["line"].startswith("Texted Max Miller. Priya Shah in California will be texted at 8:00 AM Pacific")
    held = db.query(models.WorkflowMessage).filter(models.WorkflowMessage.status == "queued").one()
    assert held.recipient == PRIYA and held.reason == "quiet_hours" and held.not_before == _pt(2026, 11, 6, 8).isoformat()
    calls.clear()
    assert outbox.flush(db, _pt(2026, 11, 6, 7)) == 0 and calls == []          # still night
    assert outbox.flush(db, _pt(2026, 11, 6, 8, 1)) == 1
    assert calls == [("+19495550101", held.body)] and held.body.startswith("Greens Core: Probation ends")
    db.refresh(held)
    assert held.status == "sent"


def test_the_daily_text_limit_sends_the_bell_instead(db, phones, workflow_row, monkeypatch):
    monkeypatch.setattr(leader, "is_deployed_worker", lambda: True)
    monkeypatch.setattr(outbox, "quiet_until", lambda now=None: None)
    calls = _sentdm(monkeypatch)
    wf_settings.save(db, ENTITY, {"textDailyCap": 1}, GAIL)
    db.commit()
    one = {"to": [{"kind": "self"}], "message": "First"}
    catalog.ACTIONS["sms"].run(_ctx(db), one)
    assert len(calls) == 1
    assert "Priya Shah already had 1 texts today" in catalog.ACTIONS["sms"].plan(_ctx(db), one)
    out = catalog.ACTIONS["sms"].run(_ctx(db), {"to": [{"kind": "self"}], "message": "Second"})
    assert len(calls) == 1                                                       # no second text
    assert "Priya Shah had 1 texts in the last 24 hours and got a notification instead" in out["line"]
    bell = db.query(models.NexusNotification).filter(models.NexusNotification.recipient == PRIYA).one()
    assert bell.title == "Probation Reminder" and "Second" in bell.body
    assert wf_settings.get(db, ENTITY)["textDailyCap"] == 1 and wf_settings.get(db, "ent-other")["textDailyCap"] == 3


def test_summary_texts_and_emails_go_out_as_one_per_person(db, phones, workflow_row, monkeypatch):
    monkeypatch.setattr(leader, "is_deployed_worker", lambda: True)
    monkeypatch.setattr(outbox, "quiet_until", lambda now=None: None)
    monkeypatch.setattr(graph_mail, "DEFAULT_FROM_EMAIL", "nexus@greensglobal.com")
    texts = _sentdm(monkeypatch)
    mails = []
    monkeypatch.setattr(graph_mail, "send_mail", lambda **kw: mails.append(kw))
    t0 = datetime(2026, 11, 5, 18, tzinfo=timezone.utc)
    monkeypatch.setattr(outbox, "now_utc", lambda: t0)
    for n in ("one", "two"):
        out = catalog.ACTIONS["sms"].run(_ctx(db), {"to": [{"kind": "self"}], "message": f"Item {n}", "group": True})
        catalog.ACTIONS["email"].run(_ctx(db), {"to": [{"kind": "self"}], "subject": f"Item {n}", "body": "b",
                                                "group": True})
    assert out["line"] == "Queued for Priya Shah's summary text" and texts == [] and mails == []
    assert outbox.flush(db, t0 + timedelta(minutes=30)) == 0
    assert outbox.flush(db, t0 + timedelta(minutes=61)) == 2
    assert len(texts) == 1 and "2 updates from Probation Reminder: Item one / Item two" in texts[0][1]
    assert texts[0][1].endswith("Open: https://nexus.test/hr/people:e-priya")
    assert len(mails) == 1 and mails[0]["to"] == [PRIYA] and mails[0]["subject"] == "Probation Reminder: 2 Updates"
    assert "Item one" in mails[0]["html"] and "Item two" in mails[0]["html"]
    assert mails[0]["reply_to"] == MAX                                       # replies go to the owner
    assert db.query(models.WorkflowMessage).filter(models.WorkflowMessage.status != "sent").count() == 0


def test_a_message_that_keeps_failing_bells_the_owner(db, phones, workflow_row, monkeypatch):
    monkeypatch.setattr(leader, "is_deployed_worker", lambda: True)
    monkeypatch.setattr(outbox, "quiet_until", lambda now=None: None)
    _sentdm(monkeypatch, answers=[(False, "sent.dm returned 503")] * 5)
    t0 = datetime(2026, 11, 5, 18, tzinfo=timezone.utc)
    monkeypatch.setattr(outbox, "now_utc", lambda: t0)
    catalog.ACTIONS["sms"].run(_ctx(db), {"to": [{"kind": "self"}], "message": "x", "group": True})
    t = t0 + timedelta(minutes=61)
    for _ in range(4):
        outbox.flush(db, t)
        t += timedelta(hours=2)
    row = db.query(models.WorkflowMessage).one()
    assert row.status == "failed" and row.attempts == 4
    bell = db.query(models.NexusNotification).filter(models.NexusNotification.recipient == MAX).one()
    assert bell.title == "Workflow Message Not Sent" and "Priya Shah" in bell.body


def test_email_cc_reply_to_and_the_owners_mailbox(db, monkeypatch):
    monkeypatch.setattr(leader, "is_deployed_worker", lambda: True)
    monkeypatch.setattr(graph_mail, "DEFAULT_FROM_EMAIL", "nexus@greensglobal.com")
    calls = []
    monkeypatch.setattr(graph_mail, "send_mail", lambda **kw: calls.append(kw))
    params = {"to": [{"kind": "self"}, {"kind": "hr_contact"}], "cc": [{"kind": "manager"}, {"kind": "self"}],
              "subject": "Hi", "body": "b"}
    assert catalog.ACTIONS["email"].plan(_ctx(db), params).endswith(", copying Max Miller")
    out = catalog.ACTIONS["email"].run(_ctx(db), params)
    assert len(calls) == 1 and calls[0]["to"] == [PRIYA, HANA] and calls[0]["cc"] == [MAX]
    assert calls[0]["from_email"] == "nexus@greensglobal.com" and calls[0]["reply_to"] == MAX
    assert out["line"] == "Emailed Priya Shah and 1 other: Hi, copying Max Miller"
    calls.clear()
    catalog.ACTIONS["email"].run(_ctx(db), {"to": [{"kind": "self"}], "subject": "Hi", "body": "b",
                                            "replyToOwner": False})
    assert calls[0]["reply_to"] == ""
    # the owner's mailbox; refused by Graph -> the Nexus mailbox, replies to the owner
    calls.clear()

    def _send(**kw):
        if kw["from_email"] == MAX:
            raise graph_mail.GraphMailError("Graph 403 ErrorAccessDenied")
        calls.append(kw)
    monkeypatch.setattr(graph_mail, "send_mail", _send)
    out = catalog.ACTIONS["email"].run(_ctx(db), {"to": [{"kind": "self"}], "subject": "Hi", "body": "b",
                                                  "sender": "owner"})
    assert calls[0]["from_email"] == "nexus@greensglobal.com" and calls[0]["reply_to"] == MAX
    assert "from the Nexus mailbox" in out["line"]


def test_email_option_rules(db):
    act = catalog.ACTIONS["email"]
    assert "take CC off" in act.allowed(_ctx(db), {"group": True, "cc": [{"kind": "manager"}]})
    assert act.allowed(_ctx(db, run_as=None), {"sender": "owner"}) == \
        "The owner's mailbox needs a person; this workflow runs as Nexus"
    assert act.allowed(_ctx(db), {"sender": "owner"}) == ""
    assert "(Person has no files to attach)" in act.plan(_ctx(db), {"to": [{"kind": "self"}], "subject": "s",
                                                                    "attach": True})


def test_email_attaches_the_records_files_within_3_mb(db, monkeypatch):
    import httpx

    from routers import files as files_router
    monkeypatch.setattr(leader, "is_deployed_worker", lambda: True)
    monkeypatch.setattr(graph_mail, "DEFAULT_FROM_EMAIL", "nexus@greensglobal.com")
    monkeypatch.setattr(files_router, "_SUPABASE_URL", "https://sb.test")
    monkeypatch.setattr(files_router, "_SERVICE_KEY", "")
    base = "https://sb.test/storage/v1/object/public/task-files/t1/"
    db.add(models.TaskAttachment(id="a1", task_id="e-priya", name="plan.pdf", url=base + "plan.pdf", added_at="1"))
    db.add(models.TaskAttachment(id="a2", task_id="e-priya", name="big.zip", url=base + "big.zip", added_at="2"))
    db.add(models.TaskAttachment(id="a3", task_id="e-priya", name="elsewhere.pdf", url="https://evil.test/x.pdf",
                                 added_at="3"))
    db.commit()
    assert outbox.record_files(db, db.get(models.NexusEmployee, "e-priya")) == [
        ("plan.pdf", base + "plan.pdf"), ("big.zip", base + "big.zip")]       # only Nexus's own storage

    class _R:
        def __init__(self, n):
            self.content = b"x" * n

        def raise_for_status(self):
            pass
    monkeypatch.setattr(httpx, "get", lambda url, timeout: _R(10 if url.endswith("plan.pdf") else 200))
    monkeypatch.setattr(outbox, "MAX_ATTACH_BYTES", 100)
    monkeypatch.setattr(catalog.ENTITIES["employee"], "files", outbox.record_files)
    calls = []
    monkeypatch.setattr(graph_mail, "send_mail", lambda **kw: calls.append(kw))
    out = catalog.ACTIONS["email"].run(_ctx(db), {"to": [{"kind": "self"}], "subject": "Plan", "body": "See it",
                                                  "attach": True})
    assert [a[0] for a in calls[0]["attachments"]] == ["plan.pdf"]
    assert calls[0]["attachments"][0][1] == "application/pdf"
    assert "Too large to attach (open the record in Nexus): big.zip" in calls[0]["html"]
    assert out["line"] == "Emailed Priya Shah: Plan with 1 file attached (1 too large to attach)"
    db.query(models.TaskAttachment).delete()
    db.commit()


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
