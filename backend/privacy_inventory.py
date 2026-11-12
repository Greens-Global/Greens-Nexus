"""What Nexus collects, why, how long it keeps it, and every outside service
it sends data to - ONE inventory the Privacy Policy page is built from
(11/02/2026, the legal compliance pass; the reel's items 1-3: a privacy
policy that does not say you collect data, that you use AI, or who the third
parties are).

`notice(db, viewer)` turns this into the policy the page shows (Legal >
Privacy Policy and the public /privacy page, through routers/privacy_notice.py).
The AI section reads the live switch (`ai_switch.enabled()` + whether a key is
present), never a hard-coded word, and a signed-in viewer also sees which of
the optional services this server has switched on.

KEEPING IT TRUE - the checklist when you add an outside service:
  1. Add a PROCESSORS entry: who, why, what data, the hosts it calls and the
     environment key(s) that switch it on.
  2. Every hostname a backend .py or frontend/src file names, and every host
     the CSP in frontend/public/_headers allows, must be in some entry's
     `hosts` or in NOT_PROCESSORS with the reason it is not one (a link a
     person clicks, an XML namespace, ...). `test_privacy_inventory.py` scans
     the code and fails on a host that is in neither list.
  3. A new storage bucket goes in BUCKETS (private, signed-only or public on
     purpose); the same test fails on a bucket name it has not seen.

This is the organization's notice to its own people and it is a DRAFT FOR
COUNSEL REVIEW, not legal advice; administrators see that note, others do not.
The text names "your organization", never a company (white-label).
"""
import os

NOTICE_VERSION = "2026-11-02"
NOTICE_UPDATED = "11/02/2026"   # shown on the page (US format)

