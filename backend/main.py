from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
import models
from database import engine, DATABASE_URL
from routers import tasks, purchases, reviews, marketing, sop, assets, accounting, operations, unifi, dashboard, requisitions, roles, notifications, inventory_requests


def _run_migrations():
    """Add columns that were introduced after the initial table creation."""
    if DATABASE_URL.startswith("sqlite"):
        return  # SQLite: create_all is enough for dev
    migrations = [
        "ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS employee_email VARCHAR DEFAULT ''",
        "ALTER TABLE nexus_notifications ADD COLUMN IF NOT EXISTS read_by VARCHAR DEFAULT ''",
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://vlow2k.github.io",
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

