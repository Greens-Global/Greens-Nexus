"""Operations > Reports, the reports added on Oct 20 2026 (ops_reports.py):
Accounts Receivable rolled forward, Balances Summary, Coverage Roll and
Activity, Facility Portfolio, Gross Potential, Historical Management Summary;
plus several facilities at once, the headline summary on every report and the
per-report options. Cubby is faked (the same fake as test_ops_reports.py, with
its own ledgers). Run alone: python -m pytest test_ops_reports_more.py"""
import pytest

import cubby
import models
import ops_reports
import test_ops_reports as base
from database import SessionLocal

# Accrual ledger for October at Temecula. Today is 10/15 (base.TODAY).
#   cust_1 / A1: rent, coverage, a discount, a payment, a fee and its waiver,
#   then a refund on 10/13 (after a period that ends 10/12).
#   cust_2 / A2 -> cust_9 / A3: a balance moved between leases (no counterpart).
#   cust_2 / A2: prepaid used on 10/14.


def _e(i, j, day, acct, debit=0, credit=0, cust="cust_1", unit="a1", name="A1", expl=""):
    return {"id": f"x{i}", "journalEntryId": j, "entryTime": f"{day}T10:00:00", "customerId": cust, "customerName": "Aiden Robb",
            "unitId": unit, "unitName": name, "account": acct, "mappedGlAccount": "", "mappedGlAccountNumber": "",
            "taxCategory": "", "explanation": expl, "debit": debit, "credit": credit}


ACCRUAL = {"entries": [
    _e(1, "j1", "2026-10-01", "ACCOUNT_RECEIVABLE", debit=15900, expl="Rent"),
    _e(2, "j1", "2026-10-01", "RENT", credit=15000, expl="Rent"),
    _e(3, "j1", "2026-10-01", "INSURANCE", credit=900, expl="Coverage"),
    _e(4, "j2", "2026-10-01", "DISCOUNTS", debit=750, expl="5% Senior Discount"),
    _e(5, "j2", "2026-10-01", "ACCOUNT_RECEIVABLE", credit=750, expl="5% Senior Discount"),
    _e(6, "j3", "2026-10-05", "CREDIT_CARD_PAYMENTS", debit=10000, expl="Payment"),
    _e(7, "j3", "2026-10-05", "ACCOUNT_RECEIVABLE", credit=10000, expl="Payment"),
    _e(8, "j4", "2026-10-11", "ACCOUNT_RECEIVABLE", debit=2000, expl="CA Late Fee"),
    _e(9, "j4", "2026-10-11", "FEES", credit=2000, expl="CA Late Fee"),
    _e(10, "j5", "2026-10-12", "WAIVED_FEES", debit=2000, expl="Waive: CA Late Fee"),
    _e(11, "j5", "2026-10-12", "ACCOUNT_RECEIVABLE", credit=2000, expl="Waive: CA Late Fee"),
    _e(12, "j6", "2026-10-13", "ACCOUNT_RECEIVABLE", debit=1000, expl="Refund"),
    _e(13, "j6", "2026-10-13", "CREDIT_CARD_PAYMENTS", credit=1000, expl="Refund"),
    _e(14, "j7", "2026-10-02", "ACCOUNT_RECEIVABLE", debit=500, cust="cust_2", unit="a2", name="A2", expl="Transfer balance"),
    _e(15, "j7", "2026-10-02", "ACCOUNT_RECEIVABLE", credit=500, cust="cust_9", unit="a3", name="A3", expl="Transfer balance"),
    _e(16, "j8", "2026-10-14", "PREPAID_RENT", debit=2000, cust="cust_2", unit="a2", name="A2", expl="Used Prepaid balance"),
    _e(17, "j8", "2026-10-14", "ACCOUNT_RECEIVABLE", credit=2000, cust="cust_2", unit="a2", name="A2", expl="Used Prepaid balance"),
]}


def _c(i, j, day, acct, direction, amount, cust="cust_1", name="A1"):
    return {"id": f"c{i}", "journalEntryId": j, "paymentTime": f"{day}T10:00:00", "amount": amount, "direction": direction,
            "account": acct, "details": {"customerId": cust, "customerName": "Aiden Robb", "unitName": name}}


