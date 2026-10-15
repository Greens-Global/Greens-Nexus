# Site Models - to-scale 3D property models

Neil, Oct 11-12 2026. One model per Greens Storage property, all eight built:

| Property | Model id | Cubby facility | Parcel source |
|---|---|---|---|
| Greens Storage Escondido | `greens-storage-escondido` | `fac_UvKP7sgZpMz` | SANDAG (San Diego County) |
| Greens Storage Valley Center | `greens-storage-valley-center` | `fac_Asbw9oaBaZC` | SANDAG (San Diego County) |
| Greens Storage Temecula | `greens-storage-temecula` | `fac_MvDV6MGhb9q` | Riverside County Assessor OpenData |
| Greens Storage Murrieta | `greens-storage-murrieta` | `fac_TqcwmjuRLgy` | Riverside County Assessor OpenData |
| Greens Storage Fairfield | `greens-storage-fairfield` | `fac_NZEnukUARtt` | Solano County parcel layer |
| Greens Storage Austin (CubeSmart) | `greens-storage-austin` | none - CubeSmart store 6992 | Williamson County (WCAD) parcels |
| Greens Storage Sachse (CubeSmart) | `greens-storage-sachse` | none - CubeSmart store 4568 | Collin CAD parcels (via the City of Allen layer) |
| Greens Storage Georgetown (CubeSmart) | `greens-storage-georgetown` | none - CubeSmart store 6093 | Williamson County (WCAD) parcels |

A site model is one JSON file per property in `backend/site_models/`.
Everything in it is in a local meter frame: `u` runs along the site's long
axis (bearing in `frame.bearingDeg`, clockwise from north), `v` runs 90
degrees counterclockwise from `u`, and `frame.north` is true north as a unit
vector in that frame. The viewer (`frontend/src/sitemodel/siteModelViewer.js`)
draws one world unit per meter, so distances, footprints and unit sizes are
real.

Two screens read it:

* **Owner** - Asset Management > property page > Site Model
  (`SiteModelSection.jsx`): occupancy from Cubby, out-of-service units,
  tickets whose location is a unit number, and markup pins. Pins are rows of
  `site_model_markups` (`/site-models/{id}/markups`).
* **Customer** - `/map/{propertyId}` (`views/PublicUnitFinder.jsx`), no login.
  Serves the customer-safe view from `GET /site-models/public/{id}`: geometry,
  unit numbers, sizes and types. Never occupancy, tenant data or layout notes.
  `/map/greens-storage-escondido#C214` preselects a unit - print it on the
  rental agreement or a QR code at the gate.

## Two looks: Satellite and Illustrated

The viewer draws the same to-scale model two ways, switched with the
Satellite / Illustrated buttons under the model (remembered per browser).

- **Satellite** - the Esri photo under the model, parcel line and pads in
  outline. Best for checking the model against the ground.
- **Illustrated** (`siteModelDiorama.js` + `SiteModelHud.jsx`, Oct 11 2026) -
  styled after the "3D warehouse dashboard" recording Neil shared: pale cool
  ground on a floating tile, ribbed brand-green buildings with white roll-up
  doors, a white office with a green roof, yellow stall lines and dashed lane
  paint, round trees, a gate arm, white box trucks, cars and RVs driving loops,
  and a map pin over the found unit. Floating cards sit over the model: a site
  chip, and a route tracker (Gate, Building, Level, Unit - the storage version
  of a shipment tracker). Owners also get a Live / Snapshot pill, KPI tiles
  (units, leased, vacant, out of service), an Attention / Pins / Tickets card,
  and a parked vehicle on every leased stall. Customers never see occupancy.
  It turns slowly until the first touch; reduced motion gets a still frame.

Everything in the illustrated look is derived from the model (pads, zones,
buildings, gates, parcels), so a model correction shows up in both looks.
Trees and vehicle colors come from a random seed of the property id, so a
property looks the same on every visit. Traffic routes are generated, not
surveyed: a loop around each building where the aisle is clear, and a loop
inside each lot.

## Live Cubby link

The model file is the geometry. Occupancy and the unit list come from Cubby
on every read when the Operator API key is set (`backend/cubby_client.py`):

* `CUBBY_API_KEY` - an API key with the **Search** role (read-only). Cubby
  issues keys by email: support@cubbystorage.com. The Report role is NOT
  enough (it has no units search). Keep the key out of git; it goes in the
  Azure app settings like every other secret.
* `CUBBY_API_BASE` (default `https://api.cubbystorage.com/v1`) and
  `CUBBY_CACHE_SECONDS` (default 300, the per-facility cache).

With the key, `GET /site-models/{id}` and the public view merge
`POST /v1/units/search` (with the `pricingGroup` expansion for features) onto
the model by unit name:

* leased / rentable / unrentable reason and note come from Cubby; the model's
  `u, v, wu, dv, f` positions stay;
* units Cubby has that the model does not place are returned in
  `live.unplaced` - the owner panel lists them under "Not On The Map Yet"
  and the customer finder says the unit exists but is not on the map;
