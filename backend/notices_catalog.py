"""The starting list of Workplace Notices (research of Oct 22 2026, for
counsel to confirm - see the plan at
https://claude.ai/artifact/ChfuZt3NpBfkApDztuxqns).

Seeded into workplace_notices once (notices.ensure_catalog): a missing id is
added, an existing row is NEVER overwritten - HR's edits win. Every row is a
notice with no file yet; the watcher's first pass downloads each official PDF
into a draft for HR to approve, and HR uploads the ones we fill in ourselves
(our carrier on DWC 7, the Payday Notice, the Employee Manual).

Fields (models.WorkplaceNotice):
  area     US | US-CA | US-CA:SAN DIEGO | US-TX | IN
  mode     post (display at the site) | deliver (give to each person) | both | read
  trigger  always | hire | annual | hire_annual | separation | event | election | window
  applies  workerTypes (default employee), minHeadcount, siteKinds (office /
           jobsite / storage; a person whose sites have no kind gets them
           all), hourlyOnly, notStates, settingIs {key: value}
"""

_EMP = {"workerTypes": ["employee"]}


def _n(id, title, *, form="", agency="", kind="poster", area="US", mode="post", trigger="always",
       annual_due="", window=None, applies=None, ack=False, langs=("en",), url="", notes="", sort=0):
    return {"id": id, "title": title, "form_code": form, "agency": agency, "kind": kind, "area": area,
            "mode": mode, "trigger": trigger, "annual_due": annual_due, "window": list(window or []),
            "applies": {**_EMP, **(applies or {})}, "requires_ack": ack, "languages": list(langs),
            "source_url": url, "notes": notes, "sort": sort}


