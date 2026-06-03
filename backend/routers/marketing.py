from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
import models
from database import get_db

router = APIRouter(prefix="/marketing-campaigns", tags=["Marketing"])


@router.get("")
def list_campaigns(db: Session = Depends(get_db)):
    return db.query(models.MarketingCampaign).all()
