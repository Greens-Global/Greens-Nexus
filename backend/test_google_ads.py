"""
Google Ads in Nexus (Marketing, plan Phase 3) - google_ads.py. Read-only.

Google is faked with rows in the shape the Google Ads REST API documents
(searchStream / GAQL), so this runs with no network and before Google grants
the developer token Basic access:
  - the OAuth state is Ads-only, sealed and expiring;
  - connecting keeps the refresh token encrypted and finds the Ads accounts
    through the manager account (cancelled and manager accounts skipped);
  - a new account backfills about 14 months, later syncs re-read 30 days and
    replace that window whole;
  - the report scopes by facility through the campaign mapping, keeps every
    facility in geoRows, and paces this month's spend;
  - a Cloud project still on Test access is reported plainly, never as a crash;
  - budgets persist and are validated.

Run with: python -m unittest test_google_ads
"""
import os
import tempfile
import unittest
from datetime import date, timedelta
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import httpx              # noqa: E402

import database           # noqa: E402
import gbp                # noqa: E402
import gbp_client         # noqa: E402
import google_ads         # noqa: E402
import google_ads_client as gac  # noqa: E402
import models             # noqa: E402
import secret_box         # noqa: E402
from gbp_client import GbpError  # noqa: E402
from routers import marketing_ads  # noqa: E402

ADMIN = "admin@greensglobal.com"
MANAGER, ACCT, DIRECT = "900", "100", "300"
TODAY = date.today()
MONTH0 = TODAY.replace(day=1)
LAST_MONTH_DAY = MONTH0 - timedelta(days=3)


def _camp(cid, name, status="ENABLED", serving="SERVING", channel="SEARCH", budget=50_000_000):
    return {"campaign": {"id": cid, "name": name, "status": status, "servingStatus": serving,
                         "advertisingChannelType": channel}, "campaignBudget": {"amountMicros": str(budget)}}


def _day(cid, d, clicks, cost, impressions=1000, conversions=2.0):
    return {"campaign": {"id": cid}, "segments": {"date": d.isoformat()},
            "metrics": {"impressions": str(impressions), "clicks": str(clicks), "conversions": conversions,
                        "costMicros": str(int(cost * 1_000_000))}}


def _kw(cid, crit, text, d, clicks, cost):
    return {"campaign": {"id": cid}, "adGroupCriterion": {"criterionId": crit, "keyword": {"text": text, "matchType": "PHRASE"}},
            "segments": {"date": d.isoformat()},
            "metrics": {"impressions": "100", "clicks": str(clicks), "conversions": 1, "costMicros": str(int(cost * 1e6))}}