# ── what is collected ──────────────────────────────────────────────────────
# `cpra` is the California category (Cal. Civ. Code 1798.140(v)); `sensitive`
# marks sensitive personal information (1798.140(ae)).
DATA_CATEGORIES = [
    {"key": "identity", "label": "Identifiers and account details",
     "cpra": "Identifiers", "sensitive": False,
     "examples": "Name, work email, job title, role, employee number, profile photo, work phone, "
                 "the Microsoft account ID used to sign you in.",
     "purpose": "Signing you in, showing who did what, routing approvals and notices.",
     "retention": "While you have access, then as long as your organization's records schedule requires."},
    {"key": "hr", "label": "Employment and HR records",
     "cpra": "Professional or employment-related information", "sensitive": False,
     "examples": "Start date, department, manager, employment type, documents, onboarding and "
                 "offboarding checklists, probation, performance reviews and goals, Ask HR requests, "
                 "HR letters, time off and leave balances, interview notes and, where your organization "
                 "records them, interview transcripts and recordings.",
     "purpose": "Running employment: hiring, onboarding, reviews, leave, separation and legal records.",
     "retention": "As long as employment law and your organization's records schedule require. Nexus does "
                  "not delete HR records by itself."},
    {"key": "pay", "label": "Pay, tax and bank details",
     "cpra": "Professional or employment-related information", "sensitive": True,
     "examples": "Pay rate and pay history, hours for payroll, reimbursements and receipts, salary "
                 "advances, and on federal forms (W-4, I-9, direct deposit) your Social Security number "
                 "and bank routing and account numbers.",
     "purpose": "Paying you correctly and meeting tax and work-eligibility law.",
     "retention": "Payroll and tax records are kept as long as the law requires. Social Security and "
                  "bank numbers are encrypted at rest and printed only into the sealed form."},
    {"key": "time", "label": "Time records",
     "cpra": "Professional or employment-related information", "sensitive": False,
     "examples": "Clock in and out, breaks, shifts, schedules, time sheet signatures and corrections.",
     "purpose": "Verifying worked time, scheduling and payroll.",
     "retention": "Kept as wage-and-hour records. Corrections never overwrite the original punch."},
    {"key": "location", "label": "Location",
     "cpra": "Geolocation data", "sensitive": True,
     "examples": "The position your device reports when a punch asks for it (checked against the work "
                 "site's area, never blocked), and only if you install the field app and consent, a "
                 "location sample about every 5 minutes or 100 meters while you are clocked in. "
                 "Addresses of work sites and company properties.",
     "purpose": "Showing a punch was made at the work site and, for field crews who consent, where the "
                "crew is during a shift.",
     "retention": "Punch locations are kept with the punch. Field-app location samples are deleted after "
                  "90 days."},
    {"key": "monitoring", "label": "Work monitoring",
     "cpra": "Internet or other electronic network activity information", "sensitive": False,
     "examples": "Only on a company-managed computer running the desktop agent, and only while you are "
                 "clocked in: periodic screenshots, the active application and window title, and an "
                 "overall active or idle level (never what you type). A manager may also open a live "
                 "view of the screen while you are clocked in.",
     "purpose": "Verifying worked time and supporting performance review.",
     "retention": "Screenshots and activity records are deleted after {shot_days} days."},
    {"key": "activity", "label": "Sign-in, device and usage records",
     "cpra": "Internet or other electronic network activity information", "sensitive": False,
     "examples": "IP address, a city-level location worked out on the server from the IP address (no "
                 "outside service is asked), browser and device, sign-in times, audit logs of changes, "
                 "policy acceptances, e-signature audit trails, notification history and phone push "
                 "subscriptions.",
     "purpose": "Security, spotting a sign-in that was not you, proving what was signed or accepted.",
     "retention": "Sign-in records 180 days; notifications 30 days; audit trails and signatures as long as "
                  "the records they prove."},
    {"key": "content", "label": "Things you create or upload",
     "cpra": "Audio, electronic, visual or similar information", "sensitive": False,
     "examples": "Tasks, tickets, notes and whiteboards, voice notes, videos, photos (checkouts, returns, "
                 "job sites, forms), documents, signatures, comments and messages.",
     "purpose": "The work itself, and evidence where a process needs it.",
     "retention": "Kept while it is part of a record. Items in a Trash are removed after the period the "
                  "screen states; some evidence (checkout photos, signed documents, time sheets) is kept "
                  "for the record."},
    {"key": "finance", "label": "Personal financial statements",
     "cpra": "Personal information described in Cal. Civ. Code 1798.80(e)", "sensitive": True,
     "examples": "Only for the owners who keep one: assets, liabilities and income on a personal "
                 "financial statement.",
     "purpose": "Lender and investor requirements of the business.",
     "retention": "Until the owner removes it; the audit trail stays."},
    {"key": "vault", "label": "Saved work logins",
     "cpra": "Identifiers", "sensitive": True,
     "examples": "Work account usernames and passwords people store in the Credential Vault.",
     "purpose": "Sharing work logins safely within a team.",
     "retention": "Until deleted from the vault."},
    {"key": "candidates", "label": "Job applicants",
     "cpra": "Professional or employment-related information", "sensitive": False,
     "examples": "What an applicant sends through the careers page: name, contact details, resume and "
                 "answers.",
     "purpose": "Hiring.",
     "retention": "As your organization's hiring records schedule requires."},
]

