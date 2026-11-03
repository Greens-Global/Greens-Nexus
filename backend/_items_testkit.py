"""Shared setup for the Item Management test files (test_items_*.py, Nov 2026).

Import it FIRST in a test file: it gives the process its own throwaway SQLite
database (before anything imports `database`), builds the tables, and makes
the storage origin and the realtime ping test values. Like every backend test
file these run ONE FILE PER PROCESS (CLAUDE.md):

    python -m pytest test_items_walls.py -q

Not a test module itself (no test_ prefix), so pytest never collects it.
"""
import os
import tempfile
from contextlib import contextmanager
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
from routers import items  # noqa: E402


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(
            f"_items_testkit deletes rows and is pointed at {actual!r}, not its own temp "
            "database. Another module imported `database` first. Run one test file per process.")


_assert_isolated()
models.Base.metadata.create_all(bind=database.engine)

STORAGE = "https://nexus-test.supabase.co/storage/v1/object/public/"
PHOTO = STORAGE + "checkout-photos/t/1.jpg"
items._STORAGE_PREFIX = STORAGE
items._fire_item_event = lambda *a, **k: None

COA, COB = "ent-items-a", "ent-items-b"
# People (email, company, role). Managers are level 3, employees level 1.
EMP_A = "erin.items@greensglobal.com"
EMP_A2 = "evan.items@greensglobal.com"
ALLOC_A = "alan.items@greensglobal.com"
MGR_A = "mia.items@greensglobal.com"
MGR_A2 = "max.items@greensglobal.com"
EMP_B = "beth.items@greensglobal.com"
MGR_B = "bob.items@greensglobal.com"
OWNER = "olga.items@greensglobal.com"
SUP_A = "sue.items@greensglobal.com"

PEOPLE = [
    (EMP_A, COA, "employee", "Erin", "Alpha"),
    (EMP_A2, COA, "employee", "Evan", "Alpha"),
    (ALLOC_A, COA, "employee", "Alan", "Alpha"),
    (MGR_A, COA, "manager", "Mia", "Alpha"),
    (MGR_A2, COA, "manager", "Max", "Alpha"),
    (SUP_A, COA, "supervisor", "Sue", "Alpha"),
    (EMP_B, COB, "employee", "Beth", "Beta"),
    (MGR_B, COB, "manager", "Bob", "Beta"),
    (OWNER, COA, "owner", "Olga", "Owner"),
]
LEVEL = {"employee": 1, "supervisor": 2, "manager": 3, "administrator": 4, "owner": 5}


def user(email: str) -> dict:
    role = next((r for e, _c, r, _f, _l in PEOPLE if e == email), "employee")
    return {"email": email, "level": LEVEL[role]}


_TABLES = (models.ItemCheckout, models.ItemAssignment, models.Item, models.NexusNotification,
           models.AuditLog, models.NexusEmployee, models.NexusRole, models.ItemCartEntry,
           models.NexusGroup, models.NexusGroupMember, models.NexusAccessScope,
           models.ShiftAssignment, models.Shift)


def fresh():
    """A session over empty item tables and the standard people."""
    db = database.SessionLocal()
    for m in _TABLES:
        db.query(m).delete()
    db.commit()
    for email, company, role, first, last in PEOPLE:
        db.add(models.NexusEmployee(id=f"e-{email}", first_name=first, last_name=last, work_email=email,
                                    status="active", deleted_at="", company=company))
        db.add(models.NexusRole(email=email, role=role))
    db.commit()
    cache.module_grants.invalidate()
    cache.role_holders.invalidate()
    return db


def add_item(db, iid, company=COA, *, ownership="transient", status="available", name=None, **cols):
    db.add(models.Item(id=iid, name=name or f"Item {iid}", company_id=company, ownership_type=ownership,
                       status=status, serial_number=cols.pop("serial_number", ""), **cols))
    db.commit()


def add_checkout(db, cid, iid, status, *, requester=EMP_A, allocator=ALLOC_A, order="", approver="", **cols):
    db.add(models.ItemCheckout(
        id=cid, item_id=iid, item_name=cols.pop("item_name", f"Item {iid}"),
        requested_by=requester.split(".")[0].title(), requested_by_email=requester,
        raised_by=requester.split(".")[0].title(), status=status, order_id=order,
        assigned_allocator_email=allocator, approver_email=approver,
        created_at=cols.pop("created_at", "2026-10-01T10:00:00+00:00"), days=cols.pop("days", 3), **cols))
    db.commit()


def add_assignment(db, aid, iid, status, *, assignee=EMP_A, by=MGR_A, **cols):
    db.add(models.ItemAssignment(
        id=aid, item_id=iid, item_name=cols.pop("item_name", f"Item {iid}"), assignee_email=assignee,
        assignee_name=assignee.split(".")[0].title(), assigned_by=by.split(".")[0].title(),
        assigned_by_email=by, status=status, created_at=cols.pop("created_at", "2026-10-01T10:00:00+00:00"),
        **cols))
    db.commit()


@contextmanager
def walls(on: bool = True):
    """The company-walls switch (Settings > Companies), on for the block."""
    with mock.patch.object(auth, "_company_walls_on", return_value=on):
        yield


def refused(testcase, code: int, fn, *a, **kw) -> HTTPException:
    """Call fn(*a, **kw) and expect an HTTPException with status `code`."""
    with testcase.assertRaises(HTTPException) as e:
        fn(*a, **kw)
    testcase.assertEqual(e.exception.status_code, code, e.exception.detail)
    return e.exception


def bells(db, ntype=None, ref=None):
    q = db.query(models.NexusNotification)
    if ntype:
        q = q.filter(models.NexusNotification.type == ntype)
    if ref:
        q = q.filter(models.NexusNotification.ref_id == ref)
    return q.all()


def cleanup():
    database.engine.dispose()
    try:
        os.remove(_tmp_db.name)
    except (FileNotFoundError, PermissionError):
        pass
