import csv
import io
import re
from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
import models
from database import engine, get_db
from unifi_client import fetch_all, build_site_payload

models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="Greens Nexus API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://vlow2k.github.io",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def health():
    return {"status": "ok"}


# ── Pydantic Schemas ────────────────────────────────────────────────────────

class TaskCreate(BaseModel):
    id: str
    title: str
    assignee: str
    project: str
    due_date: str
    hours: str
    comment: str = ""
    priority: str
    status: str
    dept: str
    synced: bool = True

class TaskUpdate(BaseModel):
    status: Optional[str] = None
    comment: Optional[str] = None

class PurchaseCreate(BaseModel):
    item: str
    vendor: str = ""
    cost: float = 0
    qty: int = 1
    dept: str
    status: str = "pending"

class PurchaseStatusUpdate(BaseModel):
    status: str

class ReviewReply(BaseModel):
    reply_text: str

class AssetCreate(BaseModel):
    name: str
    category: str
    assigned_to: str = "Unassigned"
    status: str = "Available"
    last_seen: str

class UserCreate(BaseModel):
    name: str
    dept: str
    role: str
    access_level: str
    status: str = "Active"
    last_login: str = ""

class WebsiteCreate(BaseModel):
    name: str
    domain: str
    ssl_days: int = 90
    uptime: float = 99.9
    status: str = "Online"

class ExternalLinkCreate(BaseModel):
    name: str
    url: str
    category: str
    description: str = ""

class SopCreate(BaseModel):
    title: str
    category: str
    status: str = "Published"
    date: str

class OpsProjectCreate(BaseModel):
    name: str
    status: str = "on-track"
    location: str
    members: int = 0
    due_date: str
    progress: int = 0


# ── Tasks ───────────────────────────────────────────────────────────────────

@app.get("/tasks")
def list_tasks(db: Session = Depends(get_db)):
    return db.query(models.Task).all()

@app.post("/tasks", status_code=201)
def create_task(task: TaskCreate, db: Session = Depends(get_db)):
    db_task = models.Task(**task.model_dump())
    db.add(db_task)
    db.commit()
    db.refresh(db_task)
    return db_task