# ── who data goes to ───────────────────────────────────────────────────────
# `env`: the keys that switch the service on (ANY of them set = configured);
#        [] with always=True = part of every Nexus.
# `hosts`: every hostname the code reaches for it (wildcards allowed).
# `where`: server (Nexus's API calls it) | browser (your device calls it).
PROCESSORS = [
    # Core platform - every Nexus.
    {"key": "microsoft_entra", "name": "Microsoft (Entra ID)", "group": "core", "always": True, "env": [],
     "where": "server and browser",
     "purpose": "Signing you in with your work account.",
     "data": "Your sign-in identity (name, email, account ID). Nexus never sees your password.",
     "hosts": ["login.microsoftonline.com", "*.microsoftonline.com", "login.microsoft.com",
               "login.windows.net", "login.live.com", "sts.windows.net", "aka.ms"]},
    {"key": "microsoft_graph", "name": "Microsoft 365 (Graph: Outlook, Teams, OneDrive)", "group": "core",
     "always": False, "env": ["AZURE_CLIENT_SECRET"], "where": "server and browser",
     "purpose": "Sending Nexus email, posting Teams messages (and reading the reactions and replies on "
                "kudos posts back as thanks), writing shifts and meetings to Outlook "
                "calendars, showing Teams presence, reading the intake mailboxes, interview transcripts "
                "and recordings, creating work accounts, and converting Word files to PDF.",
     "data": "Names, emails and the content of the message, event or document involved.",
     "hosts": ["graph.microsoft.com", "appsforoffice.microsoft.com", "outlook.office.com",
               "outlook.office365.com", "outlook.live.com"]},
    {"key": "supabase", "name": "Supabase", "group": "core", "always": True, "env": [],
     "where": "server and browser",
     "purpose": "The database, file storage and live updates behind Nexus.",
     "data": "Everything Nexus stores: all the categories above.",
     "hosts": ["*.supabase.co"]},
    {"key": "azure", "name": "Microsoft Azure", "group": "core", "always": True, "env": [],
     "where": "server",
     "purpose": "Runs the Nexus API.",
     "data": "Every request your browser sends to Nexus.",
     "hosts": ["*.azurewebsites.net"]},
    {"key": "cloudflare", "name": "Cloudflare", "group": "core", "always": True, "env": [],
     "where": "server and browser",
     "purpose": "Hosts the Nexus web app, passes requests to the API, measures page performance (Web "
                "Analytics), and relays a manager's live screen view.",
     "data": "Your IP address and the pages and requests you make; for a live view, the screen stream "
             "itself, relayed and not stored.",
     "hosts": ["static.cloudflareinsights.com", "cloudflareinsights.com", "rtc.live.cloudflare.com",
               "stun.cloudflare.com", "www.cloudflare.com"]},

    # Business systems - only where the organization connects them.
    {"key": "egnyte", "name": "Egnyte", "group": "business", "env": ["EGNYTE_DOMAIN", "EGNYTE_TOKEN"],
     "where": "server",
     "purpose": "Filing signed documents, time sheets, HR packets and job site media into the "
                "organization's file storage.",
     "data": "The filed document and the name of the person it belongs to.",
     "hosts": ["*.egnyte.com", "developers.egnyte.com"]},
    {"key": "intacct", "name": "Sage Intacct", "group": "business",
     "env": ["INTACCT_SENDER_ID", "INTACCT_COMPANY_ID"], "where": "server",
     "purpose": "Accounting: reading the general ledger and employee codes.",
     "data": "Employee names and codes; accounting entries.",
     "hosts": ["api.intacct.com", "*.intacct.com"]},
    {"key": "accounting_app", "name": "The organization's accounting application", "group": "business",
     "env": ["ACCOUNTING_BASE_URL"], "where": "server",
     "purpose": "Single sign-on to the accounting app and the finance dashboard figures.",
     "data": "The work emails of the people with accounting access.",
     "hosts": []},
    {"key": "cubby", "name": "Cubby (storage management)", "group": "business",
     "env": ["CUBBY_API_KEY", "CUBBY_BQ_CREDENTIALS_JSON"], "where": "server",
     "purpose": "Facility, unit, tenant and task data for storage operations; its reporting warehouse runs "
                "on Google BigQuery.",
     "data": "Mostly read from Cubby. Task status changes and rate changes go back only when an "
             "administrator turns that on.",
     "hosts": ["api.cubbystorage.com", "app.cubbystorage.com", "cubbystorage.github.io",
               "bigquery.googleapis.com"]},
    {"key": "google_business", "name": "Google (Business Profile and Ads)", "group": "business",
     "env": ["GBP_OAUTH_CLIENT_ID"], "where": "server",
     "purpose": "Managing the business listing, reviews and posts, and reading ad reports.",
     "data": "Listing content, review replies and photos the marketing team posts.",
     "hosts": ["accounts.google.com", "oauth2.googleapis.com", "openidconnect.googleapis.com",
               "mybusinessaccountmanagement.googleapis.com", "mybusinessbusinessinformation.googleapis.com",
               "mybusiness.googleapis.com", "businessprofileperformance.googleapis.com",
               "googleads.googleapis.com", "*.googleusercontent.com", "*.ggpht.com"]},
    {"key": "sentdm", "name": "sent.dm (text messages)", "group": "business",
     "env": ["NEXUS_SENTDM_KEY", "SENTDM_API_KEY"], "where": "server",
     "purpose": "Text messages: sign-in and access codes, and weather call texts.",
     "data": "Your phone number and the message.",
     "hosts": ["api.sent.dm"]},
    {"key": "unifi", "name": "Ubiquiti UniFi", "group": "business", "env": ["UNIFI_API_KEY"],
     "where": "server",
     "purpose": "Reading the status of the organization's network devices for IT.",
     "data": "No personal data.",
     "hosts": ["api.ui.com", "unifi.ui.com"]},
    {"key": "github", "name": "GitHub", "group": "business", "env": ["GITHUB_TOKEN"], "where": "server",
     "purpose": "Reading the software change log for What's New.",
     "data": "No personal data of yours; developer names on changes.",
     "hosts": ["api.github.com", "github.com"]},
    {"key": "webhooks", "name": "Workflow webhooks the organization sets up", "group": "business",
     "env": [], "where": "server", "admin_configured": True,
     "purpose": "Workflows can send a record to a web address an administrator allows.",
     "data": "Whatever fields that workflow sends.",
     "hosts": []},
    {"key": "web_push", "name": "Phone and browser push services (Apple, Google, Mozilla, Microsoft)",
     "group": "business", "env": ["NEXUS_VAPID_PRIVATE_KEY"], "where": "server",
     "purpose": "Delivering bell notifications to a phone or browser where you turned push on.",
     "data": "The notice's title, a short line, and a link.",
     "hosts": ["fcm.googleapis.com", "web.push.apple.com"]},
    {"key": "docx_convert", "name": "A Word-to-PDF conversion service", "group": "business",
     "env": ["NEXUS_DOCX_CONVERT_URL"], "where": "server",
     "purpose": "Turning a Word document into a PDF when Microsoft 365 conversion is not used.",
     "data": "The document.",
     "hosts": []},
    {"key": "timestamp", "name": "A trusted timestamp authority", "group": "business",
     "env": ["NEXUS_ESIGN_TSA_URL"], "where": "server",
     "purpose": "Timestamping sealed e-signature documents.",
     "data": "A fingerprint (hash) of the document only.",
     "hosts": ["timestamp.digicert.com", "timestamp.sectigo.com", "freetsa.org"]},
    {"key": "error_reporting", "name": "Sentry (error reporting)", "group": "business",
     "env": ["NEXUS_SENTRY_DSN"], "where": "server", "needs_module": "sentry_sdk",
     "purpose": "Reporting server errors to the developers.",
     "data": "Technical error details, which can include the request that failed.",
     "hosts": []},

    # AI - off unless the organization's operator turns it on (ai_switch.py).
    {"key": "anthropic", "name": "Anthropic (Claude AI)", "group": "ai", "env": ["ANTHROPIC_API_KEY"],
     "where": "server", "ai": True,
     "purpose": "AI features: Ask Nexus answers, the assistant, ticket summaries and topic suggestions, "
                "Knowledge Base drafting, task text rewrites, interview notes, job site photo captions "
                "and reports, item details and photos, workflow drafting.",
     "data": "The text, photo or record the feature works on, for example your question, a ticket's "
             "conversation, or an interview transcript.",
     "hosts": ["api.anthropic.com", "claude.ai"]},

    # Public data and map services - little or no personal data.
    {"key": "nominatim", "name": "OpenStreetMap (Nominatim and Overpass)", "group": "public", "always": True,
     "env": [], "where": "server and browser",
     "purpose": "Turning addresses into map points and a punch's position into an address; finding "
                "nearby businesses for market reports.",
     "data": "Addresses and coordinates. A punch's position is looked up from your own device.",
     "hosts": ["nominatim.openstreetmap.org", "overpass-api.de", "operations.osmfoundation.org"]},
    {"key": "map_tiles", "name": "Map imagery (OpenStreetMap, Esri, Amazon Web Services, Google Maps)",
     "group": "public", "always": True, "env": [], "where": "browser",
     "purpose": "Drawing maps, satellite views, 3D site models and map previews.",
     "data": "Your IP address and the area of the map being viewed.",
     "hosts": ["*.tile.openstreetmap.org", "{s}.tile.openstreetmap.org", "*.arcgisonline.com",
               "server.arcgisonline.com", "elevation-tiles-prod.s3.amazonaws.com", "tile.googleapis.com",
               "www.google.com", "maps.google.com", "maps.app.goo.gl", "goo.gl", "g.co", "share.google"]},
    {"key": "weather", "name": "Open-Meteo and the US National Weather Service", "group": "public",
     "always": True, "env": [], "where": "server",
     "purpose": "Forecasts and weather alerts for work sites.",
     "data": "Work site coordinates, rounded; never who you are.",
     "hosts": ["api.open-meteo.com", "geocoding-api.open-meteo.com", "api.weather.gov"]},
    {"key": "favicons", "name": "Website icon services (icon.horse, Google)", "group": "public",
     "always": True, "env": [], "where": "server and browser",
     "purpose": "Showing a website's icon next to a saved link or login.",
     "data": "The website address of the link (not the login itself).",
     "hosts": ["icon.horse", "t1.gstatic.com"]},
    {"key": "image_search", "name": "Google Custom Search and Openverse", "group": "public",
     "env": ["GOOGLE_CSE_KEY"], "always": True, "where": "server",
     "purpose": "Finding a product photo for an item.",
     "data": "The item's make and model.",
     "hosts": ["www.googleapis.com", "api.openverse.org"]},
    {"key": "holidays", "name": "Public holiday calendars (Nager.Date, Google Calendar)", "group": "public",
     "always": True, "env": [], "where": "server",
     "purpose": "Filling the holiday calendar.",
     "data": "A country and a year only.",
     "hosts": ["date.nager.at", "calendar.google.com"]},
    {"key": "rates", "name": "Federal Reserve Bank of New York and US Treasury", "group": "public",
     "always": True, "env": [], "where": "server",
     "purpose": "Published interest rates for loan schedules.",
     "data": "None.",
     "hosts": ["markets.newyorkfed.org", "home.treasury.gov", "www.newyorkfed.org"]},
    {"key": "pwned", "name": "Have I Been Pwned", "group": "public", "always": True, "env": [],
     "where": "server",
     "purpose": "Warning when a saved password appears in a known breach.",
     "data": "The first five characters of a scrambled (hashed) password only, never the password.",
     "hosts": ["api.pwnedpasswords.com"]},
    {"key": "video", "name": "YouTube, Vimeo and Loom", "group": "public", "always": True, "env": [],
     "where": "browser",
     "purpose": "Playing a video embedded in a What's New post.",
     "data": "Your IP address and browser details, when you play the video.",
     "hosts": ["www.youtube-nocookie.com", "www.youtube.com", "player.vimeo.com", "www.loom.com"]},
    {"key": "market_sites", "name": "Competitor websites", "group": "public", "env": ["NEXUS_MARKET_WATCH_HOURS"],
     "where": "server",
     "purpose": "Reading published prices for market reports.",
     "data": "None.",
     "hosts": []},
    {"key": "sample_images", "name": "Lorem Picsum", "group": "public", "always": True, "env": [],
     "where": "browser",
     "purpose": "Placeholder pictures on marketing screens before an account is connected.",
     "data": "Your IP address.",
     "hosts": ["picsum.photos", "fastly.picsum.photos"]},
]

