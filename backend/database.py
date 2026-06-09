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
        # 8 workers × (pool_size + max_overflow) = 64 max connections — safe on
        # Supabase Pro. pool_pre_ping replaces stale connections transparently;
        # pool_recycle retires them before Supabase's pooler drops them.
        pool_size=3,
        max_overflow=5,
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
