from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel
import models
from database import get_db

router = APIRouter(tags=["SOP & LMS"])


class SopCreate(BaseModel):
    title: str
    category: str
    status: str = "Published"
    date: str


@router.get("/sop-updates")
def list_sops(db: Session = Depends(get_db)):
    return db.query(models.SopUpdate).all()


@router.post("/sop-updates", status_code=201)
def create_sop(sop: SopCreate, db: Session = Depends(get_db)):
    db_sop = models.SopUpdate(**sop.model_dump())
    db.add(db_sop)
    db.commit()
    db.refresh(db_sop)
    return db_sop


@router.get("/lms-courses")
def list_lms_courses(db: Session = Depends(get_db)):
    return db.query(models.LmsCourse).all()
