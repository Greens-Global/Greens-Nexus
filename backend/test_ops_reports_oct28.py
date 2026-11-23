"""Operations > Reports, the Oct 28 2026 call with Neil (Ready to build):
Credits Issued (B13), vacancy duration on Occupancy Statistics (B14), the
Exclude Mailboxes / Exclude Non-Standard Units switches (B9), the preset
column library (B10), and the person's columns - order, sort, filters - kept
on the report so a memorized report and every export match the screen (B5,
B11). Cubby is faked (test_ops_reports.py's fake, test_ops_reports_more.py's
ledgers). Run alone: python -m pytest test_ops_reports_oct28.py"""
import json

import pytest

import cubby
import models
import ops_reports
import ops_unit_classes as uc
import test_ops_reports as base
import test_ops_reports_more as more
from database import SessionLocal

CREDIT = more._e(30, "j30", "2026-10-03", "GIVEN_CREDITS", debit=2500, cust="cust_2", unit="a2", name="A2",
                 expl="Issued credits to account: Referral to Nina Mejia")
CREDIT_AR = more._e(31, "j30", "2026-10-03", "CREDITS", credit=2500, cust="cust_2", unit="a2", name="A2",
                    expl="Issued credits to account: Referral to Nina Mejia")
USED = more._e(32, "j31", "2026-10-04", "USED_CREDITS", credit=2500, cust="cust_2", unit="a2", name="A2", expl="Credits used: Rent")
ACCRUAL = {"entries": more.ACCRUAL["entries"] + [CREDIT, CREDIT_AR, USED]}


def _boxes():
    """A mailbox and a $0 Business Class unit at Temecula, both rented."""
    db = SessionLocal()
    try:
        for uid, name, group, street in (("m1", "MB1", "0' x 3' mailbox", 500), ("n1", "BC1", "0' x 0' Business Class", 0)):
            rr = base._rr(uid, name, "RENTED", f"cust_{uid}", f"Tenant {name}", street, street=street, w=0, d=0, group=group)
            db.add(models.CubbyUnit(id=f"fac_a:{uid}", facility_id="fac_a", unit_id=uid, unit_name=name, status="RENTED",
                                    customer_id=f"cust_{uid}", data={"rentRoll": rr, "unit": {"unitId": uid, "name": name}}))
        db.commit()
    finally:
        db.close()


@pytest.fixture
def client(monkeypatch):
    base._seed()
    _boxes()
    monkeypatch.setenv("CUBBY_API_KEY", "test-key-not-real")
    monkeypatch.setattr(cubby, "_facility_today", lambda fac: base.TODAY)
    monkeypatch.setattr(base, "GL_ACCRUAL", ACCRUAL)
    monkeypatch.setattr(base, "GL_CASH", more.CASH)
    monkeypatch.setattr(ops_reports, "_cubby", base.FakeCubby())
    return base._client()


def _run(client, kind, **params):
    r = client.get(f"/ops-reports/run/{kind}", params=params)
    assert r.status_code == 200, (kind, r.text)
    return r.json()


# ── B13 Credits Issued ───────────────────────────────────────────────────────

def test_credits_issued_lists_credits_and_waivers_with_the_reason(client):
    out = _run(client, "credits-issued", facility_id="fac_a", start="2026-10-01", end="2026-10-15")
    got = {(r["unit"], r["kind"], r["reason"], r["amount"]) for r in out["rows"]}
    assert got == {("A2", "Credit Given", "Referral to Nina Mejia", 2500), ("A1", "Fee Waived", "CA Late Fee", 2000)}
    # spending credit a tenant already had is not a new credit, and promotions wait for the switch
    assert all(r["kind"] != "Discount" for r in out["rows"])
    assert out["totals"]["amount"] == 4500
    assert {s["label"]: s["value"] for s in out["summary"]}["Credits Given"] == 2500
    assert any("does not record which employee" in n for n in out["notes"])
    assert out["rows"][0]["date"] >= out["rows"][-1]["date"]   # newest first


