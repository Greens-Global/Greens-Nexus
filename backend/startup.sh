#!/bin/bash
# B1 plan = 1 vCPU. 4 workers meant 4 separate connection pools (60 DB conns
# total) and ~160 threadpool threads fighting over one core — under load that
# starved the DB pool and caused 20-50s tail latencies. 2 workers halves both,
# and --timeout gives slow requests room before gunicorn SIGKILLs the worker
# (the default 30s was killing in-flight requests mid-query under load).
gunicorn -w 2 -k uvicorn.workers.UvicornWorker main:app --bind 0.0.0.0:8000 --timeout 60
