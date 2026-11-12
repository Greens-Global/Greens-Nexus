"""Shared setup for the test_levels_<module>.py files (11/12/2026): what each
Access Group level (Viewer / Editor / Full) opens in a module.

Call `bind_db()` FIRST, before importing database or main (CLAUDE.md: one
throwaway SQLite per test process), then `seed(db, ...)` and `grant(...)`.
The caller is switched with `as_(email)` (NEXUS_SKIP_AUTH reads it per request).
"""
import os
import tempfile
import uuid


def bind_db() -> str:
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    os.environ["DATABASE_URL"] = f"sqlite:///{tmp.name}"
    os.environ["NEXUS_SKIP_AUTH"] = "true"
    return tmp.name


def as_(email: str) -> None:
    os.environ["NEXUS_DEV_EMAIL"] = email


def person(db, email: str, manager: str = "", company: str = "co-lv", role: str = "", first: str = "") -> None:
    import models
    db.add(models.NexusEmployee(id=f"e-{email}", first_name=first or email.split("@")[0], last_name="Test",
                                work_email=email, manager_email=manager, company=company, status="active",
                                deleted_at=""))
    if role:
        db.add(models.NexusRole(email=email, role=role))


def grant(db, email: str, modules: str) -> None:
    """One Access Group with `modules` ("credvault:editor,hr:viewer") and `email` in it."""
    import models
    gid = f"g-{uuid.uuid4().hex[:8]}"
    db.add(models.NexusGroup(id=gid, name=gid, allowed_modules=modules))
    db.add(models.NexusGroupMember(group_id=gid, email=email))


def refresh() -> None:
    import auth
    import cache
    cache.module_grants.invalidate()
    auth.invalidate_role_cache()


def reset(db, *tables) -> None:
    import models
    for m in (models.NexusEmployee, models.NexusRole, models.NexusGroup, models.NexusGroupMember,
              models.HrEntity, models.NexusNotification) + tuple(tables):
        db.query(m).execution_options(include_deleted=True).delete(synchronize_session=False)
    db.add(models.HrEntity(id="co-lv", name="Levels Co"))
