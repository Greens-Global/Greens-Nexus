from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
import models
from database import get_db
from auth import get_current_user

router = APIRouter(tags=["IT Assets"], dependencies=[Depends(get_current_user)])


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


# ---------------------------------------------------------------------------
# Real-estate Asset Management — properties (Neil-template model). Each parcel
# is one row; collections live as JSON arrays. parent_id links ancillary parcels.
# ---------------------------------------------------------------------------
_PROP_COLS = {c.name for c in models.Property.__table__.columns}


def _prop_dict(p):
    return {c: getattr(p, c) for c in _PROP_COLS}


@router.get("/properties")
def list_properties(db: Session = Depends(get_db)):
    return [_prop_dict(p) for p in db.query(models.Property).all()]


@router.get("/properties/{pid}")
def get_property(pid: str, db: Session = Depends(get_db)):
    p = db.query(models.Property).filter(models.Property.id == pid).first()
    if not p:
        raise HTTPException(status_code=404, detail="Property not found")
    return _prop_dict(p)


@router.post("/properties", status_code=201)
def create_property(payload: dict, db: Session = Depends(get_db)):
    data = {k: v for k, v in payload.items() if k in _PROP_COLS}
    if not data.get("id"):
        import uuid
        data["id"] = "p-" + uuid.uuid4().hex[:10]
    if db.query(models.Property).filter(models.Property.id == data["id"]).first():
        raise HTTPException(status_code=409, detail="Property id already exists")
    p = models.Property(**data)
    db.add(p)
    db.commit()
    db.refresh(p)
    return _prop_dict(p)


@router.put("/properties/{pid}")
def update_property(pid: str, payload: dict, db: Session = Depends(get_db)):
    p = db.query(models.Property).filter(models.Property.id == pid).first()
    if not p:
        raise HTTPException(status_code=404, detail="Property not found")
    for k, v in payload.items():
        if k in _PROP_COLS and k != "id":
            setattr(p, k, v)
    db.commit()
    db.refresh(p)
    return _prop_dict(p)


@router.delete("/properties/{pid}", status_code=204)
def delete_property(pid: str, db: Session = Depends(get_db)):
    p = db.query(models.Property).filter(models.Property.id == pid).first()
    if p:
        db.delete(p)
        db.commit()
    return None
