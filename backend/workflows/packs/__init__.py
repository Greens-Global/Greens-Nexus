"""One file per module: its entities, events, actions and list sources,
registered with the decorators in workflows/catalog.py. `load_packs()`
imports every *.py here (sorted) exactly once. A pack imports `models` and
the module's own functions - it is loaded lazily, never from database.py's
import chain."""