# Hostnames the code names that are NOT a place Nexus sends data: links a
# person clicks, XML namespaces, documentation, examples. A host here is
# never contacted by Nexus on its own.
NOT_PROCESSORS = {
    # XML, PDF and document namespaces
    "www.w3.org": "namespace", "schemas.openxmlformats.org": "namespace", "schemas.microsoft.com": "namespace",
    "purl.org": "namespace", "purl.oclc.org": "namespace", "ns.adobe.com": "namespace",
    "www.xfa.org": "namespace", "schema.org": "structured data vocabulary", "www.sitemaps.org": "namespace",
    "docs.oasis-open.org": "namespace",
    # documentation and help links shown to people
    "learn.microsoft.com": "help link", "admin.microsoft.com": "admin link", "admin.exchange.microsoft.com": "admin link",
    "compliance.microsoft.com": "admin link", "www.irs.gov": "official form source link",
    "www.uscis.gov": "official form source link", "www.intacct.com": "link",
    "988lifeline.org": "crisis resource link shown to a person",
    # links a person opens (bookmarks, social profiles, job boards, apps)
    "teams.microsoft.com": "link", "m365.cloud.microsoft": "link", "office.com": "link",
    "my.jive.com": "link", "app.ramp.com": "link", "app.asana.com": "archived link (Asana removed)",
    "asana.com": "link", "www.americanexpress.com": "link", "www.bankofamerica.com": "link",
    "www.bmo.com": "link", "www.capitalone.com": "link", "www.fidelity.com": "link", "www.fmb.com": "link",
    "www.myequity.com": "link", "www.usbank.com": "link", "secure.fivestarbank.com": "link",
    "www.speedtest.net": "link", "adp.com": "link", "slack.com": "link", "linkedin.com": "link",
    "www.linkedin.com": "link", "employers.indeed.com": "link", "x.com": "link", "facebook.com": "link",
    "instagram.com": "link", "ads.google.com": "link", "search.google.com": "review link",
    "www.hubspot.com": "link", "www.procore.com": "link", "www.sage.com": "link",
    "construction.autodesk.com": "link", "coconstruct.com": "link",
    # the organization's own sites and Nexus itself
    "nexus.greensglobal.com": "this Nexus", "dev.nexus.greensglobal.com": "this Nexus (test)",
    "dev.nexus": "this Nexus (test)", "www.greensglobal.com": "the organization's site",
    "tbd.greensglobal.com": "placeholder", "cloud.greensglobal.com": "the organization's Egnyte address",
    "greensg-my.sharepoint.com": "the organization's SharePoint link", "www.greensstorage.com": "the organization's site",
    "greensstorage.com": "the organization's site",
    # examples and samples
    "nexus.example": "sample", "www.example.com": "example", "example.com": "example",
}

