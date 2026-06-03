from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel
import models
from database import get_db

router = APIRouter(tags=["Operations & Development"])


class OpsProjectCreate(BaseModel):
    name: str
    status: str = "on-track"
    location: str
    members: int = 0
    due_date: str
    progress: int = 0


@router.get("/ops-projects")
def list_ops_projects(db: Session = Depends(get_db)):
    return db.query(models.OpsProject).all()


@router.post("/ops-projects", status_code=201)
def create_ops_project(proj: OpsProjectCreate, db: Session = Depends(get_db)):
    db_proj = models.OpsProject(**proj.model_dump())
    db.add(db_proj)
    db.commit()
    db.refresh(db_proj)
    return db_proj


@router.get("/dev-projects")
def list_dev_projects(db: Session = Depends(get_db)):
    return db.query(models.DevProject).all()