CATALOG = [
    # ── Manual and policies (files from HR; placeholders until then) ──────────
    _n("manual-core", "Greens Employee Manual", kind="manual", mode="read", ack=True, sort=1,
       notes="The manual for every US employee. The final file comes from HR; until then this shows as Coming Soon."),
    _n("manual-ca", "California Addendum", kind="addendum", area="US-CA", mode="read", ack=True, sort=2,
       notes="California policies: harassment prevention with the complaint process, paid sick leave, lactation, family and pregnancy leave."),
    _n("manual-tx", "Texas Addendum", kind="addendum", area="US-TX", mode="read", ack=True, sort=3),
    _n("ca-iipp", "Injury and Illness Prevention Program", kind="policy", area="US-CA", mode="read", sort=4,
       agency="Cal/OSHA", notes="Written plan, 8 CCR 3203. Not a poster: it must be in writing and reachable by employees."),
    _n("ca-wvpp", "Workplace Violence Prevention Plan", kind="policy", area="US-CA", mode="read", sort=5,
       agency="Cal/OSHA", notes="Labor Code 6401.9 (SB 553). May sit inside the IIPP."),
    _n("ca-heat", "Heat Illness Prevention Plan", kind="policy", area="US-CA", mode="read", sort=6,
       agency="Cal/OSHA", applies={"siteKinds": ["jobsite", "storage"]}, notes="8 CCR 3395 (outdoor) and 3396 (indoor)."),

    # ── India (contractors) ──────────────────────────────────────────────────
    _n("in-code", "Contractor Code of Conduct", kind="contractor_code", area="IN", mode="read", ack=True, sort=10,
       applies={"workerTypes": ["contractor", "employee"]},
       notes="Confidentiality, data security, anti-bribery, conflict of interest, anti-harassment, invoicing. No leave, sick days or salary language (counsel)."),
    _n("in-closures", "Office Closure Calendar", kind="closures", area="IN", mode="read", sort=11,
       applies={"workerTypes": ["contractor", "employee"]},
       notes="Built from the company's Holiday Calendar: the days no work will be requested. Not a leave entitlement."),
    _n("in-posh", "Anti-Harassment (POSH) Policy", kind="policy", area="IN", mode="read", ack=True, sort=12,
       applies={"workerTypes": ["contractor", "employee"]},
       notes="POSH Act 2013 s.19: the policy, penal consequences and the Internal Committee details. Counsel decides which entity holds the committee."),
    _n("in-privacy", "Contractor Privacy Notice", kind="policy", area="IN", mode="read", sort=13,
       applies={"workerTypes": ["contractor", "employee"]},
       notes="India's DPDP Act 2023: what we keep (PAN, bank, ID, invoices), why, for how long, and who to ask."),

    # ── Federal ──────────────────────────────────────────────────────────────
    _n("fed-flsa", "Employee Rights Under the FLSA", form="WH1088", agency="US DOL", sort=100,
       langs=("en", "es"), url="https://www.dol.gov/sites/dolgov/files/WHD/posters/minwage.pdf"),
    _n("fed-eppa", "Employee Polygraph Protection Act", form="WH1462", agency="US DOL", sort=101,
       langs=("en", "es"), url="https://www.dol.gov/sites/dolgov/files/WHD/legacy/files/eppac.pdf"),
    _n("fed-userra", "Your Rights Under USERRA", form="USERRA", agency="US DOL VETS", mode="both", sort=102,
       langs=("en", "es"), url="https://www.dol.gov/sites/dolgov/files/VETS/files/USERRA-Poster.pdf"),
    _n("fed-eeoc", "Know Your Rights: Workplace Discrimination is Illegal", form="EEOC KYR", agency="EEOC",
       applies={"minHeadcount": 15}, langs=("en", "es"), sort=103,
       url="https://www.eeoc.gov/sites/default/files/2023-06/22-088_EEOC_KnowYourRights6.12.pdf",
       notes="Under revision by the EEOC (2025-2026). Watch for the new version."),
    _n("fed-fmla", "Employee Rights Under the FMLA", form="WH1420", agency="US DOL", mode="both",
       applies={"minHeadcount": 50}, langs=("en", "es"), sort=104,
       url="https://www.dol.gov/sites/dolgov/files/WHD/fmla/fmlaen.pdf"),
    _n("fed-osha", "Job Safety and Health: It's the Law", form="OSHA 3165", agency="OSHA",
       applies={"notStates": ["CA"]}, langs=("en", "es"), sort=105,
       url="https://www.osha.gov/sites/default/files/publications/osha3165.pdf",
       notes="California is a state-plan state: California sites post the Cal/OSHA poster instead."),
    _n("fed-everify", "E-Verify Participation", form="E-Verify", agency="DHS", applies={"settingIs": {"eVerify": True}},
       langs=("en", "es"), sort=106, url="https://www.e-verify.gov/sites/default/files/everify/posters/EVerifyParticipationPoster.pdf"),
    _n("fed-righttowork", "Right to Work", form="IER", agency="DOJ IER", applies={"settingIs": {"eVerify": True}},
       langs=("en", "es"), sort=107, url="https://www.e-verify.gov/sites/default/files/everify/posters/IER_RightToWorkPoster.pdf"),
    _n("fed-aca", "Health Insurance Marketplace Coverage Options", form="ACA", agency="US DOL EBSA", kind="handout",
       mode="deliver", trigger="hire", sort=108,
       url="https://www.dol.gov/sites/dolgov/files/EBSA/laws-and-regulations/laws/affordable-care-act/for-employers-and-advisers/model-notice-for-employers-who-offer-a-health-plan-to-some-or-all-employees.pdf",
       notes="Within 14 days of start. The model form's approval runs out 12/31/2026."),
    _n("fed-osha-300a", "OSHA Form 300A Annual Summary", form="300A", agency="OSHA", trigger="window",
       window=["02-01", "04-30"], applies={"notStates": ["CA"], "minHeadcount": 11}, sort=109,
       notes="Filled in by us from the injury log. Posted 02/01 to 04/30."),

    # ── California ───────────────────────────────────────────────────────────
    _n("ca-mw", "California Minimum Wage", form="MW-2026", agency="DIR", area="US-CA", sort=200,
       url="https://www.dir.ca.gov/iwc/MW-2026.pdf", notes="New every 01/01. 2027: $17.40."),
    _n("ca-wo16", "Wage Order 16 - On-Site Construction", form="IWC 16", agency="DIR", area="US-CA", sort=201,
       applies={"siteKinds": ["jobsite"]}, url="https://www.dir.ca.gov/IWC/IWCArticle16.pdf"),
    _n("ca-wo4", "Wage Order 4 - Professional, Technical and Clerical", form="IWC 4", agency="DIR", area="US-CA",
       sort=202, applies={"siteKinds": ["office"]}, url="https://www.dir.ca.gov/IWC/IWCArticle4.pdf"),
    _n("ca-wo5", "Wage Order 5 - Public Housekeeping (Storage, Property Management)", form="IWC 5", agency="DIR",
       area="US-CA", sort=203, applies={"siteKinds": ["storage"]}, url="https://www.dir.ca.gov/IWC/IWCArticle5.pdf"),
    _n("ca-psl", "Paid Sick Leave", form="PSL", agency="DIR", area="US-CA", sort=204, langs=("en", "es"),
       url="https://www.dir.ca.gov/DLSE/Publications/Paid_Sick_Days_Poster_Template_(11_2014).pdf"),
    _n("ca-payday", "Payday Notice", form="LC 207", agency="DIR", area="US-CA", sort=205,
       url="https://www.dir.ca.gov/dlse/PaydayNotice.pdf", notes="Filled in with our paydays and where we pay."),
    _n("ca-calosha", "Safety and Health Protection on the Job", form="Cal/OSHA", agency="DIR", area="US-CA", sort=206,
       langs=("en", "es"), url="https://www.dir.ca.gov/dosh/dosh_publications/shpstreng012000.pdf"),
    _n("ca-emergency", "Emergency Phone Numbers", form="8 CCR 1512", agency="Cal/OSHA", area="US-CA", sort=207,
       applies={"siteKinds": ["jobsite"]}, url="https://www.dir.ca.gov/dosh/dosh_publications/s500pstr.pdf",
       notes="Filled in per job site."),
    _n("ca-safe-practices", "Code of Safe Practices", form="8 CCR 1509", agency="Cal/OSHA", area="US-CA", sort=208,
       applies={"siteKinds": ["jobsite"]}, notes="Our own code, posted at each job site."),
    _n("ca-dwc7", "Notice to Employees - Injuries Caused by Work", form="DWC 7", agency="DIR DWC", area="US-CA",
       sort=209, langs=("en", "es"), url="https://www.dir.ca.gov/dwc/NoticePoster.pdf",
       notes="Filled in with our workers' comp carrier."),
    _n("ca-whistleblower", "Whistleblower Protections", form="LC 1102.8", agency="DIR", area="US-CA", sort=210,
       url="https://www.dir.ca.gov/dlse/WhistleblowersNotice.pdf"),
    _n("ca-crd-discrim", "Workplace Discrimination and Harassment", form="CRD-E07P", agency="CRD", area="US-CA",
       sort=211, langs=("en", "es"),
       url="https://calcivilrights.ca.gov/wp-content/uploads/sites/32/2023/01/Workplace-Discrimination-Poster_ENG.pdf"),
    _n("ca-crd-transgender", "Rights of Transgender and Gender Nonconforming Employees", form="CRD-E04P",
       agency="CRD", area="US-CA", sort=212, applies={"minHeadcount": 5},
       url="https://calcivilrights.ca.gov/wp-content/uploads/sites/32/2022/11/The-Rights-of-Employees-who-are-Transgender-or-Gender-Nonconforming-Poster_ENG.pdf"),
    _n("ca-crd-pregnancy", "Your Rights and Obligations as a Pregnant Employee", form="CRD", agency="CRD",
       area="US-CA", sort=213, applies={"minHeadcount": 5},
       url="https://calcivilrights.ca.gov/wp-content/uploads/sites/32/2023/01/Your-Rights-and-Obligations-as-a-Pregnant-Employee_ENG.pdf"),
    _n("ca-crd-cfra", "Family Care and Medical Leave and Pregnancy Disability Leave", form="CRD", agency="CRD",
       area="US-CA", sort=214, applies={"minHeadcount": 5},
       url="https://calcivilrights.ca.gov/wp-content/uploads/sites/32/2023/01/CFRA-and-Pregnancy-Leave_ENG.pdf"),
    _n("ca-de1857a", "Notice to Employees: UI, DI and PFL", form="DE 1857A", agency="EDD", area="US-CA", sort=215,
       langs=("en", "es"), url="https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de1857a.pdf"),
    _n("ca-vote", "Time Off to Vote", form="EC 14001", agency="Secretary of State", area="US-CA", trigger="election",
       sort=216, url="https://elections.cdn.sos.ca.gov/pdfs/tov-english.pdf",
       notes="Posted 10 days before each statewide election (dates in Notices settings)."),
    _n("ca-300a", "Cal/OSHA Form 300A Annual Summary", form="300A", agency="Cal/OSHA", area="US-CA", trigger="window",
       window=["02-01", "04-30"], applies={"minHeadcount": 11}, sort=217,
       notes="Filled in by us from the injury log. Posted 02/01 to 04/30, even with no cases."),
    _n("ca-lc90", "Notice of Inspection by Immigration Agencies", form="LC 90.2", agency="DIR", area="US-CA",
       trigger="event", sort=218, url="https://www.dir.ca.gov/DLSE/LC_90.2_EE_Notice.pdf",
       notes="Post within 72 hours of receiving an I-9 inspection notice."),
    _n("ca-sb294", "Workplace Know Your Rights", form="SB 294", agency="DIR", area="US-CA", kind="handout",
       mode="deliver", trigger="hire_annual", annual_due="02-01", sort=230,
       url="https://www.dir.ca.gov/dlse/Know-Your-Rights-Notice/Know-Your-Rights-Notice-English.pdf",
       notes="To every employee by 02/01 each year and to each new hire. New template every year (LC 1554). Records kept 3 years."),
    _n("ca-dwc-hire", "Workers' Comp Time of Hire Notice", form="DWC TOH", agency="DIR DWC", area="US-CA",
       kind="handout", mode="deliver", trigger="hire", sort=231, langs=("en", "es"),
       url="https://www.dir.ca.gov/dwc/DWCPamphlets/TimeOfHireNotice.pdf"),
    _n("ca-de2515", "Disability Insurance Provisions", form="DE 2515", agency="EDD", area="US-CA", kind="handout",
       mode="deliver", trigger="hire", sort=232, url="https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de2515.pdf"),
    _n("ca-de2511", "Paid Family Leave", form="DE 2511", agency="EDD", area="US-CA", kind="handout",
       mode="deliver", trigger="hire", sort=233, url="https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de2511.pdf"),
    _n("ca-crd-sh", "Sexual Harassment Fact Sheet", form="CRD-185", agency="CRD", area="US-CA", kind="handout",
       mode="deliver", trigger="hire", sort=234,
       url="https://calcivilrights.ca.gov/wp-content/uploads/sites/32/2020/03/Sexual-Harassment-Fact-Sheet_ENG.pdf"),
    _n("ca-crd-survivors", "Survivors of Violence: Right to Leave and Accommodations", form="CRD", agency="CRD",
       area="US-CA", kind="handout", mode="deliver", trigger="hire_annual", annual_due="12-31", sort=235,
       url="https://calcivilrights.ca.gov/wp-content/uploads/sites/32/2025/07/Survivors-Right-to-Time-Off_English-B.pdf",
       notes="At hire, once a year, and whenever someone tells us they or a family member is a victim."),
    _n("ca-eitc", "California Earned Income Tax Credit", form="EITC", agency="EDD", area="US-CA", kind="handout",
       mode="deliver", trigger="annual", annual_due="02-07", sort=236,
       url="https://edd.ca.gov/en/payroll_taxes/year-end_notification_requirements/",
       notes="Within one week of the W-2. A bulletin board does not count."),
    _n("ca-de2320", "For Your Benefit (Unemployment)", form="DE 2320", agency="EDD", area="US-CA", kind="handout",
       mode="deliver", trigger="separation", sort=237, url="https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de2320.pdf",
       notes="When someone is let go, laid off or placed on leave."),
    _n("ca-lc2810", "Notice to Employee (Wage Theft Prevention Act)", form="LC 2810.5", agency="DIR", area="US-CA",
       kind="form", mode="deliver", trigger="hire", applies={"hourlyOnly": True}, sort=238,
       url="https://www.dir.ca.gov/dlse/lc_2810.5_notice.pdf",
       notes="Filled in per person with their pay - sent through Documents (Nexus Sign), not from here. Within 7 days of any change."),

    # ── City of San Diego ────────────────────────────────────────────────────
    _n("sd-mw", "San Diego Minimum Wage Notice", form="SD MW", agency="City of San Diego", area="US-CA:SAN DIEGO",
       sort=300, langs=("en", "es"),
       url="https://www.sandiego.gov/sites/default/files/2026-09/2027-minimum-wage-notice-5-languages-sept-2026.pdf",
       notes="New every 01/01. 2027: $18.35. At any workplace or job site inside city limits."),
    _n("sd-esl", "San Diego Earned Sick Leave Notice", form="SD ESL", agency="City of San Diego",
       area="US-CA:SAN DIEGO", sort=301, url="https://www.sandiego.gov/sites/default/files/esl_notice_english.pdf"),
    _n("sd-ee", "San Diego Employer-to-Employee Notice", form="SD EE", agency="City of San Diego",
       area="US-CA:SAN DIEGO", kind="handout", mode="deliver", trigger="hire", sort=302,
       url="https://www.sandiego.gov/sites/default/files/employer_to_employee_notice_english.pdf"),

    # ── Texas ────────────────────────────────────────────────────────────────
    _n("tx-ui-payday", "Texas Unemployment Compensation Act and Payday Law", form="TWC Y-10", agency="TWC",
       area="US-TX", sort=400,
       url="https://www.twc.texas.gov/files/businesses/texas-unemployment-compensation-act-and-texas-payday-law-poster-twc.pdf"),
    _n("tx-wpv", "Reporting Workplace Violence", form="TWC WPV", agency="TWC", area="US-TX", sort=401,
       langs=("en", "es"), url="https://www.twc.texas.gov/sites/default/files/fdcm/docs/workplace-violence-poster-twc.pdf"),
    _n("tx-notice6", "Notice 6 - Workers' Comp Coverage", form="Notice 6", agency="TDI DWC", area="US-TX", sort=402,
       applies={"settingIs": {"txWorkersComp": "subscriber"}}, langs=("en", "es"),
       url="https://www.tdi.texas.gov/forms/dwc/notice6.pdf"),
    _n("tx-notice5", "Notice 5 - No Workers' Comp Coverage", form="Notice 5", agency="TDI DWC", area="US-TX",
       sort=403, applies={"settingIs": {"txWorkersComp": "non_subscriber"}}, langs=("en", "es"),
       url="https://www.tdi.texas.gov/forms/dwc/notice5.pdf"),
    _n("tx-newhire", "New Employee Workers' Comp Notice", form="TDI New Hire", agency="TDI DWC", area="US-TX",
       kind="handout", mode="deliver", trigger="hire", sort=404,
       url="https://www.tdi.texas.gov/forms/dwc/newempnotice011.pdf"),
    _n("tx-ui-separation", "Unemployment Benefits Notice", form="TWC 815.1", agency="TWC", area="US-TX",
       kind="handout", mode="deliver", trigger="separation", sort=405,
       notes="At separation (40 TAC 815.1). TWC proposed changes in 2026."),
]

# Defaults for Notices > Settings (NexusSetting "workplace_notices"). Neil,
# Oct 22 2026: count Greens, MCD and Oversite together for headcount; everyone
# re-acknowledges the manual every January; we use E-Verify; English only.
DEFAULT_SETTINGS = {
    "approvers": [],              # empty = HR (the company HR contacts, administrators, Full HR)
    "countCompaniesTogether": True,
    "yearlyAck": True,            # every January, everyone acknowledges the manual again
    "yearlyAckDueDays": 31,
    "ackDueDays": 14,
    "eVerify": True,
    "txWorkersComp": "subscriber",
    "languages": ["en"],
    "elections": ["2026-11-03"],  # statewide California elections (Time Off to Vote)
    "hireSince": "",              # first day of the module: at-hire bundles go only to people who start on or after it
    "watcherOn": True,
}