# Storage buckets: every bucket the code writes to, and how it is reached.
#   protected - private; browsers open it only through /files/view (routers/files.py
#               PROTECTED_BUCKETS = frontend/src/lib/storageView.js)
#   signed    - private; only the server hands out short-lived links, after its own
#               access check (never through /files/view, which checks login only)
#   public    - public on purpose (the reason says why)
BUCKETS = {
    "checkout-photos": "protected", "item-photos": "protected", "return-photos": "protected",
    "ticket-evidence": "protected", "qa-evidence": "protected", "task-files": "protected",
    "ir-documents": "protected", "construction-media": "protected", "asset-files": "protected",
    "kb-media": "protected",
    "hr-docs": "signed", "time-monitoring": "signed", "agent-releases": "signed",
    "avatars": "public: profile photos and logos shown to everyone and in email",
    "document-images": "public: letterheads inside e-sign documents that signers open with no login",
    "agent-dist": "public: the desktop agent installer download",
}


# ── live state ────────────────────────────────────────────────────────────

def ai_status(env=None) -> dict:
    """The AI switch as it stands on THIS server: on only when the operator set
    NEXUS_AI_ENABLED=true AND a key is present (ai_switch blanks the key
    otherwise). Reads the environment only - never calls the API."""
    import ai_switch
    env = os.environ if env is None else env
    switch = ai_switch.enabled(env)
    key = bool((env.get("ANTHROPIC_API_KEY") or "").strip())
    return {"enabled": bool(switch and key), "switch": switch, "keyPresent": key}


