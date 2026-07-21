"""Company-policy & monitoring acknowledgment shown at sign-in.

A standing, portal-wide gate (distinct from the per-day clock-in MonitoringConsent):
the first time a person signs in — and again whenever POLICY_VERSION changes —
they must accept the company policies + employee-monitoring disclosure before the
app loads. The acceptance is recorded (who/when/version/ip/ua) so it's provable.

The policy TEXT lives on the frontend (PolicyGate.jsx) so it renders instantly and
is versioned there; bump POLICY_VERSION in BOTH places together when it changes.
"""
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from database import get_db
from auth import get_current_user
from models import PolicyAcknowledgment

router = APIRouter(prefix="/policy", tags=["policy"],
                   dependencies=[Depends(get_current_user)])

# Bump this string whenever the acknowledged policy wording changes — it re-prompts
# everyone. Keep it in lockstep with POLICY_VERSION in frontend/src/components/PolicyGate.jsx.
POLICY_VERSION = "2026-07-21"


@router.get("/status")
def policy_status(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Has the current user accepted the CURRENT policy version?"""
    row = (db.query(PolicyAcknowledgment)
           .filter(PolicyAcknowledgment.email == user["email"].lower(),
                   PolicyAcknowledgment.version == POLICY_VERSION)
           .first())
    return {"version": POLICY_VERSION,
            "accepted": row is not None,
            "acceptedAt": row.accepted_at if row else ""}


@router.post("/accept")
def policy_accept(request: Request, user: dict = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    """Record acceptance of the current policy version (idempotent per person+version)."""
    email = user["email"].lower()
    existing = (db.query(PolicyAcknowledgment)
                .filter(PolicyAcknowledgment.email == email,
                        PolicyAcknowledgment.version == POLICY_VERSION)
                .first())
    if existing:
        return {"ok": True, "acceptedAt": existing.accepted_at}
    now = datetime.now(timezone.utc).isoformat()
    db.add(PolicyAcknowledgment(
        id=str(uuid.uuid4()), email=email, version=POLICY_VERSION, accepted_at=now,
        ip=(request.client.host if request.client else "")[:64],
        user_agent=request.headers.get("user-agent", "")[:300]))
    db.commit()
    return {"ok": True, "acceptedAt": now}


@router.get("/acknowledgments")
def my_acknowledgments(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The caller's own acceptance history — lets them keep a copy of what they signed."""
    rows = (db.query(PolicyAcknowledgment)
            .filter(PolicyAcknowledgment.email == user["email"].lower())
            .order_by(PolicyAcknowledgment.accepted_at.desc()).all())
    return [{"version": r.version, "acceptedAt": r.accepted_at} for r in rows]
