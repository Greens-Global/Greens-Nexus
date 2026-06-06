from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
import models
from database import engine, DATABASE_URL
from routers import tasks, purchases, reviews, marketing, sop, assets, accounting, operations, unifi, dashboard, requisitions, roles, notifications, inventory_requests, audit
from audit import AuditMiddleware


def _run_migrations():
    """Add columns that were introduced after the initial table creation."""
    if DATABASE_URL.startswith("sqlite"):
        return  # SQLite: create_all is enough for dev
    migrations = [
        "ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS employee_email VARCHAR DEFAULT ''",
        "ALTER TABLE nexus_notifications ADD COLUMN IF NOT EXISTS read_by VARCHAR DEFAULT ''",
        # inventory_requests: return-flow columns added after initial table creation
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS returned_at VARCHAR DEFAULT ''",
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS return_photo_name VARCHAR DEFAULT ''",
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS return_photo_url VARCHAR DEFAULT ''",
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS condition_note VARCHAR DEFAULT ''",
        # inventory_requests: allocation columns
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS allocated_at VARCHAR DEFAULT ''",
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS allocated_by VARCHAR DEFAULT ''",
        # inventory_requests: rejection columns
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS reject_reason VARCHAR DEFAULT ''",
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS resolved_at VARCHAR DEFAULT ''",
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS resolved_by VARCHAR DEFAULT ''",
        # inventory_requests: requester targeting
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS requested_by_email VARCHAR DEFAULT ''",
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS raised_by VARCHAR DEFAULT ''",
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS days INTEGER DEFAULT 1",
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS reason VARCHAR DEFAULT ''",
        "ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS return_photo_name VARCHAR DEFAULT ''",
        "ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS return_photo_url VARCHAR DEFAULT ''",
    ]
    with engine.connect() as conn:
        for sql in migrations:
            try:
                conn.execute(text(sql))
            except Exception as e:
                print(f"[migration] skipped: {e}")
        conn.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        models.Base.metadata.create_all(bind=engine)
        print("[startup] DB tables ready")
    except Exception as e:
        print(f"[startup] DB not ready: {e}")
    try:
        _run_migrations()
        print("[startup] migrations applied")
    except Exception as e:
        print(f"[startup] migrations skipped: {e}")
    try:
        from auth import _fetch_jwks, SKIP_AUTH
        if not SKIP_AUTH:
            _fetch_jwks()
            print("[startup] JWKS keys cached")
    except Exception as e:
        print(f"[startup] JWKS prefetch skipped: {e}")
    yield


app = FastAPI(title="Greens Nexus API", lifespan=lifespan)

# AuditMiddleware must be added before CORSMiddleware so it wraps the full request
app.add_middleware(AuditMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://nexus.greensglobal.com",
        "https://dev.nexus.greensglobal.com",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def health():
    return {"status": "ok"}


@app.get("/version")
def version():
    return {"version": "2.0.0", "auth": "token-based"}


app.include_router(tasks.router)
app.include_router(purchases.router)
app.include_router(reviews.router)
app.include_router(marketing.router)
app.include_router(sop.router)
app.include_router(assets.router)
app.include_router(accounting.router)
app.include_router(operations.router)
app.include_router(unifi.router)
app.include_router(dashboard.router)
app.include_router(requisitions.router)
app.include_router(roles.router)
app.include_router(notifications.router)
app.include_router(inventory_requests.router)
app.include_router(audit.router)