CASH = {"entries": [
    _c(1, "k1", "2026-10-05", "CREDIT_CARD_PAYMENTS", "DEBIT", 10000),
    _c(2, "k1", "2026-10-05", "RENT", "CREDIT", 9100),
    _c(3, "k1", "2026-10-05", "INSURANCE", "CREDIT", 900),
    _c(4, "k2", "2026-10-06", "INSURANCE", "DEBIT", 300),
    _c(5, "k2", "2026-10-06", "CREDIT_CARD_PAYMENTS", "CREDIT", 300),
    _c(6, "k3", "2026-10-07", "BAD_DEBT", "CREDIT", 4000, cust="cust_2", name="A2"),
    _c(7, "k3", "2026-10-07", "CASH_PAYMENTS", "DEBIT", 4000, cust="cust_2", name="A2"),
]}
AR_COLS = [c for c, _ in ops_reports.AR_CATS]


def _extra():
    """A third facility, a parking unit, coverage on the leases, prepaid rent."""
    db = SessionLocal()
    try:
        db.add(models.CubbyFacility(facility_id="fac_c", name="Greens Storage Escondido", time_zone="America/Los_Angeles",
                                    enabled=True, data={"name": "Greens Storage Escondido"}, synced_at="2026-10-15T15:00:00+00:00"))
        rr = base._rr("a5", "P1", "RENTED", "cust_5", "Pat Park", 9000, street=9400, w=10, d=20,
                      group="10' x 20' Parking - Asphalt, Drive-In", moveInDate="2026-02-01")
        db.add(models.CubbyUnit(id="fac_a:a5", facility_id="fac_a", unit_id="a5", unit_name="P1", status="RENTED",
                                customer_id="cust_5", data={"rentRoll": rr, "unit": {"unitId": "a5", "name": "P1"}}))
        db.add(models.CubbyRental(id="fac_a:lease_5", facility_id="fac_a", lease_id="lease_5", unit_id="a5", customer_id="cust_5",
                                  move_in_date="2026-02-01", move_out_date="", data={"monthlyRentalAmount": 9000}))
        a2 = db.get(models.CubbyUnit, "fac_a:a2")
        a2.data = {**a2.data, "rentRoll": {**a2.data["rentRoll"], "prepaid": 5000, "deposit": 2500}}
        l1 = db.get(models.CubbyRental, "fac_a:lease_1")
        l1.data = {**l1.data, "coverage": {"coverageType": "ORGANISATION", "coverageLevelId": "cl_1", "startDate": "2025-03-01",
                                           "premiumAmount": 900, "coverageAmount": 250000}}
        l3 = db.get(models.CubbyRental, "fac_b:lease_3")
        l3.data = {**l3.data, "coverage": {"coverageType": "PRIVATE_POLICY"}, "privatePolicyNumber": "POL-1",
                   "privatePolicyExpirationDate": "2027-01-01"}
        db.commit()
    finally:
        db.close()


@pytest.fixture
def client(monkeypatch):
    base._seed()
    _extra()
    monkeypatch.setenv("CUBBY_API_KEY", "test-key-not-real")
    monkeypatch.setattr(cubby, "_facility_today", lambda fac: base.TODAY)
    monkeypatch.setattr(base, "GL_ACCRUAL", ACCRUAL)
    monkeypatch.setattr(base, "GL_CASH", CASH)
    f = base.FakeCubby()
    monkeypatch.setattr(ops_reports, "_cubby", f)
    c = base._client()
    c.fake = f
    return c


def _run(client, kind, **params):
    r = client.get(f"/ops-reports/run/{kind}", params=params)
    assert r.status_code == 200, (kind, r.text)
    return r.json()


# ── Accounts Receivable rolled forward ───────────────────────────────────────