class _Case(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.MarketingIntegrationToken, models.MarketingAdsAccount, models.MarketingAdsCampaign,
                  models.MarketingAdsDaily, models.MarketingAdsKeyword, models.MarketingAdBudget):
            self.db.query(m).delete()
        self.db.commit()
        self.campaign_rows = {ACCT: [_camp("1", "Valley Center - Brand"), _camp("2", "Escondido - Local", status="PAUSED"),
                                     _camp("3", "Spring Sale", serving="ENDED")],
                              DIRECT: [_camp("7", "Temecula - Search")]}
        self.day_rows = {ACCT: [_day("1", TODAY, 10, 25.0), _day("2", TODAY, 4, 8.0), _day("1", LAST_MONTH_DAY, 6, 12.0)],
                         DIRECT: [_day("7", TODAY, 3, 5.0)]}
        self.kw_rows = {ACCT: [_kw("1", "11", "storage near me", TODAY, 5, 10.0), _kw("1", "11", "storage near me", TODAY, 2, 3.0),
                               _kw("2", "12", "Storage Near Me", TODAY, 1, 1.0)], DIRECT: []}
        self.windows, self.refuse = [], ""

        def campaigns(tok, cid, login=""):
            if self.refuse:
                raise GbpError(self.refuse, 403)
            return [dict(r) for r in self.campaign_rows.get(cid, [])]

        def campaign_days(tok, cid, start, end, login=""):
            self.windows.append((cid, start, end, login))
            return list(self.day_rows.get(cid, []))

        fakes_gbp = {
            "exchange_code": lambda code, redirect="": {"refresh_token": "refresh-ads", "access_token": "acc", "scope": "adwords"},
            "access_token": lambda refresh: "acc",
            "account_email": lambda tok: "nexus@kadakia.com",
            "revoke": lambda refresh: None,
        }
        fakes_ads = {
            "accessible_customers": lambda tok: [MANAGER, DIRECT],
            "customer_info": lambda tok, cid: ({"id": MANAGER, "descriptiveName": "Greens Global MCC", "manager": True}
                                               if cid == MANAGER else
                                               {"id": DIRECT, "descriptiveName": "Temecula Ads", "manager": False, "currencyCode": "USD"}),
            "client_accounts": lambda tok, m: [
                {"id": ACCT, "descriptiveName": "Greens Storage", "manager": False, "status": "ENABLED", "currencyCode": "USD", "level": 1},
                {"id": "101", "descriptiveName": "Old", "manager": False, "status": "CANCELED", "level": 1},
                {"id": "902", "descriptiveName": "Sub MCC", "manager": True, "status": "ENABLED", "level": 1}],
            "campaigns": campaigns,
            "campaign_days": campaign_days,
            "keyword_days": lambda tok, cid, s, e, login="": list(self.kw_rows.get(cid, [])),
        }
        for mod, fakes in ((gbp_client, fakes_gbp), (gac, fakes_ads)):
            for name, fn in fakes.items():
                p = mock.patch.object(mod, name, fn)
                p.start()
                self.addCleanup(p.stop)

    def tearDown(self):
        self.db.close()

    def connect(self):
        return google_ads.connect(self.db, "code", ADMIN)

    def map(self, **by_campaign):
        google_ads.map_campaigns(self.db, [{"id": k, "facility": v} for k, v in by_campaign.items()], ADMIN)


class StateTests(_Case):
    def test_ads_state_round_trips_and_a_business_profile_state_is_refused(self):
        self.assertEqual(google_ads.consume_state(google_ads.issue_state("Admin@GreensGlobal.com")), ADMIN)
        self.assertEqual(google_ads.consume_state(gbp.issue_state(ADMIN)), "")
        self.assertEqual(google_ads.consume_state("junk"), "")