def test_credits_issued_can_take_the_promotions_in(client):
    out = _run(client, "credits-issued", facility_id="fac_a", start="2026-10-01", end="2026-10-15", includeDiscounts="true")
    assert ("Discount", "5% Senior Discount", 750) in {(r["kind"], r["reason"], r["amount"]) for r in out["rows"]}


def test_credits_issued_is_in_the_catalog():
    keys = {r["key"]: r for r in ops_reports.catalog()["reports"]}
    assert keys["credits-issued"]["period"] is True
    assert [o["key"] for o in keys["credits-issued"]["options"]] == ["includeDiscounts"]


# ── B14 vacancy duration ─────────────────────────────────────────────────────

def test_occupancy_statistics_says_how_long_the_vacant_units_have_been_empty(client):
    out = _run(client, "occupancy-statistics", facility_id="fac_a")
    std = next(r for r in out["rows"] if r["type"] == "10x10 Standard")
    # A3 came empty on 10/05 (the last move-out); today is 10/15
    assert (std["avgDaysVacant"], std["maxDaysVacant"]) == (10, 10)
    assert {c["key"] for c in out["columns"]} >= {"avgDaysVacant", "maxDaysVacant"}
    assert {s["label"]: s["value"] for s in out["summary"]}["Longest Vacant (Days)"] == 10


def test_days_vacant_is_a_preset_column_too(client):
    out = _run(client, "rent-roll", facility_id="fac_a", addColumns="vacantSince,daysVacant")
    a3 = next(r for r in out["rows"] if r["unit"] == "A3")
    a1 = next(r for r in out["rows"] if r["unit"] == "A1")
    assert (a3["p_vacantSince"], a3["p_daysVacant"]) == ("2026-10-05", 10)
    assert a1["p_daysVacant"] is None


# ── B9 the two switches ──────────────────────────────────────────────────────

def test_exclude_mailboxes_and_non_standard_units(client):
    every = {r["unit"] for r in _run(client, "rent-roll", facility_id="fac_a")["rows"]}
    assert {"MB1", "BC1"} <= every
    no_boxes = {r["unit"] for r in _run(client, "rent-roll", facility_id="fac_a", excludeMailboxes="true")["rows"]}
    assert "MB1" not in no_boxes and "BC1" in no_boxes
    neither = {r["unit"] for r in _run(client, "rent-roll", facility_id="fac_a", excludeMailboxes="true",
                                       excludeNonStandard="true")["rows"]}
    assert neither == every - {"MB1", "BC1"}
    occ = _run(client, "occupancy-statistics", facility_id="fac_a", excludeMailboxes="true", excludeNonStandard="true")
    assert not {"0' x 3' mailbox", "0' x 0' Business Class"} & {r["type"] for r in occ["rows"]}


def test_every_occupancy_report_takes_both_switches():
    reports = {r["key"]: [o["key"] for o in r["options"]] for r in ops_reports.catalog()["reports"]}
    for k in ("rent-roll", "occupancy-statistics", "vacant-units", "gross-potential", "management-summary",
              "facility-portfolio", "historical-management-summary"):
        assert {"excludeMailboxes", "excludeNonStandard"} <= set(reports[k]), k


def test_non_standard_is_words_or_a_dollar_rate_never_a_mailbox():
    assert uc.is_nonstandard("0' x 0' Business Class", 0)
    assert uc.is_nonstandard("0' x 0' Dump Station Agreement", 3900)
    assert uc.is_nonstandard("60' x 45' Residential Unit", 837500)
    assert uc.is_nonstandard("5' x 5' Air Duct Units", 1)
    assert uc.is_nonstandard("12' x 20' Something New", 100)
    assert not uc.is_nonstandard("10' x 10' Storage - Drive-Up", 18900)
    assert not uc.is_nonstandard("0' x 3' mailbox", 0)
    assert not uc.is_nonstandard("0' x 0' Ω Deactivated", 0)
    # the words are a setting: emptied, only the dollar rule is left
    assert not uc.is_nonstandard("0' x 0' Business Class", 4900, {**uc.DEFAULTS, "nonstandard": []})


# ── B10 preset columns ───────────────────────────────────────────────────────

