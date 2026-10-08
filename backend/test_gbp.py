"""
Google Business Profile in Nexus (Marketing, Neil call of 10/01) - gbp.py.

Google's API is faked with responses in the shape Google documents, so this
runs with no network and before Google has approved API access:
  - the OAuth state is sealed, single-identity and expires;
  - connecting keeps the refresh token encrypted, mirrors the locations and
    reviews (stars, replies, averages);
  - a reply / edit / delete goes to Google first, then records WHO did it -
    Google shows every reply as "Response from the owner";
  - a reply Google refuses changes nothing and is logged with the reason;
  - a reply changed in Google directly loses its Nexus name on the next sync;
  - the Replied / Unreplied split, and listing edits send only what changed.

Run with: python -m unittest test_gbp
"""
import os
import tempfile
import time
import unittest
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database           # noqa: E402
import models             # noqa: E402
import gbp                # noqa: E402
import gbp_client         # noqa: E402
from gbp_client import GbpError  # noqa: E402
from routers import marketing_gbp  # noqa: E402

# The real client functions, captured before the per-test fakes replace them.
_REAL = {n: getattr(gbp_client, n) for n in ("access_token", "list_accounts")}

ACCOUNT = "accounts/111"
LOC = "locations/222"
ADMIN = "admin@greensglobal.com"
AMY = "amy@greensglobal.com"


def _review(n, stars="FIVE", reply=None, update="2026-10-01T10:00:00Z"):
    rv = {"name": f"{ACCOUNT}/{LOC}/reviews/r{n}", "reviewId": f"r{n}", "starRating": stars,
          "comment": f"Review {n}", "createTime": f"2026-09-2{n}T10:00:00Z", "updateTime": update,
          "reviewer": {"displayName": f"Customer {n}", "profilePhotoUrl": ""}}
    if reply:
        rv["reviewReply"] = {"comment": reply, "updateTime": "2026-10-02T10:00:00Z"}
    return rv


LOCATION = {"name": LOC, "title": "Greens Storage Fresno", "websiteUri": "https://greensstorage.com",
            "phoneNumbers": {"primaryPhone": "(559) 555-0100"},
            "storefrontAddress": {"addressLines": ["100 Main St"], "locality": "Fresno",
                                  "administrativeArea": "CA", "postalCode": "93721"},
            "metadata": {"placeId": "ChIJplace"}, "profile": {"description": "Self storage"}}