class ConnectTests(_Case):
    def test_connect_keeps_the_token_sealed_and_finds_the_accounts_through_the_manager(self):
        out = self.connect()
        self.assertEqual(out["accounts"], 2)
        conn = google_ads.get_connection(self.db)
        self.assertNotIn("refresh-ads", conn.refresh_token_enc)
        self.assertEqual(secret_box.decrypt(conn.refresh_token_enc), "refresh-ads")
        self.assertEqual(conn.account_label, "Greens Global MCC")
        accts = {a.id: a for a in self.db.query(models.MarketingAdsAccount).all()}
        self.assertEqual(set(accts), {ACCT, DIRECT})              # cancelled + manager skipped
        self.assertEqual(accts[ACCT].manager_id, MANAGER)
        self.assertEqual(accts[DIRECT].manager_id, "")
        # Reports for a managed account go through the manager.
        self.assertIn((ACCT, (TODAY - timedelta(days=google_ads.FIRST_DAYS)).isoformat(), TODAY.isoformat(), MANAGER),
                      self.windows)
        st = google_ads.status(self.db)
        self.assertTrue(st["connected"])
        self.assertEqual(st["campaignCount"], 4)
        self.assertEqual(st["unmappedCount"], 4)

    def test_later_syncs_reread_thirty_days_and_replace_the_window(self):
        self.connect()
        self.day_rows[ACCT] = [_day("1", LAST_MONTH_DAY, 6, 12.0)]   # today's rows gone at Google
        google_ads.sync(self.db, force=True)
        self.assertEqual(self.windows[-2][1], (TODAY - timedelta(days=google_ads.REFRESH_DAYS)).isoformat())
        ids = {r.id for r in self.db.query(models.MarketingAdsDaily).filter_by(customer_id=ACCT)}
        self.assertEqual(ids, {f"{ACCT}|1|{LAST_MONTH_DAY.isoformat()}"})

    def test_sync_now_right_after_a_sync_is_skipped(self):
        self.connect()
        self.assertTrue(google_ads.sync(self.db)["skipped"])

    def test_test_access_is_said_plainly_and_the_connection_kept(self):
        self.refuse = gac._FRIENDLY["DEVELOPER_TOKEN_NOT_APPROVED"]
        with self.assertRaises(GbpError) as cm:
            self.connect()
        self.assertEqual(cm.exception.status, 409)
        st = google_ads.status(self.db)
        self.assertTrue(st["connected"])
        self.assertIn("Test access", st["lastError"])
        self.assertEqual(marketing_ads._http(cm.exception).status_code, 409)

    def test_no_reachable_account_is_explained(self):
        with mock.patch.object(gac, "accessible_customers", lambda tok: []):
            with self.assertRaises(GbpError) as cm:
                self.connect()
        self.assertEqual(cm.exception.status, 400)
        self.assertIn("cannot see any Google Ads account", google_ads.status(self.db)["lastError"])

    def test_a_dead_google_grant_is_a_409_never_a_401(self):
        e = GbpError(gbp_client.RECONNECT, 401)
        self.assertEqual(marketing_ads._http(e).status_code, 409)

    def test_disconnect_forgets_the_token_and_keeps_the_figures(self):
        self.connect()
        google_ads.disconnect(self.db)
        self.assertFalse(google_ads.status(self.db)["connected"])
        self.assertGreater(self.db.query(models.MarketingAdsDaily).count(), 0)
        self.assertEqual(google_ads.summary(self.db), {"connected": False})


class ReportTests(_Case):
    def setUp(self):
        super().setUp()
        self.connect()
        self.map(**{f"{ACCT}|1": "Greens Valley Center", f"{ACCT}|2": "Greens Escondido"})

    def test_report_totals_campaigns_and_every_facility(self):
        r = google_ads.report(self.db, TODAY.isoformat(), TODAY.isoformat())
        self.assertEqual(r["rows"], [{"date": TODAY.isoformat(), "impressions": 3000, "clicks": 17, "conversions": 6.0, "spend": 38.0}])
        self.assertEqual(len(r["prevRows"]), 1)
        geo = {g["location"]: g for g in r["geoRows"]}
        self.assertEqual(geo["Greens Valley Center"]["spend"], 25.0)
        self.assertEqual(geo[google_ads.UNASSIGNED]["spend"], 5.0)     # the unmapped direct account
        camps = {c["name"]: c for c in r["campaigns"]}
        self.assertEqual(camps["Escondido - Local"]["status"], "Paused")
        self.assertEqual(camps["Valley Center - Brand"]["platform"], "Google Search")
        self.assertNotIn("Spring Sale", camps)                         # ended, nothing spent in range
        kw = r["keywordRows"][0]
        self.assertEqual((kw["keyword"], kw["clicks"], kw["spend"]), ("storage near me", 8, 14.0))
        self.assertEqual(r["monthSpend"], 38.0)

    def test_one_facility_scopes_everything_but_geo(self):
        r = google_ads.report(self.db, TODAY.isoformat(), TODAY.isoformat(), "Greens Valley Center")
        self.assertEqual(r["rows"][0]["spend"], 25.0)
        self.assertEqual([c["name"] for c in r["campaigns"]], ["Valley Center - Brand"])
        self.assertEqual(r["monthSpend"], 25.0)
        self.assertEqual(len(r["geoRows"]), 3)
        self.assertEqual(r["keywordRows"][0]["clicks"], 7)

    def test_bad_ranges_are_refused(self):
        for start, end in (("nope", "2026-10-01"), ("2026-10-02", "2026-10-01"), ("2023-01-01", "2026-10-01")):
            with self.assertRaises(GbpError) as cm:
                google_ads.report(self.db, start, end)
            self.assertEqual(cm.exception.status, 422)

    def test_summary_this_month_and_last(self):
        s = google_ads.summary(self.db)
        self.assertEqual((s["monthSpend"], s["prevMonthSpend"]), (38.0, 12.0))
        self.assertEqual(s["campaigns"][0]["name"], "Valley Center - Brand")

    def test_mapping_clears_with_unassigned_and_refuses_unknown_campaigns(self):
        self.map(**{f"{ACCT}|1": google_ads.UNASSIGNED})
        row = self.db.get(models.MarketingAdsCampaign, f"{ACCT}|1")
        self.assertEqual(row.facility_name, "")
        with self.assertRaises(GbpError) as cm:
            self.map(**{"nope|9": "Greens Fairfield"})
        self.assertEqual(cm.exception.status, 404)


