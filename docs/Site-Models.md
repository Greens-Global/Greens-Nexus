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

The script lays units out **schematically**: drive-up units along the
exterior walls in number order, interior units along double-loaded hallways
(`corridor` per building, 1.6 m default), parking stalls in rows across the
lot. Buildings whose long side runs across the frame are laid out rotated
(door sides `w` / `e`). When the unit area needs more than the configured
floors it adds a level and says so in `layout.flags`, which the owner panel
shows under Layout Notes. Replace the generated `u, v, wu, dv, f` of each unit
from the as-built plan when it is scanned (As-Built Plans is item 3 of the
Asset Management scope) and clear `layout.schematic`.

### Open questions per property (for the as-built plans)

* **Austin** - 8023 W Parmer Ln, WCAD R569024 (2.818 ac, Greens Austin LLC).
  Operated by CubeSmart, signage reads CubeSmart, and the store is not in
  Cubby: units come from CubeSmart's rent roll (store 6992), which
  lists rented units only. Refreshed to the 08/31/2026 Financials workbook
  (966 rented); numbering gaps are vacant with sizes estimated from the Cube
  Mix (see CubeSmart stores above).
  The building (five stories, 200 ft 11 in x 155 ft 11 in) is from the WCAD
  footprint and the Merriman Anderson plans A1.01-A1.05 (Egnyte: Greens
  Austin, LLC > 8023 W Parmer Lane > Development > Plans & Maps > Building
  Plans > Final Set). Units sit in number order on their floor (1xxx on
  level 1 to 5xxx on level 5); positions within a floor are schematic until
  the plans are traced. The paved area is drawn as the whole parcel.

* **Sachse** - 7970 Woodbridge Pkwy, CCAD R-10561-00A-0040-1 (2.082 ac,
  Greens Sachse LLC, DBA CubeSmart), store 4568. One three-story building,
  74.9 x 50.0 m from the Microsoft footprint (CCAD living area 121,926 sq ft =
  three floors of it). Units from the 08/31/2026 rent roll (741 rented) plus
  145 numbering gaps as vacant. The office position (west corner, toward the
  north parking court) is read from imagery - confirm. The as-built set is in
  Egnyte (Greens Sachse, LLC > Properties > Development > Plans & Maps >
  Building Plans & Unit Mix > As-Built Drawings - CSW Sachse - Combined set.pdf,
  85 MB) for tracing unit positions. The Extra Space at 7900 Woodbridge and the
  retail strip are neighbors and are not modeled.
* **Georgetown** - 108 Boselli Way, WCAD R606431 (5.304 ac, Greens Georgetown
  LLC, DBA CubeSmart), store 6093. Main three-story building (115.4 x 35.7 m)
  and three 10x20 drive-up rows, all from WCAD building footprints. 4000-4035
  on the north row and 6000-6035 on the south row is inferred (both rows hold
  36 units) - confirm and swap the `units` regex if reversed. 5000-5014 are the
  west row. 1500-1538 are climate-controlled drive-ups on the main building's
  walls (which wall is schematic). Greens Georgetown LLC also owns Lot 1 next
  door (R606430, 310 Westinghouse Rd, 1.603 ac); it is not part of the storage
  site and is not modeled.
* **Escondido** - Building C modeled as two levels (62,690 sq ft of C units
  cannot fit one floor of its footprint); Building E/F needs a second level
  for three 15x44 garages; the RV lot outline is approximate.
* **Valley Center** - one parcel only, 188-250-45 (28407 Lizard Rocks Rd,
  5.74 ac). The storage rows on the parcel to the south (189-013-17, 28365
  Cole Grade Rd) belong to a neighbor and are not part of the model (Neil,
  Oct 11). Building B is the two-story climate-controlled building from county
  permit STP-03-026W1 (B2xx/B3xx on level 2, the schematic wants a third
  level). C001-C044 are on the long row along the east property line, doors
  facing B (measured from imagery). C045-C071 (mostly 12x35) are placed in
  the southwest corner building as the only footprint deep enough; it is too
  small for all of them, so the last ones sit on a schematic second level.
  Confirm both against the plan.
* **Temecula** - the lot (parcels 918-200-025 and -027) is split into
  sections A-E in proportion to each section's stall area, containers (X) at
  the south tip; the two canopies are drawn but not tied to stall numbers.
* **Murrieta** - one lot, stalls in letter order; the office/shop building
  holds X001, Z001 and the DL cells.
* **Fairfield** - two parcels (0166-080-040 office yard and -030 striped
  rows); the parcel layer still calls them vacant land; containers X in the
  yard.

## Release checklist

* `site_model_markups` is created by `create_all` with RLS **disabled**. On
  dev and prod run `ALTER TABLE site_model_markups ENABLE ROW LEVEL SECURITY;`
  and check `get_advisors` (CLAUDE.md, new tables).
* Set `CUBBY_API_KEY` (Search role) on dev and prod app settings to turn the
  live link on; until then the models show their Oct 11, 2026 snapshot.
* `/site-models/public/*` is anonymous and sits under the normal per-IP rate
  limit; nothing it returns is sensitive.