def test_presets_are_listed_and_fill_from_the_unit_or_the_tenant(client):
    presets = {p["key"]: p for p in ops_reports.catalog()["presets"]}
    assert presets["daysVacant"]["column"] == "p_daysVacant" and presets["tenantBalance"]["level"] == "tenant"
    out = _run(client, "aged-receivables", facility_id="fac_a", addColumns="unitClass,moveInDate,streetRate,tenantUnits,nope")
    keys = [c["key"] for c in out["columns"]]
    assert keys[-4:] == ["p_unitClass", "p_moveInDate", "p_streetRate", "p_tenantUnits"]
    row = next(r for r in out["rows"] if r["unit"] == "A1")
    assert (row["p_unitClass"], row["p_moveInDate"], row["p_streetRate"], row["p_tenantUnits"]) == \
        ("Self Storage", "2025-03-01", 20000, "A1")
    assert "p_streetRate" in out["totals"]


def test_a_line_about_no_one_unit_leaves_a_unit_preset_blank(client):
    out = _run(client, "occupancy-statistics", facility_id="fac_a", addColumns="monthlyRent")
    assert all(r["p_monthlyRent"] is None for r in out["rows"])


def test_unit_class_tells_vehicle_storage_mailboxes_and_non_standard_apart(client):
    out = _run(client, "rent-roll", facility_id="fac_a", addColumns="unitClass")
    by = {r["unit"]: r["p_unitClass"] for r in out["rows"]}
    assert (by["MB1"], by["BC1"], by["A1"]) == ("Mailbox", "Non-Standard", "Self Storage")


# ── B5 / B11 the person's columns ride on the report ─────────────────────────

def test_columns_come_back_in_the_order_kept_and_hidden_ones_stay_out(client):
    out = _run(client, "rent-roll", facility_id="fac_a", showColumns="tenant,unit,rent,gone", hideColumns="company,size")
    keys = [c["key"] for c in out["columns"]]
    assert keys[:3] == ["tenant", "unit", "rent"]
    assert "facility" in keys and not {"company", "size", "gone"} & set(keys)   # the rest follow, hidden ones stay out
    assert len(out["allColumns"]) == len(keys) + 2
    everything = _run(client, "rent-roll", facility_id="fac_a", hideColumns=",".join(c["key"] for c in out["allColumns"]))
    assert len(everything["columns"]) == 1   # never a report with no columns


def test_sort_and_filters_apply_and_the_filtered_lines_get_their_own_total(client):
    filters = json.dumps({"status": {"values": ["Rented"]}, "rent": {"min": 15000}})
    out = _run(client, "rent-roll", facility_id="fac_a", sortBy="rent:desc", filters=filters)
    assert [r["unit"] for r in out["rows"]] == ["A2", "A1"]
    assert out["totals"]["rent"] == 35000 and out["rowsBeforeFilters"] > 2
    words = _run(client, "rent-roll", facility_id="fac_a", filters=json.dumps({"tenant": {"q": "ada, bea"}}))
    assert {r["unit"] for r in words["rows"]} == {"A1", "A2"}
    days = _run(client, "rent-roll", facility_id="fac_a", filters=json.dumps({"moveIn": {"min": "2026-01-01", "max": "2026-12-31"}}))
    assert {r["unit"] for r in days["rows"]} == {"A2"}


def test_the_export_follows_the_same_columns(client):
    r = client.get("/ops-reports/export/rent-roll", params={
        "format": "csv", "facility_id": "fac_a",
        "options": json.dumps({"showColumns": "unit,tenant", "sortBy": "unit:desc", "addColumns": "unitClass,daysVacant",
                               "excludeMailboxes": True})})
    assert r.status_code == 200, r.text
    lines = r.content.decode("utf-8-sig").splitlines()
    head = next(i for i, ln in enumerate(lines) if ln.startswith("Unit"))
    assert lines[head].split(",")[:2] == ["Unit", "Tenant"]
    assert not any("MB1" in ln for ln in lines)


def test_a_column_setup_too_long_is_refused(client):
    r = client.get("/ops-reports/run/rent-roll", params={"facility_id": "fac_a", "showColumns": "x" * 3000})
    assert r.status_code == 422
