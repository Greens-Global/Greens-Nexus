"""Operations > Ops Budget (Oct 21 2026) - the tables.

Each facility's monthly results against budget and against the same month last
year. Every source writes into ONE narrow table, `ops_metric_month`; the page
reads only the API (routers/ops_budget.py), which recomputes every rate from
the period's counts - rates are never stored.

  ops_budget_facilities  the five Greens sites, their fiscal-year start and
                         budget year (from the workbook's Setup tab)
  ops_metric_month       one value per facility + segment + month + scenario +
                         metric + source; NULL = not given (a typed 0 is zero)
  ops_budget_loads       one row per workbook upload (the file itself kept) and
                         one per facility-month the Cubby snapshot job wrote
  ops_budget_lead_marks  the month a Cubby lead was first seen reserved / moved
                         in - Cubby keeps a lead's current status only

Kept in its own file so the shared models.py stays untouched (the
third_party_models.py pattern); routers/ops_budget.py imports it, so main.py's
create_all builds them. Four new tables - each has an ENABLE ROW LEVEL SECURITY
line in main.py's Postgres migration list (CLAUDE.md), and the release still
runs get_advisors on dev and prod.

Aggregates only: no tenant name, contact detail or unit number is stored here.
"""
from sqlalchemy import JSON, Column, Float, Index, Integer, LargeBinary, String, Text
from sqlalchemy.orm import deferred

from database import Base


class OpsBudgetFacility(Base):
    """One site on the Ops Budget screen. `cubby_facility_id` is filled from
    the synced Cubby facility whose name carries `short_name`."""
    __tablename__ = "ops_budget_facilities"
    id                 = Column(String, primary_key=True)           # slug, e.g. "valley-center"
    name               = Column(String, default="")                 # "Greens Storage Valley Center"
    short_name         = Column(String, default="")                 # "Valley Center"
    cubby_facility_id  = Column(String, default="")
    fiscal_start_month = Column(Integer, default=1)                 # 1-12, Setup B4's month
    budget_year_start  = Column(String, default="")                 # YYYY-MM, Setup B4; '' = no budget loaded
    history_start      = Column(String, default="")                 # YYYY-MM, Setup B5
    sort_order         = Column(Integer, default=0)
    updated_at         = Column(String, default="")
    updated_by         = Column(String, default="")


class OpsMetricMonth(Base):
    """One metric for one facility, segment, month and scenario, from one
    source. Several sources may hold the same month; ops_budget.resolve picks
    (Cubby from Sep 2026, the workbook before; tows always the workbook)."""
    __tablename__ = "ops_metric_month"
    id          = Column(String, primary_key=True)                  # "<fac>:<seg>:<YYYY-MM-01>:<scenario>:<metric>:<source>"
    facility_id = Column(String, nullable=False)
    segment     = Column(String, nullable=False)                    # self_storage | vehicle
    month       = Column(String, nullable=False)                    # first of month, YYYY-MM-01
    scenario    = Column(String, nullable=False)                    # actual | budget
    metric      = Column(String, nullable=False)                    # ops_budget.METRICS key
    value       = Column(Float)                                     # NULL = blank (dash), 0 = zero
    source      = Column(String, nullable=False, default="workbook")  # workbook | cubby_api | analytics_api | reviews_api
    load_id     = Column(String, default="")
    loaded_at   = Column(String, default="")                        # UTC iso
    loaded_by   = Column(String, default="")                        # email, or "cubby-snapshot"
    __table_args__ = (Index("ix_ops_metric_month_fsm", "facility_id", "segment", "month"),)


class OpsBudgetLoad(Base):
    """A workbook upload (who, when, the file, what was read and what was
    not) or a Cubby snapshot run for one facility-month."""
    __tablename__ = "ops_budget_loads"
    id              = Column(String, primary_key=True)
    facility_id     = Column(String, default="", index=True)
    kind            = Column(String, default="workbook")            # workbook | cubby
    file_name       = Column(String, default="")
    file_sha256     = Column(String, default="")
    file_size       = Column(Integer, default=0)
    file_bytes      = deferred(Column(LargeBinary))                 # the uploaded workbook itself
    months          = Column(JSON, default=list)                    # YYYY-MM touched
    rows_written    = Column(Integer, default=0)
    unknown_headers = Column(JSON, default=list)
    missing_headers = Column(JSON, default=list)
    warnings        = Column(JSON, default=list)
    status          = Column(String, default="ok")                  # ok | failed
    error           = Column(Text, default="")
    loaded_by       = Column(String, default="")
    loaded_at       = Column(String, default="", index=True)


class OpsBudgetLeadMark(Base):
    """When a Cubby lead was first seen as a reservation and as moved in.
    '' = not yet; 'before' = it already was when tracking began (counted in
    no month - its month is not known)."""
    __tablename__ = "ops_budget_lead_marks"
    id              = Column(String, primary_key=True)              # "<cubby facility id>:<leadId>"
    facility_id     = Column(String, default="", index=True)        # cubby facility id
    segment         = Column(String, default="self_storage")
    created_month   = Column(String, default="")                    # YYYY-MM
    reserved_month  = Column(String, default="")
    converted_month = Column(String, default="")
    first_seen_at   = Column(String, default="")
    updated_at      = Column(String, default="")
