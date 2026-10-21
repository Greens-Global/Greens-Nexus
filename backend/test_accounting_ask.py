"""Accounting -> Reporting -> AMA, Ask My Accountant (Neil, 10/15) - as tests.

The AMA accounts found by title (or picked by an editor), the AMA-account
lines read from the ledger and merged with the questions, reclass detection,
asking / replying / resolving with the status moving Open -> Answered ->
Resolved, notifications to the right person and updated in place (one per
thread per person), the accountant check, viewer vs editor, and entity scope
(another entity's question is a 404). The accounting service is replaced by a
recorder.

    python -m pytest test_accounting_ask.py -q
"""
import json
import os
import unittest
import uuid

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models
from routers import accounting, accounting_ask as ask

models.Base.metadata.create_all(bind=database.engine)

EDITOR = "editor.ask.test@greensglobal.com"        # accounting:editor
VIEWER = "viewer.ask.test@greensglobal.com"        # accounting:viewer - asks
ACCT = "accountant.ask.test@greensglobal.com"      # accounting:viewer - answers
LIMITED = "limited.ask.test@greensglobal.com"      # accounting:viewer, entity 56000 only
NOACCESS = "noaccess.ask.test@greensglobal.com"    # on the People list, no Accounting
EVERYONE = (EDITOR, VIEWER, ACCT, LIMITED, NOACCESS)
GROUPS = {"grp-ask-test-e": ("accounting:editor", (EDITOR,)), "grp-ask-test-v": ("accounting:viewer", (VIEWER, ACCT, LIMITED))}
ENTITIES = [
    {"code": "15000", "name": "Greens Escondido, LLC.", "parent_code": None},
    {"code": "56000", "name": "MCD Services, Inc.", "parent_code": None},
]
CHART = [("11000", "Chase Checking"), ("61000", "Repairs"), ("99999", "Ask My Accountant"), ("99998", "Suspense - Bank Feed")]


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


def ln(line_id, location="15000", account="99999", debit=125.0, credit=0.0, day="2026-09-15", entry="GJ-100"):
    return {"line_id": line_id, "entry_id": str(uuid.uuid5(uuid.NAMESPACE_URL, entry)), "entry_no": entry, "entry_date": day,
            "location": location, "location_name": location, "gl_code": account, "account_name": dict(CHART).get(account, ""),
            "description": f"Line {line_id}", "memo": "", "debit": debit, "credit": credit, "journal": "GJ", "vendor_name": "Home Depot"}


class PureTests(unittest.TestCase):
    def test_titles(self):
        self.assertTrue(ask.is_ama_title("Ask My Accountant"))
        self.assertTrue(ask.is_ama_title("ASK ACCOUNTANT - review"))
        self.assertTrue(ask.is_ama_title("Suspense Account"))
        self.assertFalse(ask.is_ama_title("Accounts Payable"))

    def test_effective_accounts(self):
        chart = ask.chart_of({"rows": [{"account_no": c, "title": t} for c, t in CHART] + [{"account_no": "99999", "title": "dup"}]})
        self.assertEqual([a["code"] for a in chart], ["11000", "61000", "99998", "99999"])
        self.assertEqual([a["code"] for a in ask.effective_accounts([], chart)], ["99998", "99999"])
        self.assertEqual(ask.effective_accounts(["61000"], chart), [{"code": "61000", "title": "Repairs"}])

    def test_reclassed(self):
        t = {"accountNo": "99999", "date": "2026-09-15", "entityCode": "15000", "lineId": "L1", "entryNo": "GJ-1", "amount": 10.0}
        read = {"ok": True, "accounts": {"99999"}, "from": "2026-01-01", "to": "2026-12-31", "entities": None, "ids": {"L1"}, "keys": set()}
        self.assertFalse(ask.reclassed(t, read))
        self.assertTrue(ask.reclassed(t, {**read, "ids": set()}))
        self.assertFalse(ask.reclassed(t, {**read, "ids": set(), "keys": {ask.line_key("GJ-1", "99999", 10.0, "2026-09-15")}}))   # new line id, same line
        self.assertIsNone(ask.reclassed(t, {**read, "ok": False}))
        self.assertIsNone(ask.reclassed(t, {**read, "accounts": {"99998"}}))
        self.assertIsNone(ask.reclassed(t, {**read, "from": "2026-10-01"}))
        self.assertIsNone(ask.reclassed(t, {**read, "entities": {"56000"}}))


