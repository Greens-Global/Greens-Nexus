from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
import models
from database import get_db

router = APIRouter(prefix="/purchase-requests", tags=["Purchases"])


class PurchaseCreate(BaseModel):
    item: str
    vendor: str = ""
    cost: float = 0
    qty: int = 1
    dept: str
    status: str = "pending"


class PurchaseStatusUpdate(BaseModel):
    status: str


@router.get("")
def list_purchase_requests(db: Session = Depends(get_db)):
    return db.query(models.PurchaseRequest).all()


@router.post("", status_code=201)
def create_purchase_request(req: PurchaseCreate, db: Session = Depends(get_db)):
    db_req = models.PurchaseRequest(**req.model_dump())
    db.add(db_req)
    db.commit()
    db.refresh(db_req)
    return db_req


@router.patch("/{req_id}")
def update_purchase_status(req_id: int, update: PurchaseStatusUpdate, db: Session = Depends(get_db)):
    req = db.query(models.PurchaseRequest).filter(models.PurchaseRequest.id == req_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")
    req.status = update.status
    db.commit()
    db.refresh(req)
    return req
