"""Filing & Sorting rules (Documents > Filing & Sorting, Nov 2026).

The canonical name grammar and doc-type classifier from the Filing Rulebook v1,
which reconciles the four File Sorting & Naming SOPs in
/Shared/Resources/File Naming Guide/ (the SOPs disagreed with each other on
date position, month-folder names and separators - that disagreement is why
hand labeling diverged). Grammar: ``[#]YYYY-MM-DD - Doc Type - Detail.ext``.

Pure functions, no I/O and NO AI (the AI switch stays untouched): a file is
classified from its NAME only. A name the rules cannot read becomes a "review"
proposal with the reason spelled out - that queue is the labelers' work, and
every entry in it says where the rulebook needs one more rule.

routers/filing.py is the only caller. Destinations come from the live Egnyte
tree (entities / facilities / projects listed at scan time), never hardcoded:
the lettered "Greens Storage" layout in the Storage SOP is already gone from
the tenant, which is exactly the drift hardcoding would have baked in.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

MONTHS = ["January", "February", "March", "April", "May", "June",
          "July", "August", "September", "October", "November", "December"]
MONTH_BY_NAME = {m.lower(): i + 1 for i, m in enumerate(MONTHS)}

# Words the rulebook bans in names. "Final" is allowed only inside the
# sanctioned phrases - a bare "Final" without a # is flagged, not removed.
BANNED = re.compile(r"\b(current|most recent|updated|latest)\b", re.IGNORECASE)
SANCTIONED_FINAL = ("final approved", "final tax return")

# Type-word prefixes the Financial SOP's own examples carried before the date
# ("Statement - 2023-01-15 - ..."). Rulebook resolution R2: the date leads.
TYPE_PREFIX = re.compile(
    r"^(statement|statements|invoice|report|contract|lease agreement|lease|"
    r"payment confirmation|tax return|cheque|check)\s*[-:]\s*", re.IGNORECASE)

DATE_FULL = re.compile(r"(?<!\d)(20\d{2})[-_./ ]+(\d{1,2})[-_./ ]+(\d{1,2})(?!\d)")
DATE_YM = re.compile(r"(?<!\d)(20\d{2})[-_./ ]+(\d{1,2})(?!\d)")
DATE_Y = re.compile(r"(?<!\d)(20\d{2})(?!\d)")
MONTH_LEAD = re.compile(r"^(" + "|".join(MONTHS) + r")\b\s*[-:]?\s*", re.IGNORECASE)
# "July 2026" / "July, 2026" anywhere in the name reads as 2026-07 (Visesh,
# 11/04/2026: "Offering Memorandum - July 2026" must not leave July in the
# title with a bare 2026 in front).
MONTH_YEAR = re.compile(r"\b(" + "|".join(MONTHS) + r")[.,]?\s+(20\d{2})\b", re.IGNORECASE)

# Hyphenated words the separator cleanup must not split apart.
_HYPHEN_WORDS = [("U - Haul", "U-Haul"), ("As - Built", "As-Built"),
                 ("As - Builts", "As-Builts")]


@dataclass
class ParsedName:
    original: str
    ext: str = ""
    final: bool = False          # leading '#': stamped / recorded / signed
    year: int | None = None
    month: int | None = None
    day: int | None = None
    rest: str = ""               # title text with the date and prefix removed
    warnings: list[str] = field(default_factory=list)

    @property
    def date_precision(self) -> str:
        if self.day:
            return "day"
        if self.month and self.year:
            return "month"
        if self.year:
            return "year"
        return "none"

    def date_str(self) -> str:
        if self.day:
            return f"{self.year:04d}-{self.month:02d}-{self.day:02d}"
        if self.month and self.year:
            return f"{self.year:04d}-{self.month:02d}"
        if self.year:
            return f"{self.year:04d}"
        return ""


def _clean_separators(text: str) -> str:
    text = re.sub(r"\s*[-–—_]+\s*", " - ", text)
    text = re.sub(r"\s{2,}", " ", text)
    text = re.sub(r"(\s-\s)+", " - ", text)
    for broken, fixed in _HYPHEN_WORDS:
        text = re.sub(re.escape(broken), fixed, text, flags=re.IGNORECASE)
    return text.strip(" -")


def parse_name(filename: str) -> ParsedName:
    stem, ext = os.path.splitext(filename)
    p = ParsedName(original=filename, ext=ext)

    stem = stem.strip()
    if stem.startswith("#"):
        p.final = True
        stem = stem.lstrip("#").strip()

    m = TYPE_PREFIX.match(stem)
    if m and (DATE_FULL.search(stem) or DATE_YM.search(stem) or DATE_Y.search(stem)):
        p.warnings.append(f"dropped type-word prefix '{m.group(1)}' - the date leads")
        stem = stem[m.end():]

    m = DATE_FULL.search(stem)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if 1 <= mo <= 12 and 1 <= d <= 31:
            p.year, p.month, p.day = y, mo, d
            stem = (stem[: m.start()] + " " + stem[m.end():]).strip()
    if p.year is None:
        m = DATE_YM.search(stem)
        if m and 1 <= int(m.group(2)) <= 12:
            p.year, p.month = int(m.group(1)), int(m.group(2))
            stem = (stem[: m.start()] + " " + stem[m.end():]).strip()
    if p.year is None:
        m = MONTH_YEAR.search(stem)
        if m:
            p.month = MONTH_BY_NAME[m.group(1).lower()]
            p.year = int(m.group(2))
            stem = (stem[: m.start()] + " " + stem[m.end():]).strip()
    if p.year is None:
        m = MONTH_LEAD.match(stem)
        if m:
            p.month = MONTH_BY_NAME[m.group(1).lower()]
            stem = stem[m.end():].strip()
            p.warnings.append("month name without a year")
    if p.year is None:
        m = DATE_Y.search(stem)
        if m:
            p.year = int(m.group(1))
            stem = (stem[: m.start()] + " " + stem[m.end():]).strip()

    lowered = stem.lower()
    sanctioned = any(s in lowered for s in SANCTIONED_FINAL)
    if BANNED.search(stem):
        p.warnings.append("removed a banned word (current / updated / latest)")
        stem = BANNED.sub("", stem)
    if not sanctioned and re.search(r"\bfinal\b", stem, re.IGNORECASE) and not p.final:
        p.warnings.append("says 'Final' but has no # prefix - check if it is stamped, recorded or signed")

    p.rest = _clean_separators(stem)
    return p


# ---------------------------------------------------------------------------
# Doc-type classification. Ordered, first match wins, specific before generic.
# (doc_type, route_key, pattern, needs_context, min date precision)
# ---------------------------------------------------------------------------

def _r(pat: str) -> re.Pattern:
    return re.compile(pat, re.IGNORECASE)

CLASSIFIER: list[tuple[str, str, re.Pattern, str | None, str]] = [
    ("Bank Statement", "bank_statement",
     _r(r"\bbank statement\b|(?:^|[\s(])st(?:[\s).]|$)"), "entity", "day"),
    ("Credit Card Statement", "credit_card_statement",
     _r(r"\bcredit card\b|\b(visa|mastercard|amex)\b"), "entity", "day"),
    ("Loan Statement", "loan_doc",
     _r(r"\bloan (statement|agreement|terms)\b|\bmortgage\b"), "entity", "day"),
    ("Merchant Statement", "merchant_statement", _r(r"\bmerchant statement\b"), "entity", "day"),
    ("Final Tax Return", "tax_return", _r(r"\btax return\b"), "entity", "year"),
    ("Sales Tax Return", "sales_tax", _r(r"\bsales tax\b"), "entity", "year"),

    ("U-Haul Contract", "uhaul", _r(r"\bu[\s-]?haul\b"), "facility", "day"),
    ("Incident Report", "incident", _r(r"\bincident (report|log)\b"), "facility", "day"),
    ("Certificate of Mailing", "cert_mailing", _r(r"\bcertificate of mailing\b"), "facility", "day"),
    ("Daily Close Report", "daily_close", _r(r"\bdaily close\b"), "facility", "day"),
    ("Auction Record", "auction", _r(r"\bauction\b"), "facility", "day"),
    ("Tenant Document", "tenant_doc",
     _r(r"\bapproval to enter\b|\bledger history\b|\bpayment receipt\b|\br&r\b"),
     "facility", "day"),

    ("Grant Deed", "general_project", _r(r"\bgrant deed\b"), "project", "day"),
    ("Title Report", "general_project", _r(r"\btitle report\b"), "project", "day"),
    ("Easement", "general_project", _r(r"\beasement\b"), "project", "day"),
    ("Parcel Merger", "general_project", _r(r"\bparcel merger\b"), "project", "day"),
    ("Record of Survey", "general_project", _r(r"\b(record of )?survey\b"), "project", "day"),
    ("Topo", "general_project", _r(r"\btopo(graph\w*)?\b"), "project", "day"),
    ("Assessors Map", "general_project", _r(r"\bassessors? map\b"), "project", "day"),
    ("EMRA", "general_project", _r(r"\bemra\b"), "project", "day"),

    ("MUP", "agency_doc", _r(r"\bmup\b"), "project", "day"),
    ("CEQA", "agency_doc", _r(r"\bceqa\b"), "project", "day"),
    ("Storm Water", "agency_doc", _r(r"\bswpp[p]?\b|\bswqmp\b|\bsmarts\b"), "project", "day"),
    ("Permit Application", "agency_doc", _r(r"\bpermit application\b"), "project", "day"),
    ("Submittal", "agency_doc", _r(r"\bsubmittal\b"), "project", "day"),

    ("Plans", "plans",
     _r(r"\b(architectural|grading|improvement|landscape|plot|site|sewer|signage|"
        r"solar|structural|hydrology|mep|water improvement|"
        r"fire (alarm|protection|evacuation)) plans?\b"), "project", "day"),

    ("Consultant Report", "project_report",
     _r(r"\b(bio(logical)?|geo(technical)?|environmental|traffic|auditory|"
        r"hydrolog\w+) report\b"), "project", "day"),

    ("Daily Report", "construction_daily", _r(r"\bdaily (report|progress)\b"), "project", "day"),
    ("Meeting Minutes", "meeting_minutes", _r(r"\bmeeting minutes\b"), "project", "day"),
    ("Site Photos", "construction_media", _r(r"\bpictures of\b|\bphotos\b"), "project", "day"),

    ("Close Out Document", "closeout",
     _r(r"\bada\b|\bas[\s-]?built\b|\bc of o\b|\bcertificate of occupancy\b|"
        r"\binspection report\b|\b(gc|sub) warranty\b|\blien release\b|"
        r"\bnotice of completion\b|\bo&m\b|\boperations and maintenance\b|"
        r"\bpunch list\b|\brfi\b|\btesting record\b|\butility account\b"),
     "project", "day"),

    ("Bond", "legal_financial", _r(r"\b(performance|payment) bond\b|\bbond\b"), "project", "day"),
    ("Pro Forma", "legal_financial", _r(r"\bpro forma\b"), "project", "day"),
    ("Feasibility Study", "legal_financial", _r(r"\bfeasibility\b"), "project", "day"),
    ("Budget Sheet", "legal_financial", _r(r"\bbudget\b"), "project", "day"),
    ("Bid", "legal_financial", _r(r"\bbid\b"), "project", "day"),
    ("Contract", "legal_financial", _r(r"\bcontract\b"), "project", "day"),

    ("Invoice", "invoice", _r(r"\binvoice\b"), "entity", "day"),
    ("Lease", "lease", _r(r"\blease\b"), None, "day"),
]


def classify(p: ParsedName) -> tuple[str, str, str | None, str] | None:
    for doc_type, route_key, pattern, needs, precision in CLASSIFIER:
        if pattern.search(p.rest):
            return doc_type, route_key, needs, precision
    return None


# ---------------------------------------------------------------------------
# Destination templates. confirmed=False ships as the default for every class:
# a class auto-files only after a human verified its destination against the
# live tree and flipped it on (Documents > Filing & Sorting > Rules). The
# review_always classes stay human forever by design - invoice direction,
# tenant matching, the PRIVATE Legal and Financial area.
# ---------------------------------------------------------------------------

TEMPLATES: dict[str, dict] = {
    "bank_statement": {
        "label": "Bank Statements",
        "dest": "{entity_path}/Financials/Bank Statements/{yyyy}/{mm} - {month}",
        "name": "{hash}{date} - ST{ext}"},
    "credit_card_statement": {
        "label": "Credit Card Statements",
        "dest": "{entity_path}/Financials/Credit Cards/{yyyy}/{mm} - {month}",
        "name": "{hash}{date} - {title}{ext}",
        "note": "The card subfolder (e.g. 'Visa - 1234') is picked by a human for now."},
    "loan_doc": {
        "label": "Loan & Mortgage",
        "dest": "{entity_path}/Financials/Loan & Mortgage Statements/{yyyy}/{mm} - {month}",
        "name": "{hash}{date} - {title}{ext}"},
    "merchant_statement": {
        "label": "Merchant Statements",
        "dest": "{entity_path}/Financials/Merchant Statements/{yyyy}/{mm} - {month}",
        "name": "{hash}{date} - {title}{ext}"},
    "tax_return": {
        "label": "Tax Returns",
        "dest": "{entity_path}/Financials/Tax Returns/{yyyy}",
        "name": "#{yyyy} - Final Tax Return{ext}"},
    "sales_tax": {
        "label": "Sales Tax",
        "dest": "{entity_path}/Financials/Sales Tax/{yyyy}",
        "name": "#{yyyy} - Sales Tax Return{ext}",
        "note": "Name pattern is rulebook OPEN item R4 - needs Charmi's sign-off."},
    "invoice": {
        "label": "Invoices", "review_always": True,
        "review_reason": "invoice direction (vendor or customer) needs a human"},
    "lease": {
        "label": "Leases", "review_always": True,
        "review_reason": "a lease could belong to a customer, a storage tenant, or Leasing"},

    "uhaul": {
        "label": "U-Haul Contracts",
        "dest": "{facility_path}/01 - Daily Operations/U-Haul/{yyyy}/{mm} - {month}",
        "name": "{hash}{date} - {title}{ext}"},
    "incident": {
        "label": "Incident Reports",
        "dest": "{facility_path}/01 - Daily Operations/Incidents/{yyyy}/{mm} - {month}",
        "name": "{hash}{date} - {title}{ext}"},
    "cert_mailing": {
        "label": "Certificates of Mailing",
        "dest": "{facility_path}/02 - Tenants/Certificate of Mailing/{yyyy}/{mm} - {month}",
        "name": "{hash}{date} - {title}{ext}"},
    "daily_close": {
        "label": "Daily Close Reports",
        "dest": "{facility_path}/07 - Reports/{yyyy}/{mm} - {month}/Daily Close",
        "name": "{hash}{date} - {title}{ext}"},
    "auction": {
        "label": "Auction Records",
        "dest": "{facility_path}/04 - Auction & Lien/{yyyy}/{mm} - {month}",
        "name": "{hash}{date} - {title}{ext}",
        "note": "Unit-number-first naming is rulebook OPEN item R6."},
    "tenant_doc": {
        "label": "Tenant Documents", "review_always": True,
        "review_reason": "the tenant folder must be matched by a human for now"},

    "general_project": {
        "label": "Project #General",
        "dest": "{project_path}/#General/{subfolder}",
        "name": "{hash}{date} - {title}{ext}"},
    "agency_doc": {
        "label": "Agency Documents", "review_always": True,
        "review_reason": "Entitlements vs Construction Drawings phase is not readable from the name"},
    "plans": {
        "label": "Plans",
        "dest": "{project_path}/Construction Drawings/Plans/{subfolder}",
        "name": "{hash}{date} - {title}{ext}"},
    "project_report": {
        "label": "Consultant Reports",
        "dest": "{project_path}/Construction Drawings/Reports/{subfolder}",
        "name": "{hash}{date} - {title}{ext}"},
    "construction_daily": {
        "label": "Daily Progress",
        "dest": "{project_path}/Construction/Daily Progress Notes",
        "name": "{hash}{date} - {title}{ext}"},
    "meeting_minutes": {
        "label": "Meeting Minutes",
        "dest": "{project_path}/Construction/Meeting Minutes",
        "name": "{hash}{date} - {title}{ext}"},
    "construction_media": {
        "label": "Construction Media", "review_always": True,
        "review_reason": "the media activity subfolder (Grading / Trenching / ...) needs a human"},
    "closeout": {
        "label": "Close Out",
        "dest": "{project_path}/Close Out/{subfolder}",
        "name": "{hash}{date} - {title}{ext}"},
    "legal_financial": {
        "label": "Legal and Financial", "review_always": True,
        "review_reason": "Legal and Financial is private - routing there stays human-approved"},
}

GENERAL_SUBFOLDER = {
    "Grant Deed": "Grant Deeds", "Title Report": "Title Reports",
    "Easement": "Easements", "Parcel Merger": "Parcel Mergers",
    "Record of Survey": "Survey", "Topo": "Topo",
    "Assessors Map": "Assessors Maps", "EMRA": "EMRA",
}

PLAN_WORD = re.compile(
    r"\b(architectural|grading|improvement|landscape|plot|site|sewer|signage|"
    r"solar|structural|hydrology|mep|water improvement|"
    r"fire alarm|fire protection|fire evacuation)\b", re.IGNORECASE)

REPORT_WORD = re.compile(
    r"\b(bio(?:logical)?|geo(?:technical)?|environmental|traffic|auditory|"
    r"hydrolog\w+)\b", re.IGNORECASE)

CLOSEOUT_SUBFOLDER = [
    (_r(r"\bada\b"), "ADA Reports"),
    (_r(r"\bas[\s-]?built"), "As-Builts"),
    (_r(r"\bc of o\b|certificate of occupancy|inspection report"), "C of O and Inspection Reports"),
    (_r(r"\bgc warranty\b"), "GC Warranty"),
    (_r(r"\bsub warranty\b"), "Sub Warranties"),
    (_r(r"\bsub lien release\b"), "Sub Lien Releases"),
    (_r(r"\blien release\b"), "Lien Releases"),
    (_r(r"notice of completion"), "Notice of Completion"),
    (_r(r"\bo&m\b|operations and maintenance"), "Operations and Maintenance Manuals"),
    (_r(r"\bpunch list\b"), "Punch List"),
    (_r(r"\brfi\b"), "RFIs"),
    (_r(r"\btesting record\b"), "Testing Records"),
    (_r(r"\butility account\b"), "Utility Accounts"),
]


def subfolder_for(route_key: str, doc_type: str, title: str) -> str | None:
    if route_key == "general_project":
        return GENERAL_SUBFOLDER.get(doc_type)
    if route_key == "plans":
        m = PLAN_WORD.search(title)
        if m:
            word = m.group(1)
            return "MEP" if word.upper() == "MEP" else f"{word.title()} Plans"
        return None
    if route_key == "project_report":
        m = REPORT_WORD.search(title)
        return f"{m.group(1).title()} Reports" if m else None
    if route_key == "closeout":
        for pattern, folder in CLOSEOUT_SUBFOLDER:
            if pattern.search(title):
                return folder
        return None
    return ""


# Legal suffixes stripped when matching an entity name mentioned in a file
# name - same idea as services/egnyte._site_key, narrower job (alias building,
# not folder resolution), so it lives with the rules it serves.
_LEGAL_SUFFIX = re.compile(r"[,.]| (llc|inc|lp|pvt ltd|pvt\. ltd)\b", re.IGNORECASE)


@dataclass
class Maps:
    """What the live tree offered at scan time."""
    entities: list[str] = field(default_factory=list)       # folder names under #Entities
    facilities: dict[str, str] = field(default_factory=dict)  # name -> full path
    projects: dict[str, str] = field(default_factory=dict)    # name -> full path
    entities_root: str = "/Shared/#Entities"

    def entity_aliases(self) -> dict[str, str]:
        aliases: dict[str, str] = {}
        for ent in self.entities:
            aliases.setdefault(ent.lower(), ent)
            simple = _LEGAL_SUFFIX.sub("", ent.lower()).strip()
            if simple and simple != ent.lower():
                if simple in aliases and aliases[simple] != ent:
                    aliases[simple] = ""     # ambiguous - two entities reduce to it
                else:
                    aliases.setdefault(simple, ent)
        return aliases


# SOP spelling drift: the Storage SOP says "Murietta", the tree says Murrieta.
FACILITY_ALIASES = {"murietta": "Murrieta"}


def find_context(maps: Maps, text: str, root_ctx: dict) -> dict:
    ctx = dict(root_ctx)
    lowered = text.lower()
    if "project" not in ctx:
        for name in maps.projects:
            if name.lower() in lowered:
                ctx["project"] = name
                break
    if "facility" not in ctx:
        for alias, canonical in FACILITY_ALIASES.items():
            if alias in lowered and canonical in maps.facilities:
                ctx["facility"] = canonical
                break
        else:
            for name in maps.facilities:
                if name.lower() in lowered:
                    ctx["facility"] = name
                    break
    if "entity" not in ctx:
        aliases = maps.entity_aliases()
        hits: dict[str, str] = {}      # canonical -> longest alias that matched
        for alias, canonical in aliases.items():
            if canonical and len(alias) >= 6 and alias in lowered:
                if len(alias) > len(hits.get(canonical, "")):
                    hits[canonical] = alias
        # Longest match wins: "Greens Global India" also contains the alias
        # "greens global", which must not count as a second entity.
        matched = list(hits.items())
        hits = {c: a for c, a in matched
                if not any(o != a and o.startswith(a) for _, o in matched)}
        if len(hits) == 1:
            canonical, alias = next(iter(hits.items()))
            # A bare "Greens Global" could be shorthand for Greens Global, Inc
            # OR the start of Greens Global India - never guess between them.
            rivals = {c for a, c in aliases.items()
                      if c and c != canonical and a.startswith(alias + " ")}
            if rivals:
                ctx["entity_ambiguous"] = sorted({canonical, *rivals})
            else:
                ctx["entity"] = canonical
        elif len(hits) > 1:
            ctx["entity_ambiguous"] = sorted(hits)
    return ctx


def path_context(maps: Maps, folder: str) -> dict:
    """What a folder's own PATH says about whose files live in it - an
    entity's subtree names the entity, a facility's names the facility, a
    project's the project. Stronger than name-matching the file (a scan of
    /Shared/#Entities/Greens Global, Inc/... is never ambiguous the way the
    words 'Greens Global' in a file name are)."""
    ctx: dict = {}
    norm = folder.rstrip("/")
    prefix = maps.entities_root + "/"
    if norm.startswith(prefix):
        head = norm[len(prefix):].split("/", 1)[0]
        if head in maps.entities:
            ctx["entity"] = head
    for name, path in maps.facilities.items():
        p = path.rstrip("/")
        if norm == p or norm.startswith(p + "/"):
            ctx["facility"] = name
            break
    for name, path in maps.projects.items():
        p = path.rstrip("/")
        if norm == p or norm.startswith(p + "/"):
            ctx["project"] = name
            break
    return ctx


# ---------------------------------------------------------------------------
# Learned routes (Visesh, 11/04/2026): the engine remembers where people
# actually filed things and suggests the same home for similar files. This is
# pattern MEMORY over the filing audit trail - frequency counting on name
# tokens within the same context subtree - NOT an AI model: no key is spent,
# nothing reads file contents, and the AI switch stays untouched. A content-
# reading brain stays behind Neil's sign-off.
# ---------------------------------------------------------------------------

_STOP_TOKENS = {"the", "and", "for", "with", "from", "sheet", "sheets",
                "final", "approved", "copy", "new", "pdf", "docx", "xlsx"}


def name_tokens(file_name: str) -> set[str]:
    """The words that identify what a file IS, dates and noise removed."""
    p = parse_name(file_name)
    return {t for t in re.findall(r"[a-z&]{3,}", p.rest.lower())
            if t not in _STOP_TOKENS}


def context_key(folder: str) -> str:
    """The subtree a filing habit belongs to - the first three path segments
    (/Shared/#Entities/<Entity>, /Shared/--Operations/<Facility>, ...), so
    Escondido's habits never leak into Temecula's."""
    parts = [s for s in folder.split("/") if s]
    return "/" + "/".join(parts[:3]) if len(parts) >= 3 else folder.rstrip("/")


def suggest_learned(file_name: str, source_folder: str,
                    history: list[tuple[set, str, str]]) -> tuple[str, int] | None:
    """history: (tokens, context_key, dest_folder) per past filing.
    Returns (dest_folder, how_many_similar_filings) or None. A destination is
    suggested only from the SAME context subtree, for files whose token
    overlap is substantial (Jaccard >= 0.34)."""
    toks = name_tokens(file_name)
    if not toks:
        return None
    ctx = context_key(source_folder)
    votes: dict[str, int] = {}
    for h_toks, h_ctx, dest in history:
        if h_ctx != ctx or not h_toks:
            continue
        union = toks | h_toks
        if union and len(toks & h_toks) / len(union) >= 0.34:
            votes[dest] = votes.get(dest, 0) + 1
    if not votes:
        return None
    dest = max(votes, key=lambda d: votes[d])
    return dest, votes[dest]


_PRECISION = {"none": 0, "year": 1, "month": 2, "day": 3}


def modified_day(value) -> tuple[int, int, int] | None:
    """Egnyte's last_modified ("Wed, 01 Dec 2021 18:30:00 GMT", or an ISO
    string / epoch ms on some endpoints) -> (year, month, day), else None."""
    if value in (None, ""):
        return None
    try:
        if isinstance(value, (int, float)) or str(value).isdigit():
            n = float(value)
            dt = datetime.fromtimestamp(n / 1000 if n > 1e11 else n, tz=timezone.utc)
        elif "," in str(value):
            dt = parsedate_to_datetime(str(value))
        else:
            dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError, OverflowError, OSError):
        return None
    return dt.year, dt.month, dt.day


def propose(file_name: str, source_folder: str, root_ctx: dict,
            maps: Maps, confirmed: dict[str, bool],
            ignore_exts: set[str] | None = None, modified=None) -> dict:
    """One file -> one proposal dict (JSON-shaped for the API)."""
    out = {
        "sourcePath": f"{source_folder.rstrip('/')}/{file_name}",
        "currentName": file_name, "status": "review", "docType": "",
        "destFolder": "", "newName": "", "rule": "", "reasons": [],
        # What the file SHOULD be called per the grammar alone - filled even
        # when the destination is unknown, so the Proposed Names view can show
        # a rename for every file the grammar can read. labeled = the current
        # name already is the canonical one (nothing to fix).
        "canonicalName": "", "labeled": False,
    }
    ext = os.path.splitext(file_name)[1].lower()
    if ext in (ignore_exts or {".egnyte_d"}):
        out["status"], out["reasons"] = "skip", ["Egnyte placeholder or ignored type"]
        return out
    if ext in {".zip", ".rar", ".7z"}:
        out["reasons"] = ["archive file - unpack and file the contents by hand"]
        return out

    parsed = parse_name(file_name)
    out["reasons"].extend(parsed.warnings)
    # No date in the name (Visesh, 11/05/2026): the date is Egnyte's last
    # modified day, so every file still gets a suggested name. Such a row is
    # never filed automatically - a person checks the date first.
    dated_by_egnyte = False
    if not parsed.year:
        day = modified_day(modified)
        if day:
            parsed.year, parsed.month, parsed.day = day
            dated_by_egnyte = True
            out["reasons"].append("no date in the name - used Egnyte's last modified date")
    if parsed.year:
        prefix = "#" if parsed.final else ""
        out["canonicalName"] = f"{prefix}{parsed.date_str()} - {parsed.rest or 'Document'}{parsed.ext}"
        out["labeled"] = out["canonicalName"] == file_name

    hit = classify(parsed)
    if hit is None:
        out["reasons"].append("no doc-type rule matched the name")
        return out
    doc_type, route_key, needs, min_precision = hit
    out["docType"], out["rule"] = doc_type, route_key

    template = TEMPLATES.get(route_key)
    if template is None:
        out["reasons"].append(f"no destination template for '{route_key}'")
        return out
    if template.get("review_always"):
        out["reasons"].append(template.get("review_reason", "requires a human"))
        return out

    ctx = find_context(maps, f"{file_name} {source_folder}", root_ctx)
    if "entity_ambiguous" in ctx and needs == "entity":
        out["reasons"].append("entity ambiguous: " + ", ".join(ctx["entity_ambiguous"]))
        return out
    if needs and needs not in ctx:
        out["reasons"].append(f"cannot tell which {needs} this belongs to")
        return out

    if _PRECISION[parsed.date_precision] < _PRECISION[min_precision]:
        out["reasons"].append(
            f"needs a {min_precision}-precision date, found "
            f"'{parsed.date_str() or 'none'}' - use the document's own date")
        return out

    subfolder = subfolder_for(route_key, doc_type, parsed.rest)
    if subfolder is None:
        out["reasons"].append("could not pick the destination subfolder from the name")
        return out

    values = {
        "yyyy": f"{parsed.year:04d}", "ext": parsed.ext,
        "mm": f"{parsed.month:02d}" if parsed.month else "",
        "month": MONTHS[parsed.month - 1] if parsed.month else "",
        "date": parsed.date_str(), "title": parsed.rest or "Document",
        "hash": "#" if parsed.final else "", "subfolder": subfolder,
        "entity_path": f"{maps.entities_root}/{ctx['entity']}" if "entity" in ctx else "",
        "facility_path": maps.facilities.get(ctx.get("facility", ""), ""),
        "project_path": maps.projects.get(ctx.get("project", ""), ""),
    }
    out["destFolder"] = template["dest"].format(**values)
    out["newName"] = template["name"].format(**values)
    # Classes with a fixed name pattern (ST, Final Tax Return) rename past the
    # bare canonical - the class's own name is what "labeled" means for them.
    out["labeled"] = out["newName"] == file_name

    if not confirmed.get(route_key, False):
        out["reasons"].append("this document class is not switched on for auto-filing yet (Rules)")
        return out
    if dated_by_egnyte:
        return out

    out["status"] = "auto"
    return out
