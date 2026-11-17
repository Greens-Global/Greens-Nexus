"""Operations access (ops_access.py, Neil, 11/17/2026): which facilities a
person sees and whether they see tenant details - by person and by Access
Group / job role, fail closed below Administrator.

Throwaway SQLite. Run alone: python -m pytest test_ops_access.py
"""
import atexit
import os
import tempfile

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import pytest  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402
import ops_access  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

ME = "site.lead@greensglobal.com"


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


@pytest.fixture
def db():
    s = database.SessionLocal()
    for t in (models.OpsAccessRule, models.NexusGroupMember, models.NexusGroup):
        s.query(t).delete()
    s.commit()
    yield s
    s.close()


def _user(level=2, email=ME):
    return {"email": email, "role": {4: "administrator", 5: "owner"}.get(level, "supervisor"), "level": level}


def _rule(db, kind, sid, facilities, details=False):
    db.add(models.OpsAccessRule(id=f"{kind}-{sid}", subject_type=kind, subject_id=sid,
                                facility_ids=facilities, tenant_details=details))
    db.commit()


def _group(db, gid, members=(ME,), modules=""):
    db.add(models.NexusGroup(id=gid, name=gid.title(), allowed_modules=modules))
    for email in members:
        db.add(models.NexusGroupMember(group_id=gid, email=email))
    db.commit()


def test_an_administrator_reaches_everything(db):
    _rule(db, "person", "admin@greensglobal.com", ["fac_a"], False)    # a rule never narrows an administrator
    for level in (4, 5):
        assert ops_access.reach(_user(level, "admin@greensglobal.com"), db) == {"facilities": None, "tenant_details": True}


def test_no_rule_fails_closed_on_tenant_details(db):
    for level in (1, 2, 3):
        assert ops_access.reach(_user(level), db) == {"facilities": None, "tenant_details": False}


def test_a_person_rule(db):
    _rule(db, "person", ME, ["fac_a"], True)
    _rule(db, "person", "someone.else@greensglobal.com", ["fac_b"], True)
    assert ops_access.reach(_user(), db) == {"facilities": {"fac_a"}, "tenant_details": True}
    assert ops_access.reach(_user(email="Site.Lead@GreensGlobal.com"), db)["facilities"] == {"fac_a"}   # however it is cased
    # Their rule is not mine.
    assert ops_access.reach(_user(email="third@greensglobal.com"), db) == {"facilities": None, "tenant_details": False}


def test_a_group_rule_reaches_its_members_only(db):
    _group(db, "site-managers")
    _group(db, "call-center", members=("agent@greensglobal.com",))
    _rule(db, "group", "site-managers", ["fac_b"], True)
    _rule(db, "group", "call-center", ["fac_c"], True)
    assert ops_access.reach(_user(), db) == {"facilities": {"fac_b"}, "tenant_details": True}
    assert ops_access.reach(_user(email="agent@greensglobal.com"), db)["facilities"] == {"fac_c"}
    # A group id that happens to be an email is still a group rule, and the other way round.
    _rule(db, "group", ME, ["fac_z"], True)
    _rule(db, "person", "site-managers", ["fac_y"], True)
    assert ops_access.reach(_user(), db)["facilities"] == {"fac_b"}


def test_facilities_are_the_union_of_every_matching_rule(db):
    _group(db, "site-managers")
    _group(db, "district")
    _rule(db, "person", ME, ["fac_a"], False)
    _rule(db, "group", "site-managers", ["fac_b", "fac_a"], False)
    _rule(db, "group", "district", ["fac_c"], False)
    assert ops_access.reach(_user(), db) == {"facilities": {"fac_a", "fac_b", "fac_c"}, "tenant_details": False}


def test_an_empty_list_means_every_facility(db):
    _group(db, "regional")
    _rule(db, "person", ME, ["fac_a"], True)
    assert ops_access.reach(_user(), db)["facilities"] == {"fac_a"}
    _rule(db, "group", "regional", [], False)
    assert ops_access.reach(_user(), db) == {"facilities": None, "tenant_details": True}


def test_tenant_details_come_from_any_rule(db):
    _group(db, "site-managers")
    _rule(db, "person", ME, ["fac_a"], False)
    assert ops_access.reach(_user(), db)["tenant_details"] is False
    _rule(db, "group", "site-managers", ["fac_b"], True)
    assert ops_access.reach(_user(), db) == {"facilities": {"fac_a", "fac_b"}, "tenant_details": True}


def test_a_broken_facility_list_grants_no_facility(db):
    _rule(db, "person", ME, None, True)                                # a hand-edited row, not the screen's []
    assert ops_access.reach(_user(), db) == {"facilities": set(), "tenant_details": True}


def test_sees_and_narrow():
    every, some = {"facilities": None, "tenant_details": True}, {"facilities": {"fac_b"}, "tenant_details": True}
    assert ops_access.sees(every, "fac_a") and ops_access.sees(some, "fac_b") and not ops_access.sees(some, "fac_a")
    assert ops_access.narrow(every, ["fac_a", "fac_b"]) == ["fac_a", "fac_b"]
    assert ops_access.narrow(some, ["fac_a", "fac_b"]) == ["fac_b"]


def test_who_may_manage_the_rules(db):
    assert ops_access.may_manage(_user(4), db) and ops_access.may_manage(_user(5), db)
    assert not ops_access.may_manage(_user(3), db)                     # a Manager alone may not
    _group(db, "ops-editors", members=("editor@greensglobal.com",), modules="operations:editor")
    _group(db, "ops-full", members=("full@greensglobal.com",), modules="tasks:viewer,operations:full")
    assert not ops_access.may_manage(_user(2, "editor@greensglobal.com"), db)
    assert ops_access.may_manage(_user(1, "full@greensglobal.com"), db)   # the Push to Cubby rule: an Operations grant at Full
    # Tenant details are a separate matter: managing the rules does not open them.
    assert ops_access.reach(_user(1, "full@greensglobal.com"), db)["tenant_details"] is False
