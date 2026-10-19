# Customer Unit Map

A storage customer's own map: the facility's address, the real entrance with
an "Open in Google Maps" link, and the 3D site model showing only the path
from the gate to their unit. There is no login. (Neil, Ops review, Oct 20 2026.)

Why: at Fairfield, Google's pin for 5044 Peabody Rd sends customers into the
landscape company next door. The map sends them to the entrance we set, then
walks them from the gate to the unit.

## What the customer sees

- The facility name and address.
- **Getting Here**: the Customer Entrance pin and its note, plus "Open in
  Google Maps" with directions to that exact point (not the street address).
- **Your Unit**: the unit number, type, size, building and level, and written
  directions.
- The site model with the route drawn on the ground from the gate to the unit.
  The route has numbered stops (Gate, Building, Level, Unit), and tapping a
  stop moves the camera there. A device without WebGL gets a flat plan with
  the same route.

What the customer never gets: other customers' data, occupancy colors, rates,
or any other unit. The server sends the site geometry and one unit
(`routers/unit_map.customer_view`). Lot names such as "Parking G112-G114" are
part of the site's geometry and still appear.

## Getting a link (staff)

**Operations > Site Map**: pick the facility, click or search the unit, then
click **Copy Customer Link** on the unit card. The link looks like
`https://nexus.greensglobal.com/find/<token>`.

The same screen has the facility's **Customer Entrance** card:

- Edit Entrance sets the latitude, longitude, and a note. You can paste
  "38.2918, -121.9680" from Google Maps into the latitude box.
- Without a setting, the entrance is the model's main gate, converted to
  latitude and longitude.
- A point more than about a mile from the site is refused as a typo.
- The setting is stored in `nexus_settings` under the key
  `unit_map:entrance:<model id>`. That is an existing table, so no new table
  and no RLS step are needed.

Fairfield needs this set once by someone who knows the gate.

## In Cubby's rental confirmation email

### What Cubby supports

These are the documented facts as of Oct 20, 2026:

- **No API hook.** Cubby's Operator API has no webhooks and no workflow or
  automation endpoints (https://cubbystorage.github.io/docs/api/). Nexus
  cannot react to a rental or send the email itself.
- **Variables use `${...}`.** Cubby's message and document templates are
  built in its Template Editor, and variables are written as `${variable.name}`
  (for example `${facility.name}`, `${Facility.CustomUrl}`). Source:
  https://help.cubbystorage.com/en/articles/9952735-creating-document-templates
- **The full variable list is in the editor.** It appears in the "Standard
  values" panel. The public article does not name a unit-number variable, so
  confirm the exact name in the editor before going live.
- **Support may edit templates.** An older Cubby help page says Cubby
  Support makes email and SMS template edits for the operator. If the editor
  is not open to us, send them the link below.

### The template link

Cubby can only fill in a variable; it cannot sign anything. So each facility
gets a fixed link with a per-facility key, and Cubby adds the unit number:

```
https://nexus.greensglobal.com/find/u?f=<model id>&k=<facility key>&unit=${unit.name}
```

Replace `${unit.name}` with the unit variable Cubby's editor actually lists.

You do not build this by hand. Operations > Site Map > Customer Entrance shows
it ready to copy, under "Cubby rental confirmation link". Put it in the
facility's rental (move-in) confirmation template, for example:

> Find your unit: https://nexus.greensglobal.com/find/u?f=...&k=...&unit=${unit.name}

When a customer opens it, the server:

1. checks the key against the facility;
2. normalizes the unit number (`c14` and `C 014` both become `C014`);
3. signs a `/find/<token>` link and swaps it into the address bar.

The link the customer bookmarks is therefore the signed one.

## How the link is secured

**Signed token.** `/find/<token>` carries `<payload><HMAC-SHA256, 16 bytes>`
in URL-safe base64, over `{model id, unit}`. It is signed with the server's
signing secret (`secret_box.signing_secret`, the `NEXUS_VAULT_KEY`, the same
key used for the iCal feed and task links) under its own context
`unit-map:v1:`.

- Change the unit or the facility in the URL and the signature fails: you get
  a 404, "This link is not valid".
- The token is not encrypted. Anyone can read which unit it is for. It cannot
  be forged.
- It does not expire, because a rental lasts months.

**Facility key.** The key in the template link is an HMAC of the model id
(context `unit-map-facility:v1:`, 12 characters). It proves the link came
from us for that one facility.

Someone holding a facility's key can ask for any unit number at that facility.
What they get back is that unit's place on the map. That is less than the
older `/map/<property>` finder already shows for every unit, and it still
carries no occupancy and no tenant data.

**Rate limit.** Both public routes (`/unit-map/t/...` and `/unit-map/u`) are
in `RequestRateLimit.SENSITIVE_PREFIXES`: 30 requests a minute per IP. They
are also in `TOKEN_PATH_PREFIXES`, so a rate-limit trip logs
`/unit-map/<token>` and never the token itself.

**No Cubby call.** A customer's page load reads the model file and one
`nexus_settings` row. It never calls Cubby.

**Revoking.** Rotating `NEXUS_VAULT_KEY` invalidates every customer link and
facility key, along with everything else signed with it. There is no
per-link revoke. If one is needed, add a version or salt per facility in the
entrance setting.

## Endpoints

| Route | Who | What |
|---|---|---|
| `GET /unit-map/t/{token}` | public | the customer view for a signed token |
| `GET /unit-map/u?f=&k=&unit=` | public | the template form: checks the key, returns the view plus `token` |
| `GET /facility-ops/site-map/facilities` | Operations | which Cubby facilities have a site model |
| `GET /facility-ops/site-map?facility_id=` | Operations | the owner model, per-unit layer facts, entrance, template link |
| `POST /facility-ops/site-map/customer-link` | Operations | `{url}` for one unit |
| `PUT /facility-ops/site-map/entrance` | Operations editor | set or clear the Customer Entrance |

The Maintenance layer reads `GET /facility-ops/maintenance-map?facility_id=`,
which the maintenance work provides. Until it exists, the layer says
"Maintenance layer not connected yet".