class _Case(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.MarketingIntegrationToken, models.MarketingGbpLocation, models.MarketingReview, models.MarketingReviewAction,
                  models.MarketingListingAction, models.MarketingGbpDaily, models.MarketingGbpKeyword,
                  models.NexusNotification, models.NexusGroup, models.NexusGroupMember, models.NexusEmployee):
            self.db.query(m).delete()
        self.db.add(models.NexusEmployee(id="e1", first_name="Amy", last_name="Lee", work_email=AMY))
        self.db.commit()
        self.reviews = [_review(1), _review(2, "TWO"), _review(3, "FOUR", reply="Thanks!")]
        self.puts, self.deletes, self.patches = [], [], []
        fakes = {
            "exchange_code": lambda code: {"refresh_token": "refresh-xyz", "access_token": "acc", "scope": "s"},
            "access_token": lambda refresh: "acc",
            "account_email": lambda tok: "nexus@kadakia.com",
            "list_accounts": lambda tok: [{"name": "accounts/999", "type": "PERSONAL"},
                                          {"name": ACCOUNT, "type": "LOCATION_GROUP", "accountName": "Greens Storage"}],
            "list_locations": lambda tok, acct: [dict(LOCATION)],
            "list_reviews": lambda tok, acct, loc: [dict(r) for r in self.reviews],
            "put_reply": self._put, "delete_reply": lambda tok, name: self.deletes.append(name),
            "update_location": lambda tok, loc, patch, mask: self.patches.append((patch, mask)) or {},
            "get_location": lambda tok, loc: {**LOCATION, "profile": {"description": "New words"},
                                              "metadata": {**LOCATION["metadata"], "hasPendingEdits": True}},
            "revoke": lambda refresh: None,
            "daily_metrics": self._daily,
            "search_keywords": lambda tok, loc, y, m: [("self storage near me", 120, False), ("greens storage", 15, True)],
            "list_media": lambda tok, acct, loc: [dict(p) for p in self.media],
            "upload_photo": self._upload,
            "list_posts": lambda tok, acct, loc: [dict(p) for p in self.posts_g],
            "create_post": self._create_post,
            "update_post": lambda tok, name, body, mask: {"name": name, **body, "createTime": "2026-10-01T10:00:00Z"},
            "delete_post": lambda tok, name: self.deletes.append(name),
            "delete_media": lambda tok, name: self.deletes.append(name),
        }
        self.media = [{"name": f"{ACCOUNT}/{LOC}/media/m1", "mediaFormat": "PHOTO",
                       "googleUrl": "https://lh3.googleusercontent.com/p/m1",
                       "createTime": "2026-01-02T10:00:00Z", "locationAssociation": {"category": "EXTERIOR"}}]
        self.posts_g, self.created, self.daily_calls = [], [], []
        for name, fn in fakes.items():
            p = mock.patch.object(gbp_client, name, fn)
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        self.db.close()

    def _put(self, tok, name, comment):
        if comment == "REFUSE":
            raise GbpError("Google said: Request contains an invalid argument.", 400)
        self.puts.append((name, comment))
        return {"comment": comment, "updateTime": "2026-10-05T12:00:00Z"}

    def _daily(self, tok, loc, start, end):
        self.daily_calls.append((start, end))
        return {"BUSINESS_IMPRESSIONS_MOBILE_MAPS": [("2026-10-01", 10), ("2026-10-02", 4)],
                "BUSINESS_IMPRESSIONS_DESKTOP_MAPS": [("2026-10-01", 5)],
                "BUSINESS_IMPRESSIONS_MOBILE_SEARCH": [("2026-10-01", 7)],
                "WEBSITE_CLICKS": [("2026-10-01", 3)], "CALL_CLICKS": [("2026-10-02", 2)],
                "BUSINESS_DIRECTION_REQUESTS": [("2026-09-25", 1)]}

    def _upload(self, tok, acct, loc, data, ctype, category):
        self.created.append(("photo", len(data), ctype, category))
        return {"name": f"{ACCOUNT}/{LOC}/media/m2", "googleUrl": "https://lh3.googleusercontent.com/p/m2",
                "createTime": "2026-10-06T10:00:00Z", "locationAssociation": {"category": category}}

    def _create_post(self, tok, acct, loc, body):
        self.created.append(("post", body))
        return {"name": f"{ACCOUNT}/{LOC}/localPosts/p9", **body, "state": "LIVE", "createTime": "2026-10-06T10:00:00Z"}

    def _connect(self):
        return gbp.connect(self.db, "auth-code", ADMIN)

    def _row(self, n):
        self.db.expire_all()
        return self.db.query(models.MarketingReview).filter(models.MarketingReview.external_id.endswith(f"/r{n}")).one()


class StateTests(_Case):
    def test_state_carries_who_and_expires(self):
        s = gbp.issue_state(ADMIN.upper())
        self.assertEqual(gbp.consume_state(s), ADMIN)
        self.assertNotIn(ADMIN, s)                          # sealed, not readable
        self.assertEqual(gbp.consume_state(s[:-4] + "AAAA"), "")
        with mock.patch.object(time, "time", return_value=time.time() + gbp.STATE_TTL + 5):
            self.assertEqual(gbp.consume_state(s), "")


