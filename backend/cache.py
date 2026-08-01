"""In-process TTL caches for hot, slow-changing reads.

There is no Redis in this stack, so each of the 8 gunicorn workers keeps its
own copy - the same tradeoff auth._role_cache already made (120s TTL). What
that means for consistency: the worker that handles a write invalidates its
own copy instantly (via the session events below), and the other 7 workers
converge within one TTL. Keep TTLs short enough that a revoked grant or an
offboarded employee disappears everywhere within a minute or two, and never
cache anything where that window is unacceptable (step-up MFA state, vault
reveals, notification feeds).

Invalidation is wired centrally to the session factory rather than sprinkled
through every router: after a COMMIT that touched a watched model, the caches
mapped to it are dropped. Writers added later are covered automatically, which
scattered invalidate() calls would not be. Bulk query(...).delete()/.update()
bypass session.new/dirty, so the bulk events are hooked as well.
"""
import threading
import time

_MISS = object()


class TTLCache:
    """Thread-safe key -> value cache with one TTL per cache.

    Reads and writes never raise: any internal failure behaves as a miss, so
    callers always fall back to the real query. Use it as

        val = cache.get(key)
        if val is None:
            val = <expensive query>
            cache.set(key, val)
    """

    def __init__(self, name: str, ttl: float):
        self.name = name
        self.ttl = ttl
        self._lock = threading.Lock()
        self._data: dict = {}          # key -> (expires_at, value)
        self._loaders: dict = {}       # key -> Lock (single-flight, see get_or_load)

    def get(self, key, default=None):
        try:
            with self._lock:
                ent = self._data.get(key)
                if not ent:
                    return default
                if ent[0] < time.monotonic():
                    self._data.pop(key, None)
                    return default
                return ent[1]
        except Exception:               # noqa: BLE001 - a cache must never 500 a request
            return default

    def set(self, key, value):
        try:
            with self._lock:
                self._data[key] = (time.monotonic() + self.ttl, value)
        except Exception:               # noqa: BLE001
            pass

    def invalidate(self, key=None):
        try:
            with self._lock:
                if key is None:
                    self._data.clear()
                else:
                    self._data.pop(key, None)
        except Exception:               # noqa: BLE001
            pass

    def get_or_load(self, key, loader):
        """Miss-and-populate with single-flight: when N requests miss the same
        key at once, ONE runs `loader` and the rest wait and reuse its result,
        so an expiring hot key can't stampede the database. Loader errors
        propagate to every waiter (nothing is cached on failure) - the caller's
        normal error path is the fallback."""
        val = self.get(key, _MISS)
        if val is not _MISS:
            return val
        with self._lock:
            gate = self._loaders.setdefault(key, threading.Lock())
        with gate:
            val = self.get(key, _MISS)      # the flight we waited on may have filled it
            if val is not _MISS:
                return val
            try:
                val = loader()
            finally:
                with self._lock:
                    self._loaders.pop(key, None)
            self.set(key, val)
            return val


# The caches. TTLs bound how long the OTHER workers can serve stale data after
# a write (the writing worker drops its copy at commit).
people_directory = TTLCache("people_directory", ttl=60)    # /myhr/directory - every picker app-wide
module_grants    = TTLCache("module_grants",    ttl=120)   # auth._module_level - per grant-gated request
settings_config  = TTLCache("settings_config",  ttl=60)    # NexusSetting-backed configs (branding)
item_types       = TTLCache("item_types",       ttl=300)   # /items/types - manager-curated, near-static
role_holders     = TTLCache("role_holders",     ttl=120)   # /items/approvers + /allocators pickers
dashboard_kpis   = TTLCache("dashboard_kpis",   ttl=20)    # /dashboards/kpis - per (email,team); a dozen COUNT
                                                           # queries per load. Glanceable counts tolerate ~20s
                                                           # staleness; single-flight also collapses the burst of
                                                           # identical loads when a dashboard/its widgets mount.

# Watched model -> caches to drop when a commit touches it. HrEntity feeds the
# directory's company names; group/member rows feed the grant map; employees
# also feed the approver/allocator lists (filtered against nexus_employees).
_WATCHED = {
    "NexusEmployee":    (people_directory, role_holders),
    "HrEntity":         (people_directory,),
    "NexusGroup":       (module_grants,),
    "NexusGroupMember": (module_grants,),
    "NexusSetting":     (settings_config,),
    "ItemType":         (item_types,),
    "NexusRole":        (role_holders,),
}


def _touch(session, name: str):
    if name in _WATCHED:
        session.info.setdefault("_cache_touched", set()).add(name)


def wire(session_factory):
    """Attach the invalidation listeners to SessionLocal (called once from
    database.py). Touched models are recorded at flush time and acted on only
    at commit - a rolled-back write must not drop anything."""
    from sqlalchemy import event

    @event.listens_for(session_factory, "after_flush")
    def _record(session, _ctx):
        for obj in session.new | session.dirty | session.deleted:
            _touch(session, type(obj).__name__)

    @event.listens_for(session_factory, "after_bulk_delete")
    def _record_bulk_delete(ctx):
        if ctx.mapper is not None:
            _touch(ctx.session, ctx.mapper.class_.__name__)

    @event.listens_for(session_factory, "after_bulk_update")
    def _record_bulk_update(ctx):
        if ctx.mapper is not None:
            _touch(ctx.session, ctx.mapper.class_.__name__)

    @event.listens_for(session_factory, "after_commit")
    def _invalidate(session):
        for name in session.info.pop("_cache_touched", ()):
            for c in _WATCHED[name]:
                c.invalidate()

    @event.listens_for(session_factory, "after_rollback")
    def _discard(session):
        session.info.pop("_cache_touched", None)