class PeriodAndColumnsTests(unittest.TestCase):
    """Oct 22: the period is the line's date for questions too (Urmi), and the
    line memo, Department, Vendor and Custom travel with every row (Priyanka)."""

    def test_split_period_across_years(self):
        threads = [{"date": "2025-03-04", "status": "Open"}, {"date": "2025-12-31", "status": "Resolved"},
                   {"date": "2026-09-01", "status": "Open"}, {"date": "2026-09-30", "status": "Answered"},
                   {"date": "2026-10-01", "status": "Open"}, {"date": "", "status": "Open"}]
        inside, out = ask.split_period(threads, "2026-09-01", "2026-09-30")
        self.assertEqual([t["date"] for t in inside], ["2026-09-01", "2026-09-30", ""])
        self.assertEqual(out, {"count": 3, "open": 2, "earliest": "2025-03-04", "latest": "2026-10-01"})
        inside, out = ask.split_period(threads, "2025-01-01", "2026-12-31")
        self.assertEqual((len(inside), out["count"]), (6, 0))

    def test_line_dims(self):
        r = {"department": "200", "department_name": "Operations", "vendor_id": "V00412", "vendor_name": "Amazon Marketplace",
             "project_id": "P7", "project_name": "Escondido"}
        self.assertEqual(ask.line_dims(r), {"department": "200 Operations", "vendor": "V00412 Amazon Marketplace", "custom": "P7 Escondido"})
        self.assertEqual(ask.line_dims({**r, "custom_id": "C1", "custom_name": "Property A"})["custom"], "C1 Property A")
        self.assertEqual(ask.line_dims({}), {"department": "", "vendor": "", "custom": ""})

    def test_fill_from_lines_only_fills_blanks(self):
        line = {**ask.line_out(ln("L1")), "memo": "Charge Card Transaction - AMAZON", "department": "200 Ops"}
        t = {"lineId": "L1", "entryNo": "GJ-100", "accountNo": "99999", "amount": 125.0, "date": "2026-09-15", "memo": "", "department": "Kept", "vendor": "", "custom": ""}
        ask.fill_from_lines([t], [line])
        self.assertEqual((t["memo"], t["department"]), ("Charge Card Transaction - AMAZON", "Kept"))


class EndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(main.app)
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            for gid, (mods, members) in GROUPS.items():
                db.add(models.NexusGroup(id=gid, name=gid, allowed_modules=mods))
                for em in members:
                    db.add(models.NexusGroupMember(group_id=gid, email=em))
            for em in EVERYONE:
                db.add(models.NexusEmployee(id=str(uuid.uuid4()), first_name=em.split(".")[0].title(), last_name="Test", work_email=em, status="active"))
            db.add(models.NexusAccessScope(id=str(uuid.uuid4()), email=LIMITED, module_id="accounting", scope_type="ledger", scope_id="56000"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        accounting._ACCT_CACHE.clear()
        self.calls = []
        self.lines = [ln("L1"), ln("L2", debit=0.0, credit=40.0, entry="GJ-101"), ln("L3", location="56000", entry="GJ-102"),
                      ln("L4", account="61000", entry="GJ-103")]

        async def fake_get(path, params):
            clean = {k: v for k, v in params.items() if v is not None}
            self.calls.append((path, clean))
            if path.endswith("/reports/locations"):
                return {"ok": True, "entities": ENTITIES}
            if path.endswith("/reports/buckets"):
                return {"ok": True, "rows": [{"bucket": "total", "account_no": c, "title": t, "debit": 1, "credit": 0} for c, t in CHART]}
            if path.endswith("/search"):
                locs = {clean["location"]} if "location" in clean else set((clean.get("locations") or "").split(",")) - {""}
                rows = [r for r in self.lines if r["gl_code"] == clean.get("account") and (not locs or r["location"] in locs)
                        and clean.get("from", "") <= r["entry_date"] <= clean.get("to", "9999")]
                off, lim = clean.get("offset", 0), clean.get("limit", 100)
                return {"ok": True, "rows": rows[off:off + lim], "total": len(rows)}
            return {"ok": True}

        self._get, accounting._acct_get = accounting._acct_get, fake_get
        self._base, self._key = accounting._ACCT_BASE, accounting._ACCT_KEY
        accounting._ACCT_BASE, accounting._ACCT_KEY = "http://accounting.invalid", "test-key"

    def tearDown(self):
        accounting._acct_get = self._get
        accounting._ACCT_BASE, accounting._ACCT_KEY = self._base, self._key
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            ids = [t.id for t in db.query(models.AccountingAmaThread).filter(models.AccountingAmaThread.asked_by.in_(EVERYONE)).all()]
            if ids:
                db.query(models.AccountingAmaMessage).filter(models.AccountingAmaMessage.thread_id.in_(ids)).delete(synchronize_session=False)
                db.query(models.AccountingAmaThread).filter(models.AccountingAmaThread.id.in_(ids)).delete(synchronize_session=False)
            db.query(models.NexusNotification).filter(models.NexusNotification.type == ask.NOTIFY_TYPE,
                                                      models.NexusNotification.recipient.in_(EVERYONE)).delete(synchronize_session=False)
            db.query(models.AccountingAmaSetting).filter(models.AccountingAmaSetting.updated_by.in_(EVERYONE)).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_(tuple(GROUPS))).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id.in_(tuple(GROUPS))).delete(synchronize_session=False)
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email.in_(EVERYONE)).delete(synchronize_session=False)
            db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email.in_(EVERYONE)).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _notes(self, recipient):
        db = database.SessionLocal()
        try:
            return [(n.title, n.body, n.read_by, n.ref_id, n.action) for n in db.query(models.NexusNotification)
                    .filter(models.NexusNotification.type == ask.NOTIFY_TYPE, models.NexusNotification.recipient == recipient).all()]
        finally:
            db.close()

    def _ask(self, line_id="L1", entity="15000", account="99999", question="Where does this go?", accountant=ACCT):
        return self.client.post("/accounting/ask/threads", json={
            "entityCode": entity, "question": question, "accountant": accountant, "lineId": line_id, "entryNo": "GJ-100",
            "accountNo": account, "accountTitle": dict(CHART).get(account, ""), "date": "2026-09-15", "debit": 125.0, "credit": 0.0,
            "description": f"Line {line_id}", "memo": "Snapshot memo", "entryId": str(uuid.uuid4())})

    # ── AMA accounts and lines ──
    def test_accounts_found_by_title_and_lines_listed(self):
        _as(VIEWER)
        s = self.client.get("/accounting/ask/settings").json()
        self.assertEqual([a["code"] for a in s["accounts"]], ["99998", "99999"])
        self.assertTrue(s["autoDetected"])
        r = self.client.get("/accounting/ask/items?from=2026-01-01&to=2026-12-31")
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertEqual(sorted(x["lineId"] for x in d["rows"]), ["L1", "L2", "L3"])       # never L4 (Repairs)
        self.assertEqual(d["counts"], {"Open": 3, "Answered": 0, "Resolved": 0, "All": 3})
        l2 = next(x for x in d["rows"] if x["lineId"] == "L2")
        self.assertEqual((l2["kind"], l2["amount"], l2["status"], l2["party"]), ("line", -40.0, "Open", "Home Depot"))
        searched = {c[1]["account"] for c in self.calls if c[0].endswith("/search")}
        self.assertEqual(searched, {"99998", "99999"})

    def test_the_period_picker_from_date_is_honored(self):
        """`?from=` used to be dropped (no Query alias), so a period that ended
        more than a year ago failed as "from after to"."""
        _as(VIEWER)
        r = self.client.get("/accounting/ask/items?from=2024-01-01&to=2024-12-31")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.client.get("/accounting/ask/items?from=2026-12-31&to=2026-01-01").status_code, 400)

    def test_questions_follow_the_period_too(self):
        """Urmi (10/15): 09/01-09/30/2026 still listed lines from 2025 - the
        questions showed whatever their date. A question on a 2025 line is
        counted under `outside`, not listed, and the counts follow."""
        _as(VIEWER)
        self.lines.append(ln("L7", day="2025-06-02", entry="GJ-077"))
        r = self.client.post("/accounting/ask/threads", json={
            "entityCode": "15000", "question": "Old one?", "accountant": ACCT, "lineId": "L7", "entryNo": "GJ-077",
            "accountNo": "99999", "date": "2025-06-02", "debit": 125.0, "credit": 0.0, "department": "200 Ops", "vendor": "V1 Amazon", "custom": "P7"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual((r.json()["department"], r.json()["vendor"], r.json()["custom"]), ("200 Ops", "V1 Amazon", "P7"))
        d = self.client.get("/accounting/ask/items?from=2026-09-01&to=2026-09-30").json()
        self.assertTrue(all("2026-09-01" <= x["date"] <= "2026-09-30" for x in d["rows"]), d["rows"])
        self.assertEqual(d["counts"]["All"], len(d["rows"]))
        self.assertEqual((d["outside"]["count"], d["outside"]["open"], d["outside"]["earliest"]), (1, 1, "2025-06-02"))
        d = self.client.get("/accounting/ask/items?from=2025-01-01&to=2026-12-31").json()
        old = next(x for x in d["rows"] if x["lineId"] == "L7")
        self.assertEqual((old["kind"], old["question"], d["outside"]["count"]), ("thread", "Old one?", 0))

    def test_editor_picks_the_accounts(self):
        _as(VIEWER)
        self.assertEqual(self.client.put("/accounting/ask/settings", json={"accounts": ["61000"]}).status_code, 403)
        self.assertEqual(self.client.get("/accounting/ask/chart").status_code, 403)
        _as(EDITOR)
        chart = self.client.get("/accounting/ask/chart").json()["accounts"]
        self.assertEqual([a["code"] for a in chart if a["detected"]], ["99998", "99999"])
        r = self.client.put("/accounting/ask/settings", json={"accounts": ["61000"], "accountants": {"": [ACCT], "15000": [EDITOR]}})
        self.assertEqual(r.status_code, 200, r.text)
        s = r.json()
        self.assertEqual((s["configured"], s["autoDetected"]), (["61000"], False))
        self.assertEqual(s["accountants"]["15000"][0]["email"], EDITOR)
        rows = self.client.get("/accounting/ask/items?from=2026-01-01&to=2026-12-31").json()["rows"]
        self.assertEqual([x["lineId"] for x in rows], ["L4"])
        self.assertEqual(self.client.put("/accounting/ask/settings", json={"accounts": ["bad code!"]}).status_code, 400)
        self.assertEqual(self.client.put("/accounting/ask/settings", json={"accountants": {"": ["nobody.ask.test@greensglobal.com"]}}).status_code, 400)
        # A limited person sees only their entities' accountants.
        _as(LIMITED)
        self.assertNotIn("15000", self.client.get("/accounting/ask/settings").json()["accountants"])

    def test_limited_editor_saves_with_an_every_entity_default_in_place(self):
        """Neil's review (Oct 20): once an Every Entity ('') accountant existed,
        an editor limited to certain entities could not save at all - the
        screen re-sends '' (unchanged, or as []) and that was a 403. An
        unchanged or empty '' entry is now ignored, never applied; a real
        change to it is still refused."""
        _as(EDITOR)
        self.assertEqual(self.client.put("/accounting/ask/settings", json={"accountants": {"": [ACCT]}}).status_code, 200)
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroupMember(group_id="grp-ask-test-e", email=LIMITED))     # LIMITED becomes an editor, still 56000 only
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        _as(LIMITED)
        for default in ([ACCT], []):
            r = self.client.put("/accounting/ask/settings", json={"accountants": {"": default, "56000": [VIEWER]}})
            self.assertEqual(r.status_code, 200, (default, r.text))
            s = r.json()
            self.assertEqual([p["email"] for p in s["accountants"]["56000"]], [VIEWER])
            self.assertEqual([p["email"] for p in s["accountants"][""]], [ACCT], "the default is untouched")
        r = self.client.put("/accounting/ask/settings", json={"accountants": {"": [VIEWER], "56000": [VIEWER]}})
        self.assertEqual(r.status_code, 403, "a real change to the default still takes unlimited access")
        self.assertEqual(self.client.put("/accounting/ask/settings", json={"accountants": {"15000": [VIEWER]}}).status_code, 403)
        _as(EDITOR)
        self.assertEqual([p["email"] for p in self.client.get("/accounting/ask/settings").json()["accountants"][""]], [ACCT])

    # ── Questions ──
    def test_ask_reply_resolve_with_notifications_in_place(self):
        _as(VIEWER)
        r = self._ask()
        self.assertEqual(r.status_code, 201, r.text)
        t = r.json()
        self.assertEqual((t["status"], t["source"], t["accountant"], t["askedBy"], t["memo"]), ("Open", "ama", ACCT, VIEWER, "Snapshot memo"))
        self.assertEqual([m["kind"] for m in t["messages"]], ["question"])
        notes = self._notes(ACCT)
        self.assertEqual(len(notes), 1)
        self.assertIn("Where does this go?", notes[0][1])
        self.assertEqual(notes[0][3], t["id"])
        # The bell opens the AMA tab on THIS question (Priyanka, 10/15).
        self.assertEqual(json.loads(notes[0][4]), {"view": "accounting", "sub": "ama", "label": "Open AMA", "amaThreadId": t["id"]})
        self.assertEqual(self._notes(VIEWER), [])                # never to the person acting

        # The accountant answers: Answered, the asker hears.
        _as(ACCT)
        db = database.SessionLocal()
        try:
            db.query(models.NexusNotification).filter(models.NexusNotification.recipient == ACCT).update({"read_by": ACCT})
            db.commit()
        finally:
            db.close()
        r = self.client.post(f"/accounting/ask/threads/{t['id']}/messages", json={"body": "Repairs, 61000."})
        self.assertEqual(r.json()["status"], "Answered")
        self.assertEqual(len(self._notes(VIEWER)), 1)
        self.assertIn("answered", self._notes(VIEWER)[0][1])

        # The asker writes again: Open, the accountant's one notification is updated and unread again.
        _as(VIEWER)
        r = self.client.post(f"/accounting/ask/threads/{t['id']}/messages", json={"body": "Which property?"})
        self.assertEqual(r.json()["status"], "Open")
        notes = self._notes(ACCT)
        self.assertEqual(len(notes), 1)
        self.assertIn("Which property?", notes[0][1])
        self.assertEqual(notes[0][2], "")

        _as(ACCT)
        self.client.post(f"/accounting/ask/threads/{t['id']}/messages", json={"body": "Escondido."})
        r = self.client.post(f"/accounting/ask/threads/{t['id']}/resolve", json={"movedToAccount": "61000"})
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertEqual((d["status"], d["movedToAccount"], d["resolvedBy"], d["replies"]), ("Resolved", "61000", ACCT, 3))
        self.assertEqual(d["messages"][-1]["kind"], "event")
        notes = self._notes(VIEWER)
        self.assertEqual(len(notes), 1)
        self.assertIn("Resolved", notes[0][0])
        self.assertIn("61000", notes[0][1])
        self.assertEqual(self.client.post(f"/accounting/ask/threads/{t['id']}/resolve", json={"movedToAccount": "not a gl!"}).status_code, 400)

        items = self.client.get("/accounting/ask/items?from=2026-01-01&to=2026-12-31").json()
        self.assertEqual(items["counts"]["Resolved"], 1)
        self.assertEqual(sum(1 for x in items["rows"] if x["lineId"] == "L1"), 1)      # the line shows once, as its question

    def test_one_thread_per_open_line(self):
        _as(VIEWER)
        a = self._ask().json()
        _as(EDITOR)
        r = self._ask(question="Also - is this capitalized?")
        self.assertEqual(r.status_code, 201)
        self.assertEqual((r.json()["id"], r.json()["merged"]), (a["id"], True))
        self.assertEqual(len(r.json()["messages"]), 2)
        self.assertEqual(len(self._notes(ACCT)), 1)

    def test_accountant_must_be_able_to_see_it(self):
        _as(VIEWER)
        self.assertEqual(self._ask(accountant=NOACCESS).status_code, 400)
        self.assertEqual(self._ask(accountant="stranger.ask.test@greensglobal.com").status_code, 400)
        self.assertEqual(self._ask(accountant=LIMITED).status_code, 400)      # limited to 56000, the line is 15000
        self.assertEqual(self._ask(question=" ").status_code, 400)
        self.assertEqual(self._ask(line_id="L3", entity="56000", accountant=LIMITED).status_code, 201)

    def test_viewer_vs_editor(self):
        _as(VIEWER)
        t = self._ask().json()
        _as(LIMITED)
        self.assertEqual(self.client.post(f"/accounting/ask/threads/{t['id']}/resolve", json={}).status_code, 404)
        # Another viewer may reply, not resolve; an editor may resolve anything.
        db = database.SessionLocal()
        try:
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email == LIMITED).delete()
            db.commit()
        finally:
            db.close()
        r = self.client.post(f"/accounting/ask/threads/{t['id']}/messages", json={"body": "Same question here."})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(self._notes(VIEWER)), 1)                 # the asker hears about a third person's reply
        self.assertEqual(self.client.post(f"/accounting/ask/threads/{t['id']}/resolve", json={}).status_code, 403)
        self.assertEqual(self.client.put(f"/accounting/ask/threads/{t['id']}/accountant", json={"accountant": EDITOR}).status_code, 403)
        _as(EDITOR)
        self.assertEqual(self.client.post(f"/accounting/ask/threads/{t['id']}/resolve", json={}).json()["status"], "Resolved")
        self.assertEqual(self.client.post(f"/accounting/ask/threads/{t['id']}/reopen").json()["status"], "Open")
        r = self.client.put(f"/accounting/ask/threads/{t['id']}/accountant", json={"accountant": EDITOR})
        self.assertEqual(r.json()["accountant"], EDITOR)

    def test_entity_scope(self):
        _as(VIEWER)
        theirs = self._ask().json()
        _as(LIMITED)
        mine = self._ask(line_id="L3", entity="56000").json()
        self.assertEqual(self.client.get(f"/accounting/ask/threads/{theirs['id']}").status_code, 404)
        self.assertEqual(self.client.post(f"/accounting/ask/threads/{theirs['id']}/messages", json={"body": "x"}).status_code, 404)
        self.assertEqual(self.client.get(f"/accounting/ask/threads/{mine['id']}").status_code, 200)
        self.assertEqual(self._ask(line_id="L2").status_code, 403)                       # asking on 15000
        self.assertEqual(self.client.get("/accounting/ask/items?entity=15000").status_code, 403)
        rows = self.client.get("/accounting/ask/items?from=2026-01-01&to=2026-12-31").json()["rows"]
        self.assertEqual({x["entityCode"] for x in rows}, {"56000"})
        self.assertEqual([x["id"] for x in rows if x["kind"] == "thread"], [mine["id"]])
        self.assertEqual({c[1].get("location") for c in self.calls if c[0].endswith("/search")}, {"56000"})

    def test_reclassed_line(self):
        _as(VIEWER)
        t = self._ask().json()
        items = self.client.get("/accounting/ask/items?from=2026-01-01&to=2026-12-31").json()
        self.assertFalse(next(x for x in items["rows"] if x["id"] == t["id"])["reclassed"])
        # Reclassed in Intacct: L1 now sits on Repairs.
        self.lines[0] = ln("L1", account="61000")
        accounting._ACCT_CACHE.clear()
        items = self.client.get("/accounting/ask/items?from=2026-01-01&to=2026-12-31").json()
        row = next(x for x in items["rows"] if x["id"] == t["id"])
        self.assertTrue(row["reclassed"])
        self.assertTrue(self.client.get(f"/accounting/ask/threads/{t['id']}").json()["reclassed"])     # kept
        # A read that did not cover it changes nothing.
        self.client.get("/accounting/ask/items?from=2026-10-01&to=2026-12-31")
        self.assertTrue(self.client.get(f"/accounting/ask/threads/{t['id']}").json()["reclassed"])
        # One click resolves it (the asker).
        r = self.client.post(f"/accounting/ask/threads/{t['id']}/resolve", json={"movedToAccount": "61000"})
        self.assertEqual(r.json()["status"], "Resolved")
        self.assertIn("reclassed", r.json()["messages"][-1]["body"])

    def test_ledger_down_still_lists_questions(self):
        _as(VIEWER)
        t = self._ask().json()

        async def down(path, params):
            if path.endswith("/reports/locations"):
                return {"ok": True, "entities": ENTITIES}
            from fastapi import HTTPException
            raise HTTPException(status_code=424, detail="The accounting app did not answer.")
        accounting._acct_get = down
        d = self.client.get("/accounting/ask/items").json()
        self.assertEqual([x["id"] for x in d["rows"]], [t["id"]])
        self.assertIn("did not answer", d["ledgerError"])
        self.assertFalse(d["rows"][0]["reclassed"])


if __name__ == "__main__":
    unittest.main()
