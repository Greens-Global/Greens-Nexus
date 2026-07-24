"""Public URL of the Nexus frontend, for links in outbound email (tickets,
e-sign). NEXUS_APP_URL always wins when set. Otherwise derive it from
WEBSITE_SITE_NAME (set by Azure App Service): the prod API serves the prod
site, any other Azure site name is the dev deployment, and no site name at
all means local development. Before this, an unset NEXUS_APP_URL produced
href="#" ticket buttons (email clients strip those to plain text) and
prod e-sign emails that linked to dev.nexus."""
import os


def app_url() -> str:
    explicit = os.getenv("NEXUS_APP_URL", "").rstrip("/")
    if explicit:
        return explicit
    site = os.getenv("WEBSITE_SITE_NAME", "")
    if site == "greens-nexus-api":
        return "https://nexus.greensglobal.com"
    if site:
        return "https://dev.nexus.greensglobal.com"
    return "http://localhost:5173"
