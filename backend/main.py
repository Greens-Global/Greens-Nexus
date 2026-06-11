import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
import models
from database import engine, DATABASE_URL, SessionLocal
from routers import tasks, purchases, reviews, marketing, sop, assets, accounting, operations, unifi, dashboard, requisitions, roles, notifications, inventory_requests, audit, groups, items as items_router
from audit import AuditMiddleware


def _run_migrations():
    """Add columns that were introduced after the initial table creation."""
    if DATABASE_URL.startswith("sqlite"):
        # create_all builds NEW tables but never alters existing ones — columns
        # added to models after a local DB was created must be patched in here
        # (a model column missing from the DB breaks every SELECT with a 500).
        # SQLite has no IF NOT EXISTS for columns; duplicates just error and
        # are swallowed.
        sqlite_migrations = [
            "ALTER TABLE items ADD COLUMN picture_required BOOLEAN DEFAULT 1",
            "ALTER TABLE items ADD COLUMN asset_value FLOAT DEFAULT 0",
        ]
        with engine.connect() as conn:
            for sql in sqlite_migrations:
                try:
                    conn.execute(text(sql))
                except Exception:
                    pass  # column already exists
            conn.commit()
        return
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
        # inventory_requests: assigned-allocator handoff (manager picks who allocates)
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS assigned_allocator_email VARCHAR DEFAULT ''",
        "ALTER TABLE inventory_requests ADD COLUMN IF NOT EXISTS assigned_allocator_name VARCHAR DEFAULT ''",
        # nexus_roles: display name captured from Microsoft Graph at assignment time
        "ALTER TABLE nexus_roles ADD COLUMN IF NOT EXISTS display_name VARCHAR DEFAULT ''",
        # inventory_items: physical site/storage location (e.g. "GSVC", "GSE")
        "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS location VARCHAR DEFAULT ''",
        # item_checkouts: extension request flow (employee asks for more days, manager approves)
        "ALTER TABLE item_checkouts ADD COLUMN IF NOT EXISTS extension_days INTEGER DEFAULT 0",
        "ALTER TABLE item_checkouts ADD COLUMN IF NOT EXISTS extension_reason VARCHAR DEFAULT ''",
        "ALTER TABLE item_checkouts ADD COLUMN IF NOT EXISTS extension_status VARCHAR DEFAULT ''",
        # item_checkouts: employee picks which manager is notified for approval
        "ALTER TABLE item_checkouts ADD COLUMN IF NOT EXISTS approver_email VARCHAR DEFAULT ''",
        "ALTER TABLE item_checkouts ADD COLUMN IF NOT EXISTS approver_name VARCHAR DEFAULT ''",
        # items: current permanent assignee pointer (full history in item_assignments)
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS assigned_to_email VARCHAR DEFAULT ''",
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS assigned_to_name VARCHAR DEFAULT ''",
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS assigned_at VARCHAR DEFAULT ''",
        # Fleet department retired — vehicles belong to Construction (Neil, Jun 2026)
        "UPDATE items SET department = 'Construction' WHERE department = 'Fleet'",
        # items: per-item photo policy + dollar value (Neil, Jun 2026 review)
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS picture_required BOOLEAN DEFAULT TRUE",
        "ALTER TABLE items ADD COLUMN IF NOT EXISTS asset_value DOUBLE PRECISION DEFAULT 0",
    ]
    with engine.connect() as conn:
        for sql in migrations:
            try:
                conn.execute(text(sql))
            except Exception as e:
                print(f"[migration] skipped: {e}")
        conn.commit()