def test_ar_activity_rolls_beginning_to_ending_by_column(client):
    out = _run(client, "ar-activity", facility_id="fac_a", start="2026-10-01", end="2026-10-12")
    a1 = next(r for r in out["rows"] if r["unit"] == "A1")
    # today's balance 951.08, less the 10/13 refund posted after the period
    assert a1["ending"] == 95108 - 1000
    assert (a1["rent"], a1["insurance"], a1["fees"], a1["discounts"], a1["payments"], a1["waivedFees"], a1["refunds"]) == \
        (15000, 900, 2000, -750, -10000, -2000, 0)
    assert a1["beginning"] == a1["ending"] - (15900 - 750 - 10000 + 2000 - 2000)
    assert a1["accountType"] == "Lease" and (a1["_f"], a1["_c"], a1["_u"]) == ("fac_a", "cust_1", "a1")
    for r in out["rows"]:                                         # the roll-forward holds on every line
        assert r["beginning"] + sum(r[c] for c in AR_COLS) == r["ending"], r["unit"]
    t = out["totals"]
    assert t["beginning"] + sum(t[c] for c in AR_COLS) == t["ending"]
    a2 = next(r for r in out["rows"] if r["unit"] == "A2")
    assert a2["other"] == 500 and a2["ending"] == 2000             # moved in, then prepaid paid it on 10/14
    a3 = next(r for r in out["rows"] if r["unit"] == "A3")
    assert a3["other"] == -500 and a3["tenant"] == "Gone Tenant"
    labels = [s["label"] for s in out["summary"]]
    assert labels[0] == "Beginning Balance" and "Ending Balance" in labels
    assert next(s for s in out["summary"] if s["label"] == "Charges")["value"] == 17900


def test_ar_activity_through_today_ends_on_cubbys_balance_and_counts_the_refund(client):
    out = _run(client, "ar-activity", facility_id="fac_a", start="2026-10-01", end="2026-10-15")
    a1 = next(r for r in out["rows"] if r["unit"] == "A1")
    assert a1["ending"] == 95108 and a1["refunds"] == 1000
    one_day = _run(client, "ar-activity", facility_id="fac_a", start="2026-10-15", end="2026-10-15")
    a1 = next(r for r in one_day["rows"] if r["unit"] == "A1")
    assert a1["beginning"] == a1["ending"] == 95108               # Cubby's sample: no activity, both balances equal


def test_old_accounts_receivable_key_is_aged_receivables(client):
    cat = client.get("/ops-reports/catalog").json()
    keys = {r["key"]: r for r in cat["reports"]}
    assert keys["aged-receivables"]["title"] == "Aged Receivables" and keys["ar-activity"]["title"] == "Accounts Receivable"
    assert "accounts-receivable" not in keys and cat["aliases"]["accounts-receivable"] == "aged-receivables"
    old = _run(client, "accounts-receivable")
    assert old["key"] == "aged-receivables" and old["rows"][0]["total"] == 95108


# ── Balances, coverage ───────────────────────────────────────────────────────

def test_balances_summary_through_a_date(client):
    out = _run(client, "balances-summary", facility_id="fac_a", end="2026-10-12")
    assert out["asOf"] == "2026-10-12" and out["period"] is None
    a = out["rows"][0]
    # AR: A1 951.08 less the refund after 10/12; A2 0 today, but 20.00 before prepaid paid it on 10/14.
    assert a["ar"] == 94108 + 2000
    assert a["prepaid"] == 5000 + 2000 and a["deposit"] == 2500
    assert a["net"] == a["ar"] - a["prepaid"] - a["credit"]
    lines = {r["unit"]: r for r in out["groups"][a["_sub"]]["rows"]}
    assert lines["A2"]["prepaid"] == 7000 and lines["A1"]["ar"] == 94108
    today = _run(client, "balances-summary", facility_id="fac_a")
    assert today["asOf"] == "2026-10-15" and today["rows"][0]["ar"] == 95108 and today["rows"][0]["prepaid"] == 5000
    cat = {r["key"]: r for r in client.get("/ops-reports/catalog").json()["reports"]}
    assert cat["balances-summary"]["pointInTime"] is True and cat["rent-roll"]["pointInTime"] is False


