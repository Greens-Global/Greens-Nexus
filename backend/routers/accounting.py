from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
import models
from database import get_db
from auth import require_module_grant

# Grant-driven (Jun 17): a manager role no longer opens Accounting by itself -
# it needs an "accounting" Access Group grant (or IT Admin+). The router has no
# per-endpoint read/write split, so a grant = full accounting access; grant it
# only to finance people.
router = APIRouter(prefix="/accounting", tags=["Accounting"], dependencies=[Depends(require_module_grant("accounting", "viewer"))])


class RampMemoUpdate(BaseModel):
    memo: str


@router.get("/transactions")
def list_transactions(db: Session = Depends(get_db)):
    return db.query(models.AccountingTrx).all()


@router.get("/ramp")
def list_ramp(db: Session = Depends(get_db)):
    return db.query(models.RampTransaction).all()


@router.patch("/ramp/{trx_id}")
def update_ramp_memo(trx_id: str, payload: RampMemoUpdate, db: Session = Depends(get_db)):
    trx = db.query(models.RampTransaction).filter(models.RampTransaction.id == trx_id).first()
    if not trx:
        raise HTTPException(status_code=404, detail="Ramp transaction not found")
    trx.memo = payload.memo.strip()
    trx.missing = not trx.memo
    db.commit()
    db.refresh(trx)
    return trx


@router.get("/ama")
def list_ama(db: Session = Depends(get_db)):
    return db.query(models.AmaEntity).all()
