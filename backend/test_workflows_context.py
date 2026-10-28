"""Workflows (Oct 28 2026) - Task 4: the run context, templating and
recipients.

  * render fills `{{ subject.name }}` and `{{ subject.start_date | us_date }}`
    as MM/DD/YYYY, reports a path that resolves to nothing, honors
    default:"-", and never shows a comp field to someone without hr_comp;
  * paths: change.<field>.from / to, actor.name, today, subject.link;
  * recipients: the manager and the HR contact resolve and dedupe, the cap
    drops and counts, a person who may not see the record is dropped.

    cd backend && python -m pytest test_workflows_context.py -q
"""
import os
import tempfile
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
import models  # noqa: E402
from workflows import catalog, recipients  # noqa: E402
from workflows.context import MISSING, RunContext, render, us_date, us_datetime  # noqa: E402

ENTITY = "ent-ctx"
PRIYA, MAX, HANA, DEE = ("priya.ctx@greensglobal.com", "max.ctx@greensglobal.com",
                         "hana.ctx@greensglobal.com", "dee.ctx@greensglobal.com")


@pytest.fixture(scope="module", autouse=True)
def _setup():
    assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
    models.Base.metadata.create_all(bind=database.engine)
    catalog.load_packs()
    catalog.entity("test_person", label="Test Person", model=models.NexusEmployee, module="core",
                   company=lambda row: row.company,
                   people={"self": lambda db, row: [row.work_email], "manager": lambda db, row: [row.manager_email]},
                   fields=[catalog.F("name", "Name", "text", path="__label__"),
                           catalog.F("start_date", "Start Date", "date"),
                           catalog.F("pay", "Pay", "money", visibility="comp", path="compensation.base"),
                           catalog.F("dob", "Birthday", "date", visibility="hr", path="personal.dob"),
                           catalog.F("manager_email", "Manager", "person")],
                   label_of=lambda row: f"{row.first_name} {row.last_name}".strip(),
                   visible_to=lambda db, user, row: user["email"] != DEE)
    catalog.event("test_person.changed", entity="test_person", label="Changed", module="core", group="Test",
                  changes=("start_date",), sample={"name": "Priya Shah", "start_date": "2026-11-12"})
    yield
    database.engine.dispose()
    try:
        os.remove(_tmp_db.name)
    except (FileNotFoundError, PermissionError):
        pass


@pytest.fixture
def db():
    s = database.SessionLocal()
    for m in (models.WorkflowEvent, models.NexusEmployee, models.NexusRole, models.HrEntity):
        s.query(m).delete()
    s.add(models.HrEntity(id=ENTITY, name="Greens Test", hr_contact_email=HANA))
    for em, first, mgr in ((PRIYA, "Priya", MAX), (MAX, "Max", ""), (HANA, "Hana", ""), (DEE, "Dee", MAX)):
        s.add(models.NexusEmployee(id=f"id-{first}", work_email=em, first_name=first,
                                   last_name="Shah" if first == "Priya" else "Test", manager_email=mgr,
                                   status="active", company=ENTITY, start_date="2026-11-12",
                                   compensation={"base": 95000}, personal={"dob": "1994-03-08"}))
    s.add(models.NexusRole(email=MAX, role="manager", assigned_by="test"))
    s.commit()
    auth._role_cache.clear()
    cache.module_grants.invalidate()
    yield s
    s.rollback()
    s.close()


def _ctx(db, run_as=None, **kw):
    ent = catalog.ENTITIES["test_person"]
    row = db.get(models.NexusEmployee, "id-Priya")
    payload = {"subject": {"name": "Priya Shah", "start_date": "2026-11-12"},
               "changes": {"start_date": {"from": "2026-10-01", "to": "2026-11-12"}},
               "extra": {"note": "moved"}, "actor": HANA}
    return RunContext(db=db, entity=ent, subject=row, payload=payload, actor=HANA,
                      run_as=run_as or {"email": MAX, "role": "manager", "level": 3},
                      today=date(2026, 10, 28), **kw)


# ── us formats ────────────────────────────────────────────────────────────────
def test_us_date_and_datetime():
    assert us_date("2026-11-12") == "11/12/2026"
    assert us_date("2026-11-12T08:00:00+00:00") == "11/12/2026"
    assert us_date("") == "" and us_date("soon") == "soon"
    assert us_datetime("2026-11-12T20:05:00+00:00", "America/Los_Angeles") == "11/12/2026 12:05 PM"
    assert us_datetime("2026-11-12T08:00:00") == "11/12/2026 8:00 AM"
    assert us_datetime("2026-11-12") == "11/12/2026"


# ── templating ───────────────────────────────────────────────────────────────
def test_render_fills_paths_and_us_date(db):
    text, missing = render("{{ subject.name }} starts {{ subject.start_date | us_date }}", _ctx(db))
    assert text == "Priya Shah starts 11/12/2026" and missing == []


def test_render_reports_missing_paths(db):
    assert render("{{ subject.nope }}", _ctx(db)) == ("", ["subject.nope"])
    assert render("{{ nothing.here }}", _ctx(db)) == ("", ["nothing.here"])