def test_coverage_roll_and_activity(client):
    p = {"start": "2026-10-01", "end": "2026-10-15"}
    roll = _run(client, "coverage-roll", **p)
    assert [(r["unit"], r["coverage"], r["premium"], r["covAmount"]) for r in roll["rows"]] == [("A1", "Facility Plan", 900, 250000)]
    both = _run(client, "coverage-roll", includePrivate="true", **p)
    b1 = next(r for r in both["rows"] if r["unit"] == "B1")
    assert b1["coverage"] == "Private Policy" and b1["policyOnFile"] == "Yes" and b1["policyExpires"] == "2027-01-01"
    assert "POL-1" not in str(both)                               # the policy number is never shown
    act = _run(client, "coverage-activity", facility_id="fac_a", **p)
    r = act["rows"][0]
    assert (r["unit"], r["charged"], r["paid"], r["returned"], r["net"], r["unpaid"]) == ("A1", 900, 900, 300, 600, 300)
    assert r["coverage"] == "Facility Plan" and len(act["rows"]) == 1


# ── Portfolio, gross potential, history ──────────────────────────────────────

def test_facility_portfolio_has_a_total_and_coverage(client):
    out = _run(client, "facility-portfolio", facility_ids="fac_a,fac_b", start="2026-10-01", end="2026-10-15")
    a = next(r for r in out["rows"] if r["facility"] == "Temecula")
    assert (a["units"], a["rented"], a["rentRoll"], a["pastDue"], a["receipts"]) == (5, 3, 44000, 95108, 35000)
    assert a["covered"] == pytest.approx(33.3) and a["delinquency"] == pytest.approx(216.2)
    assert out["totals"]["facility"] == "All Facilities" and out["totals"]["units"] == 6
    noparking = _run(client, "facility-portfolio", facility_id="fac_a", ignoreParking="true")
    assert noparking["rows"][0]["units"] == 4 and noparking["options"] == {"ignoreParking": True}


def test_gross_potential_identity_and_unit_drill(client):
    out = _run(client, "gross-potential", facility_id="fac_a")
    std = next(r for r in out["rows"] if r["type"] == "10x10 Standard")
    assert (std["potential"], std["actual"], std["loss"], std["variance"]) == (60000, 15000, 40000, -5000)
    for r in out["rows"]:
        assert r["potential"] == r["actual"] + r["loss"] - r["variance"]
    units = out["groups"][std["_sub"]]["rows"]
    assert [u["unit"] for u in units] == ["A1", "A3", "A4"]
    assert any("target rate" in n for n in out["notes"])


def test_buckets_split_periods():
    assert ops_reports.buckets("2026-10-01", "2026-10-20", "week")[0] == ("Week of 09/27/2026", "2026-10-01", "2026-10-03")
    assert ops_reports.buckets("2026-10-01", "2026-10-20", "week")[1][1:] == ("2026-10-04", "2026-10-10")
    assert [b[0] for b in ops_reports.buckets("2026-02-15", "2026-10-20", "quarter")] == ["Q1 2026", "Q2 2026", "Q3 2026", "Q4 2026"]
    assert ops_reports.buckets("2026-09-15", "2026-10-20", "month") == [
        ("September 2026", "2026-09-15", "2026-09-30"), ("October 2026", "2026-10-01", "2026-10-20")]
    assert ops_reports.buckets("2025-06-01", "2026-10-20", "year")[0] == ("2025", "2025-06-01", "2025-12-31")
    with pytest.raises(ops_reports.ReportError):
        ops_reports.buckets("2025-01-01", "2026-01-01", "day")


def test_historical_management_summary_by_month(client):
    out = _run(client, "historical-management-summary", facility_id="fac_a", start="2026-09-01", end="2026-10-15")
    assert [r["period"] for r in out["rows"]] == ["September 2026", "October 2026"]
    sep, octo = out["rows"]
    assert sep["occupied"] == 3 and sep["to"] == "2026-09-30"       # A1, A3 (until 10/05) and P1
    assert (octo["moveIns"], octo["moveOuts"], octo["receipts"], octo["leads"]) == (1, 1, 35000, 2)
    assert octo["occupied"] == 3 and octo["rentRoll"] == 44000      # A3 left, A2 came: A1, A2 and P1 on 10/15
    weekly = _run(client, "historical-management-summary", facility_id="fac_a", start="2026-10-01", end="2026-10-15", split="week")
    assert len(weekly["rows"]) == 3 and weekly["options"]["split"] == "week"
    assert client.get("/ops-reports/run/historical-management-summary", params={"split": "fortnight"}).status_code == 422