class ConnectTests(_Case):
    def test_connect_keeps_the_token_encrypted_and_mirrors_everything(self):
        out = self._connect()
        self.assertEqual(out, {"locations": 1, "reviews": 3})
        conn = gbp.get_connection(self.db)
        self.assertEqual((conn.account_email, conn.account_name, conn.connected_by),
                         ("nexus@kadakia.com", ACCOUNT, ADMIN))   # the business group, not the personal account
        self.assertNotIn("refresh-xyz", conn.refresh_token_enc)
        loc = self.db.get(models.MarketingGbpLocation, LOC)
        self.assertEqual(loc.address, "100 Main St, Fresno, CA 93721")
        self.assertEqual((loc.review_count, loc.avg_rating), (3, 3.67))
        d = gbp.location_dict(loc)
        self.assertEqual(d["reviewLink"], "https://search.google.com/local/writereview?placeid=ChIJplace")
        self.assertEqual(self._row(2).rating, 2)
        st = gbp.status(self.db)
        self.assertTrue(st["connected"])
        self.assertNotIn("refresh", str(st).replace("lastSync", ""))

    def test_a_refused_sync_is_recorded_on_the_connection(self):
        self._connect()
        with mock.patch.object(gbp_client, "list_locations",
                               side_effect=GbpError("Quota exceeded for quota metric 'Requests'", 429)):
            with self.assertRaises(GbpError):
                gbp.sync(self.db, force=True)
        self.assertIn("Quota exceeded", gbp.status(self.db)["lastError"])
        http = marketing_gbp._http(GbpError("Quota exceeded for quota metric 'Requests'", 429))
        self.assertIn("has not opened Business Profile API access", http.detail)

    def test_sync_now_right_after_a_sync_is_skipped(self):
        self._connect()
        with mock.patch.object(gbp_client, "list_locations", side_effect=AssertionError("should not call Google")):
            self.assertTrue(gbp.sync(self.db)["skipped"])

    def test_a_dead_google_grant_asks_for_a_reconnect_and_never_answers_401(self):
        self._connect()
        with mock.patch.object(gbp_client, "access_token",
                               side_effect=GbpError(gbp_client.RECONNECT, 401)):
            with self.assertRaises(GbpError) as cm:
                gbp.sync(self.db, force=True)
        st = gbp.status(self.db)
        self.assertTrue(st["needsReconnect"])
        # a 401 from Nexus would read as "your Nexus session expired" in api.js
        http = marketing_gbp._http(cm.exception)
        self.assertEqual(http.status_code, 409)
        self.assertEqual(http.detail.count(gbp_client.RECONNECT), 1)

    def test_invalid_grant_from_google_becomes_the_reconnect_error(self):
        real = _REAL["access_token"]
        with mock.patch.object(gbp_client, "_send",
                               side_effect=GbpError("Google said: invalid_grant - Token has been expired or revoked.", 400)):
            with self.assertRaises(GbpError) as cm:
                real("some-dead-refresh-token")
        self.assertEqual((str(cm.exception), cm.exception.status), (gbp_client.RECONNECT, 401))

    def test_a_network_failure_is_a_gbp_error_not_a_crash(self):
        import httpx
        with mock.patch.object(httpx, "request", side_effect=httpx.ConnectTimeout("timed out")):
            with self.assertRaises(GbpError) as cm:
                _REAL["list_accounts"]("tok")
        self.assertTrue(cm.exception.transport)
        self.assertEqual(marketing_gbp._http(cm.exception).status_code, 503)

    def test_disconnect_forgets_the_token_but_keeps_the_record(self):
        self._connect()
        gbp.disconnect(self.db)
        self.assertFalse(gbp.status(self.db)["connected"])
        self.assertEqual(self.db.query(models.MarketingReview).count(), 3)


