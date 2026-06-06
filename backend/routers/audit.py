from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from typing import Optional
from database import get_db
from auth import require_administrator
import models

router = APIRouter(prefix="/audit-logs", tags=["Audit"])


@router.get("")
def list_audit_logs(
    limit: int = Query(200, le=1000),
    offset: int = 0,
    user_email: Optional[str] = None,
    action: Optional[str] = None,
    resource_type: Optional[str] = None,
    user: dict = Depends(require_administrator),
    db: Session = Depends(get_db),
):
    q = db.query(models.AuditLog).order_by(models.AuditLog.id.desc())
    if user_email:
        q = q.filter(models.AuditLog.user_email == user_email.lower())
    if action:
        q = q.filter(models.AuditLog.action.contains(action))
    if resource_type:
        q = q.filter(models.AuditLog.resource_type == resource_type)
    total = q.count()
    rows = q.offset(offset).limit(limit).all()
    return {
        "total": total,
        "rows": [
            {
                "id":            r.id,
                "timestamp":     r.timestamp,
                "user_email":    r.user_email,
                "user_role":     r.user_role,
                "action":        r.action,
                "resource_type": r.resource_type,
                "resource_id":   r.resource_id,
                "details":       r.details,
                "ip_address":    r.ip_address,
            }
            for r in rows
        ],
    }
