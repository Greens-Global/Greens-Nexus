"""The five Super Administrators, set once (Neil, 11/02/2026).

Super Administrator is the `owner` tier (level 5) - the only tier that sees
past the company walls (auth.is_global_admin). Neil named the five people
who hold it for now; everyone else who held `owner` becomes an Administrator
(level 4, company-walled). This pass runs at startup after the migrations,
on dev and prod alike, and records itself in nexus_settings under MARK so it
never re-applies: a Super Administrator later demoted by a Super
Administrator stays demoted after a restart, and a later promotion stands.
Never turn this into a code default that reasserts the set.

A second one-time pass, `clear_tier_words_once` (mark TIER_WORDS_MARK), takes
the old tier words out of the DATA: on dev an owner-tier job role was named
"Global Admin", and routers/jobroles.py apply_job_role copies a job role's
name into `nexus_employees.job_title`, so four people had "Global Admin"
under their name. A tier word is never a job title (docs/Roles.md). It has
its own mark so it runs once even where MARK is already written.

Both passes run on EVERY boot (main.py `_tier_seeds`, outside the
once-per-deploy schema gate): each is guarded by its mark and costs one
primary-key read once done.
"""
from datetime import datetime, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

MARK = "roles.super_admins_set_2026_11_02"
TIER_WORDS_MARK = "roles.tier_words_cleared_2026_11_02"

SUPER_ADMINS = (
    "neil@greensglobal.com",
    "visesh.lodha@greensglobal.com",
    "charmi@greensglobal.com",
    "pranshu.pandey@greensglobal.com",
    "sagar.shoundik@greensglobal.com",
)

# Job roles named with an old tier word are access roles: renamed to the tier
# they grant. Exact names only.
JOB_ROLE_RENAMES = {
    "Global Admin": "Super Administrators",
    "IT Admin": "Administrators",
}
# A job title equal (case-insensitive, trimmed) to one of these is cleared.
TIER_TITLES = frozenset((
    "global admin", "it admin",
    "super administrator", "super administrators",
    "administrator", "administrators",
))
NEIL = "neil@greensglobal.com"
NEIL_TITLE = "Managing Principal"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _has_people_record(db: Session, email: str) -> bool:
    from models import NexusEmployee
    return db.query(NexusEmployee.id).filter(
        func.lower(NexusEmployee.work_email) == email).first() is not None


def apply_once(db: Session) -> dict | None:
    """Set the five to `owner` (tier pinned, so a job role's tier never
    re-stamps them) and every OTHER `owner` row to `administrator`, then
    write the mark. Returns what changed - `super_admins` (rows created or
    raised to owner), `demoted`, and `skipped` (one of the five with neither
    a role row nor a People record: on a fresh database no owner row is made
    up for someone who is not there) - or None when the mark is already there
    (nothing touched). Commits."""
    from models import NexusRole, NexusSetting
    import auth

    if db.get(NexusSetting, MARK):
        return None
    now = _now()
    promoted, demoted, skipped = [], [], []
    for email in SUPER_ADMINS:
        row = db.query(NexusRole).filter(func.lower(NexusRole.email) == email).first()
        if row is None:
            if not _has_people_record(db, email):
                skipped.append(email)
                continue
            row = NexusRole(email=email, role="owner", assigned_by="super_admins_seed")
            db.add(row)
            promoted.append(email)
        elif row.role != "owner":
            row.role = "owner"
            row.assigned_by = "super_admins_seed"
            promoted.append(email)
        row.tier_pinned = True
    for row in db.query(NexusRole).filter(NexusRole.role == "owner").all():
        if (row.email or "").lower() in SUPER_ADMINS:
            continue
        row.role = "administrator"
        row.assigned_by = "super_admins_seed"
        demoted.append(row.email)
    db.add(NexusSetting(key=MARK, value=now, updated_by="startup", updated_at=now))
    db.commit()
    auth.invalidate_role_cache()
    return {"super_admins": promoted, "demoted": demoted, "skipped": skipped}


def clear_tier_words_once(db: Session) -> dict | None:
    """Once (TIER_WORDS_MARK): rename the job roles named "Global Admin" /
    "IT Admin" to "Super Administrators" / "Administrators"; clear every
    job_title that is a tier word; give Neil his job title ("Managing
    Principal") when his is empty after that. Returns `renamed` (old -> new
    names), `cleared` (emails whose title was cleared) and `titled` (emails
    given a title), or None when the mark is already there. Commits."""
    from models import NexusEmployee, NexusGroup, NexusSetting

    if db.get(NexusSetting, TIER_WORDS_MARK):
        return None
    now = _now()
    renamed = []
    for g in db.query(NexusGroup).filter(
            NexusGroup.is_job_role == 1, NexusGroup.name.in_(list(JOB_ROLE_RENAMES))).all():
        new = JOB_ROLE_RENAMES[g.name]
        renamed.append(f"{g.name} -> {new}")
        g.name = new
    cleared, titled = [], []
    for emp in db.query(NexusEmployee).filter(
            func.lower(func.trim(NexusEmployee.job_title)).in_(list(TIER_TITLES))).all():
        emp.job_title = ""
        cleared.append(emp.work_email or emp.id)
    neil = db.query(NexusEmployee).filter(func.lower(NexusEmployee.work_email) == NEIL).first()
    if neil is not None and not (neil.job_title or "").strip():
        neil.job_title = NEIL_TITLE
        titled.append(NEIL)
    db.add(NexusSetting(key=TIER_WORDS_MARK, value=now, updated_by="startup", updated_at=now))
    db.commit()
    return {"renamed": renamed, "cleared": cleared, "titled": titled}


# Three grant levels only (Pranshu, 11/12/2026): the Owner GRANT level is
# retired (auth.MODULE_LEVELS) and two grants nothing reads any more go -
# `development` (off the navigation since 08/11/2026) and `purchase` (no code
# ever read it). The tier key `owner` (Super Administrator) is untouched.
OWNER_LEVEL_MARK = "roles.owner_level_retired_2026_11_12"
DEAD_GRANTS = frozenset(("development", "purchase"))


def clean_modules(raw: str) -> str:
    """One allowed_modules string with every `:owner` written as `:full` and
    the dead grants dropped; every other part is kept as it was spelled."""
    parts = []
    for part in (raw or "").split(","):
        part = part.strip()
        mid, _, level = part.partition(":")
        mid = mid.strip().lower()
        if not mid or mid in DEAD_GRANTS:
            continue
        parts.append(f"{mid}:full" if level.strip().lower() == "owner" else part)
    return ",".join(parts)


def retire_owner_level_once(db: Session) -> dict | None:
    """Once (OWNER_LEVEL_MARK): rewrite `allowed_modules` on every group and
    job role through clean_modules. Returns `groups` (names changed), or None
    when the mark is already there. Commits and drops the grants cache."""
    from models import NexusGroup, NexusSetting
    import cache

    if db.get(NexusSetting, OWNER_LEVEL_MARK):
        return None
    now = _now()
    changed = []
    for g in db.query(NexusGroup).filter(NexusGroup.allowed_modules != "").all():
        new = clean_modules(g.allowed_modules)
        if new != g.allowed_modules:
            g.allowed_modules = new
            changed.append(g.name or g.id)
    db.add(NexusSetting(key=OWNER_LEVEL_MARK, value=now, updated_by="startup", updated_at=now))
    db.commit()
    cache.module_grants.invalidate()
    return {"groups": changed}