class ReplyTests(_Case):
    def setUp(self):
        super().setUp()
        self._connect()

    def test_reply_goes_to_google_then_records_who(self):
        r = self._row(1)
        out = gbp.reply(self.db, r.id, "  Thank you, Customer 1!  ", AMY)
        self.assertEqual(self.puts, [(r.external_id, "Thank you, Customer 1!")])
        self.assertEqual((out["replied"], out["repliedBy"], out["repliedByName"]), (True, AMY, "Amy Lee"))
        [h] = gbp.history(self.db, r.id)
        self.assertEqual((h["action"], h["byName"], h["ok"]), ("reply", "Amy Lee", True))

    def test_replacing_a_reply_is_an_edit(self):
        r = self._row(3)
        gbp.reply(self.db, r.id, "Thanks again!", AMY)
        self.assertEqual(gbp.history(self.db, r.id)[0]["action"], "edit")

    def test_a_refused_reply_changes_nothing_and_is_logged(self):
        r = self._row(1)
        with self.assertRaises(GbpError):
            gbp.reply(self.db, r.id, "REFUSE", AMY)
        self.assertEqual(self._row(1).reply_text, "")
        [h] = gbp.history(self.db, r.id)
        self.assertFalse(h["ok"])
        self.assertIn("invalid argument", h["error"])

    def test_blank_or_too_long_replies_never_reach_google(self):
        r = self._row(1)
        for text in ("   ", "x" * (gbp.REPLY_MAX + 1)):
            with self.assertRaises(GbpError):
                gbp.reply(self.db, r.id, text, AMY)
        self.assertEqual(self.puts, [])

    def test_a_reply_that_timed_out_but_landed_is_recorded_as_posted(self):
        r = self._row(1)
        lost = GbpError("Could not reach Google (ReadTimeout)", 503, transport=True)
        landed = {**_review(1), "reviewReply": {"comment": "Thank you!", "updateTime": "2026-10-05T12:00:00Z"}}
        with mock.patch.object(gbp_client, "put_reply", side_effect=lost),              mock.patch.object(gbp_client, "get_review", return_value=landed, create=True):
            out = gbp.reply(self.db, r.id, "Thank you!", AMY)
        self.assertEqual((out["reply"], out["repliedBy"]), ("Thank you!", AMY))
        self.assertTrue(gbp.history(self.db, r.id)[0]["ok"])

    def test_a_reply_that_timed_out_and_did_not_land_is_a_failure(self):
        r = self._row(1)
        lost = GbpError("Could not reach Google (ReadTimeout)", 503, transport=True)
        with mock.patch.object(gbp_client, "put_reply", side_effect=lost),              mock.patch.object(gbp_client, "get_review", return_value=_review(1), create=True):
            with self.assertRaises(GbpError):
                gbp.reply(self.db, r.id, "Thank you!", AMY)
        self.assertEqual(self._row(1).reply_text, "")
        self.assertFalse(gbp.history(self.db, r.id)[0]["ok"])

    def test_a_refusal_is_never_second_guessed(self):
        r = self._row(1)
        with mock.patch.object(gbp_client, "get_review", side_effect=AssertionError("must not re-read"), create=True):
            with self.assertRaises(GbpError):
                gbp.reply(self.db, r.id, "REFUSE", AMY)

    def test_delete_reply(self):
        r = self._row(3)
        gbp.delete_reply(self.db, r.id, AMY)
        self.assertEqual(self.deletes, [r.external_id])
        self.assertEqual(self._row(3).reply_text, "")
        self.assertEqual(gbp.history(self.db, r.id)[0]["action"], "delete")

    def test_sync_keeps_the_name_until_google_shows_a_different_reply(self):
        r = self._row(1)
        gbp.reply(self.db, r.id, "Thank you!", AMY)
        # Google now returns the reply Nexus posted - the name stays.
        self.reviews[0] = {**_review(1), "reviewReply": {"comment": "Thank you!", "updateTime": "2026-10-05T12:00:00Z"}}
        gbp.sync(self.db, force=True)
        self.assertEqual(self._row(1).replied_by, AMY)
        # Someone rewrote it in Google itself - nobody in Nexus can be named.
        self.reviews[0] = {**_review(1), "reviewReply": {"comment": "Edited in Google", "updateTime": "2026-10-06T09:00:00Z"}}
        gbp.sync(self.db, force=True)
        self.assertEqual((self._row(1).reply_text, self._row(1).replied_by), ("Edited in Google", ""))

    def test_replied_and_unreplied_split(self):
        out = gbp.list_reviews(self.db, replied="no")
        self.assertEqual(out["counts"], {"all": 3, "unreplied": 2, "replied": 1})
        self.assertEqual([x["reviewer"] for x in out["reviews"]], ["Customer 2", "Customer 1"])   # newest first
        self.assertEqual([x["reply"] for x in gbp.list_reviews(self.db, replied="yes")["reviews"]], ["Thanks!"])


