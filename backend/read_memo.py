"""Session read memo for long READ-ONLY roster passes (Oct 23 2026).

The Compensation report prices every person's payroll card for up to twelve
months through Time Clock's engine. The engine was written for one card at a
time, so it asks the database the same thing over and over: the rounding
and break settings, the person's rate row, their employee row, their
company's policy and holidays - about 26 round trips per person per month,
~14,000 for 60 people over 9 months. Against the hosted Postgres pooler that
is minutes of pure latency, which is why the report "never finished".

`memoized(db)` answers an identical ORM SELECT from the first answer for as
long as the block runs: same SQL, same parameters, same execution options =
the same rows. Nothing about WHAT is read or how it is priced changes - the
engine is untouched and still the one pay calculation. It is safe because:

  - only plain SELECTs are kept (no FOR UPDATE, no lazy / refresh loads);
  - the whole memo is dropped on any flush, commit or rollback, so a write
    made inside the block (Time Clock creates a missing monitoring policy on
    first read) is never answered from before it;
  - it lives on ONE session and only inside the `with`, so nothing else in
    the app ever sees it.

`deadline` (a time.monotonic() value) turns the block into a time budget:
the first query after it raises `TimeBudgetExceeded`, so a pass that runs
too long stops promptly instead of holding a worker for minutes.
"""
import time
from contextlib import contextmanager

from sqlalchemy import event

_SIMPLE = (str, int, float, bool, type(None))


class TimeBudgetExceeded(Exception):
    """The block's deadline passed - the pass was stopped part way."""


def _key(state):
    """SQLAlchemy's own statement cache key (the shape of the SQL) plus every
    bound value - far cheaper than compiling the SQL text. None = the
    statement cannot be keyed, so it is not memoized."""
    ck = state.statement._generate_cache_key()
    if ck is None:
        return None
    opts = sorted((k, v) for k, v in (state.execution_options or {}).items() if isinstance(v, _SIMPLE))
    params = state.parameters
    return (ck.key, repr([b.effective_value for b in ck.bindparams]),
            repr(sorted(params.items())) if isinstance(params, dict) else repr(params), repr(opts))


@contextmanager
def memoized(db, deadline: float | None = None, stats: dict | None = None):
    """Identical SELECTs inside the block run once. `stats` (optional) counts
    hits and misses for tests."""
    memo: dict = {}
    counts = stats if stats is not None else {}
    counts.setdefault("hits", 0)
    counts.setdefault("misses", 0)

    def on_execute(state):
        if deadline is not None and time.monotonic() > deadline:
            # Recorded as well as raised: a caller that swallowed the raise
            # somewhere deep must still not trust the pass.
            counts["tripped"] = True
            raise TimeBudgetExceeded()
        if not state.is_select or state.is_column_load or state.is_relationship_load:
            return None
        if getattr(state.statement, "_for_update_arg", None) is not None:
            return None
        try:
            key = _key(state)
        except Exception:   # noqa: BLE001 - a statement we cannot key simply runs
            return None
        if key is None:
            return None
        hit = memo.get(key)
        if hit is not None:
            counts["hits"] += 1
            return hit()
        counts["misses"] += 1
        frozen = state.invoke_statement().freeze()
        memo[key] = frozen
        return frozen()

    def drop(*_a, **_k):
        memo.clear()

    event.listen(db, "do_orm_execute", on_execute)
    for name in ("after_flush", "after_commit", "after_rollback"):
        event.listen(db, name, drop)
    try:
        yield counts
    finally:
        event.remove(db, "do_orm_execute", on_execute)
        for name in ("after_flush", "after_commit", "after_rollback"):
            event.remove(db, name, drop)
        memo.clear()
