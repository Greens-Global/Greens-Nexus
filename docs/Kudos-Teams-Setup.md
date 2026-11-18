# Kudos on Teams - Setup

Kudos post to one Teams channel per company and come back both ways
(Neil, 11/12/2026):

- **Out:** a kudos is posted as its sender into the company's channel,
  @mentioning the recipient, with an Open in Nexus link.
- **Back:** a reaction or a thread reply there from a Nexus colleague of
  that company becomes that person's thanks in Nexus. The recipient's
  reaction is their Say Thanks. Taking a reaction off in Teams takes the
  thanks back (never the recipient's).
- **Out again:** a thanks added in Nexus puts a clap on the post as that
  person (and, in a channel, their note as a reply). Take Back takes the
  clap off; a reply already posted stays in Teams.

Code: `backend/perf_kudos_teams.py` (the rules), `backend/perf_feedback.py`
(the post), `backend/routers/teams_webhook.py` (Graph notifications).

## 1. Pick the channel (per company)

Settings > Performance > **Kudos on Teams** (Super Administrators only).
Pick "Every company" for the default, or a company for its own. Channel >
Bind A Channel lists the teams you are in. A channel in the company's
all-staff team works best. Everyone who sends kudos must be a member of
that team (and of the channel, if it is private) for the post to go out as
them; otherwise it goes out as one of `NEXUS_FEEDBACK_CHAT_POSTERS`.

A company that only had the old chat id keeps posting to that chat until a
channel is picked.

## 2. Grant the read permissions (one time)

Posting already works with the existing permissions. Reading reactions and
replies back needs three more DELEGATED Graph permissions on the Nexus Entra
app (`AZURE_CLIENT_ID`):

1. Azure portal > **Microsoft Entra ID** > **App registrations** > the Nexus app.
2. **API permissions** > **Add a permission** > **Microsoft Graph** >
   **Delegated permissions**.
3. Check **ChannelMessage.Read.All**, **Chat.Read** and **User.ReadBasic.All**
   > **Add permissions**.
4. **Grant admin consent for Greens Global** > **Yes**.
   ChannelMessage.Read.All needs it.

Until consent is granted the read-back quietly waits. Each kudos keeps the
reason in `hr_perf_kudos.teams_post.error`. Posts and the claps still go out.

## 3. Change notifications (automatic)

On Azure the API's public address comes from `WEBSITE_HOSTNAME`
(`NEXUS_API_BASE` overrides it). For every channel with a kudos post under
30 days old, Nexus keeps a Graph subscription to
`<API>/webhooks/teams/kudos`. Each subscription lasts 55 minutes and is
renewed with 20 minutes left. A reaction or reply then shows in Nexus within
seconds.

Polling is the backstop, in case a notification is lost or a subscription
could not be made:

| Post age | Read every |
|---|---|
| Under a day | 5 minutes |
| Under a week | 30 minutes |
| Under 30 days | 3 hours |
| 30 days or more | Never |

Without a public https address (a laptop) only polling runs.

## 4. Release steps (dev and prod)

```sql
ALTER TABLE teams_user_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams_subscriptions ENABLE ROW LEVEL SECURITY;
```

Both are also in `main.py`'s Postgres migration list. Run `get_advisors`
afterwards.

## Switching it off

Workflows > Automations > **Kudos on Teams** stops the read-back and the
subscription renewals; nothing else changes. Posting is the Ticket Teams
Messages queue, as before.
