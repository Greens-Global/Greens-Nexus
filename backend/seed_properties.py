"""Seed the `properties` table from the verified property JSONs
(frontend/src/data/assets/*.json — the imported Excel data), mapped into the
Neil-template flat model. Idempotent: upserts by id.

Run from the backend dir:  ./.venv/bin/python seed_properties.py
"""
import glob
import json
import os
import re

from database import SessionLocal, engine, Base
import models

ASSETS_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend", "src", "data", "assets")


def sv(p, group, prefix):
    for g in p.get("snapshot", []):
        if g.get("group") == group:
            for f in g.get("fields", []):
                if (f.get("label") or "").lower().startswith(prefix.lower()):
                    return f.get("value") or ""
    return ""


def num0(v):
    s = re.sub(r"[^0-9.]", "", str(v if v is not None else ""))
    try:
        return float(s) if s else 0
    except ValueError:
        return 0


def ufield(u, prefix):
    for f in u.get("fields", []):
        if (f.get("label") or "").lower().startswith(prefix.lower()):
            return f.get("value") or ""
    return ""


def adapt(p, group_primary):
    parent = ""
    g = p.get("group")
    if g and group_primary.get(g) and group_primary[g] != p["id"]:
        parent = group_primary[g]
    utilities = [{
        "service": u.get("name", "Utility"), "provider": ufield(u, "Authority"),
        "accountNumber": ufield(u, "Application"), "meterNumber": "", "serviceAddress": "",
        "autopay": "", "avgMonthly": 0, "contactPhone": ufield(u, "Phone"), "portal": "",
        "notes": ufield(u, "Notes"),
    } for u in p.get("utilities", [])]
    warranties = [{
        "kind": w.get("Type", ""), "scope": w.get("Scope / item covered", ""), "party": w.get("Contractor / manufacturer", ""),
        "contactName": w.get("Contact", ""), "phone": w.get("Phone", ""), "email": w.get("Email", ""),
        "startDate": w.get("Start date", ""), "termMonths": w.get("Term (months)", ""), "expiration": w.get("Expiration", ""),
        "docRef": w.get("Document location", ""), "coverage": w.get("Coverage summary", ""), "notes": w.get("Notes", ""),
    } for w in p.get("warranties", [])]
    inspections = [{
        "type": r.get("Inspection type", ""), "frequency": r.get("Frequency", ""), "ahjRequired": "",
        "vendor": r.get("Vendor", ""), "vendorPhone": r.get("Vendor phone", ""), "lastCompleted": r.get("Last completed", ""),
        "nextDue": r.get("Next due", ""), "cost": r.get("Cost", ""), "notes": r.get("Notes", ""),
    } for r in p.get("inspections", [])]
    documents = [{
        "category": d.get("category", ""), "title": d.get("title", ""), "dateOf": d.get("date", ""),
        "version": d.get("version", ""), "location": d.get("location", ""), "notes": d.get("notes", ""),
    } for d in p.get("documents", [])]
    ahj = [{
        "authority": a.get("name", ""), "jurisdiction": ufield(a, "Authority"), "contactName": ufield(a, "Contact Name"),
        "title": "", "phone": ufield(a, "Phone"), "email": ufield(a, "Email"), "portal": "",
        "accountOrPermit": ufield(a, "Application"), "renewalDate": "", "notes": ufield(a, "Notes"),
    } for a in p.get("ahj", [])]
    return dict(
        id=p["id"], name=p.get("name", ""), parent_id=parent,
        parcel_role=sv(p, "Project Details", "Current Use") or p.get("type", ""),
        entity=sv(p, "Ownership + Core Team", "Ownership Entity"),
        builder=sv(p, "Ownership + Core Team", "GC / CM"),
        manager=p.get("assetManager") or sv(p, "Ownership + Core Team", "PM / Asset Manager"),
        address=p.get("address") or sv(p, "Project Details", "Property Address"),
        city=sv(p, "Project Details", "City"), state=sv(p, "Project Details", "State"),
        zip=sv(p, "Project Details", "Zip"), county=sv(p, "Project Details", "County"),
        apn=sv(p, "Project Details", "APN"), legal_desc=sv(p, "Project Details", "Legal Description"),
        year_built=str(p.get("yearBuilt") or sv(p, "Existing Improvements", "Year Built") or ""),
        construction_type="", stories="",
        nrsf=num0(p.get("buildingSf")), gsf=0, acreage=num0(sv(p, "Site Data", "Lot Size")),
        zoning=sv(p, "Zoning + Land Use", "Zoning"), flood_zone=sv(p, "Site Data", "Flood Zone"),
        sprinklered=sv(p, "Existing Improvements", "Sprinklered"),
        alarm_monitored=sv(p, "Existing Improvements", "Alarm Monitored"),
        dev_stage=sv(p, "Project Details", "Development Stage"),
        placed_in_service="", co_number="", co_date="",
        units_non_climate=int(num0(sv(p, "Unit Mix", "Non-Climate"))), units_climate=int(num0(sv(p, "Unit Mix", "Climate"))),
        units_rv=int(num0(sv(p, "Unit Mix", "RV"))), units_total=int(num0(sv(p, "Unit Mix", "Total"))),
        ins_carrier=sv(p, "Insurance", "Insurance Carrier"), ins_policy=sv(p, "Insurance", "Policy Number"),
        ins_expiration=sv(p, "Insurance", "Policy Expiration"), ins_agent=sv(p, "Insurance", "Insurance Agent"), ins_phone="",
        tax_id=sv(p, "Property Tax", "Tax Account"), tax_annual=num0(sv(p, "Property Tax", "Annual Tax")), tax_due=sv(p, "Property Tax", "Tax Due"),
        notes="", image=p.get("image", ""),
        warranties=warranties, inspections=inspections, documents=documents, ahj=ahj, utilities=utilities, vendors=[],
    )


def main():
    Base.metadata.create_all(bind=engine)  # ensure properties table exists
    files = sorted(glob.glob(os.path.join(ASSETS_DIR, "*.json")))
    raw = []
    seen = set()
    for fn in files:
        with open(fn) as f:
            p = json.load(f)
        if p.get("id") in seen:
            continue
        seen.add(p["id"])
        raw.append(p)
    group_primary = {}
    for p in raw:
        g = p.get("group")
        if g and g not in group_primary:
            group_primary[g] = p["id"]
    db = SessionLocal()
    n_new = n_upd = 0
    try:
        for p in raw:
            data = adapt(p, group_primary)
            existing = db.query(models.Property).filter(models.Property.id == data["id"]).first()
            if existing:
                for k, v in data.items():
                    setattr(existing, k, v)
                n_upd += 1
            else:
                db.add(models.Property(**data))
                n_new += 1
        db.commit()
    finally:
        db.close()
    print(f"Seeded properties — inserted {n_new}, updated {n_upd}, total source {len(raw)}")


if __name__ == "__main__":
    main()
