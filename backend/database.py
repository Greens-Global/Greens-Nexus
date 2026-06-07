import os
import ssl
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "sqlite:///./greens_nexus.db"
)

if DATABASE_URL.startswith("sqlite"):
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
else:
    # Force pg8000 driver (pure Python, no C extensions needed)
    url = DATABASE_URL.replace("postgresql+psycopg2://", "postgresql+pg8000://")
    if not url.startswith("postgresql+"):
        url = url.replace("postgresql://", "postgresql+pg8000://")
    # Supabase requires SSL — pg8000 needs it passed explicitly via ssl_context.
    # CERT_NONE is intentional: Supabase uses a self-signed intermediate CA that is
    # not in Azure App Service's trust store (sslmode=require, not verify-full).
    # The connection is still TLS-encrypted; only certificate chain verification is skipped.
    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE
    engine = create_engine(
        url,
        connect_args={"ssl_context": ssl_ctx},
        # Routes are sync (`def`, not `async def`), so each request borrows a
        # connection from this pool while running in FastAPI's threadpool.
        # SQLAlchemy's defaults (5 + 10 = 15 per worker) became the limiting
        # factor once CPU was no longer the bottleneck. Modest bump — stay
        # mindful this multiplies by gunicorn worker count against whatever
        # connection ceiling the Supabase pooler enforces on the dev project.
        pool_size=10,
        max_overflow=15,
        # Under load, the default pool_timeout (30s) made starved requests hang
        # for up to 30s before failing — fail fast instead so the tail latency
        # stays bounded and the caller gets a prompt error to retry.
        pool_timeout=10,
        # Supabase's pooler drops idle connections; pre_ping detects and replaces
        # dead ones transparently instead of surfacing "connection closed" errors,
        # and recycle proactively retires connections before they go stale.
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