# One-time seed for the inventory_items master stock table — mirrors the figures
# the frontend used to hardcode in InventoryContext.jsx before stock tracking
# moved server-side. Only runs if the table is empty, so live counts (which get
# decremented/incremented by the allocate/return flow) are never reset on deploy.
_SEED_INVENTORY_ITEMS = [
    ("INV-001", "Laptop (Dell XPS 15)",      "IT Supplies",      "IT",           2,  6),
    ("INV-002", "Network Switch 24-Port",    "IT Supplies",      "IT",           1,  3),
    ("INV-003", "HDMI Cable (2m)",           "IT Supplies",      "IT",           6,  10),
    ("INV-004", "Extension Lead (5m)",       "Electrical",       "IT",           4,  7),
    ("INV-005", "USB-C Docking Station",     "IT Supplies",      "IT",           3,  5),
    ("INV-006", "Wireless Mouse & Keyboard", "IT Supplies",      "IT",           8,  12),
    ("INV-007", "External Monitor 27\"",     "IT Supplies",      "IT",           1,  4),
    ("INV-008", "UPS Battery Backup",        "Electrical",       "IT",           2,  3),
    ("INV-009", "Ethernet Cable Box (30m)",  "IT Supplies",      "IT",           5,  8),
    ("INV-010", "Webcam HD 1080p",           "IT Supplies",      "IT",           0,  4),
    ("INV-011", "Power Drill (Cordless)",    "Tools",            "Construction", 3,  5),
    ("INV-012", "Angle Grinder",             "Tools",            "Construction", 2,  4),
    ("INV-013", "Safety Helmet",             "Safety Equipment", "Construction", 10, 20),
    ("INV-014", "Hi-Vis Vest",               "Safety Equipment", "Construction", 8,  15),
    ("INV-015", "Tape Measure (5m)",         "Tools",            "Construction", 7,  10),
    ("INV-016", "Circular Saw",              "Tools",            "Construction", 1,  3),
    ("INV-017", "Safety Goggles",            "Safety Equipment", "Construction", 12, 20),
    ("INV-018", "Ear Protection (Pair)",     "Safety Equipment", "Construction", 15, 25),
    ("INV-019", "Spirit Level (600mm)",      "Tools",            "Construction", 4,  6),
    ("INV-020", "Cable Reel (25m)",          "Electrical",       "Construction", 0,  4),
    ("INV-021", "Office Chair (Ergonomic)",  "Furniture",        "Operations",   3,  8),
    ("INV-022", "Standing Desk",             "Furniture",        "Operations",   1,  4),
    ("INV-023", "First Aid Kit",             "Safety Equipment", "Operations",   4,  6),
    ("INV-024", "Walkie Talkie (Set of 2)",  "Tools",            "Operations",   5,  8),
    ("INV-025", "Floor Cleaning Machine",    "Tools",            "Operations",   0,  2),
    ("INV-026", "Storage Cabinet",           "Furniture",        "Operations",   2,  3),
    ("INV-027", "Handheld Vacuum",           "Tools",            "Operations",   3,  4),
    ("INV-028", "Printer Paper (Ream)",      "Office Supplies",  "Accounting",   20, 50),
    ("INV-029", "Stapler",                   "Office Supplies",  "Accounting",   5,  8),
    ("INV-030", "File Folders (Box of 50)",  "Office Supplies",  "Accounting",   10, 20),
    ("INV-031", "Financial Calculator",      "Office Supplies",  "Accounting",   3,  6),
    ("INV-032", "Document Shredder",         "Office Supplies",  "Accounting",   1,  2),
    ("INV-033", "Binding Machine",           "Office Supplies",  "Accounting",   0,  1),
    ("INV-034", "Whiteboard + Markers Kit",  "Office Supplies",  "Accounting",   2,  4),
]


def _seed_inventory_items():
    db = SessionLocal()
    try:
        if db.query(models.InventoryItem).count() > 0:
            return
        now = datetime.now(timezone.utc).isoformat()
        for item_id, name, category, dept, available, total in _SEED_INVENTORY_ITEMS:
            db.add(models.InventoryItem(
                id=item_id, name=name, category=category, department=dept,
                total_qty=total, available_qty=available, last_updated=now,
            ))
        db.commit()
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Refuse to start if NEXUS_SKIP_AUTH is set while running on Azure App
    # Service — the env var is for local development only and must never reach
    # a deployed instance (dev or prod).
    import sys as _sys
    if os.getenv("NEXUS_SKIP_AUTH", "").lower() in ("1", "true", "yes"):
        if os.getenv("WEBSITE_SITE_NAME"):
            print(
                "FATAL: NEXUS_SKIP_AUTH must not be set on Azure App Service. "
                "Remove it from the application settings and restart.",
                file=_sys.stderr,
            )
            _sys.exit(1)

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
        _seed_inventory_items()
        print("[startup] inventory_items seeded")
    except Exception as e:
        print(f"[startup] inventory_items seed skipped: {e}")
    try:
        from auth import _fetch_jwks, SKIP_AUTH
        if not SKIP_AUTH:
            _fetch_jwks()
            print("[startup] JWKS keys cached")
    except Exception as e:
        print(f"[startup] JWKS prefetch skipped: {e}")
    # Pre-warm the DB connection pool so the first user request doesn't pay
    # the cold-start cost of establishing the initial Postgres connection.
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        print("[startup] DB connection pool warmed")
    except Exception as e:
        print(f"[startup] DB pool warm-up skipped: {e}")
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
def root():
    return {"status": "ok"}


@app.get("/health")
def health():
    """No-auth liveness probe — used by frontend to detect outages without burning a token."""
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
app.include_router(groups.router)
app.include_router(items_router.router)