@app.patch("/tasks/{task_id}")
def update_task(task_id: str, update: TaskUpdate, db: Session = Depends(get_db)):
    task = db.query(models.Task).filter(models.Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if update.status is not None:
        task.status = update.status
    if update.comment is not None:
        task.comment = update.comment
    db.commit()
    db.refresh(task)
    return task

@app.delete("/tasks/{task_id}", status_code=204)
def delete_task(task_id: str, db: Session = Depends(get_db)):
    task = db.query(models.Task).filter(models.Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    db.delete(task)
    db.commit()


# ── Purchase Requests ───────────────────────────────────────────────────────

@app.get("/purchase-requests")
def list_purchase_requests(db: Session = Depends(get_db)):
    return db.query(models.PurchaseRequest).all()

@app.post("/purchase-requests", status_code=201)
def create_purchase_request(req: PurchaseCreate, db: Session = Depends(get_db)):
    db_req = models.PurchaseRequest(**req.model_dump())
    db.add(db_req)
    db.commit()
    db.refresh(db_req)
    return db_req

@app.patch("/purchase-requests/{req_id}")
def update_purchase_status(req_id: int, update: PurchaseStatusUpdate, db: Session = Depends(get_db)):
    req = db.query(models.PurchaseRequest).filter(models.PurchaseRequest.id == req_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")
    req.status = update.status
    db.commit()
    db.refresh(req)
    return req


# ── Reviews ─────────────────────────────────────────────────────────────────

@app.get("/reviews")
def list_reviews(db: Session = Depends(get_db)):
    return db.query(models.Review).all()

@app.patch("/reviews/{review_id}/reply")
def reply_to_review(review_id: int, reply: ReviewReply, db: Session = Depends(get_db)):
    review = db.query(models.Review).filter(models.Review.id == review_id).first()
    if not review:
        raise HTTPException(status_code=404, detail="Review not found")
    review.replied = True
    review.reply_text = reply.reply_text
    db.commit()
    db.refresh(review)
    return review


# ── Marketing Campaigns ─────────────────────────────────────────────────────

@app.get("/marketing-campaigns")
def list_campaigns(db: Session = Depends(get_db)):
    return db.query(models.MarketingCampaign).all()


# ── SOP Updates ─────────────────────────────────────────────────────────────

@app.get("/sop-updates")
def list_sops(db: Session = Depends(get_db)):
    return db.query(models.SopUpdate).all()

@app.post("/sop-updates", status_code=201)
def create_sop(sop: SopCreate, db: Session = Depends(get_db)):
    db_sop = models.SopUpdate(**sop.model_dump())
    db.add(db_sop)
    db.commit()
    db.refresh(db_sop)
    return db_sop


# ── Assets ───────────────────────────────────────────────────────────────────

@app.get("/assets")
def list_assets(db: Session = Depends(get_db)):
    return db.query(models.Asset).all()

@app.post("/assets", status_code=201)
def create_asset(asset: AssetCreate, db: Session = Depends(get_db)):
    db_asset = models.Asset(**asset.model_dump())
    db.add(db_asset)
    db.commit()
    db.refresh(db_asset)
    return db_asset


# ── Users ────────────────────────────────────────────────────────────────────

@app.get("/users")
def list_users(db: Session = Depends(get_db)):
    return db.query(models.User).all()

@app.post("/users", status_code=201)
def create_user(user: UserCreate, db: Session = Depends(get_db)):
    db_user = models.User(**user.model_dump())
    db.add(db_user)
    db.commit()
    db.refresh(db_user)
    return db_user


# ── Websites ─────────────────────────────────────────────────────────────────

@app.get("/websites")
def list_websites(db: Session = Depends(get_db)):
    return db.query(models.Website).all()

@app.post("/websites", status_code=201)
def create_website(site: WebsiteCreate, db: Session = Depends(get_db)):
    db_site = models.Website(**site.model_dump())
    db.add(db_site)
    db.commit()
    db.refresh(db_site)
    return db_site


# ── External Links ───────────────────────────────────────────────────────────

@app.get("/external-links")
def list_external_links(db: Session = Depends(get_db)):
    return db.query(models.ExternalLink).all()

@app.post("/external-links", status_code=201)
def create_external_link(link: ExternalLinkCreate, db: Session = Depends(get_db)):
    db_link = models.ExternalLink(**link.model_dump())
    db.add(db_link)
    db.commit()
    db.refresh(db_link)
    return db_link

@app.patch("/external-links/{link_id}/click")
def increment_click(link_id: int, db: Session = Depends(get_db)):
    link = db.query(models.ExternalLink).filter(models.ExternalLink.id == link_id).first()
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")
    link.clicks += 1
    db.commit()
    return link


# ── Accounting ───────────────────────────────────────────────────────────────

@app.get("/accounting/transactions")
def list_transactions(db: Session = Depends(get_db)):
    return db.query(models.AccountingTrx).all()

@app.get("/accounting/ramp")
def list_ramp(db: Session = Depends(get_db)):
    return db.query(models.RampTransaction).all()

@app.get("/accounting/ama")
def list_ama(db: Session = Depends(get_db)):
    return db.query(models.AmaEntity).all()


# ── Operations ───────────────────────────────────────────────────────────────

@app.get("/ops-projects")
def list_ops_projects(db: Session = Depends(get_db)):
    return db.query(models.OpsProject).all()

@app.post("/ops-projects", status_code=201)
def create_ops_project(proj: OpsProjectCreate, db: Session = Depends(get_db)):
    db_proj = models.OpsProject(**proj.model_dump())
    db.add(db_proj)
    db.commit()
    db.refresh(db_proj)
    return db_proj


# ── Development ──────────────────────────────────────────────────────────────

@app.get("/dev-projects")
def list_dev_projects(db: Session = Depends(get_db)):
    return db.query(models.DevProject).all()


# ── LMS ──────────────────────────────────────────────────────────────────────

@app.get("/lms-courses")
def list_lms_courses(db: Session = Depends(get_db)):
    return db.query(models.LmsCourse).all()


# ── UniFi ────────────────────────────────────────────────────────────────────

@app.get("/unifi/overview")
async def unifi_overview():
    sites_raw, devices_raw = await fetch_all()
    host_map = {e["hostId"]: e for e in devices_raw.get("data", [])}
    result = [
        build_site_payload(s, host_map.get(s.get("hostId", ""), {}))
        for s in sites_raw.get("data", [])
    ]
    return {"data": result}


@app.get("/unifi/stats")
async def unifi_stats(siteId: str):
    sites_raw, devices_raw = await fetch_all()
    site = next((s for s in sites_raw.get("data", []) if s.get("siteId") == siteId), None)
    if not site:
        raise HTTPException(404, f"Site {siteId} not found")
    host_id = site.get("hostId", "")
    host_entry = next((e for e in devices_raw.get("data", []) if e.get("hostId") == host_id), {})
    payload = build_site_payload(site, host_entry)
    devices = host_entry.get("devices", [])
    return {
        "total_devices": payload["total_devices"],
        "online_devices": payload["online_devices"],
        "offline_devices": len(payload["offline_devices"]),
        "total_clients": payload["wifi_clients"] + payload["wired_clients"],
        "wireless_clients": payload["wifi_clients"],
        "wired_clients": payload["wired_clients"],
        "devices": devices,
    }


@app.get("/unifi/export/csv")
async def unifi_export_csv(siteId: str):
    sites_raw, devices_raw = await fetch_all()
    site = next((s for s in sites_raw.get("data", []) if s.get("siteId") == siteId), None)
    if not site:
        raise HTTPException(404, f"Site {siteId} not found")
    host_id = site.get("hostId", "")
    host_entry = next((e for e in devices_raw.get("data", []) if e.get("hostId") == host_id), {})
    site_name = host_entry.get("hostName") or site.get("meta", {}).get("desc") or siteId
    devices = host_entry.get("devices", [])
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Site", "Name", "Model", "MAC Address", "IP Address", "Status", "Firmware Version", "Firmware Status", "Product Line", "Is Console", "Startup Time", "Adoption Time"])
    for d in devices:
        writer.writerow([site_name, d.get("name", ""), d.get("model", ""), d.get("mac", ""), d.get("ip", ""), d.get("status", ""), d.get("version", ""), d.get("firmwareStatus", ""), d.get("productLine", ""), "Yes" if d.get("isConsole") else "No", d.get("startupTime", ""), d.get("adoptionTime", "")])
    safe_name = re.sub(r"[^a-zA-Z0-9_-]", "_", site_name)
    output.seek(0)
    return StreamingResponse(iter([output.getvalue()]), media_type="text/csv", headers={"Content-Disposition": f"attachment; filename={safe_name}_inventory.csv"})


# ── Dashboard Summary ────────────────────────────────────────────────────────

@app.get("/dashboard/summary")
def dashboard_summary(db: Session = Depends(get_db)):
    tasks_count = db.query(models.Task).filter(models.Task.status != 'Completed').count()
    approvals_count = db.query(models.PurchaseRequest).filter(models.PurchaseRequest.status == 'pending').count()
    purchases_count = db.query(models.PurchaseRequest).count()
    reviews_pending = db.query(models.Review).filter(models.Review.replied.is_(False)).count()
    sop_count = db.query(models.SopUpdate).count()
    return {
        "tasks_count": tasks_count,
        "approvals_count": approvals_count,
        "purchases_count": purchases_count,
        "reviews_pending": reviews_pending,
        "sop_count": sop_count,
    }