class ListingTests(_Case):
    def setUp(self):
        super().setUp()
        self._connect()

    def test_only_what_was_sent_is_changed(self):
        out = gbp.update_listing(self.db, LOC, {"description": "New words"}, ADMIN)
        [(patch, mask)] = self.patches
        self.assertEqual(mask, ["profile.description"])
        self.assertEqual(patch, {"profile": {"description": "New words"}})
        self.assertEqual(out["description"], "New words")
        self.assertTrue(out["pendingGoogleReview"])

    def test_listing_edits_record_who_changed_what(self):
        gbp.update_listing(self.db, LOC, {"description": "New words", "phone": "(559) 555-0199"}, AMY)
        with mock.patch.object(gbp_client, "update_location",
                               side_effect=GbpError("Google said: Invalid phone number.", 400)):
            with self.assertRaises(GbpError):
                gbp.update_listing(self.db, LOC, {"phone": "nope"}, ADMIN)
        failed, done = gbp.listing_history(self.db, LOC)
        self.assertEqual((done["byName"], done["fields"], done["ok"]),
                         ("Amy Lee", ["profile.description", "phoneNumbers.primaryPhone"], True))
        self.assertEqual((failed["by"], failed["ok"]), (ADMIN, False))
        self.assertIn("Invalid phone", failed["error"])

    def test_a_failed_read_back_still_keeps_the_edit(self):
        with mock.patch.object(gbp_client, "get_location",
                               side_effect=GbpError("Could not reach Google (ReadTimeout)", 503, transport=True)):
            out = gbp.update_listing(self.db, LOC, {"website": "https://greensstorage.com/fresno"}, ADMIN)
        self.assertEqual(out["id"], LOC)
        self.assertTrue(gbp.listing_history(self.db, LOC)[0]["ok"])

    def test_nothing_or_too_long_is_refused(self):
        for changes in ({}, {"description": "x" * 751}):
            with self.assertRaises(GbpError):
                gbp.update_listing(self.db, LOC, changes, ADMIN)
        self.assertEqual(self.patches, [])

    def test_a_location_maps_to_a_nexus_property(self):
        self.assertEqual(gbp.map_facility(self.db, LOC, " Fresno Storage ")["facility"], "Fresno Storage")