def _module_present(name: str) -> bool:
    import importlib.util
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def configured(p: dict, env=None) -> bool:
    env = os.environ if env is None else env
    if p.get("ai"):
        return ai_status(env)["enabled"]
    if p.get("always"):
        return True
    if p.get("needs_module") and not _module_present(p["needs_module"]):
        return False
    return any((env.get(k) or "").strip() for k in p.get("env", []))


def processors(env=None, with_status: bool = False) -> list:
    out = []
    for p in PROCESSORS:
        row = {k: p[k] for k in ("key", "name", "group", "where", "purpose", "data")}
        if with_status:
            row["inUse"] = configured(p, env)
            row["adminConfigured"] = bool(p.get("admin_configured"))
        out.append(row)
    return out


def _shot_days(env=None) -> int:
    env = os.environ if env is None else env
    try:
        return int(env.get("NEXUS_SHOT_RETENTION_DAYS", "90"))
    except ValueError:
        return 90


def categories(env=None) -> list:
    days = _shot_days(env)
    retained = f"{days}" if days > 0 else "a period your organization sets"
    return [{**c, "retention": c["retention"].replace("{shot_days}", retained)} for c in DATA_CATEGORIES]


# ── the notice ────────────────────────────────────────────────────────────

GROUP_TITLES = {
    "core": "Services every Nexus uses",
    "business": "Services your organization may connect",
    "ai": "AI",
    "public": "Map, weather and other public data services",
}


