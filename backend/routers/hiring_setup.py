"""Hiring Setup API (Oct 23 2026) - Settings > Hiring > Hiring Documents.
Permissions and shapes only; the engine is hiring_setup.py."""
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

import hiring_setup as hs
from auth import hr_scope
from database import get_db
from routers.hr import require_hr_read, require_hr_write

router = APIRouter(prefix="/hr/hiring-setup", tags=["hr-hiring-setup"])


class SettingIdIn(BaseModel):
    setting_id: str


class MakeOwnIn(BaseModel):
    entity_id:        Optional[str] = ""
    event:            str
    worker_type:      Optional[str] = ""
    country:          Optional[str] = ""
    region:           Optional[str] = ""
    start:            Optional[str] = "copy"       # copy | templates
    doc_template_ids: Optional[list] = None
    also:             Optional[list] = None        # [{worker_type, country, region}]


class DocumentsIn(BaseModel):
    doc_template_ids: list


class PlaceIn(BaseModel):
    entity_id: Optional[str] = ""
    country:   Optional[str] = ""
    region:    Optional[str] = ""
    remove:    Optional[bool] = False


class DutyIn(BaseModel):
    hired_as:  Optional[str] = ""
    country:   Optional[str] = ""
    region:    Optional[str] = ""
    entity_id: Optional[str] = ""


class DutyTextIn(BaseModel):
    text: Optional[str] = ""


class RoleDocsIn(BaseModel):
    hiring_docs: list


@router.get("")
def company_list(user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    return hs.company_list(db, hr_scope(user, db))


@router.get("/company")
def company(entity_id: str = "", role_id: str = "", user: dict = Depends(require_hr_read),
            db: Session = Depends(get_db)):
    return hs.company_view(db, entity_id, role_id, hr_scope(user, db))


@router.post("/use-same")
def use_same(body: SettingIdIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    return hs.use_same(db, user, hr_scope(user, db), body.setting_id)


@router.post("/restore")
def restore(body: SettingIdIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    return hs.restore(db, user, hr_scope(user, db), body.setting_id)


@router.post("/make-own")
def make_own(body: MakeOwnIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    return hs.make_own(db, user, hr_scope(user, db), body.model_dump())


@router.put("/settings/{sid}/documents")
def set_documents(sid: str, body: DocumentsIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    return hs.set_documents(db, user, hr_scope(user, db), sid, body.doc_template_ids)


@router.post("/settings/{sid}/documents/{tid}/own-copy")
def own_copy(sid: str, tid: str, entity_id: str = "", user: dict = Depends(require_hr_write),
             db: Session = Depends(get_db)):
    return hs.own_copy(db, user, hr_scope(user, db), sid, tid, entity_id)


@router.put("/places")
def set_place(body: PlaceIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    return {"places": hs.set_place(db, user, hr_scope(user, db), body.entity_id or "", body.country or "",
                                   body.region or "", bool(body.remove))}


@router.get("/roles/{rid}/duties")
def role_duties(rid: str, entity_id: str = "", user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    scope = hr_scope(user, db)
    return hs.duties_out(db, hs._role(db, rid, scope), entity_id, scope)


@router.post("/roles/{rid}/duties")
def add_duty(rid: str, body: DutyIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    return hs.add_duty(db, user, hr_scope(user, db), rid, body.model_dump())


@router.patch("/roles/{rid}/duties/{vid}")
def update_duty(rid: str, vid: str, body: DutyTextIn, user: dict = Depends(require_hr_write),
                db: Session = Depends(get_db)):
    return hs.update_duty(db, user, hr_scope(user, db), rid, vid, body.text or "")


@router.delete("/roles/{rid}/duties/{vid}")
def remove_duty(rid: str, vid: str, entity_id: str = "", user: dict = Depends(require_hr_write),
                db: Session = Depends(get_db)):
    return hs.remove_duty(db, user, hr_scope(user, db), rid, vid, entity_id)


@router.put("/roles/{rid}/documents")
def set_role_documents(rid: str, body: RoleDocsIn, user: dict = Depends(require_hr_write),
                       db: Session = Depends(get_db)):
    return hs.set_role_documents(db, user, hr_scope(user, db), rid, body.hiring_docs)
