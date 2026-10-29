"""Accounting > Tools > Import Hub - the bank statement rules (Charmi, 10/27
call, item 01: "We were able to create rules for each and every transaction").

One table, `accounting_statement_rules`: a rule names the text a statement
line's description holds (contains / equals / starts with), optionally the
direction (money in or out) and the exact amount, and what such a line posts
to - the GL account, plus a vendor or customer. The screen applies them to
every upload, in priority order (lower first), so the Intacct journal entry
file comes out classified. Ported from the stand-alone Import Hub's
bank_rules (keyword, match_type, gl_code, priority, active, notes) with the
fidelity rules' direction and amount added.

Shared by the whole accounting team (the default the 10/27 spec names): no
owner column, every Accounting user reads them, editors change them. Nothing
here reaches Intacct - the file is downloaded and imported by hand.

Kept in its own file so the shared models.py stays untouched (the
ops_budget_models.py pattern); routers/import_hub.py imports it, so main.py's
create_all builds the table. New table - main.py's Postgres migration list
has its ENABLE ROW LEVEL SECURITY line (CLAUDE.md), and the release still runs
get_advisors on dev and prod.
"""
from sqlalchemy import Column, Float, Integer, String, Text

from database import Base


class AccountingStatementRule(Base):
    """One bank statement rule. `amount` NULL = any amount; set, it matches the
    line's absolute amount to the cent. `direction` any | in | out."""
    __tablename__ = "accounting_statement_rules"
    id            = Column(String, primary_key=True)
    match_text    = Column(String, default="")         # "INTEREST PAYMENT"
    match_type    = Column(String, default="contains") # contains | equals | starts_with
    direction     = Column(String, default="any")      # any | in | out
    amount        = Column(Float, nullable=True)
    account       = Column(String, default="")         # Intacct GL account number
    account_name  = Column(String, default="")
    vendor_id     = Column(String, default="")
    vendor_name   = Column(String, default="")
    customer_id   = Column(String, default="")
    customer_name = Column(String, default="")
    priority      = Column(Integer, default=100)        # lower runs first
    active        = Column(Integer, default=1)
    notes         = Column(Text, default="")
    created_by    = Column(String, default="")
    created_at    = Column(String, default="")
    updated_by    = Column(String, default="")
    updated_at    = Column(String, default="")