* model units Cubby no longer has are marked `gone` (hidden from customers);
* `live.asOf` is the Cubby read time; a Cubby outage serves the last good
  answer with `live.error` set, and the panel says so.

`POST /site-models/{id}/refresh` drops the cache for one facility. Without a
key every screen shows the snapshot the model was built from and the panel
says "live link off". The Operator API has no days-vacant figure, so days
vacant is kept from the snapshot only while a unit stays vacant.

## Building a model

`backend/site_models/build/build_site_model.py <config> <parcel.geojson> <units.json> <out.json>`

Inputs for every property are beside it (`<id>.config.json`,
`<id>.parcel.geojson`, `<id>.units.json`):

1. **Parcel** - the county's parcel service, one GeoJSON feature per parcel
   the facility sits on (`properties.apn`). SANDAG for San Diego County
   (`geo.sandag.org/.../Hosted/Parcels`, query by situs address), Riverside
   County OpenData `Assessor/MapServer/50` (query by `STREET_NUMBER` and
   `STREET_NAME`, or a point), the Solano County layer on
   `portal.sanborn.com` (`siteroad` / `sitenum`).
2. **Building footprints** - Microsoft Open Building Footprints (the
   `global-buildings` quadkey tiles carry heights) fitted with a minimum-area
   rectangle and written to the config as `rect: {E, N, L, W, bearing}` in
   meters from the frame origin; checked against Esri World Imagery. OSM has
   no footprints at any of the five sites. Each building names the unit
   letters (or a `units` regex) it holds. `inferred: true` means the
   letter-to-building match came from imagery and unit sizes, not a plan -
   fix it in the config when the as-built says otherwise.
