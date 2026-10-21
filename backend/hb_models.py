"""Hummingbird (HB) mirror tables (Oct 21 2026).

Greens Storage ran its five sites on Hummingbird until the Cubby cutover
(Sep 15 2026). A full export was pulled from HB's API on Sep 12 2026. The
loader (`python -m hb_load <folder>`, hb_load.py) copies it into these
tables, the same shape as the cubby_* mirror: a few typed columns for what
Nexus filters on, and `data` for the rest of HB's fields.

  hb_loads          one row per loader run: files, their generated_at, counts
  hb_properties     the 5 sites, mapped to the Ops Budget facility and Cubby
  hb_units          every space with its unit type (Cubby pricing group name)
  hb_leases         every lease HB had (active and closed)
  hb_lease_months   one lease's money in one month (invoices by due month,
                    payments by date) - the raw invoice/ledger lines are not kept
  hb_leads          inquiries, without the contact
  hb_report_rows    row-shaped HB reports: space activity, rental activity,
                    transfers, insurance coverage
  hb_reports        HB's summary reports as returned (management summary,
                    occupancy statistics, ...) per property
  hb_rate_months    DERIVED by hb_history.rebuild: per site, unit type and
                    month - sell rate, in-place rent, units, occupied. CMA
                    Rate History reads it.

Privacy (the Cubby mirror's rule): every row is cleaned by hb_load.clean
before it is written - no tenant name, email, phone, address, date of birth,
ID number or contact block, no free-text notes. A lease keeps HB's lease id
and unit only.

Kept out of models.py (the ops_budget_models.py pattern); routers/ops_budget
imports it so main.py's create_all builds the tables. Each has an ENABLE ROW
LEVEL SECURITY line in main.py's Postgres migration list.
"""
from sqlalchemy import JSON, Column, Float, Index, Integer, String, Text

from database import Base


class HbLoad(Base):
    __tablename__ = "hb_loads"
    id          = Column(String, primary_key=True)
    started_at  = Column(String, default="", index=True)
    finished_at = Column(String, default="")
    loaded_by   = Column(String, default="")
    status      = Column(String, default="running")             # running | ok | failed
    files       = Column(JSON, default=list)                    # [{name, size, sha256, generatedAt}]
    counts      = Column(JSON, default=dict)                    # {table: rows written}
    sites       = Column(JSON, default=list)                    # per-site summary of what the rebuild produced
    warnings    = Column(JSON, default=list)
    error       = Column(Text, default="")


class HbProperty(Base):
    __tablename__ = "hb_properties"
    id                = Column(String, primary_key=True)        # HB property id
    name              = Column(String, default="")              # "Greens Storage, Temecula" (trimmed)
    short_name        = Column(String, default="")              # "Temecula"
    number            = Column(String, default="")              # HB facility number, "01"
    ops_facility_id   = Column(String, default="")              # ops_budget_facilities.id, "temecula"
    unit_count        = Column(Integer, default=0)
    go_live           = Column(String, default="")              # YYYY-MM-DD: first move-out HB recorded
    exported_at       = Column(String, default="")              # the export's generated_at
    data              = Column(JSON, default=dict)
    load_id           = Column(String, default="")


class HbUnit(Base):
    __tablename__ = "hb_units"
    id            = Column(String, primary_key=True)            # HB unit id
    property_id   = Column(String, index=True, nullable=False)
    number        = Column(String, default="")
    space_type    = Column(String, default="")                  # storage | parking | mailbox
    category      = Column(String, default="")                  # "Storage - Interior, Lower"
    width         = Column(Float)
    length        = Column(Float)
    unit_type     = Column(String, default="")                  # "10' x 10' Storage - Interior, Lower" (Cubby's pricing group name)
    state         = Column(String, default="")                  # Leased | Available | Inactive | ... at export
    price         = Column(Float)                               # sell (web) rate at export, dollars
    set_rate      = Column(Float)                               # standard rate at export, dollars
    data          = Column(JSON, default=dict)
    load_id       = Column(String, default="")