def test_render_default_filter(db):
    text, missing = render('{{ subject.nope | default:"-" }}', _ctx(db))
    assert text == "-" and missing == []
    text, _ = render("{{ subject.name | default:'x' | upper }}", _ctx(db))
    assert text == "PRIYA SHAH"


def test_render_change_actor_today_and_link(db):
    ctx = _ctx(db)
    text, missing = render("{{ change.start_date.from | us_date }} -> {{ change.start_date.to | us_date }} "
                           "by {{ actor.name }} ({{ actor.email }}) on {{ today | us_date }} "
                           "note {{ event.note }}", ctx)
    assert text == "10/01/2026 -> 11/12/2026 by Hana Test (hana.ctx@greensglobal.com) on 10/28/2026 note moved"
    assert missing == []
    assert render("{{ subject.link }}", ctx)[0] == ""           # the test entity has no link
    emp = catalog.ENTITIES["employee"]
    ctx2 = RunContext(db=db, entity=emp, subject=db.get(models.NexusEmployee, "id-Priya"))
    assert render("{{ subject.link }}", ctx2)[0] == "https://nexus.test/hr/people:id-Priya"


def test_comp_field_is_missing_for_non_comp_user(db):
    ctx = _ctx(db)                                   # a manager: no hr_comp grant
    assert ctx.resolve("subject.pay") is MISSING
    assert render("Pay {{ subject.pay }}", ctx) == ("Pay ", ["subject.pay"])
    assert ctx.resolve("subject.dob") is MISSING     # hr field, no HR grant either
    owner = _ctx(db, run_as={"email": MAX, "role": "owner", "level": 5})
    assert owner.resolve("subject.pay") == 95000
    assert render("{{ subject.dob | us_date }}", owner)[0] == "03/08/1994"
    nexus = _ctx(db, run_as=None)
    assert nexus.resolve("subject.pay") is MISSING and nexus.resolve("subject.name") == "Priya Shah"


def test_resolve_falls_back_to_the_payload_without_a_row(db):
    ctx = _ctx(db)
    ctx.subject = None
    assert ctx.resolve("subject.name") == "Priya Shah"
    assert ctx.resolve("subject.start_date") == "2026-11-12"
    assert ctx.resolve("subject.manager_email") is MISSING


def test_item_and_vars(db):
    ctx = _ctx(db, item={"name": "Ravi", "due": "2026-12-01"}, vars={"count": 4})
    assert render("{{ item.name }} {{ item.due | us_date }} {{ vars.count }}", ctx)[0] == "Ravi 12/01/2026 4"


# ── recipients ───────────────────────────────────────────────────────────────
def test_manager_and_hr_contact_resolve_and_dedupe(db):
    ctx = _ctx(db)
    got, dropped = recipients.resolve(ctx, [{"kind": "manager"}, {"kind": "role", "value": "hr_contact"},
                                            {"kind": "person", "value": MAX.upper()}], cap=50)
    assert got == [MAX, HANA] and dropped == 0
    got, _ = recipients.resolve(ctx, [{"kind": "self"}, {"kind": "hr_contact"}], cap=50)
    assert got == [PRIYA, HANA]


def test_cap_drops_and_counts(db):
    ctx = _ctx(db)
    got, dropped = recipients.resolve(ctx, [{"kind": "self"}, {"kind": "manager"},
                                            {"kind": "person", "value": HANA}], cap=2)
    assert got == [PRIYA, MAX] and dropped == 1


def test_invisible_recipient_is_dropped(db):
    ctx = _ctx(db)
    got, dropped = recipients.resolve(ctx, [{"kind": "person", "value": DEE}, {"kind": "manager"}], cap=50)
    assert got == [MAX] and dropped == 1
    got, dropped = recipients.resolve(ctx, [{"kind": "person", "value": "nobody@greensglobal.com"}], cap=50)
    assert got == [] and dropped == 1


def test_department_team_company_and_global_admins(db):
    db.query(models.NexusEmployee).filter(models.NexusEmployee.id == "id-Priya").update({"department": "Ops"})
    db.add(models.NexusRole(email=HANA, role="owner", assigned_by="test"))
    db.commit()
    ctx = _ctx(db)
    assert recipients.resolve(ctx, [{"kind": "department", "value": "Ops"}], cap=50)[0] == [PRIYA]
    assert recipients.resolve(ctx, [{"kind": "team", "value": MAX}], cap=50)[0] == [PRIYA]   # Dee is invisible
    assert recipients.resolve(ctx, [{"kind": "global_admins"}], cap=50)[0] == [HANA]
    got, dropped = recipients.resolve(ctx, [{"kind": "company"}], cap=50)
    assert set(got) == {PRIYA, MAX, HANA} and dropped == 1


def test_describe_reads_as_english():
    assert recipients.describe([{"kind": "manager"}, {"kind": "role", "value": "hr_contact"}]) == \
        "the manager and the HR contact"
    assert recipients.describe([]) == "nobody"
