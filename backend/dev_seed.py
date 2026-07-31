"""Local-only dev seed: give NEXUS_DEV_EMAIL an owner role + an HR employee row.

Without a `nexus_roles` row the skip-auth dev identity resolves to "employee"
(auth.py `_role_for` defaults there), which hides every `minRole: supervisor`
module from the sidebar - most of the app is unreachable on a laptop.

Safe by construction: refuses to run unless DATABASE_URL is unset, i.e. only
against the local SQLite file. Never run this against the shared dev Postgres.

    cd backend && .venv/bin/python dev_seed.py
"""
import os
import uuid

from dotenv import load_dotenv

load_dotenv()

if os.getenv("DATABASE_URL"):
    raise SystemExit("refusing to run: DATABASE_URL is set (this is local-SQLite only)")

from database import SessionLocal, engine  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=engine)

EMAIL = os.getenv("NEXUS_DEV_EMAIL", "dev@localhost").lower()
FIRST, LAST = "Visesh", "Lodha"

db = SessionLocal()

role = db.query(models.NexusRole).filter(models.NexusRole.email == EMAIL).first()
if role:
    role.role = "owner"
else:
    db.add(models.NexusRole(email=EMAIL, role="owner",
                            display_name=f"{FIRST} {LAST}", assigned_by="dev_seed"))

emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == EMAIL).first()
if not emp:
    db.add(models.NexusEmployee(
        id=str(uuid.uuid4()),
        employee_code="GG-001",
        first_name=FIRST,
        last_name=LAST,
        work_email=EMAIL,
        job_title="Software Developer",
        department="IT",
        employment_type="full_time",
        start_date="2026-01-05",
        status="active",
        location="Mumbai",
    ))

db.commit()
db.close()

print(f"dev seed OK - {EMAIL} is now owner (level 5) with an employee record")
