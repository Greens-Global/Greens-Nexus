"""
Teams posts carry a quiet "Sent by Nexus" line (Neil, 10/07).

Nexus posts to Teams AS a person, so a BOD/EOD or ticket message read exactly
like something they typed. Both senders now end every message with one small
grey line; a retry, or a body that already has it, is never signed twice.

    python -m unittest test_teams_signature
"""
import unittest
from unittest import mock

import teams_post


class _Resp:
    status_code = 201
    text = ""


class TeamsSignatureTests(unittest.TestCase):
    def test_signs_once(self):
        once = teams_post.with_signature("<b>End of Day</b>")
        self.assertTrue(once.startswith("<b>End of Day</b>"))
        self.assertIn("Sent by Nexus", once)
        self.assertEqual(teams_post.with_signature(once), once)
        self.assertEqual(teams_post.with_signature(None).count("Sent by Nexus"), 1)

    def test_chat_and_channel_posts_are_signed(self):
        with mock.patch.object(teams_post.httpx, "post", return_value=_Resp()) as post:
            teams_post.send_chat_message("tok", "chat1", "<p>hi</p>")
            teams_post.send_channel_message("tok", "team1", "chan1", "<p>hi</p>")
        for call in post.call_args_list:
            content = call.kwargs["json"]["body"]["content"]
            self.assertTrue(content.startswith("<p>hi</p>"))
            self.assertEqual(content.count("Sent by Nexus"), 1)


if __name__ == "__main__":
    unittest.main()
