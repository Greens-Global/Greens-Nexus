"""The engine's own exceptions. `TransientError` marks a failure worth a
retry (a 5xx from a webhook host, a Graph outage); the engine also treats
`graph_mail.GraphMailError`, `httpx.TransportError` and SQLAlchemy's
`OperationalError` as transient (spec 6.6: 3 retries with backoff)."""


class TransientError(Exception):
    """Raised by an action when the failure is likely to pass."""


class StepRefused(Exception):
    """Raised by the engine when an action's `allowed` rule says no - the
    step fails at once with the readable reason, never retried."""
