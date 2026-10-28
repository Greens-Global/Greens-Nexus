"""A performance review's Nexus Sign envelope (release review, Oct 27 2026).

  * the write routes (remind, void, holds, correct a party, copy a party's
    link) are HR's for the review's company - never the employee's, and the
    managers in the chain only view it
  * a signed review never files to the sender's or the default Egnyte folder

    python -m pytest -q test_esign_perf_review_guard.py
"""
import unittest

from test_perf_reviews import ReviewCase, U, _Req, EMP, MGR, BOSS, HR, FARHR  # noqa: F401  (sets DATABASE_URL first)

import models  # noqa: E402
from routers import esign  # noqa: E402
from routers import perf_reviews as api  # noqa: E402


class EnvelopeWriteGuard(ReviewCase):
    def shared(self):
        c, rid = self.to_hr()
        api.share_review(rid, _Req(), U(HR), self.db)
        self.db.expire_all()
        req = self.db.get(models.HrSignRequest, self.db.get(models.PerfReview, rid).sign_request_id)
        party = self.db.query(models.HrSignParty).filter_by(request_id=req.id).first()
        return req, party

    def test_managers_and_the_employee_only_view(self):
        req, party = self.shared()
        for who in (MGR, BOSS, EMP):
            self.refused(lambda: esign.remind(req.id, U(who, 3), self.db), 403)
            self.refused(lambda: esign.void_request(req.id, U(who, 3), self.db), 403)
            self.refused(lambda: esign.place_hold(req.id, esign.HoldIn(reason="x"), U(who, 3), self.db), 403)
            self.refused(lambda: esign.correct_party(req.id, party.id, esign.PartyFix(name="New Name"),
                                                     _Req(), U(who, 3), self.db), 403)
            self.refused(lambda: esign.party_link(req.id, party.id, U(who, 3), self.db), 403)
        # The chain still opens it.
        self.assertEqual(esign.get_request(req.id, U(MGR, 3), self.db)["id"], req.id)
        self.db.expire_all()
        self.assertEqual(self.db.get(models.HrSignRequest, req.id).status, "pending")

    def test_hr_of_another_company_is_not_hr_here(self):
        req, _ = self.shared()
        self.refused(lambda: esign.remind(req.id, U(FARHR, 3), self.db), 404)

    def test_hr_for_the_company_manages_it(self):
        req, _ = self.shared()
        self.assertTrue(esign.remind(req.id, U(HR, 3), self.db)["ok"])
        self.assertEqual(esign.void_request(req.id, U(HR, 3), self.db)["status"], "voided")

    def test_signed_review_never_files_to_the_sender_folder(self):
        req, _ = self.shared()
        self.assertEqual(esign._signed_folder(self.db, req), "")


if __name__ == "__main__":
    unittest.main()
