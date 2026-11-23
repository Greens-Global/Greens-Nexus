"""Revenue Management: a tenant's rate history and comments log (Oct 28 2026
call with Neil, B16). The history comes from the Hummingbird months before
the cutover, the rent changes Nexus put in Cubby and today's Cubby rent;
Cubby's own notes on the lease are read live and never stored; Nexus's
comments are their own table, append-only. Uses test_ops_revenue's fake
facility and its Cubby guard. Run alone: python -m pytest test_ops_revenue_history.py"""
from datetime import date

import pytest

import cubby
import hb_models as hm
import models
import ops_revenue as rev
from database import SessionLocal
from test_ops_revenue import TODAY, client  # noqa: F401 - the shared fixture

CUBBY_NOTES = {"notes": [{"text": "Asked to hold the rent until spring", "createdAt": "2026-10-02T10:00:00Z", "createdBy": "Front Desk"},
                         {"text": "Moved in with a promo", "createdAt": "2024-01-10T10:00:00Z", "createdBy": "Front Desk"}]}


@pytest.fixture
def hb(monkeypatch):
    """Tenant A1's Hummingbird lease: $90 from move-in, $95 from 03/2025."""
    db = SessionLocal()
    try:
        for model in (hm.HbLeaseMonth, hm.HbLease, hm.HbUnit, hm.HbProperty, models.OpsTenantComment):
            db.query(model).delete()
        db.add(hm.HbProperty(id="p_t", name="Greens Storage, Temecula", short_name="Temecula"))
        db.add(hm.HbUnit(id="u_a1", property_id="p_t", number="A1"))
        db.add(hm.HbLease(id="l_a1", property_id="p_t", unit_id="u_a1", status=1, start_date="2024-01-10"))
        for y, m, rent in [(2024, 1, 90.0), (2024, 6, 90.0), (2025, 2, 90.0), (2025, 3, 95.0), (2026, 9, 95.0)]:
            db.add(hm.HbLeaseMonth(id=f"l_a1:{y}-{m:02d}", lease_id="l_a1", property_id="p_t", month=f"{y}-{m:02d}", rent=rent))
        db.commit()
    finally:
        db.close()
    monkeypatch.setenv("CUBBY_API_KEY", "test-key-not-real")
    calls = []

    def fake_post(path, where):
        calls.append((path, where))
        assert path == "notes/search"   # a read; nothing is written to Cubby
        return CUBBY_NOTES
    monkeypatch.setattr(cubby, "_post", fake_post)
    return calls


# ── The pure history ──────────────────────────────────────────────────────────

def test_history_reads_hummingbird_then_cubby():
    t = {"rent": 10000, "moveIn": "2024-01-10", "lastIncrease": ""}
    out = rev.rate_history(t, [("2024-01", 90.0), ("2024-02", 90.0), ("2025-03", 95.0)], "2024-01-10", [], TODAY)
    assert [(e["date"], e["rent"], e["source"], e["kind"]) for e in out] == [
        ("2024-01-10", 9000, "Hummingbird", "Move-In"), ("2025-03-01", 9500, "Hummingbird", "Rent Change"),
        ("2026-09-15", 10000, "Cubby", "Rent Change")]
    assert out[1]["change"] == 500 and out[1]["changePct"] == 5.6
    assert "does not say on which day" in out[2]["note"]


def test_history_takes_nexus_changes_and_reads_one_change_once():
    t = {"rent": 10000, "moveIn": "2024-01-10", "lastIncrease": "2026-10-01"}
    out = rev.rate_history(t, [("2024-01", 90.0)], "2024-01-10", [{"date": "2026-10-01", "from": 9000, "to": 10000}], TODAY)
    assert [(e["date"], e["rent"], e["source"]) for e in out] == [("2024-01-10", 9000, "Hummingbird"),
                                                                  ("2026-10-01", 10000, "Nexus Rent Change")]
    # a change not reached yet is not history
    later = rev.rate_history(t, [], "", [{"date": "2027-01-01", "to": 11000}], TODAY)
    assert all(e["date"] <= TODAY.isoformat() for e in later)


def test_a_tenant_new_to_cubby_starts_at_move_in():
    out = rev.rate_history({"rent": 12000, "moveIn": "2026-10-01", "lastIncrease": ""}, [], "", [], TODAY)
    assert [(e["date"], e["rent"], e["kind"], e["change"]) for e in out] == [("2026-10-01", 12000, "Move-In", None)]


