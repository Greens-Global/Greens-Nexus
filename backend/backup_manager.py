"""Backup Manager (Neil, Oct 13): who covers an employee when their manager
is out. The backup has the SAME rights over that employee as the manager -
timecards, punches, leave on their behalf, punch requests, timesheet review,
People - so every manager check adds `backed_up_by()` to the people a caller
manages directly.

Who the backup is, in order:
  1. the person set on the employee's profile (nexus_employees.backup_manager_email);
  2. otherwise their manager's manager;
  3. otherwise the HR contact of the employee's company (People -> Companies).

Nobody is their own backup, and a backup who is already the employee's manager
adds nothing. The level gate is unchanged: a backup still needs the manager
tier (or an HR grant) to open the team screens, exactly like a manager does.
"""
from sqlalchemy.orm import Session


def roster(db: Session):
    from models import HrEntity, NexusEmployee
    rows = db.query(NexusEmployee.work_email, NexusEmployee.manager_email,
                    NexusEmployee.backup_manager_email, NexusEmployee.company).all()
    hr = {e.id: (e.hr_contact_email or "").strip().lower()
          for e in db.query(HrEntity.id, HrEntity.hr_contact_email).all()}
    people = {}
    for em, mgr, bk, company in rows:
        em = (em or "").strip().lower()
        if em:
            people[em] = ((mgr or "").strip().lower(), (bk or "").strip().lower(), company or "")
    return people, hr


def resolve(em: str, people: dict, hr: dict) -> tuple[str, str]:
    """(backup email, source) for one employee. source: 'set' | 'manager' | 'hr' | ''."""
    mgr, bk, company = people.get(em, ("", "", ""))
    if bk and bk != em:
        return bk, "set"
    mm = people.get(mgr, ("", "", ""))[0] if mgr else ""
    if mm and mm != em:
        return mm, "manager"
    h = hr.get(company, "")
    if h and h != em:
        return h, "hr"
    return "", ""


def backup_of(db: Session, email: str) -> tuple[str, str]:
    """The effective backup manager of `email` and where it comes from."""
    people, hr = roster(db)
    return resolve((email or "").strip().lower(), people, hr)


def backed_up_by(db: Session, me: str) -> set:
    """Everyone `me` is the backup manager for (never me, never someone I
    already manage directly)."""
    me = (me or "").strip().lower()
    if not me:
        return set()
    people, hr = roster(db)
    out = set()
    for em, (mgr, _bk, _c) in people.items():
        if em == me or mgr == me:
            continue
        if resolve(em, people, hr)[0] == me:
            out.add(em)
    return out


def managed_directly(db: Session, me: str) -> set:
    """Direct reports plus the people `me` backs up - the set a manager's
    rights apply to one level down."""
    from models import NexusEmployee
    me = (me or "").strip().lower()
    directs = {(e.work_email or "").strip().lower() for e in db.query(NexusEmployee.work_email, NexusEmployee.manager_email).all()
               if e.work_email and (e.manager_email or "").strip().lower() == me}
    return (directs | backed_up_by(db, me)) - {me}
