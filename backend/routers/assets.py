from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
import models
from database import get_db

router = APIRouter(tags=["IT Assets"])


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


@router.get("/assets")
def list_assets(db: Session = Depends(get_db)):
    return db.query(models.Asset).all()


@router.post("/assets", status_code=201)
def create_asset(asset: AssetCreate, db: Session = Depends(get_db)):
    db_asset = models.Asset(**asset.model_dump())
    db.add(db_asset)
    db.commit()
    db.refresh(db_asset)
    return db_asset


@router.get("/users")
def list_users(db: Session = Depends(get_db)):
    return db.query(models.User).all()


@router.post("/users", status_code=201)
def create_user(user: UserCreate, db: Session = Depends(get_db)):
    db_user = models.User(**user.model_dump())
    db.add(db_user)
    db.commit()
    db.refresh(db_user)
    return db_user


@router.get("/websites")
def list_websites(db: Session = Depends(get_db)):
    return db.query(models.Website).all()


@router.post("/websites", status_code=201)
def create_website(site: WebsiteCreate, db: Session = Depends(get_db)):
    db_site = models.Website(**site.model_dump())
    db.add(db_site)
    db.commit()
    db.refresh(db_site)
    return db_site


@router.get("/external-links")
def list_external_links(db: Session = Depends(get_db)):
    return db.query(models.ExternalLink).all()


@router.post("/external-links", status_code=201)
def create_external_link(link: ExternalLinkCreate, db: Session = Depends(get_db)):
    db_link = models.ExternalLink(**link.model_dump())
    db.add(db_link)
    db.commit()
    db.refresh(db_link)
    return db_link


@router.patch("/external-links/{link_id}/click")
def increment_click(link_id: int, db: Session = Depends(get_db)):
    link = db.query(models.ExternalLink).filter(models.ExternalLink.id == link_id).first()
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")
    link.clicks += 1
    db.commit()
    return link
