import os
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "sqlite:///./greens_nexus.db"
)

if DATABASE_URL.startswith("sqlite"):
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
else:
    # psycopg2-binary bundles its own libpq — no system dependencies needed on
    # Azure App Service. sslmode=require encrypts without verifying the cert chain;
    # Supabase's intermediate CA isn't in Azure's trust store so verify-full fails.
    url = DATABASE_URL
    if url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg2://", 1)
    elif url.startswith("postgresql+pg8000://"):
        url = url.replace("postgresql+pg8000://", "postgresql+psycopg2://", 1)
    engine = create_engine(
        url,
        connect_args={"sslmode": "require", "options": "-c statement_timeout=25000"},
        # Connection budget: Supabase max_connections=60, ~10 reserved for
        # superuser/internal → ~50 usable, shared by BOTH deployment slots while
        # a deploy overlaps. The old 3+5 per worker × 8 workers = 64 potential
        # OVERSHOT that ceiling — bursts (one page load fans out 10-15 calls)
        # intermittently hit "too many clients" → instant OperationalError →
        # random 500s on any endpoint (Jul 24 diagnosis). 2+3 × 8 workers = 40
        # caps prod safely under the limit; short bursts beyond it queue for up
        # to pool_timeout instead of erroring. pool_pre_ping replaces stale
        # connections transparently; pool_recycle retires them before Supabase's
        # pooler drops them.
        pool_size=2,
        max_overflow=3,
        pool_timeout=10,
        pool_pre_ping=True,
        pool_recycle=300,
    )

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
