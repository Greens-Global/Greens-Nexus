"""Public URL of the Nexus frontend, for links in outbound email (tickets,
e-sign, task notifications, external-user invites, OAuth redirects). Always
set NEXUS_APP_URL explicitly in both Azure App Services' Configuration ->
Application settings - it always wins here and skips the guesswork below
entirely, which is the only way to be sure of this across a slot swap.

Fallback, when NEXUS_APP_URL is unset, derives from WEBSITE_SITE_NAME (set by
Azure App Service): no site name at all means local development, "dev"
anywhere in the site name is the dev deployment, anything else on Azure is
treated as prod. That is deliberately the reverse of an exact "is this
prod?" match. Prod deploys through a staging slot then a swap (see
main_greens-nexus-api.yml); WEBSITE_SITE_NAME during slot warm-up can carry a
slot suffix that no longer equals the bare app name exactly, and this
constant is only read once at process start (see task_notify.py /
ticket_notify.py), so a worker warmed up under a not-exactly-matching name
baked in the dev URL for its whole lifetime and NEVER re-derived it -
production task/ticket/e-sign emails linked to dev.nexus and stayed wrong
until that worker recycled (Aug 2026, reported as "havoc" company-wide).
Matching "is this dev?" by substring instead means a slot-suffixed prod name
still correctly resolves to prod - dev's real site name reliably contains
"dev" (e.g. greens-nexus-api-dev-a6fad4brawevg8de), prod's never does.
Before the original version of this file existed at all, an unset
NEXUS_APP_URL produced href="#" ticket buttons (email clients strip those to
plain text) and prod e-sign emails that linked to dev.nexus."""
import os


def app_url() -> str:
    explicit = os.getenv("NEXUS_APP_URL", "").rstrip("/")
    if explicit:
        return explicit
    site = os.getenv("WEBSITE_SITE_NAME", "").strip().lower()
    if not site:
        return "http://localhost:5173"
    if "dev" in site:
        return "https://dev.nexus.greensglobal.com"
    return "https://nexus.greensglobal.com"
