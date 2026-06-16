#!/bin/bash
# B3 plan = 4 vCPU, 7 GB RAM. Formula: 2*vCPU+1 = 9, use 8 to leave headroom.
# --keepalive 65 avoids Azure load balancer / TCP keepalive mismatch that causes
# random dropped connections. --timeout 120 gives slow operations (reports,
# batch checkouts) room without gunicorn SIGKILLing the worker mid-request.
gunicorn -w 8 -k uvicorn.workers.UvicornWorker main:app --bind 0.0.0.0:8000 --timeout 120 --keepalive 65
