# Teams Presence in the Contact Directory - Setup

The Contact Directory (Support > Contact Directory) shows the same green / red /
amber dot Teams itself shows next to each person, read from Microsoft Graph.
Nothing shows until the Entra app is allowed to read presence. This is a
one-time admin step in the Azure portal; no code or deploy is involved.

## What the code does

- `GET /directory/presence` (`backend/routers/directory.py`) calls Graph
  `POST /communications/getPresencesByUserId` app-only, with the same
  client-credential token every other Graph feature uses (`graph_mail.access_token`).
- One Graph call per company-wall key per 30 seconds (`cache.teams_presence`),
  whatever the number of people with the directory open. Up to 650 ids per
  call, Graph's documented maximum.
- Only people linked to a Microsoft 365 account (`nexus_employees.m365_id`,
  set by the M365 sync) get a dot.
- If Graph answers 401 / 403 the endpoint returns `{"enabled": false}`, the
  directory shows no dots, and the refusal is remembered for five minutes
  rather than retried on every poll. Administrators also get a `reason`
  naming this document.

## The permission to add (one time)

Entra app registration used by Nexus (the same app as the BFF / Mail.Send /
User.Invite.All - `AZURE_CLIENT_ID` in the backend env vars).

1. Azure portal > **Microsoft Entra ID** > **App registrations** > the Nexus app.
2. **API permissions** > **Add a permission** > **Microsoft Graph** >
   **Application permissions** (NOT Delegated).
3. Search **Presence.Read.All** > check it > **Add permissions**.
4. Press **Grant admin consent for Greens Global** (the button above the
   permissions table) > **Yes**. The Status column must read
   "Granted for Greens Global".

Nothing else: no new secret, no new redirect URI, no env var. The existing
client secret already covers the new permission the next time a token is
issued (the backend caches tokens for 45 minutes, so allow up to that long,
or restart the API to see it immediately).

## Verify

Signed in as an administrator, open `<api>/directory/presence`:

- `{"enabled": true, "presence": {"someone@greensglobal.com": {"availability": "Available", ...}}}`
  - done; dots appear in the directory within 30 seconds.
- `{"enabled": false, "reason": "The Entra app lacks the Presence.Read.All application permission..."}`
  - step 4 above was not completed, or consent was granted on a different
    app registration than `AZURE_CLIENT_ID`.
- `{"enabled": false, "reason": "Microsoft Graph is not configured ..."}`
  - `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` are missing
    in that environment's App Service settings.

## What the dots mean

| Graph availability | Dot | Label in Nexus |
|---|---|---|
| Available, AvailableIdle | green | Available |
| Busy, BusyIdle, DoNotDisturb | red | Busy / Do Not Disturb (activity: In a Call, In a Meeting, Presenting) |
| Away, BeRightBack | amber | Away / Be Right Back |
| Offline, PresenceUnknown | gray | Offline |

Presence is decoration on top of the directory's own availability (Off Today,
On Leave, Clocked In, ...), which comes from Nexus data and needs no Graph
permission. A person can be "Off Today" in Nexus and still green in Teams;
both are shown.

## Privacy note

Presence is already visible to every colleague inside Teams; the directory
shows nothing Teams does not. Nexus never stores it - the 30-second cache is
in process memory only.
