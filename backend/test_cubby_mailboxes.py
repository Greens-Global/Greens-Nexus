"""Mailboxes get their own occupancy (Neil, Oct 20 2026 Ops review).

Cubby has no mailbox flag: a mailbox is a unit whose pricing group name says
so ("0' x 3' mailbox"), and Cubby marks every unrented mailbox UNAVAILABLE.
At Valley Center that made 236 mailboxes look like off-market storage and the
occupancy read 59.9%. The fixture below is that facility in miniature: storage
(rented, vacant, one in repair), mailboxes (a few rented, most "unrentable")
and one switched-off "Deactivated" record. Run alone:
python -m pytest test_cubby_mailboxes.py"""
from datetime import date

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import cubby
import models
import ops_unit_classes as uc
from auth import get_current_user
from database import SessionLocal

FAC = {"facilityId": "fac_vc", "name": "Greens Storage Valley Center", "timeZone": "America/Los_Angeles"}
STORAGE = "10' x 10' Storage - Interior, Lower"
MAILBOX = "0' x 3' mailbox"
BIG_MAILBOX = "0' x 11' mailbox"
DEACTIVATED = "0' x 0' Ω Deactivated"


def _unit(uid, status, group, street=10000, rent=None, width=10.0, depth=10.0):
    row = {"unitId": uid, "unitName": uid.upper(), "status": status, "pricingGroupName": group,
           "width": width, "depth": depth, "standardRate": street, "autoPayEnabled": False, "overlockApplied": False}
    if status == "RENTED":
        row.update({"customerId": f"cust_{uid}", "customerName": f"Tenant {uid}", "monthlyRentalAmount": rent or street,
                    "paid": True, "overlockNeeded": False, "autoPayEnabled": True, "moveInDate": "2025-01-01"})
    return row


def _raw():
    rr = ([_unit(f"s{i}", "RENTED", STORAGE) for i in range(10)]
          + [_unit("s10", "VACANT", STORAGE), _unit("s11", "VACANT", STORAGE), _unit("s12", "UNAVAILABLE", STORAGE)]
          + [_unit(f"m{i}", "RENTED", MAILBOX, street=2500, width=0.0, depth=3.0) for i in range(2)]
          + [_unit("m2", "RENTED", BIG_MAILBOX, street=4000, width=0.0, depth=11.0)]
          + [_unit(f"m{i}", "UNAVAILABLE", MAILBOX, street=2500, width=0.0, depth=3.0) for i in range(3, 9)]
          + [_unit("x1", "UNAVAILABLE", DEACTIVATED, street=0, width=0.0, depth=0.0)])
    units = ([{"unitId": "s12", "rentability": {"rentable": False, "unrentableReason": "REPAIRS_REQUIRED", "unrentableReasonNote": "Door"}}]
             + [{"unitId": f"m{i}", "rentability": {"rentable": False, "unrentableReason": "OTHER"}} for i in range(3, 9)])
    leases = [{"customerId": r["customerId"], "unitId": r["unitId"], "moveInDate": "2025-01-01", "moveOutDate": None}
              for r in rr if r["status"] == "RENTED"]
    return {"today": date(2026, 10, 20), "rent_roll": rr, "units": units, "receivables": [], "leases": leases,
            "leads": [], "customers": [], "tasks": [], "payments": []}


# ── The rule ──────────────────────────────────────────────────────────────────

def test_the_rule_reads_the_pricing_group_name():
    assert uc.unit_class(STORAGE) == uc.STORAGE
    assert uc.unit_class("11' x 30' Parking - Gravel, Drive-In") == uc.STORAGE
    assert uc.unit_class("0' x 0' Other") == uc.STORAGE
    assert uc.unit_class(MAILBOX) == uc.MAILBOX
    assert uc.unit_class("0' x 4.75' Mailbox") == uc.MAILBOX
    assert uc.unit_class("Mail Box - Large") == uc.MAILBOX
    assert uc.unit_class(DEACTIVATED) == uc.EXCLUDED
    assert uc.unit_class("") == uc.STORAGE and uc.unit_class(None) == uc.STORAGE


def test_normalize_trims_dedupes_and_keeps_an_emptied_list_empty():
    assert uc.normalize(None) == uc.DEFAULTS
    assert uc.normalize({"mailbox": ["  PO Box ", "po box", ""], "excluded": []}) == {"mailbox": ["po box"], "excluded": []}
    assert uc.normalize({"mailbox": "mailbox"})["mailbox"] == uc.DEFAULTS["mailbox"]   # not a list = default


# ── The figures ───────────────────────────────────────────────────────────────

