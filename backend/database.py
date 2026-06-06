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
    engine = create_engine(url, connect_args={"ssl_context": ssl_ctx})

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
