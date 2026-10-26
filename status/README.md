# Nexus Status

The Nexus status page and outage alerts. A Cloudflare Worker that lives in this
repo but runs **outside Nexus**, on Cloudflare, so the page and its alerts keep
working when Nexus is down - the moment they matter most.

## What it does

Every minute, from Cloudflare:

| Component | How it is checked |
|---|---|
| Nexus Web App | The page loads **and** its main script really is JavaScript (a 200 with the fallback HTML is the white-screen outage) |
| Nexus API | `GET /health` |
| Database, File Storage, Sign-In / Email / Teams (Microsoft 365), Reminders and Background Jobs, Modules | The API's own report, `GET /health/components` (`backend/routers/health_components.py`) |

- A component is **down** after 3 failed checks in a row (a failing probe is
  retried once inside the same minute), and **recovered** after 2 good ones.
- Going down opens an incident on the page and posts **one** Teams alert;
  recovering resolves it and posts one more. Never an alert a minute.
- While the API is down, the parts it reports on read "unknown" - the API row
  carries the outage instead of seven alerts for one problem.
- A maintenance window posted by the team silences incidents and alerts for
  the components it covers.
- History: one row per component per Pacific day, drawn as 90-day bars with
  uptime %.

Pages: `/` (the status page, refreshes every minute), `/api/status` (JSON),
`/health` (the Worker itself).

## Set it up (once)

1. **Cloudflare token.** In the Greens Cloudflare account: My Profile > API
   Tokens > Create Token > "Edit Cloudflare Workers" template, add
   **Account > D1 > Edit**, limit it to the Greens account. Save it in GitHub
   as the repo secret `CLOUDFLARE_STATUS_TOKEN`.
2. **Teams alert channel.** In Teams, on the channel that should get alerts:
   ... > Workflows > "Post to a channel when a webhook request is received".
   Save the URL it gives as `STATUS_TEAMS_WEBHOOK_URL`.
3. **Admin token.** Any long random string, as `STATUS_ADMIN_TOKEN` - it lets
   the team post incidents and maintenance (below).
4. **Deploy.** Merge to `main` (or run "Deploy Status Page" from the Actions
   tab). The workflow finds or creates the `nexus-status` D1 database, applies
   `schema.sql`, deploys, and sets the secrets. It probes the prod API at the
   existing `VITE_API_BASE` secret.
5. **Address.** The Worker answers on `nexus-status.<account>.workers.dev`.
   For `status.greensglobal.com`, add a Custom Domain to the Worker in the
   Cloudflare dashboard (Workers & Pages > nexus-status > Settings > Domains),
   and set `STATUS_PAGE_URL` in `wrangler.toml` so alerts link to it.

## Post an incident or maintenance

```bash
# An explanation for something the checks cannot see
curl -X POST https://<status-host>/api/incidents \
  -H "Authorization: Bearer $STATUS_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"title":"Time Sheets slow to load","impact":"minor","components":["api"],"message":"We are looking into it."}'

# Add an update, or resolve it
curl -X POST https://<status-host>/api/incidents/12/updates \
  -H "Authorization: Bearer $STATUS_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"status":"resolved","message":"Fixed."}'

# Planned maintenance (no alerts for those components in the window)
curl -X POST https://<status-host>/api/incidents \
  -H "Authorization: Bearer $STATUS_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"title":"Database upgrade","impact":"maintenance","components":["database","api"],
       "startsAt":"2026-11-01T06:00:00Z","endsAt":"2026-11-01T07:00:00Z","message":"Nexus may be unavailable for a few minutes."}'
```

`impact` is `minor`, `major` or `maintenance`; `status` is `investigating`,
`identified`, `monitoring` or `resolved`. Component keys: `web`, `api`,
`database`, `storage`, `microsoft365`, `backgroundJobs`, `schema`.

## Develop and test locally

No Cloudflare account or token needed - `wrangler dev` runs the Worker and a
local copy of the D1 database on your laptop.

```bash
cd status
npm test                                   # plain Node tests, no installs

# 1. Local settings (git-ignored). Point it at your local Nexus:
cat > .dev.vars <<'EOF'
NEXUS_WEB_URL=http://localhost:4173/
NEXUS_API_URL=http://127.0.0.1:8000
STATUS_PAGE_URL=http://localhost:8787/
ADMIN_TOKEN=local-admin-token
# TEAMS_WEBHOOK_URL=<a test channel's Workflows webhook, to see real alerts>
EOF

# 2. The local database tables (once)
npx wrangler@3 d1 execute nexus-status --local --file=schema.sql

# 3. Nexus running locally: the backend on :8000 as usual, and the BUILT
#    frontend on :4173 - the web check looks for the built app script, which
#    the Vite dev server (:5173) does not serve.
(cd ../frontend && npm run build && npx vite preview --port 4173)

# 4. The Worker on :8787
npx wrangler@3 dev --test-scheduled --port 8787
```

Locally the cron does not fire on its own - run one minute's check with
`curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"`, or keep it going:
`while true; do curl -s "http://localhost:8787/__scheduled?cron=*+*+*+*+*" >/dev/null; sleep 60; done`.
Then open http://localhost:8787 (or `/api/status`).

To try an outage: stop the backend, run 3 checks (a check against a stopped
port can take a few seconds on Windows) - the API goes "Major Outage" and an
incident opens; start it again and run 2 checks - it recovers and the incident
resolves. Start over with
`npx wrangler@3 d1 execute nexus-status --local --command "DELETE FROM component_state; DELETE FROM daily; DELETE FROM incidents; DELETE FROM incident_updates;"`.

## Later

Email / SMS subscribers, a Nexus screen to post incidents instead of curl,
and per-integration checks (Intacct, Egnyte, Cubby) in `/health/components`.
