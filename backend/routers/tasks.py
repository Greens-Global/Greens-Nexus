from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
import models
from database import get_db

router = APIRouter(prefix="/tasks", tags=["Tasks"])


class TaskCreate(BaseModel):
    id: str
    title: str
    assignee: str
    project: str
    due_date: str
    hours: str
    comment: str = ""
    priority: str
    status: str
    dept: str
    synced: bool = True


class TaskUpdate(BaseModel):
    status: Optional[str] = None
    comment: Optional[str] = None


@router.get("")
def list_tasks(db: Session = Depends(get_db)):
    return db.query(models.Task).all()


@router.post("", status_code=201)
def create_task(task: TaskCreate, db: Session = Depends(get_db)):
    db_task = models.Task(**task.model_dump())
    db.add(db_task)
    db.commit()
    db.refresh(db_task)
    return db_task


@router.patch("/{task_id}")
def update_task(task_id: str, update: TaskUpdate, db: Session = Depends(get_db)):
    task = db.query(models.Task).filter(models.Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if update.status is not None:
        task.status = update.status
    if update.comment is not None:
        task.comment = update.comment
    db.commit()
    db.refresh(task)
    return task


@router.delete("/{task_id}", status_code=204)
def delete_task(task_id: str, db: Session = Depends(get_db)):
    task = db.query(models.Task).filter(models.Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    db.delete(task)
    db.commit()
