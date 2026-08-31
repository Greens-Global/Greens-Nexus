#!/bin/bash
# B3 plan = 4 vCPU, 7 GB RAM. Formula: 2*vCPU+1 = 9, use 8 to leave headroom.
# --keep-alive 65 avoids Azure load balancer / TCP keepalive mismatch that causes
# random dropped connections. --timeout 120 gives slow operations (reports,
# batch checkouts) room without gunicorn SIGKILLing the worker mid-request.
#
# NOTE (Aug 31): this file is almost certainly NOT what boots the app on Azure.
# It read `--keepalive 65`, which gunicorn has never accepted as a CLI flag -
# `keepalive` is the CONFIG-FILE name, the flag is `--keep-alive`. On the pinned
# gunicorn 22.0.0 that line exits 2 without starting anything, yet the API is up,
# so the live Startup Command must come from App Service configuration (portal)
# rather than from here - the deploy workflow sets none. Corrected regardless, so
# this is runnable if anything ever does use it; but changing the worker flags
# HERE will not change the running app. Do that in the portal too.
# --max-requests retires a worker after ~1000 requests and respawns it. Without
# it a worker lives forever, and an Azure deploy that writes the new files but
# does NOT restart gunicorn's master leaves the fleet serving TWO code versions
# at once, indefinitely: after the Aug 31 dev deploy (workflow green, files in
# place) the same instance answered one request from a new worker and the next
# from a stale one for 25+ minutes with no sign of converging. Recycling makes
# any deploy settle by itself within minutes. --max-requests-jitter staggers the
# retirements so all 8 workers never go down together and drop a burst of
# requests. Workers do NOT --preload, so each respawn re-imports main:app and
# therefore picks up whatever is on disk - which is what makes this work.
gunicorn -w 8 -k uvicorn.workers.UvicornWorker main:app --bind 0.0.0.0:8000 --timeout 120 --keep-alive 65 \
  --max-requests 1000 --max-requests-jitter 100