# ── Several facilities, summary, options ─────────────────────────────────────

def test_several_facilities_at_once(client):
    two = _run(client, "rent-roll", facility_ids="fac_a,fac_b")
    assert two["facility"] == "2 Facilities" and two["facilities"] == ["Murrieta", "Temecula"]
    assert {r["facility"] for r in two["rows"]} == {"Temecula", "Murrieta"}
    every = _run(client, "rent-roll", facility_ids="fac_a,fac_b,fac_c")
    assert every["facility"] == "All Facilities" and len(every["facilities"]) == 3
    one = _run(client, "rent-roll", facility_ids="fac_b", facility_id="fac_a")      # the list wins
    assert one["facility"] == "Murrieta"
    assert _run(client, "rent-roll", facility_id="fac_a")["facility"] == "Temecula"   # the old parameter still works
    assert client.get("/ops-reports/run/rent-roll", params={"facility_ids": "fac_a,fac_zzz"}).status_code == 404
    m = ops_reports.run("management-summary", facility_ids=["fac_a", "fac_b"], start="2026-10-01", end="2026-10-15")
    assert len(m["rows"]) == 2 and m["totals"]["facility"] == "All Facilities"


def test_every_report_has_a_headline_summary(client):
    for r in client.get("/ops-reports/catalog").json()["reports"]:
        out = _run(client, r["key"], start="2026-10-01", end="2026-10-15")
        s = out["summary"]
        assert (1 if r["source"] == "unavailable" else 3) <= len(s) <= 6, r["key"]
        for item in s:
            assert set(item) == {"label", "value", "type"} and item["type"] in ("money", "int", "pct", "text"), (r["key"], item)
            assert item["label"] == " ".join(w[:1].upper() + w[1:] if w not in ("or", "and", "a", "of") else w
                                              for w in item["label"].split(" ")), item["label"]   # Title Case
        base._no_secrets(out)


def test_options_are_whitelisted_and_described(client):
    cat = {r["key"]: r for r in client.get("/ops-reports/catalog").json()["reports"]}
    assert [o["key"] for o in cat["rent-roll"]["options"]] == ["occupiedOnly"]
    split = next(o for o in cat["historical-management-summary"]["options"] if o["key"] == "split")
    assert split["type"] == "select" and split["default"] == "month" and {c["value"] for c in split["choices"]} >= {"day", "year"}
    for r in cat.values():
        for o in r["options"]:
            assert o["type"] in ("bool", "select") and o["label"] and o["help"]
    full = _run(client, "rent-roll", facility_id="fac_a")
    occ = _run(client, "rent-roll", facility_id="fac_a", occupiedOnly="true")
    assert len(full["rows"]) == 5 and {r["status"] for r in occ["rows"]} == {"Rented"} and len(occ["rows"]) == 3
    assert next(s for s in occ["summary"] if s["label"] == "Units")["value"] == 5         # still out of every unit
    assert _run(client, "rent-roll", ignoreParking="true")["options"] == {"occupiedOnly": False}   # not this report's: dropped
    assert client.get("/ops-reports/run/rent-roll", params={"occupiedOnly": "maybe"}).status_code == 422
    occs = _run(client, "occupancy-statistics", facility_id="fac_a", ignoreParking="1")
    assert not any("Parking" in r["type"] for r in occs["rows"])
    vac = _run(client, "move-in-move-out-detail", start="2026-10-01", end="2026-10-15")
    assert vac["options"] == {}


def test_ignore_bad_debt_drops_the_write_off_journal(client):
    p = {"facility_id": "fac_a", "start": "2026-10-01", "end": "2026-10-15"}
    with_bd = _run(client, "general-ledger-cash", **p)
    without = _run(client, "general-ledger-cash", ignoreBadDebt="true", **p)
    assert len(with_bd["rows"]) - len(without["rows"]) == 2
    assert not any(r["account"] == "Bad Debt" for r in without["rows"])
    charge = _run(client, "receipts-by-charge-type", ignoreBadDebt="true", **p)
    assert "Bad Debt" not in {r["charge"] for r in charge["rows"]}
