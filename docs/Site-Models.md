# Site Models - to-scale 3D property models

Neil, Oct 11 2026. First property: Greens Storage Escondido
(`backend/site_models/greens-storage-escondido.json`).

A site model is one JSON file per property. Everything in it is in a local
meter frame: `u` runs along the site's long axis (bearing in
`frame.bearingDeg`, southeast for Escondido), `v` runs toward the northeast,
and `frame.north` is true north as a unit vector in that frame. The viewer
(`frontend/src/sitemodel/siteModelViewer.js`) draws one world unit per meter,
so distances, footprints and unit sizes are real.

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

## Building a model

`backend/site_models/build/build_site_model.py <config> <parcel.geojson> <units.json> <out.json>`

Inputs for Escondido are beside it:

1. **Parcel** - SANDAG parcel service (`geo.sandag.org/.../Hosted/Parcels`),
   queried by situs address, exported as GeoJSON in WGS84.
2. **Building footprints** - digitized against Esri World Imagery (the export
   endpoint with `bboxSR=4326`), cross-checked with Microsoft Open Building
   Footprints for heights. Each building is a rectangle in `(u, v)` with the
   unit letters it holds. `inferred: true` means the letter-to-building match
   came from imagery and unit sizes, not a plan - fix it in the config when the
   as-built says otherwise.
3. **Units** - a Cubby export (`units` table, active rows for the facility):
   name, width, depth, type class, occupancy and rentability flags.
4. **Imagery** - `ground.jpg` (detail) and `ground-wide.jpg` (context) in
   `frontend/public/site-models/<id>/`, with their bounding boxes in the config.

The script lays units out **schematically**: drive-up units along the
exterior walls in number order, interior units along double-loaded hallways,
parking stalls in rows across the lot. When the unit area needs more than the
configured floors it adds a level and says so in `layout.flags`, which the
owner panel shows under Layout Notes. Replace the generated `u, v, wu, dv, f`
of each unit from the as-built plan when it is scanned (As-Built Plans is item
3 of the Asset Management scope) and clear `layout.schematic`.

Escondido open questions for the as-built: Building C is modeled as two
levels because its 62,690 sq ft of C units cannot fit one floor of its
footprint; Building B's 24 vehicle garages (15 x 40 / 45 ft) are longer than
the building they were matched to; the RV lot outline is approximate.

## Refreshing occupancy

The model carries a snapshot of Cubby occupancy (`l`, `r`, `why`, `dv`) from
the build date. Re-run the build with a fresh Cubby export to refresh it; a
scheduled refresh through the Cubby reporting API is the obvious next step.

## Release checklist

* `site_model_markups` is created by `create_all` with RLS **disabled**. On
  dev and prod run `ALTER TABLE site_model_markups ENABLE ROW LEVEL SECURITY;`
  and check `get_advisors` (CLAUDE.md, new tables).
* `/site-models/public/*` is anonymous and sits under the normal per-IP rate
  limit; nothing it returns is sensitive.
