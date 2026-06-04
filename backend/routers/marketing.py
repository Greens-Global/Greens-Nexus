from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
import models
from database import get_db
from auth import get_current_user

router = APIRouter(prefix="/marketing-campaigns", tags=["Marketing"], dependencies=[Depends(get_current_user)])


@router.get("")
def list_campaigns(db: Session = Depends(get_db)):
    return db.query(models.MarketingCampaign).all()
