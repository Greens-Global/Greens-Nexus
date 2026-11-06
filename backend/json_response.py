"""Render a big JSON answer inside a sync route's thread, not on the event loop.

FastAPI turns a returned dict into bytes (jsonable_encoder + json.dumps) in its
async request handler - ON THE EVENT LOOP, even for a plain `def` route. For a
multi-megabyte answer that freezes the whole worker: every other request it is
serving waits (11/05/2026: GET /tasks/delta is ~11 MB on dev; a local repro of
a 6,500-row answer held a trivial /ping for 2.5 s). A route that returns a
ready Response skips that step, so the work happens in the threadpool the
route already runs in. Same bytes as FastAPI's default, which builds exactly
JSONResponse(jsonable_encoder(...)).

Register the wrapper, keep the plain function for Python callers (tests and
other routes call these directly and read the dict):

    def list_things(...): ...
    router.get("/things")(rendered_in_thread(list_things))
"""
import functools

from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse


def rendered_in_thread(fn):
    @functools.wraps(fn)   # FastAPI reads the dependencies from fn's signature
    def route(*args, **kwargs):
        return JSONResponse(jsonable_encoder(fn(*args, **kwargs)))
    return route