def _all_storage():
    """The pre-Oct 20 behavior: no rule, every row a unit."""
    return {"mailbox": [], "excluded": []}


def test_before_mailboxes_and_switched_off_records_sank_the_occupancy():
    f = cubby.summarize_facility(FAC, _raw(), _all_storage())
    assert f["units"] == {"total": 23, "rented": 13, "vacant": 2, "unavailable": 8}
    assert round(100 * f["units"]["rented"] / f["units"]["total"], 1) == 56.5
    assert len(f["offMarket"]) == 8


def test_storage_occupancy_counts_storage_only():
    f = cubby.summarize_facility(FAC, _raw())
    assert f["units"] == {"total": 13, "rented": 10, "vacant": 2, "unavailable": 1}
    rentable = f["units"]["rented"] + f["units"]["vacant"]
    assert round(100 * f["units"]["rented"] / rentable, 1) == 83.3          # "of rentable"
    assert f["excludedUnits"] == 1
    # Off market is storage that cannot be rented - not mailboxes, not dead records.
    assert [r["unit"] for r in f["offMarket"]] == ["S12"]
    assert f["area"] == {"total": 1300, "rented": 1000}
    assert f["rent"]["vacantPotential"] == 20000


def test_mailboxes_get_their_own_counts():
    f = cubby.summarize_facility(FAC, _raw())
    assert f["mailboxes"] == {"total": 9, "rented": 3, "vacant": 0, "unavailable": 6}
    assert f["rent"]["mailboxRentRoll"] == 2 * 2500 + 4000


def test_money_and_tenants_still_cover_mailbox_renters():
    f = cubby.summarize_facility(FAC, _raw())
    assert f["rent"]["rentRoll"] == 10 * 10000 + 2 * 2500 + 4000
    assert f["autoPay"] == 13                                                # every renter, mailboxes too


def test_unit_types_say_which_kind_and_drop_dead_records():
    f = cubby.summarize_facility(FAC, _raw())
    kinds = {t["name"]: t["kind"] for t in f["unitTypes"]}
    assert kinds == {STORAGE: "storage", MAILBOX: "mailbox", BIG_MAILBOX: "mailbox"}


def test_rented_history_follows_storage_only():
    f = cubby.summarize_facility(FAC, _raw())
    assert f["history"][-1]["rented"] == 10


def test_a_custom_word_list_moves_units_between_classes():
    f = cubby.summarize_facility(FAC, _raw(), {"mailbox": ["11' mailbox"], "excluded": []})
    assert f["mailboxes"]["total"] == 1 and f["units"]["total"] == 22


def test_the_screen_payload_carries_the_rule():
    pulled = {"organization": "Greens Storage", "facilities": [FAC], "raw": [_raw()]}
    out = cubby.build(pulled, uc.normalize({"mailbox": ["mailbox"]}))
    assert out["unitClasses"]["mailbox"] == ["mailbox"]
    assert out["facilities"][0]["mailboxes"]["total"] == 9


# ── The setting ───────────────────────────────────────────────────────────────

@pytest.fixture
def client():
    from routers import facility_ops
    db = SessionLocal()
    db.query(models.NexusSetting).filter(models.NexusSetting.key == uc.SETTING_KEY).delete()
    db.commit()
    db.close()
    app = FastAPI()
    app.include_router(facility_ops.router)
    user = {"email": "ops.manager@greensglobal.com", "role": "manager", "level": 3}
    app.dependency_overrides[get_current_user] = lambda: user
    c = TestClient(app)
    c.user = user
    return c


def test_the_setting_defaults_saves_and_feeds_the_summary(client):
    r = client.get("/facility-ops/unit-classes")
    assert r.status_code == 200 and r.json()["mailbox"] == uc.DEFAULTS["mailbox"]
    r = client.put("/facility-ops/unit-classes", json={"mailbox": ["Mailbox", "PO Box"], "excluded": ["deactivated"]})
    assert r.status_code == 200 and r.json()["mailbox"] == ["mailbox", "po box"]
    assert uc.load()["mailbox"] == ["mailbox", "po box"]
    assert cubby._rules()["mailbox"] == ["mailbox", "po box"]


def test_only_a_manager_or_operations_editor_changes_the_words(client):
    client.user.update({"role": "supervisor", "level": 2, "email": "site.lead@greensglobal.com"})
    assert client.get("/facility-ops/unit-classes").status_code == 200
    assert client.put("/facility-ops/unit-classes", json={"mailbox": []}).status_code == 401
    assert uc.load() == uc.DEFAULTS
