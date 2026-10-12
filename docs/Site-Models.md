# Site Models - to-scale 3D property models

Neil, Oct 11 2026. One model per Greens Storage property, all five built:

| Property | Model id | Cubby facility | Parcel source |
|---|---|---|---|
| Greens Storage Escondido | `greens-storage-escondido` | `fac_UvKP7sgZpMz` | SANDAG (San Diego County) |
| Greens Storage Valley Center | `greens-storage-valley-center` | `fac_Asbw9oaBaZC` | SANDAG (San Diego County) |
| Greens Storage Temecula | `greens-storage-temecula` | `fac_MvDV6MGhb9q` | Riverside County Assessor OpenData |
| Greens Storage Murrieta | `greens-storage-murrieta` | `fac_TqcwmjuRLgy` | Riverside County Assessor OpenData |
| Greens Storage Fairfield | `greens-storage-fairfield` | `fac_NZEnukUARtt` | Solano County parcel layer |

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

* **Escondido** - Building C modeled as two levels (62,690 sq ft of C units
  cannot fit one floor of its footprint); Building E/F needs a second level
  for three 15x44 garages; the RV lot outline is approximate.
* **Valley Center** - the facility spans two parcels (188-250-45 and
  189-013-17, the Cole Grade Rd rows); Building B is the two-story
  climate-controlled building from county permit STP-03-026W1 (B2xx/B3xx on
  level 2, the schematic wants a third level); two footprints (R1, R2) have
  no unit letter matched; C is split C001-C044 / C045-C071 across two rows.
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