class LowStarBellTests(_Case):
    def setUp(self):
        super().setUp()
        self.db.add(models.NexusGroup(id="g1", name="Marketing", allowed_modules="marketing:editor"))
        self.db.add(models.NexusGroup(id="g2", name="Viewers", allowed_modules="marketing:viewer,items:full"))
        self.db.add(models.NexusGroupMember(group_id="g1", email=AMY))
        self.db.add(models.NexusGroupMember(group_id="g2", email="viewer@greensglobal.com"))
        self.db.commit()

    def _fresh(self, n, stars):
        from datetime import datetime, timedelta, timezone
        rv = _review(n, stars)
        rv["createTime"] = (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat().replace("+00:00", "Z")
        return rv

    def _bells(self):
        self.db.expire_all()
        return self.db.query(models.NexusNotification).filter(models.NexusNotification.type == "gbp_low_review").all()

    def test_the_first_import_rings_nothing(self):
        self.reviews.append(self._fresh(7, "ONE"))
        self._connect()
        self.assertEqual(self._bells(), [])

    def test_a_new_low_review_rings_everyone_who_can_reply(self):
        self._connect()
        self.reviews += [self._fresh(8, "TWO"), self._fresh(9, "FIVE")]
        gbp.sync(self.db, force=True)
        [bell] = self._bells()
        self.assertEqual(bell.recipient, AMY)                       # editor grant, not the viewer
        self.assertIn("2-star Google review for Greens Storage Fresno", bell.title)
        self.assertIn("Review 8", bell.body)
        self.assertIn("marketing-reputation", bell.action)
        gbp.sync(self.db, force=True)                               # seen once, rung once
        self.assertEqual(len(self._bells()), 1)

    def test_an_old_low_review_surfacing_late_rings_nothing(self):
        self._connect()
        self.reviews.append({**_review(8, "ONE"), "createTime": "2026-08-01T10:00:00Z"})   # an old review
        gbp.sync(self.db, force=True)
        self.assertEqual(self._bells(), [])


class PerformanceTests(_Case):
    def test_connecting_fills_performance_keywords_and_photo_counts(self):
        self._connect()
        self.assertEqual((self.daily_calls[0][1] - self.daily_calls[0][0]).days, gbp.PERF_FIRST_DAYS - 1)
        out = gbp.performance(self.db, "", "2026-10-01", "2026-10-02")
        self.assertEqual(out["rows"][0], {"date": "2026-10-01", "mapsViews": 15, "searchViews": 7, "websiteClicks": 3,
                                          "callClicks": 0, "directionRequests": 0})
        self.assertEqual(out["rows"][1]["callClicks"], 2)
        self.assertEqual([r["date"] for r in out["prevRows"]], ["2026-09-29", "2026-09-30"])
        loc = gbp.location_dict(self.db.get(models.MarketingGbpLocation, LOC))
        self.assertEqual((loc["photoCount"], loc["lastPhotoAt"]), (1, "2026-01-02T10:00:00Z"))
        self.assertTrue(gbp.status(self.db)["perfSyncedAt"])

    def test_later_syncs_only_reread_recent_days_and_wait_six_hours(self):
        self._connect()
        conn = gbp.get_connection(self.db)
        conn.perf_synced_at = "2026-01-01T00:00:00+00:00"           # long ago
        self.db.commit()
        gbp.sync(self.db, force=True)
        self.assertEqual((self.daily_calls[1][1] - self.daily_calls[1][0]).days, gbp.PERF_REFRESH_DAYS - 1)
        gbp.sync(self.db, force=True)                               # just ran - not again
        self.assertEqual(len(self.daily_calls), 2)

    def test_a_refused_performance_api_never_stops_reviews(self):
        with mock.patch.object(gbp_client, "daily_metrics",
                               side_effect=GbpError("Google said: Business Profile Performance API has not been used", 403)):
            out = self._connect()
        self.assertEqual(out["reviews"], 3)
        st = gbp.status(self.db)
        self.assertEqual(st["lastError"], "")
        self.assertIn("Performance API", st["perfError"])

    def test_keywords_sum_across_months_and_mark_floors(self):
        self._connect()
        months = gbp._months_back(2)
        start = f"{months[1][0]:04d}-{months[1][1]:02d}-01"
        end = f"{months[0][0]:04d}-{months[0][1]:02d}-28"
        kws = gbp.performance(self.db, LOC, start, end)["keywords"]
        self.assertEqual(kws[0], {"keyword": "self storage near me", "impressions": 240, "belowThreshold": False})
        self.assertTrue(kws[1]["belowThreshold"])

    def test_a_bad_range_is_refused(self):
        for a, b in (("x", "2026-10-01"), ("2026-10-02", "2026-10-01"), ("2023-01-01", "2026-10-01")):
            with self.assertRaises(GbpError):
                gbp.performance(self.db, "", a, b)


class SummaryTests(_Case):
    def test_summary_counts_what_the_alerts_need(self):
        self.assertEqual(gbp.summary(self.db), {"connected": False})
        self._connect()
        s = gbp.summary(self.db)
        self.assertEqual((s["unreplied"], s["lowStarUnreplied"], s["overdueUnreplied"], s["reviewCount"]), (2, 1, 2, 3))
        self.assertEqual(s["rating"]["current"], 3.67)
        self.assertEqual(s["platformRatings"], [{"platform": "Google", "rating": 3.67, "reviews": 3}])
        self.assertEqual(s["stalePhotoLocations"], ["Greens Storage Fresno"])   # newest photo is from January


class PostAndPhotoTests(_Case):
    def setUp(self):
        super().setUp()
        self._connect()

    def test_a_post_goes_to_google_and_is_recorded(self):
        out = gbp.create_post(self.db, LOC, {"summary": " Fall special: first month free ", "ctaType": "LEARN_MORE",
                                             "ctaUrl": "https://greensstorage.com/fall",
                                             "photoUrl": "https://lh3.googleusercontent.com/p/m1"}, AMY)
        [(_, body)] = self.created
        self.assertEqual(body["summary"], "Fall special: first month free")
        self.assertEqual(body["callToAction"], {"actionType": "LEARN_MORE", "url": "https://greensstorage.com/fall"})
        self.assertEqual(body["media"], [{"mediaFormat": "PHOTO", "sourceUrl": "https://lh3.googleusercontent.com/p/m1"}])
        self.assertEqual((out["id"], out["state"]), ("p9", "LIVE"))
        self.assertEqual(gbp.listing_history(self.db, LOC)[0]["fields"], ["post:create"])

    def test_bad_posts_never_reach_google(self):
        for body in ({"summary": ""}, {"summary": "x" * (gbp.POST_MAX + 1)},
                     {"summary": "Hi", "ctaType": "LEARN_MORE", "ctaUrl": "greensstorage.com"},
                     {"summary": "Hi", "ctaType": "DONATE", "ctaUrl": "https://x.com"},
                     {"summary": "Hi", "photoUrl": "https://evil.example.com/p.png"}):
            with self.assertRaises(GbpError):
                gbp.create_post(self.db, LOC, body, AMY)
        self.assertEqual(self.created, [])

    def test_a_call_button_needs_no_address_and_ids_are_checked(self):
        gbp.create_post(self.db, LOC, {"summary": "Call us", "ctaType": "CALL"}, AMY)
        self.assertEqual(self.created[0][1]["callToAction"], {"actionType": "CALL"})
        gbp.delete_post(self.db, LOC, "p9", AMY)
        self.assertEqual(self.deletes, [f"{ACCOUNT}/{LOC}/localPosts/p9"])
        with self.assertRaises(GbpError):
            gbp.delete_post(self.db, LOC, "../../reviews/r1", AMY)

    def test_photos_upload_straight_to_google_within_its_limits(self):
        jpg = bytes([0xFF, 0xD8]) + b"0" * 20_000
        out = gbp.add_photo(self.db, LOC, jpg, "image/jpeg", "interior", AMY)
        self.assertEqual(self.created, [("photo", len(jpg), "image/jpeg", "INTERIOR")])
        self.assertEqual(out["category"], "INTERIOR")
        loc = self.db.get(models.MarketingGbpLocation, LOC)
        self.assertEqual((loc.photo_count, loc.last_photo_at), (2, "2026-10-06T10:00:00Z"))
        for data, ctype, cat in ((b"0" * 100, "image/jpeg", "INTERIOR"), (jpg, "image/gif", "INTERIOR"),
                                 (jpg, "image/png", "SELFIE"), (b"0" * (gbp.PHOTO_MAX_BYTES + 1), "image/png", "INTERIOR")):
            with self.assertRaises(GbpError):
                gbp.add_photo(self.db, LOC, data, ctype, cat, AMY)
        self.assertEqual(len(self.created), 1)

    def test_listing_photos_refreshes_the_counts(self):
        self.media.append({"name": f"{ACCOUNT}/{LOC}/media/m3", "mediaFormat": "PHOTO",
                           "googleUrl": "https://lh3.googleusercontent.com/p/m3", "createTime": "2026-10-05T10:00:00Z"})
        photos = gbp.list_photos(self.db, LOC)
        self.assertEqual([p["id"] for p in photos], ["m3", "m1"])
        self.assertEqual(self.db.get(models.MarketingGbpLocation, LOC).photo_count, 2)


if __name__ == "__main__":
    unittest.main()
