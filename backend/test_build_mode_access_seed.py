"""Build Mode access, set once (Neil, 11/12/2026). ONE FILE PER PROCESS - it
binds `database` to its own throwaway SQLite."""
import os
import tempfile

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import pytest  # noqa: E402

import auth  # noqa: E402
import build_mode_access_seed as seed  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402


@pytest.fixture(autouse=True)
def _db():
    models.Base.metadata.create_all(bind=database.engine)
    db = database.SessionLocal()
    for m in (models.NexusGroup, models.NexusGroupMember, models.NexusSetting):
        db.query(m).delete()
    db.commit()
    cache.module_grants.invalidate()
    yield db
    db.close()


def _level(db, email):
    cache.module_grants.invalidate()
    return auth._module_level(email, "build-mode", db)


def test_the_four_get_build_mode_through_one_access_group_and_nobody_else(_db):
    out = seed.apply_once(_db)
    assert out == {"group": "Build Mode", "added": list(seed.PEOPLE)}
    groups = _db.query(models.NexusGroup).all()
    assert len(groups) == 1
    g = groups[0]
    # An Access Group, not a role: no job role, no tier, shared by every company.
    assert (g.name, g.is_job_role, g.tier or "", g.company_id or "", g.allowed_modules) == \
        ("Build Mode", 0, "", "", "build-mode:full")
    for email in ("neil@greensglobal.com", "visesh.lodha@greensglobal.com", "pranshu.pandey@greensglobal.com",
                  "sagar.shoundik@greensglobal.com"):
        assert _level(_db, email) >= auth._MODULE_LEVEL_RANK["viewer"], email
    assert _level(_db, "charmi@greensglobal.com") == 0
    assert _level(_db, "someone.else@greensglobal.com") == 0


def test_it_runs_once_so_a_change_made_in_settings_stands(_db):
    seed.apply_once(_db)
    g = _db.query(models.NexusGroup).one()
    _db.query(models.NexusGroupMember).filter_by(group_id=g.id, email="sagar.shoundik@greensglobal.com").delete()
    _db.add(models.NexusGroupMember(group_id=g.id, email="new.dev@greensglobal.com", added_by="neil@greensglobal.com"))
    _db.commit()
    assert seed.apply_once(_db) is None
    assert _level(_db, "sagar.shoundik@greensglobal.com") == 0
    assert _level(_db, "new.dev@greensglobal.com") > 0
    assert _db.query(models.NexusGroup).count() == 1


def test_a_group_that_already_grants_it_is_left_alone(_db):
    _db.add(models.NexusGroup(id="g1", name="Developers", allowed_modules="tasks:viewer, build-mode:viewer"))
    _db.add(models.NexusGroupMember(group_id="g1", email="pranshu.pandey@greensglobal.com"))
    _db.commit()
    assert seed.apply_once(_db) == {"group": "", "added": []}
    assert _db.query(models.NexusGroup).count() == 1
    assert _level(_db, "neil@greensglobal.com") == 0        # whoever set the group up decided
    assert seed.apply_once(_db) is None
