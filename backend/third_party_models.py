"""Third-party managed properties (Operations, Oct 20 2026 - Neil's Ops call).

Some Greens stores are run on another operator's system: the three Texas
stores (Austin, Sachse, Georgetown) are managed by CubeSmart and never reach
Cubby. Their figures come in as CubeSmart's own reports - the SRE ("Summary of
Rental Experience") month table from CubeSmart's Qlik site, the SmartView
Daily Flash, and the monthly rent roll - uploaded by ops (or, later, fetched
nightly; see third_party_fetch.py, OFF by default).

Kept in its own file so the shared models.py stays untouched; main.py imports
it before create_all. Five new tables - each has an ENABLE ROW LEVEL SECURITY
line in main.py's Postgres migration list (CLAUDE.md), and the release still
runs get_advisors on dev and prod.

No customer data is stored anywhere here: the rent roll keeps unit, size and
attribute only (see third_party_parse.parse_rent_roll).
"""
from sqlalchemy import JSON, Boolean, Column, Float, Integer, String, Text, UniqueConstraint

from database import Base


class ThirdPartyProperty(Base):
    """One store run by an outside operator, and where it lives in Nexus:
    `site_model_id` is its Site Model (backend/site_models/<id>.json),
    `property_asset_id` its Asset Management portfolio row (property_assets.id,
    soft link - empty until someone maps it)."""
    __tablename__ = "third_party_properties"
    id                = Column(String, primary_key=True)          # slug, e.g. "cubesmart-6992"
    source            = Column(String, default="cubesmart", index=True)   # cubesmart | ...
    store_number      = Column(String, default="", index=True)    # the operator's store id (CubeSmart 6992)
    name              = Column(String, default="")                # "Greens Storage Austin"
    short_name        = Column(String, default="")                # "Austin" - the Operations picker pill
    site_model_id     = Column(String, default="")
    property_asset_id = Column(String, default="")
    time_zone         = Column(String, default="America/Chicago")
    fetch_enabled     = Column(Boolean, default=False)            # nightly fetch for THIS store (also needs the global switch)
    enabled           = Column(Boolean, default=True)
    created_at        = Column(String, default="")
    updated_at        = Column(String, default="")
    __table_args__ = (UniqueConstraint("source", "store_number", name="ux_third_party_source_store"),)


class ThirdPartySreMonth(Base):
    """One store-month of the SRE Summary (Rental Activity + Revenue & AR).
    Money in dollars as the report shows it; percentages as 0-100. A later
    upload of the same month replaces the row (upsert on property + month)."""
    __tablename__ = "third_party_sre_months"
    id                   = Column(String, primary_key=True)
    property_id          = Column(String, nullable=False, index=True)
    month                = Column(String, nullable=False)          # YYYY-MM
    # Rental Activity
    total_cubes_avail    = Column(Integer)
    rented_during_month  = Column(Integer)
    vacated_during_month = Column(Integer)
    net_rentals          = Column(Integer)
    total_company_cubes  = Column(Integer)
    total_maint_cubes    = Column(Integer)
    cubes_occ_eom        = Column(Integer)
    pct_rented_cube      = Column(Float)
    pct_rented_sqft      = Column(Float)
    pct_ncc              = Column(Float)
    pct_cc               = Column(Float)
    pct_up               = Column(Float)
    pct_down             = Column(Float)
    pct_in               = Column(Float)
    pct_out              = Column(Float)
    budget_sf_occupancy  = Column(Float)
    los_days             = Column(Float)
    los_months           = Column(Float)
    los_value            = Column(Float)
    # Revenue & AR
    rental_revenue       = Column(Float)
    fee_revenue          = Column(Float)
    insurance_revenue    = Column(Float)
    merchandise_revenue  = Column(Float)
    other_revenue        = Column(Float)
    total_revenue        = Column(Float)
    promo_discounts      = Column(Float)
    promo_move_ins       = Column(Integer)
    write_offs           = Column(Float)
    ar_0_30              = Column(Float)
    ar_31_60             = Column(Float)
    ar_61_90             = Column(Float)
    ar_91_plus           = Column(Float)
    ar_total             = Column(Float)
    extra                = Column(JSON, default=dict)               # report lines Nexus does not map yet, kept by label
    import_id            = Column(String, default="")
    updated_at           = Column(String, default="")
    __table_args__ = (UniqueConstraint("property_id", "month", name="ux_third_party_sre_property_month"),)


