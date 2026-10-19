# Third-Party Managed Properties (CubeSmart first)

Operations, Oct 20 2026 (Neil's Ops review call, 19:35-24:51).

Three Greens stores in Texas - **Austin (CubeSmart store 6992), Sachse (4568),
Georgetown (6093)** - are run by CubeSmart on CubeSmart's own system, so they
never reach Cubby and were missing from the Operations screen. Neil: "Otherwise
we've got half our properties on Nexus, half not." The same will be true of any
store a third party manages (Neil: "I manage 8 in California but I have one in
Canada").

This feature brings those stores into Nexus from the operator's own reports.

## What existed before

- **Site Models** for Austin / Sachse / Georgetown (commits d9469f88, d27af96f)
  already used a CubeSmart rent roll - loaded **by hand, offline**:
  `backend/site_models/build/cubesmart_units.py <Financials.xlsx> <store> <as-of> <out.units.json>`
  reads columns A-D of the "Rent Roll" sheet (Store, Cube, Cube Dimensions,
  Cube Attribute) and the "Cube Mix" sheet of CubeSmart's monthly Financials
  workbook (from Egnyte), writes `greens-storage-<site>.units.json`, and
  `build_site_model.py` bakes that into `backend/site_models/<id>.json`, which is
  committed. The model's `property.unitSource` ("CubeSmart rent roll,
  08/31/2026") is what the owner screen shows; a new rent roll meant a rebuild
  and a commit.
- Operations (`/facility-ops`, `cubby.py`) only knew Cubby facilities.

The offline builder is unchanged (it still sizes and places units). What is new
is that a rent roll **uploaded in Nexus** now repaints the Site Model's
occupancy without a rebuild.

## Data model (`backend/third_party_models.py`)

| Table | One row per | Holds |
|---|---|---|
| `third_party_properties` | operator store | source (`cubesmart`), store number, name, short name, `site_model_id`, `property_asset_id` (Asset Management portfolio row, soft link), `fetch_enabled`, `enabled`. Seeded with the three Texas stores on first read. |
| `third_party_sre_months` | store + month (unique) | SRE Summary: Rental Activity (cubes available, rented / vacated during month, net rentals, company / maintenance cubes, cubes occupied at EOM, % rented by cube and by sq ft, % NCC / CC / UP / DOWN / IN / OUT, budget SF occupancy, length of stay days / months / value) and Revenue & AR (rental, fee, insurance, merchandise, other, total revenue, promotions, promo move-ins, write-offs, AR 0-30 / 31-60 / 61-90 / 91+ / total). Report lines Nexus does not map yet are kept in `extra` by label. |
| `third_party_flash_days` | store + day (unique) | Daily Flash: move-ins / move-outs daily, daily budget, MTD, MTD budget, MTD prior year; occupancy by status (occupied, vacant, reserved, damaged, unrentable, totals) in cubes and sq ft; accrued rent, fees, insurance, merchandise, total revenue, discount, write-offs, net revenue - MTD / budget / prior year. |
| `third_party_rent_rolls` | store + as-of day (unique) | The RENTED units only: unit, size, attribute. No customer name, rate or date is ever stored. |
| `third_party_imports` | upload or fetch | who, when, which report, how many rows, status, a scrubbed error. |

Each table has an `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` line in `main.py`'s
Postgres migration list. Release step: confirm RLS is on for all five on dev
AND prod, then run `get_advisors`.

## Path (a): upload - live now

Operations > Overview > pick a CubeSmart store (or All Facilities) > **Upload
Report** (managers and above; the API also admits an Operations editor).

1. Export from CubeSmart, as Excel or CSV:
   - **SRE Summary** - qsreports.cubesmart.com, the "SRE" sheet: right-click the
     Rental Activity table (and the Revenue & AR table) > Download as > Data.
     Both tables can be on one sheet or one file each.
   - **Daily Flash** - smartviewweb.cubesmart.com/flash: the Revenue,
     Allowances, Net Revenue, Occupancy by Status and Net Rentals tables, stacked
     on one sheet the way the landing page shows them, or a long export with one
     row per day.
   - **Rent Roll** - the "Rent Roll" sheet of the monthly Financials workbook
     (the same file `cubesmart_units.py` reads), or a CSV of it.
2. **Preview** (`POST /third-party/upload`, `commit=false`) parses and validates
   and saves nothing. It shows the property, every month / day found, which rows
   replace figures already in Nexus, warnings (occupancy by status not adding to
   the total, Net Rentals not equal to Rented minus Vacated, rent roll rows that
   did not look like a unit) and errors (a file for a different store than the
   one picked, a Daily Flash dated in the future, no As Of date).
3. **Save** sends the same file with `commit=true`; the server parses it again
   and upserts (store + month, store + day, store + as-of day) under row locks.

Parsing (`backend/third_party_parse.py`) goes by labels, never column positions:
months can be in any order (Qlik lets the viewer re-sort), the occupancy table
can put Sq Ft before Cubes, the long layouts can shuffle columns. Numbers read
the way Qlik exports them: `2,926`, `85.1%`, `$1,215.13`, `(1,227)`, `-`, `NA`.
The store comes from the file ("Store 6992", a Store column) or the form. The
rent roll reads ONLY Store / Cube / Cube Dimensions / Cube Attribute, located by
header; a bad row is counted, never echoed (it could be a customer name).

Fixtures built from the screenshots' layouts: `backend/fixtures/third_party/`
(regenerate with `make_fixtures.py`). The Rental Activity, Daily Flash
Revenue / Occupancy / Net Rentals figures are the 10/19/2026 values on screen;
the Revenue & AR row labels were below the fold on the call - **check them
against a real export** and add any new label to `SRE_FIELDS` (unmapped labels
are listed in the preview and kept in `extra`, never lost).

## Operations screen

`GET /third-party/ops-facilities` returns each store in the same shape
`cubby.summarize_facility` gives a Cubby facility, so `operations/model.js`
`combine()` adds them into All Facilities unchanged. The picker pill reads
"Austin **CubeSmart Managed**" (hover: "Data as of MM/DD/YYYY"); picking it
shows a card with **Data as of MM/DD/YYYY** (a **Stale** badge when the newest
Daily Flash is more than 2 days old), the Daily Flash tables and the SRE months.

| Overview figure | Where it comes from |
|---|---|
| Occupancy, units | newest Daily Flash, Occupancy by Status (reserved + damaged + unrentable = off market); else the newest SRE month (cubes available / occupied EOM) |
| Monthly Rent Roll | rental revenue of the newest COMPLETE SRE month; before one is loaded, the Daily Flash accrued rent MTD |
| Past Due | the newest SRE month's AR (0-30, 31-60, 61-90, 91+, total) |
| Net Move-Ins, Move-Ins / Move-Outs charts | Daily Flash MTD (a day's figure = its MTD less the previous loaded day's in the month); months with no Daily Flash use the SRE month totals |
| Rented Units trend | SRE cubes occupied at EOM per month |

Not available for an operator-run store (they live in the operator's system):
tenants, payments / collections, autopay, leads, tasks, unit types and pricing.
Those lists are simply empty for these stores.

## Site Model

`site_models.with_live` asks `third_party.rent_roll_live` first for a model
with a `unitSource` and no Cubby facility. With an uploaded rent roll for the
store mapped to that model: every unit on the roll is leased, every other unit
vacant, roll units the model does not have are listed as unplaced, and the
panel reads "CubeSmart rent roll, MM/DD/YYYY - not in Cubby, updated when a new
rent roll is loaded". With none, the built snapshot shows as before. The
public unit finder still never carries occupancy.

## Path (b): nightly fetch - designed, OFF

`backend/third_party_fetch.py`: `ThirdPartySource.fetch(property, day)` returns
the report files exactly as an upload carries them, so the fetch shares the
parser, the validation and the upsert. `CubeSmartSource` is a **stub that
refuses**: nothing logs in, nothing is scraped, until CubeSmart confirms a
machine-readable path. The loop (`third_party_fetch_loop`, started from
`main.py` on the deployed worker) runs at most once a night after 3 AM
Central, and only when ALL of these hold:

1. `NEXUS_THIRD_PARTY_FETCH=on` (Azure app setting; anything else = off),
2. the store's `fetch_enabled` is true (`PATCH /third-party/properties/{id}`),
3. `CUBESMART_USERNAME` and `CUBESMART_PASSWORD` are set as **Azure app
   settings** (Key Vault references preferred). Never in code, `.env` files in
   git, tests, docs, the database or logs. They are read from `os.environ` at
   call time only; every stored or printed message passes `scrub()`, which
   blanks them (plain and URL-encoded). `GET /third-party/fetch` says whether
   they are present, never their values.

Blocking work runs in `asyncio.to_thread` (CLAUDE.md). A failure is a
`third_party_imports` row with `via = fetch` and a scrubbed error.

### How CubeSmart's reports could be read by a machine

What the screenshots show: the SRE Summary is a **Qlik Sense (client-managed)**
app at `qsreports.cubesmart.com/jwt/sense/app/<app id>/sheet/<sheet id>` - the
`/jwt/` prefix is a Qlik virtual proxy that authenticates with a **JSON Web
Token** CubeSmart's portal issues. SmartView (`smartviewweb.cubesmart.com`) is
CubeSmart's web portal around the same Qlik content (the Daily Flash page is
"Analytics app" / Qlik objects).

Qlik Sense's documented, general-purpose interfaces:

- **Engine API** (JSON-RPC over a WebSocket, `wss://<host>/<proxy>/app/<app id>`):
  `OpenDoc` -> `GetObject(<table id>)` -> `GetHyperCubeData` reads the table's
  cells directly, or `ExportData` (`qFileType: OOXML` or `CSV_C`) makes Qlik
  write an .xlsx / .csv and return a temporary `/tempcontent/...` link to
  download over HTTPS. Selections (Store, Year, Month) are applied with
  `SelectValues` on the fields shown in the filter bar.
- **Repository Service (QRS) REST API** - administration (apps, users,
  tasks); not for report data, and admin-only.
- **Scheduled delivery** - Qlik subscriptions / Qlik NPrinting (and many
  operators' portals) email a report or an Excel export on a schedule.

All of these need CubeSmart's cooperation for an account: a JWT Nexus can
obtain (a service account the portal will mint a token for, or CubeSmart
issuing one), or a scheduled email. A username and password alone only work if
the portal's login can be replayed with plain HTTPS (no MFA, no CAPTCHA) and
CubeSmart's terms allow automated access.

**Recommendation, in order:**

1. **Ask CubeSmart to email the SRE Summary and Daily Flash exports nightly**
   to an ops mailbox (e.g. a shared `cubesmart-reports@` box). Nexus already
   reads mailboxes through Microsoft Graph (task / ticket email); a small
   `MailboxSource` would pick up the attachments and run them through the same
   preview + save. No CubeSmart credentials in Nexus at all, no scraping, and it
   runs in the cloud. **Best option.**
2. **Qlik Engine API with a token CubeSmart issues** for a service account:
   plain HTTPS + WebSocket, so it runs **in the API's own background loop, in a
   thread** (`CubeSmartSource.fetch` opens the app, applies the Store / month
   selections, calls `ExportData`, downloads the file). Cloud, no browser. Needs
   CubeSmart's Qlik admin to allow it and the `websocket-client` package.
3. **Headless browser** (Playwright logging in as a user and clicking Export)
   only if CubeSmart offers neither. It does **not** belong in the API process
   (Chromium is ~300 MB and memory-hungry on App Service): run it as an
   **Azure Container Apps job** (or an Azure Function on a timer with a
   Playwright image) that uploads the files to `POST /third-party/upload` with
   a service credential. Brittle: any change to the portal's pages breaks it.

**Cloud vs. office PC:** Neil wants the cloud, and it is the right call. Every
option above runs in Azure on a schedule, survives an office power or internet
outage, needs no machine to patch or keep logged in, keeps the credential in
Azure's settings rather than on a desk, and reports failures where everything
else in Nexus does. An office PC running 24/7 adds a single point of failure
(power, Windows updates, someone logging it off) for no benefit.

### To turn the nightly fetch on (needed from Neil)

1. Confirm with CubeSmart which path they support (scheduled email strongly
   preferred; else a Qlik service account / JWT) and that the management
   agreement allows automated access to the reports.
2. For option 1: the mailbox address, and a Graph Mail.Read application
   permission scoped to that mailbox (application access policy).
   For option 2: the service account's credentials or token, set by an admin
   as Azure app settings `CUBESMART_USERNAME` / `CUBESMART_PASSWORD` (or a
   token setting) - never sent in chat or email - plus the SRE / Daily Flash
   app and object ids.
3. Implement `CubeSmartSource.fetch` (or `MailboxSource`) against a real export,
   test it against fixtures, then set `NEXUS_THIRD_PARTY_FETCH=on` and turn on
   `fetch_enabled` for the three stores.

## Adding another operator

Add the source to `third_party.SOURCES` (label: "X Managed") and, when its
reports differ, label aliases to `third_party_parse.py`; seed or insert its
stores in `third_party_properties` with their Site Model id. Upload works the
same day; a nightly fetch is a new `ThirdPartySource`.

## Tests

- `backend/test_third_party.py` - parses every fixture, preview saves nothing,
  store mismatch refused, rent roll never echoes a customer, upsert by store +
  month / day, Ops facility blocks, stale flag, Site Model overlay, fetch off by
  default / never runs without env / no credential in logs or the database.
- `frontend/src/operations/ThirdParty.test.jsx` - the upload preview and the
  "CubeSmart Managed" picker label with Data as of.
