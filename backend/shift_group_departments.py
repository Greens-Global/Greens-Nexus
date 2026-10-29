"""Shift groups that follow a department (Neil, Oct 28 2026).

A group may name a department (`shift_groups.department`, within the group's
company when it has one). Every active person in that department is a member
without anyone adding them - Construction was missing six people because
nobody had put them on the group. Those rows carry `source = 'department'`;
people added by hand have `source = ''` and are never touched here.

A person's department, status or company changes from many places (People,
hiring, role changes, offboarding, department renames...), so - like
feature_request_sync.py - a before_flush hook sees the change wherever it
happened instead of every route remembering to call us. Kept apart from
routers/timeclock.py so database.py can wire it before models exist.
"""
import uuid

from sqlalchemy import event, func, inspect

AUTO = "department"
# The person fields that decide whether they belong to a department's group.
_WATCHED = ("department", "status", "company", "deleted_at", "work_email")


def _active(e) -> bool:
    # The schedule's own rule (timeclock._is_active_emp): active, not deleted.
    return bool(e.work_email) and (e.status or "active").lower() == "active" and not (e.deleted_at or "")


def in_department(g, e) -> bool:
    dept = (g.department or "").strip().lower()
    return (bool(dept) and _active(e) and (e.department or "").strip().lower() == dept
            and (not (g.company_id or "") or (e.company or "") == g.company_id))


def sync_group(db, g) -> None:
    """Make the group's automatic members match its department now. Hand-added
    members stay; someone already on the group by hand gets no second row."""
    import models
    rows = db.query(models.ShiftGroupMember).filter(models.ShiftGroupMember.group_id == g.id).all()
    have = {}
    for r in rows:
        have.setdefault((r.employee_email or "").lower(), r)
    want = set()
    dept = (g.department or "").strip().lower()
    if dept:
        q = db.query(models.NexusEmployee).filter(func.lower(func.trim(models.NexusEmployee.department)) == dept)
        want = {(e.work_email or "").lower() for e in q.all() if in_department(g, e)}
    for r in rows:
        if (r.source or "") == AUTO and (r.employee_email or "").lower() not in want:
            db.delete(r)
    for em in sorted(want - set(have)):
        db.add(models.ShiftGroupMember(id=str(uuid.uuid4()), group_id=g.id, employee_email=em, source=AUTO))


def sync_person(session, e) -> None:
    """Add or take off this one person's automatic memberships."""
    import models
    em = (e.work_email or "").lower()
    if not em:
        return
    groups = session.query(models.ShiftGroup).filter(models.ShiftGroup.department != "").all()
    if not groups:
        return
    rows = {}
    for r in (session.query(models.ShiftGroupMember)
              .filter(func.lower(models.ShiftGroupMember.employee_email) == em).all()):
        rows.setdefault(r.group_id, r)
    for g in groups:
        r = rows.get(g.id)
        if in_department(g, e):
            if r is None:
                session.add(models.ShiftGroupMember(id=str(uuid.uuid4()), group_id=g.id, employee_email=em, source=AUTO))
        elif r is not None and (r.source or "") == AUTO:
            session.delete(r)


def _changed(obj, names) -> bool:
    state = inspect(obj)
    return any(state.attrs[n].history.has_changes() for n in names)


def wire(session_factory):
    @event.listens_for(session_factory, "before_flush")
    def _department_groups(session, _ctx, _instances):
        import models
        try:
            # A renamed department keeps its groups: they follow the new name
            # (People renames everyone's department string in the same save).
            for d in list(session.dirty):
                if isinstance(d, models.HrDepartment) and _changed(d, ("name",)):
                    old = (inspect(d).attrs.name.history.deleted or [""])[0] or ""
                    if not old.strip():
                        continue
                    for g in (session.query(models.ShiftGroup)
                              .filter(func.lower(models.ShiftGroup.department) == old.strip().lower(),
                                      models.ShiftGroup.company_id == (d.company_id or "")).all()):
                        g.department = d.name
            people = [o for o in list(session.new) if isinstance(o, models.NexusEmployee)]
            people += [o for o in list(session.dirty) if isinstance(o, models.NexusEmployee) and _changed(o, _WATCHED)]
            for e in people:
                sync_person(session, e)
        except Exception as e:  # noqa: BLE001 - a group sync must never fail the People save
            print(f"[shift-groups] department sync: {e}")