def _contact_line(contact: dict | None) -> str:
    if contact and contact.get("email"):
        who = contact.get("name") or "your HR contact"
        return f"{who} at {contact['email']}"
    return "your HR team (your administrator lists the HR contact for each company in Settings)"


def notice(env=None, viewer: dict | None = None) -> dict:
    """The Privacy Policy as structured sections ({h, p, list}) plus the
    data the page draws itself (categories, processors, AI status).

    viewer (signed-in only): {"company": legal name or "", "contact":
    {"name", "email"} or None}. With no viewer (the public page) nothing
    about this server's optional services or any person is included."""
    env = os.environ if env is None else env
    signed_in = viewer is not None
    # The public page says only whether AI is on; how the switch and the key
    # stand is for signed-in people (review, 11/02/2026).
    ai = ai_status(env) if signed_in else {"enabled": ai_status(env)["enabled"]}
    company = (viewer or {}).get("company") or ""
    who = f"your organization ({company})" if company else "your organization"
    contact = _contact_line((viewer or {}).get("contact"))
    cats = categories(env)
    procs = processors(env, with_status=signed_in)

    sections = [
        {"h": "1. Who This Notice Is From", "p": [
            f"Nexus is the internal portal {who} provides to its employees, contractors and other "
            "authorized people. Your organization decides what Nexus is used for and is responsible for "
            "the personal information in it. This notice explains what Nexus collects about you, why, "
            "how long it is kept, who it is shared with, and the rights you have.",
            "It is also the notice at collection for California employees, applicants and contractors "
            "under the California Consumer Privacy Act as amended by the California Privacy Rights Act "
            "(CPRA), and the notice for people in India under the Digital Personal Data Protection Act, "
            "2023.",
        ]},
        {"h": "2. What We Collect and Why", "p": [
            "Nexus collects personal information about you. The categories, what each includes, why it "
            "is used and how long it is kept are listed below. Items marked sensitive are sensitive "
            "personal information under the CPRA.",
        ], "list": [
            f"{c['label']}{' (sensitive)' if c['sensitive'] else ''}: {c['examples']} Used for: "
            f"{c['purpose']} Kept: {c['retention']}" for c in cats
        ]},
        {"h": "3. Location and Work Monitoring", "p": [
            "Location: when a punch screen asks for your location, your device's position is recorded "
            "with the punch and compared with the work site's area. A punch outside the area is recorded "
            "and flagged, never blocked. To show the address, your device looks the position up with "
            "OpenStreetMap. Continuous location is collected only through the field app, only after you "
            "consent in it, and only while you are clocked in; you can withdraw that consent in the app.",
            "Work monitoring: on a company-managed computer running the desktop agent, and only while you "
            "are clocked in, Nexus may take periodic screenshots, record the active application and window "
            "title, and measure an overall active or idle level. It never records what you type. A "
            "manager may open a live view of the screen during that time. You are told about this and "
            "asked to accept it at sign-in. Monitoring data is visible to your manager and HR for time "
            "verification, performance and payroll.",
        ]},
        {"h": "4. AI Features", "p": [
            "Nexus includes AI features that use Anthropic's Claude models: Ask Nexus answers, the "
            "assistant, ticket summaries and topic suggestions, Knowledge Base drafting, task text "
            "rewrites, interview notes, job site photo captions and reports, item details and workflow "
            "drafting. When a feature runs, the text, photo or record it works on (for example your "
            "question, a ticket's conversation, or an interview transcript) is sent to Anthropic to "
            "produce the result.",
            "AI is off unless your organization's operator turns it on. "
            + ("On this Nexus, AI features are ON." if ai["enabled"] else
               "On this Nexus, AI features are OFF: nothing is sent to Anthropic."),
            "Nexus never uses AI to make a hiring, pay, discipline or other employment decision by itself; "
            "a person decides. A message that expresses thoughts of suicide or self-harm is never answered "
            "by AI: Nexus shows crisis resources instead, and does not record that it did.",
        ], "aiStatus": ai},
        {"h": "5. Who We Share It With", "p": [
            "Nexus does not sell your personal information and does not share it for cross-context "
            "behavioral advertising. It is shared with the service providers below, who process it for "
            "your organization to run Nexus, and inside your organization only with the people whose role "
            "needs it (your own records are visible to you, your manager, and HR and administrators as "
            "their role allows).",
            "The services under \"Services your organization may connect\", and AI, are used only when your "
            "organization switches them on."
            + (" The In Use column shows what this Nexus has switched on today." if signed_in else ""),
        ], "processors": procs, "groupTitles": GROUP_TITLES},
        {"h": "6. How Long We Keep It", "p": [
            "Each category above says how long it is kept. In short: records are kept while you have "
            "access and then as long as employment, tax and wage-and-hour law and your organization's "
            "records schedule require. Some records are never edited in place or deleted by Nexus on its "
            "own, because they are evidence (punches, signed documents, time sheets, checkout photos). "
            "Things moved to a Trash are removed after the period the screen states.",
        ]},
        {"h": "7. Security", "p": [
            "Sign-in goes through your work account; Nexus keeps no separate password. Evidence files are "
            "kept in private storage and opened only through a signed-in link. Social Security and bank "
            "numbers are encrypted at rest. Access inside Nexus follows your role and company.",
        ]},
        {"h": "8. Your Rights", "p": [
            "California residents (employees, applicants and contractors) have the right to know what "
            "personal information is collected and how it is used and shared, to access it, to correct "
            "it, to delete it (except where the law or a record requirement says it must be kept), and to "
            "limit the use of sensitive personal information to what employment requires. Nexus uses "
            "sensitive personal information only for those employment purposes. You will not be "
            "retaliated against for using these rights.",
            "People in India have the right, under the Digital Personal Data Protection Act, 2023, to a "
            "summary of the personal data processed about them and who it was shared with, to have it "
            "corrected, completed, updated or erased, to withdraw consent where processing relies on "
            "consent, to nominate someone to act for them, and to have a grievance addressed. Employment "
            "processing generally relies on the law's legitimate uses for employment. If a grievance is "
            "not resolved, you may complain to the Data Protection Board of India.",
            f"To make a request or raise a concern, use Ask HR in Nexus or contact {contact}. Your "
            "organization will confirm who you are before acting on it and answer within the time the law "
            "allows (45 days under the CPRA, which can be extended once).",
            "You can review the policy versions you accepted from your Profile.",
        ]},
        {"h": "9. Changes", "p": [
            "When this notice or the sign-in policy changes in a material way, you are asked to review "
            "and accept it again at your next sign-in.",
        ]},
    ]
    return {"version": NOTICE_VERSION, "updated": NOTICE_UPDATED, "title": "Privacy Policy",
            "sections": sections, "categories": cats, "processors": procs, "ai": ai}
