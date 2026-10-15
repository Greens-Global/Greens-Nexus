"""LOCAL ONLY - demo data for HR packets built from Documents (Oct 14).

Seeds the "Greens Demo Co" company with published templates (offer letter,
NDA, two addenda, two job descriptions, promotion letter, separation
letter), turns its three demo packets into Documents packets, and adds an
employee to offboard. Refuses to run against anything but a local SQLite
file. Safe to re-run: every row has a fixed id and is replaced.

    cd backend && python scripts_local_seed_hr_packets_demo.py
"""
import datetime as dt

import database
import models

if not str(database.engine.url).startswith("sqlite"):
    raise SystemExit("Refusing: this seed only writes to a local SQLite database.")

ME = "pranshu.pandey@greensglobal.com"
CO = "demo-ent-greens-demo"
NOW = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds")


def doc(*nodes):
    return {"pages": [{"id": "p1", "json": {"type": "doc", "content": list(nodes)}}]}


def h(text):
    return {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": text}]}


def p(*parts):
    """A paragraph; "{{x}}" parts become merge fields, "**x**" bold text."""
    out = []
    for x in parts:
        if x.startswith("{{"):
            out.append({"type": "mergeField", "attrs": {"token": x[2:-2]}})
        elif x.startswith("**"):
            out.append({"type": "text", "text": x[2:-2], "marks": [{"type": "bold"}]})
        else:
            out.append({"type": "text", "text": x})
    return {"type": "paragraph", "content": out}


def bullets(*items):
    return {"type": "bulletList", "content": [
        {"type": "listItem", "content": [p(i)]} for i in items]}


def sig(role):
    return {"type": "signatureBlock", "attrs": {"role": role}}


OFFER = doc(
    p("{{today}}"),
    p("Dear ", "{{first_name}}", " ", "{{last_name}}", ","),
    p("We are pleased to offer you the position of ", "**{{job_title}}**", " at ", "{{company}}",
      ". This is a ", "{{employment_type}}", " role reporting to ", "{{manager}}", "."),
    h("Terms Of The Offer"),
    bullets("Start date: {{start_date}}", "Compensation: {{salary}}", "Working hours: {{work_schedule}}"),
    p("This offer is open until ", "{{offer_expires}}", ". It is subject to the enclosed confidentiality "
      "agreement and the job description for your role."),
    p("Sincerely,"),
    p("{{signer.company}}"),
    sig("company"),
    h("Acceptance"),
    p("I accept this offer on the terms above."),
    sig("employee"),
)

NDA = doc(
    h("Confidentiality Agreement"),
    p("This agreement is between ", "{{company}}", " and ", "**{{full_name}}**", "."),
    p("You agree to keep confidential all non-public information about the company, its properties, "
      "tenants, investors and employees, during and after your employment."),
    bullets("Do not share confidential information outside the company.",
            "Return all company documents and equipment when you leave.",
            "Report any accidental disclosure to HR right away."),
    sig("employee"),
)

ADD_EQUIP = doc(
    h("Addendum - Equipment Use"),
    p("Company laptops, phones and tools issued to ", "{{full_name}}", " stay company property and are "
      "returned on the last day of work."),
    sig("employee"),
)

ADD_REMOTE = doc(
    h("Addendum - Remote Work"),
    p("{{full_name}}", " may work remotely on agreed days. Working hours stay ", "{{work_schedule}}", "."),
    p("Company information is only accessed on company devices over a secure connection."),
    sig("employee"),
)

JD_SITE = doc(
    h("Job Description - Site Coordinator"),
    p("Reports to: ", "{{manager}}"),
    p("**Responsibilities**"),
    bullets("Coordinate daily site activity with vendors and contractors.",
            "Keep site logs, permits and safety records current.",
            "Flag maintenance issues and follow them to closure."),
    p("**Requirements**"),
    bullets("2+ years in property or construction coordination.", "Valid driver's license."),
    p("I have read and understand this job description."),
    sig("employee"),
)

JD_IT = doc(
    h("Job Description - IT Support Associate"),
    p("Reports to: ", "{{manager}}"),
    p("**Responsibilities**"),
    bullets("Answer support tickets and set up new hires' devices.",
            "Maintain the hardware inventory in Nexus.",
            "Keep Microsoft 365 accounts and licenses tidy."),
    p("I have read and understand this job description."),
    sig("employee"),
)

PROMO = doc(
    p("{{today}}"),
    p("Dear ", "{{first_name}}", ","),
    p("Congratulations! We are pleased to confirm your ", "{{change_type}}", " from ", "{{old_title}}",
      " to ", "**{{new_title}}**", ", effective ", "{{effective_date}}", "."),
    p("Your new compensation is ", "{{salary}}", ". You will continue to report to ", "{{manager}}", "."),
    p("Sincerely,"),
    p("{{signer.company}}"),
    sig("company"),
    p("Acknowledged:"),
    sig("employee"),
)

SEPARATION = doc(
    p("{{today}}"),
    p("Dear ", "{{first_name}}", ","),
    p("This letter confirms that your employment with ", "{{company}}", " as ", "{{job_title}}",
      " ends on ", "**{{last_day}}**", " (", "{{separation_type}}", ")."),
    p("Please return all company equipment by your last day. Your final pay and any benefits continuation "
      "details will follow separately."),
    p("Sincerely,"),
    p("{{signer.company}}"),
    sig("company"),
    p("Acknowledged:"),
    sig("employee"),
)

TEMPLATES = [
    ("demo-doc-offer", "Offer Letter", "hr", OFFER),
    ("demo-doc-nda", "Confidentiality Agreement (NDA)", "hr", NDA),
    ("demo-doc-add-equip", "Addendum - Equipment Use", "hr", ADD_EQUIP),
    ("demo-doc-add-remote", "Addendum - Remote Work", "hr", ADD_REMOTE),
    ("demo-doc-jd-site", "Job Description - Site Coordinator", "job_description", JD_SITE),
    ("demo-doc-jd-it", "Job Description - IT Support Associate", "job_description", JD_IT),
    ("demo-doc-promo", "Promotion Letter", "hr", PROMO),
    ("demo-doc-sep", "Separation Letter", "hr", SEPARATION),
]

HIRE_FLOW = [{"key": "company", "role": "signatory", "action": "sign"},
             {"key": "manager", "role": "manager", "action": "copy"},
             {"key": "employee", "role": "employee", "action": "sign"}]
PROMO_FLOW = [{"key": "company", "role": "hr", "action": "sign"},
              {"key": "employee", "role": "employee", "action": "sign"},
              {"key": "manager", "role": "manager", "action": "copy"}]
SEP_FLOW = [{"key": "company", "role": "hr", "action": "sign"},
            {"key": "employee", "role": "employee", "action": "sign"}]

PACKETS = [
    # (id, event, name, templates, flow) - the three demo PDF packets become Documents packets
    ("demo-packet-hire", "hire", "Standard Hire", ["demo-doc-offer", "demo-doc-nda", "demo-doc-add-equip"], HIRE_FLOW),
    ("demo-packet-hire-remote", "hire", "Remote Hire",
     ["demo-doc-offer", "demo-doc-nda", "demo-doc-add-equip", "demo-doc-add-remote"], HIRE_FLOW),
    ("demo-packet-promo", "promotion", "Promotion Letter", ["demo-doc-promo"], PROMO_FLOW),
    ("demo-packet-sep", "separation", "Separation Package", ["demo-doc-sep"], SEP_FLOW),
]


def main():
    db = database.SessionLocal()
    try:
        ent = db.query(models.HrEntity).filter_by(id=CO).first()
        if not ent:
            raise SystemExit(f"Company {CO} is missing - run the earlier demo seeds first.")
        ent.hr_contact_email = ME          # verifies every packet
        ent.signatory_email = ME           # signs offer letters as Authorized Signatory

        meta = {"fieldDefs": [], "signerRoles": [], "mergeOverrides": {}, "letterheadId": "",
                "requiresLetterhead": False}
        ids = [t[0] for t in TEMPLATES]
        db.query(models.DocTemplateVersion).filter(models.DocTemplateVersion.template_id.in_(ids)).delete(
            synchronize_session=False)
        db.query(models.DocTemplate).filter(models.DocTemplate.id.in_(ids)).delete(synchronize_session=False)
        for tid, name, cat, content in TEMPLATES:
            db.add(models.DocTemplate(id=tid, name=name, category=cat, status="active", version=1, content=content,
                                      department="", created_by=ME, created_at=NOW, updated_by=ME, updated_at=NOW,
                                      published_version=1, published_meta=meta, published_by=ME,
                                      published_at=NOW))
            db.add(models.DocTemplateVersion(id=f"{tid}-v1", template_id=tid, version_no=1, content=content))

        for sid, event, name, tids, flow in PACKETS:
            row = db.query(models.HrPacketSetting).filter_by(id=sid).first()
            if not row:
                row = models.HrPacketSetting(id=sid, entity_id=CO, event=event, worker_type="any")
                db.add(row)
            # "Remote Hire" sits on a worker type nobody resolves to, so Standard
            # Hire is the default and Remote Hire is picked by hand.
            row.entity_id, row.event, row.role_ids = CO, event, []
            row.worker_type = "contractor" if sid == "demo-packet-hire-remote" else "any"
            row.engine, row.template_id, row.name = "documents", "", name
            row.doc_template_ids, row.flow, row.subject_role = tids, flow, "employee"
            row.verify_role, row.verify_distinct, row.letterhead_id, row.pay_mode = "hr", False, "", ""
            row.email_message = ("Welcome to Greens Demo Co! Please review and sign your documents."
                                 if event == "hire" else "")

        omar = db.query(models.NexusEmployee).filter_by(id="demo-emp-omar").first()
        if not omar:
            omar = models.NexusEmployee(id="demo-emp-omar")
            db.add(omar)
        omar.work_email, omar.personal_email = "omar.demo@greensglobal.com", "omar.reyes.demo@example.com"
        omar.first_name, omar.last_name, omar.employee_code = "Omar", "Reyes", "GD-0042"
        omar.job_title, omar.department, omar.company = "IT Support Associate", "IT", CO
        omar.status, omar.employment_type, omar.manager_email = "active", "full_time", ME
        omar.start_date, omar.created_at, omar.created_by = "2025-03-03", NOW, ME
        omar.country = "US"

        # Two candidates at Offer: Sam (HR fills in his details) and Priya
        # (she fills them in herself from the link).
        priya = db.query(models.HrCandidate).filter_by(id="demo-cand-priya").first()
        if not priya:
            priya = models.HrCandidate(id="demo-cand-priya", created_by=ME, created_at=NOW)
            db.add(priya)
        priya.first_name, priya.last_name, priya.email = "Priya", "Shah", "priya.shah.demo@example.com"
        priya.role_title, priya.department, priya.company = "IT Support Associate", "IT", CO
        for cand in (priya, db.query(models.HrCandidate).filter_by(id="demo-cand-sam").first()):
            if cand:
                cand.stage = "offer"

        db.commit()
        print("Seeded: 8 published templates, 4 Documents packets, Omar Reyes (to offboard).")
        print("Hire: candidates Sam Carter / Priya Shah (Offer stage). Promote: Erin Demo. Offboard: Omar Reyes.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
