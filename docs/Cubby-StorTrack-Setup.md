# Cubby StorTrack Setup (Operations > Market Rates)

StorTrack is a competitor rate feed (normally about $400 a month) that Cubby
includes in our plan. Cubby lands it in its Google BigQuery warehouse as
`cubby-partner-data.analytics.stor_track`, filtered to our org (Greens
Storage). Nexus reads it with a Google service account and imports it into
Operations > Market Rates (`backend/cubby_warehouse.py`,
`backend/ops_stortrack.py`).

Until the key below is set, nothing runs: the Market Rates tab shows
"StorTrack not connected yet" and everything else on it works as before.

## What Nexus does with it

- Every competitor store StorTrack lists around one of our facilities becomes
  (or is matched to) a competitor on that facility's Market Rates tab, keyed
  by store name + street + ZIP. A competitor a manager removed stays removed.
- Each price becomes a rate observation with the source **StorTrack**, the
  date StorTrack collected it, the unit size and type (climate controlled,
  drive-up, elevator, space type) and the regular / online / promo prices.
- The **regular price** is the competitor's rate, the same standard rate the
  website reader and staff record, so the market low / median / high and the
  suggested rate compare like with like. Online and promo prices are kept
  beside it. (When StorTrack has no regular price for a row, the online price
  stands in.)
- The import runs every 6 hours (`NEXUS_STORTRACK_HOURS`, 2 to 24) on the
  deployed API, riding the Cubby sync loop, and reads only the days since the
  last run (plus a 3-day overlap for late rows). Managers can also press
  **Sync StorTrack Now** on the tab.

## Setup steps

There are two ways in. Both read the same table; pick one.

- **Option A - a signed-in Google account (fastest, no new ask to Cubby).**
  Cubby already granted warehouse access to our people's Google accounts
  (Nathaniel, Sep 18 2026). Nexus can use one of them.
  It acts as that person, so it stops working if their Google account or
  Cubby access goes away. Move to Option B when convenient.
- **Option B - a service account (sturdier, needs one more grant from Cubby).**

### Option A - a signed-in Google account

1. **Google Cloud project.** In console.cloud.google.com, signed in with the
   Google account Cubby granted: create a project, for example "Cubby Data". Enable
   the **BigQuery API** (APIs & Services > Library). Queries are billed here;
   typical use is pennies a month. This is Step 1 of Cubby's own guide.
2. **Consent screen.** APIs & Services > OAuth consent screen: User type
   **External**, fill in only the required fields, then **Publish App** (status
   "In production"). Leave it in "Testing" and Google expires the login after
   7 days. An unverified app is fine for our own use: at sign-in click
   Advanced > Go to (app).
3. **OAuth client.** APIs & Services > Credentials > Create Credentials >
   OAuth client ID > Application type **Desktop app** > Create >
   **Download JSON**. Keep that file private.
4. **Sign in once.** On a computer with the repo:

   ```
   python backend/scripts/cubby_bq_login.py --client <downloaded client JSON> --project <project id>
   ```

   The browser opens, you sign in with the Google account Cubby granted, and the
   script saves `cubby-bq-login.json` in your home folder and runs a test
   query ("Works. StorTrack rows in the last 30 days: ..."). The file is a
   password: never commit, email or paste it.
5. **Put it on the API servers.** Set `CUBBY_BQ_CREDENTIALS_JSON` on BOTH
   `greens-nexus-api-dev` and `greens-nexus-api` to the file's contents (step
   3 below), for example without printing it:

   ```
   az webapp config appsettings set -g greens-nexus-rg -n <app> --settings CUBBY_BQ_CREDENTIALS_JSON="$(cat ~/cubby-bq-login.json)" -o none
   ```

   Then check it as in step 4 below.

### Option B, step 1. Create the service account (our Google Cloud project)

1. Open the Google Cloud console and pick (or create) a Greens project for
   Nexus, for example `greens-nexus`. Enable the **BigQuery API** in it.
2. IAM & Admin > Service Accounts > **Create Service Account**. Name it
   `nexus-cubby-warehouse`. Its email looks like
   `nexus-cubby-warehouse@greens-nexus.iam.gserviceaccount.com`.
3. IAM & Admin > IAM > **Grant Access** in OUR project: give that service
   account the **BigQuery Job User** role (`roles/bigquery.jobUser`). Query
   jobs run, and are billed, in our project; without this role every query
   fails with "Access Denied: User does not have bigquery.jobs.create".
4. Service account > Keys > **Add Key > Create New Key > JSON**. A `.json`
   file downloads. Treat it like a password: never commit it, never paste it
   in chat or email.

### Option B, step 2. Ask Cubby to grant access

Email Cubby (Kristen Brigagliano / Nathaniel) the service account's **email
address** (never the key) and ask them to grant it read access (BigQuery Data
Viewer) to `cubby-partner-data`, dataset `analytics`, including the
`stor_track` table, for the Greens Storage org. Cubby's row filter limits it
to our facilities.

### 3. Put the key on the API servers (both options)

In Azure Portal > App Services, for BOTH `greens-nexus-api-dev` and
`greens-nexus-api` > Settings > Environment variables > App settings, add:

| Name | Value |
|---|---|
| `CUBBY_BQ_CREDENTIALS_JSON` | the whole contents of the `.json` key file (one line is fine) |
| `CUBBY_BQ_PROJECT` | optional - the project query jobs are billed to. Leave it out to use the `project_id` inside the key. |
| `NEXUS_STORTRACK_HOURS` | optional - how often the import runs (default 6). |

Saving restarts the app. The `google-cloud-bigquery` package is already in
`backend/requirements.txt`, so a deploy installs it.

### 4. Check it (both options)

1. Open Operations > Market Rates, pick a facility. The StorTrack line should
   change from "StorTrack not connected yet" to "StorTrack has not synced yet".
2. As a manager, press **Sync StorTrack Now**. The first run reads the last
   120 days and can take a minute. The line then reads
   "StorTrack last synced MM/DD/YYYY h:mm AM", new competitors appear with
   the note "Added from StorTrack", and rates carry a **StorTrack** chip.
3. The API log shows `[stortrack] manual: Read N rows; ...` (and every few
   hours `[stortrack] schedule: ...`).

## Troubleshooting

| What the tab says | Cause |
|---|---|
| StorTrack not connected yet | `CUBBY_BQ_CREDENTIALS_JSON` is not set on this server. |
| "...is not valid JSON" / "...is not a Google service account key" | The app setting holds part of the file, or the wrong file. Paste the whole JSON key again. |
| "...bigquery.jobs.create" / Access Denied on our project | Step 1.3: the BigQuery Job User role is missing in our project (or `CUBBY_BQ_PROJECT` names a project where it is missing). |
| "...Access Denied: Table cubby-partner-data..." | Step 2: Cubby has not granted the service account yet. |
| Synced, but no rows | Cubby's row filter has not been set for our org, or StorTrack has no stores near that facility. |

The key is never logged or shown in an error. To rotate it, create a new key
on the service account, replace the app setting on both servers, then delete
the old key in the Google Cloud console.
