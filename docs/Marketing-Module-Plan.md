# Marketing Module - Implementation Plan

Make the Marketing module real. Today it is a polished front end (`frontend/src/marketing/`,
~13.5k lines, six tabs) running entirely on seeded mock data. This plan replaces the mocks
tab by tab, in the order that delivers value soonest with the fewest outside dependencies.

Owner: Sagar (handed over from Pranshu, Oct 6 2026).

---

## Where it stands (Oct 6, 2026)

**Nothing persists.** The module makes no API calls and uses no storage. Every edit (lead
stage, review reply, budget, post, tracked keyword) lives in React `useState` and is lost on
refresh, or even on switching tabs (`Marketing.jsx` keys each page on `tab`, so it remounts).

**"Today" is frozen** at `ANCHOR_DATE = '2025-06-30'` (`shared/utils.js:1`); every seed covers
Jan-Jun 2025.

**Data is generated** with a seeded PRNG (`mulberry32`) in each tab's `data.js`. Several tabs
already isolate the source behind an adapter written against the real API's response shape -
those are the seams to plug into:

| Tab | Mock files | Imitates | Adapter seam |
|---|---|---|---|
| Google Ads | `googleAds/data.js` | Google Ads API `GoogleAdsService.Search` | `googleAdsApi.js` (`adaptGoogleAdsReport`) |
| Reputation | `reputation/data.js` (`allReviews`) | GBP reviews, Facebook recommendations, aggregators | none |
| Listings | `gbpContentData.js`, `profileData.js`, `facebookContentData.js`, `instagramContentData.js` | GBP API (localPosts, media, Q&A), GBP Performance API, Meta Graph API | `gbpContentApi.js`, `gbpApi.js` |
| Insights | `insights/data.js`, `ga4.js` | GA4 Data API `runReport`; NPS from a survey tool | `ga4.js` parse functions |
| SEO | `seo/data.js`, `localSearchData.js`, `websitePerformanceData.js` | Rank tracker, keyword tool, Search Console, CrUX | none |
| Leads | `leads/data.js` (54 leads, hardcoded `STAFF`) | CRM / web forms / call tracking | none |

**"AI" is rules, not a model.** `aiReplyEngine.js` (review replies) is a template engine with a
placeholder phone `(916) 555-1234`; `insightEngine.js` (AI Analyst, insight cards) is a
deterministic rule set. Neither calls an LLM.

**Alerts read the static seeds**, not page state (`shared/alerts.js`,
`insights/buildAccountWideInsightInput.js`), so answering a review never clears its alert.
Dismissals live in a Set and come back on reload.

**Properties are hardcoded strings.** `shared/facilities.js` lists five facility names and two
regions; those names are the join key for campaigns, reviews, GBP locations, GA4, budgets,
goals and keyword URLs.

**Permissions are not enforced.** The view is gated at `supervisor` (`App.jsx:129`) and
`moduleCapabilities.js` describes viewer/editor/full/owner, but nothing in `marketing/` checks
them - every viewer can do every write.

**Backend is a stub.** `routers/marketing.py` is one `GET /marketing-campaigns` over
`MarketingCampaign` (seeded with unrelated "Harbor View"-style properties), not behind
`require_module_grant`; `api.getCampaigns` is never called. `routers/reviews.py` + `models.Review`
is an older unused reviews API.

---

## Principles

- **Nexus stores what only Nexus knows; external platforms stay the source of truth for their
  own data.** Leads, notes, assignments, goals, budgets, alert state and tracked-keyword lists
  live in Nexus tables. Ad spend, sessions, rankings and reviews are read from the platform,
  cached server-side, never keyed in.
- **All external calls are server-side.** Credentials never reach the browser. Tokens use
  `secret_box` encryption (as `egnyte_oauth.py` does). Syncs run as a `*_loop` in `main.py`'s
  lifespan with every DB query and HTTP call inside `asyncio.to_thread` (CLAUDE.md).
- **Keep the UI; swap the data.** Replace each `data.js` export with a hook over `api.js`, using
  `AsyncSection` / `SkeletonBlocks` while loading. Do not redesign screens in the same change.
- **Writes are gated** by `require_module_grant("marketing", "editor")` on the server and the
  same capability check in the UI (hide/disable, never just fail).
- **Read before write against external platforms.** Phase 1 of every integration is read-only.
  Creating campaigns or posting to Google from Nexus comes later, if at all - until then those
  buttons deep-link to the platform.
- New tables get RLS enabled on dev and prod; new columns go in both migration lists.

---

## Phase 0 - Foundations (no outside credentials)

**Backend**
- `marketing_facilities` table: `id` (slug), `name`, `region`, `active`, plus the per-platform
  mapping each later phase fills in: `google_ads_customer_id`, `google_ads_campaign_ids` (JSON),
  `gbp_location_name`, `ga4_property_id` / `ga4_hostname`, `fb_page_id`, `ig_account_id`,
  `site_url`, `phone`. Seed the current five. Link to `property_assets.id` where one exists
  (nullable - not every marketed facility is in Asset Management yet).
- `routers/marketing.py` rewritten under `/marketing`, with `require_module_grant("marketing")`
  on the router and `"editor"` on writes. Update the `auth.py` external-path entry.
- `GET/PUT /marketing/facilities` (Full level to edit the platform mapping).
- `marketing_settings` (per facility, per month): `ad_budget`, `lead_goal`. Replaces
  `monthlyBudgetByPropertyDefault` / `leadGoalByPropertyDefault`.
- `marketing_alert_dismissals` (alert key, user, dismissed_at).
- Retire `MarketingCampaign` usage and its seed rows; keep the table and model (no drops).