class BudgetTests(_Case):
    def test_budgets_persist_and_bad_ones_are_refused(self):
        out = google_ads.set_budgets(self.db, {"Greens Valley Center": "5800", "Greens Escondido": 0}, ADMIN)
        self.assertEqual(out, {"Greens Valley Center": 5800.0, "Greens Escondido": 0.0})
        self.assertEqual(self.db.get(models.MarketingAdBudget, "Greens Valley Center").updated_by, ADMIN)
        for bad in ({"Greens Fairfield": -1}, {"Greens Fairfield": "lots"}, {"": 10}, {}):
            with self.assertRaises(GbpError):
                google_ads.set_budgets(self.db, bad, ADMIN)


class ClientTests(unittest.TestCase):
    def test_search_sends_both_ids_and_flattens_the_stream(self):
        seen = {}

        def fake(method, url, **kw):
            seen.update(url=url, headers=kw["headers"], body=kw["json"])
            return httpx.Response(200, json=[{"results": [{"a": 1}]}, {"results": [{"a": 2}]}])
        with mock.patch.object(httpx, "request", fake):
            rows = gac.search("acc", ACCT, "SELECT campaign.id FROM campaign", MANAGER)
        self.assertEqual(rows, [{"a": 1}, {"a": 2}])
        self.assertTrue(seen["url"].endswith(f"/customers/{ACCT}/googleAds:searchStream"))
        self.assertEqual(seen["headers"]["login-customer-id"], MANAGER)
        self.assertNotIn("developer-token", seen["headers"])     # retired by Google on Sep 9, 2026

    def test_errors_use_googles_detail_code(self):
        body = {"error": {"code": 403, "message": "The caller does not have permission", "details": [
            {"errors": [{"errorCode": {"authorizationError": "DEVELOPER_TOKEN_NOT_APPROVED"}, "message": "test only"}]}]}}
        with mock.patch.object(httpx, "request", lambda *a, **k: httpx.Response(403, json=body)):
            with self.assertRaises(GbpError) as cm:
                gac.search("acc", ACCT, "SELECT customer.id FROM customer")
        self.assertIn("Test access", str(cm.exception))
        self.assertEqual(cm.exception.status, 403)

    def test_network_failure_is_a_503(self):
        def boom(*a, **k):
            raise httpx.ConnectTimeout("slow")
        with mock.patch.object(httpx, "request", boom):
            with self.assertRaises(GbpError) as cm:
                gac.accessible_customers("acc")
        self.assertEqual((cm.exception.status, cm.exception.transport), (503, True))

    def test_ids_are_cleaned(self):
        self.assertEqual([gac.clean_id(x) for x in ("123-456-7890", "customers/42", "abc")], ["1234567890", "42", ""])


if __name__ == "__main__":
    unittest.main()