class ThirdPartyFlashDay(Base):
    """One store-day of the SmartView Daily Flash. Upsert on property + day."""
    __tablename__ = "third_party_flash_days"
    id                     = Column(String, primary_key=True)
    property_id            = Column(String, nullable=False, index=True)
    day                    = Column(String, nullable=False)        # YYYY-MM-DD, the "as of" day
    # Net Rentals table
    move_ins_day           = Column(Integer)
    move_ins_day_budget    = Column(Integer)
    move_ins_mtd           = Column(Integer)
    move_ins_mtd_budget    = Column(Integer)
    move_ins_mtd_py        = Column(Integer)
    move_outs_day          = Column(Integer)
    move_outs_day_budget   = Column(Integer)
    move_outs_mtd          = Column(Integer)
    move_outs_mtd_budget   = Column(Integer)
    move_outs_mtd_py       = Column(Integer)
    # Occupancy by Status (cubes and square feet)
    total_cubes            = Column(Integer)
    total_sqft             = Column(Integer)
    occupied_cubes         = Column(Integer)
    occupied_sqft          = Column(Integer)
    vacant_cubes           = Column(Integer)
    vacant_sqft            = Column(Integer)
    reserved_cubes         = Column(Integer)
    reserved_sqft          = Column(Integer)
    damaged_cubes          = Column(Integer)
    damaged_sqft           = Column(Integer)
    unrentable_cubes       = Column(Integer)
    unrentable_sqft        = Column(Integer)
    # Revenue: MTD / Budget / Prior Year (dollars)
    accrued_rent_mtd       = Column(Float)
    accrued_rent_budget    = Column(Float)
    accrued_rent_py        = Column(Float)
    fees_mtd               = Column(Float)
    fees_budget            = Column(Float)
    fees_py                = Column(Float)
    insurance_mtd          = Column(Float)
    insurance_budget       = Column(Float)
    insurance_py           = Column(Float)
    merchandise_mtd        = Column(Float)
    merchandise_budget     = Column(Float)
    merchandise_py         = Column(Float)
    revenue_mtd            = Column(Float)
    revenue_budget         = Column(Float)
    revenue_py             = Column(Float)
    discount_mtd           = Column(Float)
    discount_budget        = Column(Float)
    discount_py            = Column(Float)
    write_offs_mtd         = Column(Float)
    write_offs_budget      = Column(Float)
    write_offs_py          = Column(Float)
    net_revenue_mtd        = Column(Float)
    net_revenue_budget     = Column(Float)
    net_revenue_py         = Column(Float)
    extra                  = Column(JSON, default=dict)
    import_id              = Column(String, default="")
    updated_at             = Column(String, default="")
    __table_args__ = (UniqueConstraint("property_id", "day", name="ux_third_party_flash_property_day"),)


class ThirdPartyRentRoll(Base):
    """A rent roll as of a day: the RENTED units only (unit, size, attribute) -
    never a customer name, rate or date. The Site Model of the property paints
    its occupancy from the newest one. Upsert on property + as-of day."""
    __tablename__ = "third_party_rent_rolls"
    id          = Column(String, primary_key=True)
    property_id = Column(String, nullable=False, index=True)
    as_of       = Column(String, nullable=False)                   # YYYY-MM-DD
    units       = Column(JSON, default=list)                       # [{"n": "1003", "size": "10X15", "attr": "CE"}]
    unit_count  = Column(Integer, default=0)
    import_id   = Column(String, default="")
    updated_at  = Column(String, default="")
    __table_args__ = (UniqueConstraint("property_id", "as_of", name="ux_third_party_rent_roll_property_day"),)


class ThirdPartyImport(Base):
    """One saved upload or nightly fetch: who, what, how many rows. `error`
    never carries a credential or a cell value from a rent roll."""
    __tablename__ = "third_party_imports"
    id          = Column(String, primary_key=True)
    property_id = Column(String, default="", index=True)
    kind        = Column(String, default="")                       # sre | flash | rent_roll
    via         = Column(String, default="upload")                 # upload | fetch
    file_name   = Column(String, default="")
    rows        = Column(Integer, default=0)
    status      = Column(String, default="ok")                     # ok | failed | skipped
    error       = Column(Text, default="")
    created_by  = Column(String, default="")
    created_at  = Column(String, default="", index=True)
