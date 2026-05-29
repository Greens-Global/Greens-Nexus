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
    # Force pg8000 driver (pure Python, no C extensions needed)
    url = DATABASE_URL.replace("postgresql+psycopg2://", "postgresql+pg8000://")
    if not url.startswith("postgresql+"):
        url = url.replace("postgresql://", "postgresql+pg8000://")
    engine = create_engine(url)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
