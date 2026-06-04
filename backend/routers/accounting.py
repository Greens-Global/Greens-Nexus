from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
import models
from database import get_db
from auth import get_current_user, require_manager

router = APIRouter(prefix="/accounting", tags=["Accounting"], dependencies=[Depends(require_manager)])


@router.get("/transactions")
def list_transactions(db: Session = Depends(get_db)):
    return db.query(models.AccountingTrx).all()


@router.get("/ramp")
def list_ramp(db: Session = Depends(get_db)):
    return db.query(models.RampTransaction).all()


@router.get("/ama")
def list_ama(db: Session = Depends(get_db)):
    return db.query(models.AmaEntity).all()
