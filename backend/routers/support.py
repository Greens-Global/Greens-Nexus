"""Support > System & Design (Sep 19, Pranshu: "a new card 'System & Design'
where it will state all the tech we used or using for building NEXUS", plus a
"Data Dictionary" that "should get updated automatically... in real time").

Two endpoints, both open to any signed-in employee (informational only - no
data ever comes back, just table/field NAMES and plain-English descriptions,
so this carries the same access level as the rest of the self-service
Support module, not an admin grant):
  - GET /support/system-info    static architecture description (the actual
    Nexus stack - see CLAUDE.md, kept in step by hand since a tech stack
    doesn't change often)
  - GET /support/data-dictionary  live, derived from models.py/
    construction_models.py on every call (see data_dictionary.py)
"""
from fastapi import APIRouter, Depends

from auth import get_current_user
import data_dictionary

router = APIRouter(prefix="/support", tags=["Support"], dependencies=[Depends(get_current_user)])


@router.get("/data-dictionary")
def get_data_dictionary():
    return data_dictionary.build()


# Static, hand-maintained (a tech stack doesn't change on every deploy the way
# the database schema does) - update this alongside CLAUDE.md when a real
# stack decision changes, not on every commit.
_SYSTEM_INFO = {
    "intro": "Nexus is a single internal portal that runs in the browser, built and deployed continuously "
             "straight from this codebase - no separate mobile or desktop build.",
    "sections": [
        {
            "key": "frontend",
            "icon": "Globe",
            "title": "Web Application",
            "subtitle": "What you see in the browser",
            "points": [
                "Built with React 19 and Vite - a single-page app, not server-rendered.",
                "Deployed on Cloudflare Pages' global edge network for fast access anywhere.",
                "Microsoft Entra ID (MSAL) handles sign-in - the same Microsoft 365 account everyone already uses.",
                "Responsive layout - works on desktop and tablet browsers; phone-width gets a simplified nav.",
            ],
        },
        {
            "key": "backend",
            "icon": "Server",
            "title": "Server Logic",
            "subtitle": "The rules that run the business",
            "points": [
                "A FastAPI (Python) backend - every module's business rules, permissions, and integrations live here.",
                "Deployed on Azure App Service. Every merge to dev auto-deploys and restarts the API within a few minutes.",
                "All sensitive operations (approving leave, sealing a signed document, changing a role) run "
                "server-side, never trusted from the browser alone.",
                "Every request is checked against the caller's real session and role - nothing skips authentication.",
            ],
        },
        {
            "key": "database",
            "icon": "Database",
            "title": "Database",
            "subtitle": "Where the data lives",
            "points": [
                "Postgres, hosted on Supabase - also provides file storage (documents, photos, signed PDFs) and backups.",
                "SQLAlchemy is the ORM layer between the FastAPI backend and Postgres - every table is a Python model.",
                "Row-Level Security is enabled per table as it ships, so the database itself - not just the API - "
                "enforces who can read or write which rows.",
                "200+ tables today, spanning every module from Tickets to Investor Relations - see the Data "
                "Dictionary tab for the live, current list.",
            ],
        },
        {
            "key": "integrations",
            "icon": "Plug",
            "title": "Integrations",
            "subtitle": "What Nexus talks to",
            "points": [
                "Microsoft Graph - mailbox, calendar, and M365 directory sync.",
                "Egnyte - browse and upload company files at the right folder level from inside Nexus.",
                "GitHub - PR/push activity feeds the admin \"What's New\" drafts and deploy notifications.",
            ],
        },
    ],
}


@router.get("/system-info")
def get_system_info():
    return _SYSTEM_INFO