class HbLease(Base):
    __tablename__ = "hb_leases"
    id                = Column(String, primary_key=True)        # HB lease id
    property_id       = Column(String, index=True, nullable=False)
    unit_id           = Column(String, default="", index=True)
    status            = Column(Integer, default=0)              # 1 = a real tenancy; 0 = never completed
    standing          = Column(String, default="")              # Current | Lease Closed | Delinquent | ...
    start_date        = Column(String, default="")              # YYYY-MM-DD (move-in)
    end_date          = Column(String, default="")              # YYYY-MM-DD (move-out); '' = still in
    rent              = Column(Float)                           # last rent, dollars
    move_in_rent      = Column(Float)                           # active leases only
    is_transferred    = Column(Integer, default=0)
    has_autopay       = Column(Integer)                         # at export; NULL = not known
    decline_insurance = Column(Integer)
    total_rent_raises = Column(Integer)
    last_rent_raise   = Column(String, default="")
    auction_status    = Column(String, default="")
    data              = Column(JSON, default=dict)
    load_id           = Column(String, default="")


class HbLeaseMonth(Base):
    """One lease's money in one month. Invoices count in the month they are
    DUE, payments in the month they were made. `data` keeps each invoice's
    due day and amount and each payment's day and amount (no description,
    no method) - the aging needs them."""
    __tablename__ = "hb_lease_months"
    id          = Column(String, primary_key=True)              # "<lease id>:<YYYY-MM>"
    lease_id    = Column(String, index=True, nullable=False)
    property_id = Column(String, index=True, nullable=False)
    month       = Column(String, nullable=False)                # YYYY-MM
    rent        = Column(Float)                                 # the month's recurring rent (auto invoice less insurance)
    invoiced    = Column(Float, default=0)                      # invoice subtotals (rent + fees + insurance), by period start
    discounts   = Column(Float, default=0)
    insurance   = Column(Float, default=0)
    charged     = Column(Float, default=0)                      # invoice totals due this month (after discounts, with tax)
    paid        = Column(Float, default=0)                      # payments and credits made this month
    data        = Column(JSON, default=dict)
    load_id     = Column(String, default="")
    __table_args__ = (Index("ix_hb_lease_months_pm", "property_id", "month"),)


class HbLead(Base):
    __tablename__ = "hb_leads"
    id          = Column(String, primary_key=True)
    property_id = Column(String, index=True, nullable=False)
    created     = Column(String, default="")                    # YYYY-MM-DD HH:MM:SS
    status      = Column(String, default="")
    source      = Column(String, default="")
    lease_id    = Column(String, default="")
    unit_id     = Column(String, default="")
    category_id = Column(String, default="")
    data        = Column(JSON, default=dict)
    load_id     = Column(String, default="")


class HbReportRow(Base):
    """A row of a row-shaped HB report, cleaned. kind: space_activity |
    move_in | move_out | transfer | coverage."""
    __tablename__ = "hb_report_rows"
    id          = Column(String, primary_key=True)              # "<kind>:<hash of the row>"
    kind        = Column(String, nullable=False)
    property_id = Column(String, index=True, nullable=False)
    day         = Column(String, default="")                    # YYYY-MM-DD
    lease_id    = Column(String, default="")
    unit_id     = Column(String, default="")
    data        = Column(JSON, default=dict)
    load_id     = Column(String, default="")
    __table_args__ = (Index("ix_hb_report_rows_kp", "kind", "property_id"),)


class HbReport(Base):
    __tablename__ = "hb_reports"
    id          = Column(String, primary_key=True)              # "<kind>:<property id or company>[:<group>]"
    kind        = Column(String, nullable=False)
    property_id = Column(String, default="", index=True)
    as_of       = Column(String, default="")                    # the export's day
    data        = Column(JSON, default=dict)
    load_id     = Column(String, default="")


class HbRateMonth(Base):
    """Derived (hb_history.rebuild). Money in cents, like the CMA tables."""
    __tablename__ = "hb_rate_months"
    id           = Column(String, primary_key=True)             # "<property id>|<unit type>|<YYYY-MM>"
    property_id  = Column(String, index=True, nullable=False)
    unit_type    = Column(String, nullable=False)
    month        = Column(String, nullable=False)               # YYYY-MM
    sell_cents   = Column(Integer)                              # median sell rate of the type's units at month-end
    rent_cents   = Column(Integer)                              # average in-place rent of the rented units
    units        = Column(Integer, default=0)                   # rentable units
    occupied     = Column(Integer, default=0)
    observations = Column(Integer, default=0)                   # sell-rate readings HB recorded this month
    built_at     = Column(String, default="")
    __table_args__ = (Index("ix_hb_rate_months_pt", "property_id", "unit_type"),)
