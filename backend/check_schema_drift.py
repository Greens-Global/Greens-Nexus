"""Schema drift checker (Aug 1, 2026) - the guard against the Jun 17 outage class.

Model columns missing from the live database break every SELECT on that table
with a 500. This script compares every SQLAlchemy model against the database
the backend would actually talk to (DATABASE_URL, or local SQLite) and reports:

  - tables defined in models.py but absent from the DB (create_all adds these
    on boot - informational)
  - columns defined on a model but MISSING from the live table (the outage
    case - these need an ALTER line in main.py's migration lists)

Run it against dev/prod before a release (RELEASE-CHECKLIST.md step 2):

    cd backend
    python check_schema_drift.py                      # local SQLite
    DATABASE_URL=postgresql://... python check_schema_drift.py   # dev/prod

Exit code 1 when any live table is missing model columns, so CI can gate on it.
"""
import sys

from sqlalchemy import inspect

import models          # noqa: F401 - imports register every model on Base
from database import Base, engine


def main() -> int:
    insp = inspect(engine)
    db_tables = set(insp.get_table_names())
    missing_tables = []
    drifted = {}

    for table in Base.metadata.sorted_tables:
        if table.name not in db_tables:
            missing_tables.append(table.name)
            continue
        live_cols = {c["name"] for c in insp.get_columns(table.name)}
        missing = [c.name for c in table.columns if c.name not in live_cols]
        if missing:
            drifted[table.name] = missing

    print(f"database: {engine.url.render_as_string(hide_password=True)}")
    print(f"model tables: {len(Base.metadata.tables)}   live tables: {len(db_tables)}")

    if missing_tables:
        print(f"\n{len(missing_tables)} model table(s) not in DB yet (create_all adds on boot):")
        for t in missing_tables:
            print(f"  - {t}")

    if drifted:
        print(f"\nDRIFT - {len(drifted)} live table(s) missing model columns (500s on SELECT!):")
        for t, cols in sorted(drifted.items()):
            print(f"  - {t}: {', '.join(cols)}")
        print("\nFix: add ALTER TABLE ... ADD COLUMN IF NOT EXISTS lines to BOTH "
              "migration lists in main.py and pre-apply to the live DB.")
        return 1

    print("\nno column drift - every live table has every model column")
    return 0


if __name__ == "__main__":
    sys.exit(main())