**Frontend**
- `useMarketingFacilities()` replaces `shared/facilities.js` everywhere.
- Remove `ANCHOR_DATE`; `thisMonth()` / `lastMonth()` use the real date (`lib/datetime.js`).
- Capability checks on every write control.
- Alerts compute from live page data (not the seeds); dismissals persist via the API.

## Phase 1 - Leads (no outside credentials, highest daily value)

**Backend**
- `marketing_leads`: id, facility_id, name, email, phone, source, stage
  (`new | contacted | toured | move_in | lost`), captured_at, stage_changed_at,
  assigned_to_email, lost_reason, created_by, timestamps.
- `marketing_lead_notes` and a stage-history table (powers time-in-stage and response-time
  metrics instead of computing from a single `stageChangedDate`).
- CRUD + `PATCH /marketing/leads/{id}/stage` + notes endpoints.
- Assignment notifies the assignee server-side (`_notify` pattern from `items.py`, one
  notification per lead, targeted recipient).
- **Intake**: `POST /marketing/leads/intake` - public, keyed by a per-source secret, rate
  limited (`SENSITIVE_PREFIXES`) - so the website form can post leads directly. Dedupe on
  email/phone + facility within N days.

**Frontend**
- Leads tab on the API: kanban drag, assign (people picker = `getPeopleDirectory()`, replacing
  hardcoded `STAFF`), notes, Add Lead. Use the shell's property filter instead of its own.
- Insights' lead counts and response-time rules read real leads.

## Phase 2 - Reviews and Google Business Profile

Needs: a Google Cloud project with Business Profile API access (Google approval takes days to
weeks - **request it at the start of Phase 0**), OAuth by an account that manages the five
locations.

- Sync reviews into `marketing_reviews` (platform, external id, facility, rating, text,
  reviewer, reviewed_at, reply text, replied_at, reply status). Posting a reply goes to GBP via
  the API.
- GBP Performance API for profile views / calls / direction requests; search-keyword
  impressions monthly.
- Q&A: Google retired the Business Profile Q&A API (late 2025 - confirm before Phase 2); if so,
  drop the Q&A section rather than wire it.
- Posts and photos: read first; creating posts from Nexus is a later option.
- **Review reply drafts via Claude** (`ai_assistant.py` already calls the Anthropic API):
  replace the template engine, with the facility's real phone and the reviewer's specifics.
  A person always approves before anything is posted.
- Facebook / Instagram (Meta Graph API, Page access token) follows the same shape - separate
  sub-phase, only if marketing actually uses those channels.

## Phase 3 - Google Ads

Needs: Google Ads developer token (apply from a manager account - Basic access approval can
take a while; **request at the start**), OAuth client, MCC/customer ids.

- Nightly + on-demand sync of daily metrics per campaign, geo, keyword and device into
  `marketing_ads_daily` (date, campaign id, metrics). Map campaigns to facilities through
  `marketing_facilities.google_ads_campaign_ids`.
- `adaptGoogleAdsReport` stays; the server returns the same shape.
- Budget pacing compares real spend to `marketing_settings.ad_budget`.
- New / Edit Campaign and status toggles become "Open in Google Ads" links in this phase.

## Phase 4 - Website analytics (GA4) and Insights

Needs: GA4 service account with Viewer on the property, and a way to split traffic by facility
(per-page path or a custom dimension - confirm with whoever runs the site).

- Daily sessions by channel and facility, plus `generate_lead` / move-in events, cached in
  `marketing_ga4_daily`.
- Move-ins should come from the storage management system if one exists (see Open questions),
  not from a GA4 event.
- Insight rules run server-side on real data; the AI Analyst button gets a Claude summary over
  the computed insights (numbers come from the rules, the model only writes the prose).
- NPS: drop it unless a survey tool is in use.

## Phase 5 - SEO

Needs: Google Search Console access (free) and, for rankings / keyword volume, a paid provider
(e.g. DataForSEO, Semrush API) - a budget decision.

- Tracked keywords become a Nexus table (`marketing_tracked_keywords` + daily position history).
- Search Console for clicks / impressions / position / top landing pages; CrUX API (free) for
  Core Web Vitals.
- Keyword Explorer and map-pack positions depend on the paid provider; hide those cards until
  it is chosen.

---

## Data-model summary (new tables)

`marketing_facilities`, `marketing_settings`, `marketing_alert_dismissals`, `marketing_leads`,
`marketing_lead_notes`, `marketing_lead_stage_history`, `marketing_reviews`,
`marketing_integration_tokens` (encrypted), `marketing_ads_daily`, `marketing_ga4_daily`,
`marketing_tracked_keywords`, `marketing_keyword_positions`. All prefixed `marketing_` (the data
dictionary already groups them); RLS on every one.

## Open questions (for Neil / marketing)

1. **Where do leads come from today?** Website form, phone calls, the storage management
   software (SiteLink / storEDGE / other)? If that software already tracks leads and move-ins,
   Leads should sync from it rather than be a second CRM.
2. Who owns the Google Ads, GBP, GA4 and Meta accounts, and can they grant API access?
3. Are the five facilities and two regions in `facilities.js` the complete, current list?
4. Is a paid SEO data provider in budget?
5. Should campaign creation / GBP posting ever happen from Nexus, or is read + deep-link enough?
6. Who should see Marketing - is the `supervisor` view gate right, or should it be grant-only?

## Verification (per phase)

`ruff check backend/`, `npm run lint`, `npx vitest run`, `npm run build` green; one backend test
file per phase run on its own (CLAUDE.md); a render-smoke test for each tab once it reads the
API; drive the flow locally with skip-auth (add lead, drag stage, assign, refresh - still there).