3. **Units** - the Cubby inventory (`units` table for the facility, active
   rows): name, width, depth, type, occupancy and rentability flags, feature
   flags. `classify` rules in the config override the Cubby feature flags
   (Cubby's "Not climate controlled" strings make the raw flag unreliable).
4. **Imagery** - `ground.jpg` (detail) and `ground-wide.jpg` (context) in
   `frontend/public/site-models/<id>/`, Esri World Imagery exports with their
   bounding boxes in the config.

### CubeSmart stores (Austin, Sachse, Georgetown)

These three are operated by CubeSmart and are not in Cubby; their units come
from CubeSmart's monthly **Financials** workbook (Egnyte: `<entity>/#Reports/
Reports - Daily & Monthly/<year>/<month>/<store>/<store> Financials <Month>
<year>.xlsx`). To refresh one:

    python cubesmart_units.py "<store> Financials August 2026.xlsx" <store> 08/31/2026 greens-storage-<site>.units.json [greens-storage-sachse.sizes.json 02/02/2021]
    python build_site_model.py greens-storage-<site>.config.json greens-storage-<site>.parcel.geojson greens-storage-<site>.units.json ../greens-storage-<site>.json

`cubesmart_units.py` reads only Store / Cube / Cube Dimensions / Cube Attribute
from the Rent Roll sheet and the Cube Mix totals - never the customer, date or
rate columns. The rent roll lists rented units only: every gap in a floor's
numbering is written as vacant, sized from an older all-units audit when one
exists (Sachse: `greens-storage-sachse.sizes.json`, the 02/02/2021 audit, which
matched the current rent roll on all 653 shared units) or else estimated from
the Cube Mix vacant counts (note "size estimated"). Update `unitSource` in the
config to the new date. Delete the downloaded workbook afterwards.

Buildings packed this tightly (about 78% of each floor is rentable) use
`autoFit: true`: the builder tries hallways along and across the building and
units turned long side in, and keeps the layout that fits the real floor count.

Open lots (RV and vehicle storage) are **zones**: an outline from the parcel
rings (`parcels`, with an `inset` and an optional `uRange` to split one lot
into lettered sections), from image pixels, or from meters. Stalls fill the
zone in rows along `u` in unit-number order. A `canopy` zone is a roof drawn
over the stalls with no units of its own.

The script lays units out **schematically** only where nothing better is
known: drive-up units along the exterior walls in number order, interior units
along double-loaded hallways (`corridor` per building, 1.6 m default), parking
stalls in rows across the lot. When the unit area needs more than the
configured floors it adds a level and says so in `layout.flags`.

### Traced from the plans (Oct 14 2026)

Every site is now traced from its plans with **runs** in the config (see the
docstring at the top of `build_site_model.py`): an ordered line of units along a
wall, hallway or painted row, with a start point (meters from a building's
corner, or frame u,v for a lot), a direction, the side the units extend toward,
gaps for stairs and doors, an optional fixed stall width, and an optional
`angle` for angled parking or a skewed wall (the unit keeps its size, sits centered in its
painted parallelogram and carries `rot`). Runs are placed first; anything in no
run falls back to the schematic layout.

Each placed unit says where it came from: `tr: 1` traced from a numbered plan,
`tr: 2` position from the plans but the number matched by size because the
plans carry no unit numbers (`"numbering": "inferred"` on the run), no `tr`
schematic. `layout.traced`, `layout.numbersInferred` and `layout.schematic`
summarize it, and the unit panel tells the reader which one they are looking at.

`planSizes` in the config holds sizes the plans prove where the unit list says
otherwise (mostly vacant CubeSmart units whose size was estimated). The build
applies them over the unit list every time, so a `cubesmart_units.py` refresh
cannot undo them.

**Best sources, in order:** a numbered customer map under
`/Shared/--Asset Management/<NN - GS Site>/Property Plans & Maps/` (vector
PDFs: read labels with PyMuPDF `get_text("words")` and shapes with
`get_drawings()`); unit-numbering floor plans in the entity's due-diligence or
development folders; as-built / permit floor plans (positions only); the site
plan. Fit lot maps to the parcel and check over the Esri imagery.

### Per property (as traced Oct 14 2026)

| Site | Traced | Source | Open |
|---|---|---|---|
| Sachse | 886 of 886 | CSW Sachse 1st/2nd/3rd Floor Unit Numbers (06/12/2020, due diligence) | Lockers 1001L-1011L are unnumbered on the plan (placed in the niche by the elevators, order assumed). Plan units missing from the roll: 1001, 2105, 2334, 2335, 3335. 1224, 2042 and 1180 differ in size from the plan. |
| Austin | 1113 of 1113, numbers matched by size | As-Built Arch A1.01-A1.05 + Final Set A0.01 | No numbered plan exists: order within runs of same-size units (and the 5x5 columns' direction) follows the numbering snake - confirm on site. Gate not confirmed. |
| Georgetown | 964 of 964, numbers matched by size | Westinghouse Storage Add 05 Architectural A1.00, A2.01-A2.03, A2.06 + 12-15-21 Unit Mix | No numbered plan exists. 4000 on the north row (B) and 6000 on the south row (D) still need an on-site check, as does the direction along each row. 1500-1504 on the west wall, 1505-1538 along the south wall. 3068 sits where the level 3 plan shows an MEP closet. |
| Valley Center | 568 of 851 (the rest are 279 mailboxes + Z1001 in the office, and N37 / P001 / P002) | Customer Map GSVC PB v0.4 (06/24/2024) + Building B CAD maps (02/25/2023) | Building letters corrected (E1, E2, C2, F, A). F023 is 14x20 in Cubby but a 10x12 cell on the map (overlaps F041-F043) - a Cubby data question. Split B units' halves, C045-C052 door sides, parking position from imagery. |
| Temecula | 467 of 527 | TEMECULA SITE MAP (3 sheets, 06/2022) + Cubby map snips (03/2025) | 59 units on no plan (E600-E639 and others) sit in an "Unmapped Stalls" zone off the lot (plus one more untraced unit elsewhere) - a current stall map would place them. Some B stalls run past the assessor line where the fence does. About 75 Cubby sizes differ from the painted stalls. |
| Murrieta | 163 of 175 | 2024-06-20 Murrieta Customer Map PB v8 | X001, DL cells, TEST1 and zero-size records are on no plan. Containers C01-C07 are on the map but not in Cubby. |
| Fairfield | 300 of 307 | Customer Map A-3.0 (06/09/2026) + storEDGE map + directional key | A032-A038 are inactive placeholders on no map ("Not On Site Plan" zone). X001-X004, A001A-D and H020 on weaker evidence. |
| Escondido | 884 of 884 | Site Map 1"=20' (10/10/2023), Customer Map with RV Spots (10/18/2023), Customer Map (02/23/2024) | Building C is two stories (C300-C563 on level 2) - C300-C339 keep the drive-up rule, confirm. E and F are separate buildings; A is the bays at the office's east end. C048A is on no plan (placed in the C1-1 mechanical room); C046/C048 are drawn 5x7.5 but rented as 5x10 (one overlap). BC1/BC2, Z001, mailboxes M100-M176 and about 15 curved/corner stalls are placed on weaker evidence. Frame bearing corrected 141.5 to 140.4 degrees (saved pins may shift up to about 3 m). |

The Valley Center ruling stands: only APN 188-250-45; the rows on 189-013-17
belong to a neighbor. Georgetown's Lot 1 (R606430) and Sachse's neighbors
(Extra Space at 7900 Woodbridge, the retail strip) are not modeled.

## Release checklist

* `site_model_markups` is created by `create_all` with RLS **disabled**. On
  dev and prod run `ALTER TABLE site_model_markups ENABLE ROW LEVEL SECURITY;`
  and check `get_advisors` (CLAUDE.md, new tables).
* Set `CUBBY_API_KEY` (Search role) on dev and prod app settings to turn the
  live link on; until then the models show their Oct 11, 2026 snapshot.
* `/site-models/public/*` is anonymous and sits under the normal per-IP rate
  limit; nothing it returns is sensitive.
