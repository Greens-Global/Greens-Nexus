from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
import models
from database import get_db

router = APIRouter(prefix="/dashboard", tags=["Dashboard"])


@router.get("/summary")
def dashboard_summary(db: Session = Depends(get_db)):
    tasks_count = db.query(models.Task).filter(models.Task.status != "Completed").count()
    approvals_count = db.query(models.PurchaseRequest).filter(models.PurchaseRequest.status == "pending").count()
    req_pending = db.query(models.Requisition).filter(models.Requisition.status == "pending_manager").count()
    purchases_count = db.query(models.PurchaseRequest).count()
    reviews_pending = db.query(models.Review).filter(models.Review.replied.is_(False)).count()
    sop_count = db.query(models.SopUpdate).count()
    return {
        "tasks_count": tasks_count,
        "approvals_count": approvals_count + req_pending,
        "purchases_count": purchases_count,
        "reviews_pending": reviews_pending,
        "sop_count": sop_count,
    }
