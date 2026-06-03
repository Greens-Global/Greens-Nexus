from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
import models
from database import get_db

router = APIRouter(prefix="/reviews", tags=["Reviews"])


class ReviewReply(BaseModel):
    reply_text: str


@router.get("")
def list_reviews(db: Session = Depends(get_db)):
    return db.query(models.Review).all()


@router.patch("/{review_id}/reply")
def reply_to_review(review_id: int, reply: ReviewReply, db: Session = Depends(get_db)):
    review = db.query(models.Review).filter(models.Review.id == review_id).first()
    if not review:
        raise HTTPException(status_code=404, detail="Review not found")
    review.replied = True
    review.reply_text = reply.reply_text
    db.commit()
    db.refresh(review)
    return review