def test_upcoming_and_eligibility():
    t = {"rent": 20000, "street": 25000, "moveIn": "2024-01-10", "lastIncrease": "", "balance": 0,
         "scheduled": {"date": "2026-11-01", "amount": 21000}, "pending": None}
    assert rev.upcoming(t) == [{"date": "2026-11-01", "rent": 21000, "source": "Cubby", "kind": "Scheduled in Cubby", "change": 1000}]
    e = rev.eligibility(t, [dict(rev.DEFAULT_STRATEGY, id="s1", name="Annual 8%")], date(2026, 10, 20))[0]
    assert e["eligible"] is False and "already scheduled in Cubby" in " ".join(e["reasons"])


# ── The endpoint ─────────────────────────────────────────────────────────────

def test_tenant_history_endpoint(client, hb):  # noqa: F811
    r = client.get("/facility-ops/revenue/tenant-history", params={"facility_id": "fac_t", "key": "lease_a1"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["fromHummingbird"] is True
    assert [(e["date"], e["rent"]) for e in d["history"]] == [("2024-01-10", 9000), ("2025-03-01", 9500), ("2026-09-15", 10000)]
    assert d["tenant"]["rent"] == 10000
    assert [n["text"] for n in d["cubbyNotes"]] == ["Asked to hold the rent until spring", "Moved in with a promo"]
    assert hb == [("notes/search", {"leaseId": "lease_a1"})]
    assert d["comments"] == []
    # B1 has Cubby's scheduled change waiting
    b1 = client.get("/facility-ops/revenue/tenant-history", params={"facility_id": "fac_t", "key": "lease_b1"}).json()
    assert b1["upcoming"][0]["kind"] == "Scheduled in Cubby"
    assert client.get("/facility-ops/revenue/tenant-history", params={"facility_id": "fac_t", "key": "nope"}).status_code == 404


def test_cubby_not_answering_costs_only_the_notes(client, hb, monkeypatch):  # noqa: F811
    def down(path, where):
        raise cubby.CubbyError(0, "Cubby could not be reached (ConnectError)")
    monkeypatch.setattr(cubby, "_post", down)
    d = client.get("/facility-ops/revenue/tenant-history", params={"facility_id": "fac_t", "key": "lease_a1"}).json()
    assert d["cubbyNotes"] == [] and "did not answer" in d["cubbyNotesError"]
    assert len(d["history"]) == 3


def test_comments_are_kept_and_taken_back_never_deleted(client, hb):  # noqa: F811
    r = client.post("/facility-ops/revenue/tenant-comments",
                    json={"facility_id": "fac_t", "key": "lease_a1", "text": "  Can't handle an increase this year  ", "hold": True})
    assert r.status_code == 201, r.text
    [c] = r.json()["comments"]
    assert (c["text"], c["hold"], c["authorEmail"], c["withdrawn"]) == ("Can't handle an increase this year", True,
                                                                         "ops.manager@greensglobal.com", False)
    assert client.post("/facility-ops/revenue/tenant-comments", json={"facility_id": "fac_t", "key": "lease_a1", "text": "   "}).status_code == 422
    # someone else cannot take it back; its author can, and it stays in the log
    client.user.update({"email": "other.manager@greensglobal.com"})
    assert client.post(f"/facility-ops/revenue/tenant-comments/{c['id']}/withdraw").status_code == 403
    client.user.update({"email": "ops.manager@greensglobal.com"})
    assert client.post(f"/facility-ops/revenue/tenant-comments/{c['id']}/withdraw").status_code == 200
    d = client.get("/facility-ops/revenue/tenant-history", params={"facility_id": "fac_t", "key": "lease_a1"}).json()
    assert [(x["text"], x["withdrawn"]) for x in d["comments"]] == [("Can't handle an increase this year", True)]
    db = SessionLocal()
    try:
        row = db.query(models.OpsTenantComment).one()
        assert (row.lease_id, row.customer_id, row.hold) == ("lease_a1", "cust_a1", True)
    finally:
        db.close()


def test_supervisors_cannot_read_or_write_comments(client, hb):  # noqa: F811
    client.user.update({"level": 2, "role": "supervisor", "email": "sup@greensglobal.com"})
    assert client.get("/facility-ops/revenue/tenant-history", params={"facility_id": "fac_t", "key": "lease_a1"}).status_code == 401
    assert client.post("/facility-ops/revenue/tenant-comments", json={"facility_id": "fac_t", "key": "lease_a1", "text": "x"}).status_code == 401
