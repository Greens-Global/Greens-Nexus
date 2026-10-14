"""LOCAL ONLY - demo data for the offer-first hiring flow (Neil and Charmi, Oct 14).

On "Greens Demo Co" (run scripts_local_seed_hr_packets_demo.py first):
  - three offer letters (category Offer Letter): US Employee, US Contractor,
    India Contractor - picked by Hired As + Works In on Make An Offer;
  - the hiring packet that follows a signed offer, rebuilt from building
    blocks: Employee Onboarding Requirements (asks the person: date of birth,
    PAN, bank account - private ones marked) + the Equipment addendum, plus
    each team's own confidentiality agreement (Administration, IT);
  - two candidates at Interview: Ravi Kumar (IT, hire as a US employee) and
    Arjun Mehta (Administration, hire as an India contractor).
Refuses to run against anything but a local SQLite file. Safe to re-run.

    cd backend && python scripts_local_seed_offer_flow_demo.py
"""
import datetime as dt

import database
import models
from routers.documents import _clean_field_defs

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
    out = []
    for x in parts:
        if x.startswith("{{"):
            out.append({"type": "mergeField", "attrs": {"token": x[2:-2]}})
        elif x.startswith("**"):
            out.append({"type": "text", "text": x[2:-2], "marks": [{"type": "bold"}]})
        else:
            out.append({"type": "text", "text": x})
    return {"type": "paragraph", "content": out}


def sig(role):
    return {"type": "signatureBlock", "attrs": {"role": role}}


def hr(token, label, pay=False):
    return {"token": token, "label": label, "type": "text", "source": "hr", "pay": pay}


def person(token, label, ftype="text", required=True, sensitive=False, options=None):
    d = {"token": token, "label": label, "type": ftype, "source": "person", "required": required, "sensitive": sensitive}
    if options:
        d["options"] = options
    return d


OFFER_US_EMP = doc(
    p("{{today}}"),
    p("{{full_name}}"), p("{{address}}"),
    h("Offer Of Employment"),
    p("Dear ", "{{first_name}}", ","),
    p("Following our recent discussions, we are pleased to offer you employment with ", "{{company_legal}}",
      " as ", "**{{job_title}}**", ", reporting to ", "{{manager}}", "."),
    p("Start date: ", "{{start_date}}", ". Employment type: ", "{{employment_type}}", "."),
    p("Primary work location: ", "{{work_location}}", ". Working hours: ", "{{work_schedule}}", "."),
    p("Base pay: ", "{{salary}}", ". Probation period: ", "{{probation_period}}", "."),
    p("You are eligible for the company's benefits as described in the employee handbook."),
    p("This offer is open until ", "{{offer_expires}}", "."),
    p("Sincerely,"), p("{{signer.company}}"), p("{{signer.company.title}}"),
    sig("company"),
    h("Acceptance"),
    p("I accept this offer of employment on the terms above."),
    sig("employee"),
)
OFFER_US_CON = doc(
    p("{{today}}"),
    p("{{full_name}}"),
    h("Offer Of Independent Contractor Services"),
    p("Dear ", "{{first_name}}", ","),
    p("We are pleased to engage you as an independent contractor to provide ", "**{{job_title}}**",
      " services to ", "{{company_legal}}", ", starting ", "{{start_date}}", "."),
    p("Contractual fee: ", "{{salary}}", ". You are responsible for your own taxes and are not eligible for "
      "employee benefits."),
    p("Services are performed from ", "{{work_location}}", ". This offer is open until ", "{{offer_expires}}", "."),
    p("Sincerely,"), p("{{signer.company}}"),
    sig("company"),
    h("Acceptance"),
    p("I accept this engagement as an independent contractor on the terms above."),
    sig("employee"),
)
OFFER_IN_CON = doc(
    p("{{today}}"),
    h("Offer Of Engagement - Independent Contractor (India)"),
    p("Dear ", "{{full_name}}", ","),
    p("{{company_legal}}", " is pleased to engage you as an independent contractor for the role of ",
      "**{{job_title}}**", " from ", "{{start_date}}", ", working remotely from India."),
    p("Contractual monthly fee: ", "{{salary}}", ", paid by bank transfer after your monthly invoice."),
    p("Notice period: ", "{{notice_period}}", ". This offer is open until ", "{{offer_expires}}", "."),
    p("For ", "{{company_legal}}", ":"), p("{{signer.company}}"),
    sig("company"),
    h("Acceptance"),
    p("I accept this engagement on the terms above."),
    sig("employee"),
)
ONBOARDING = doc(
    h("Employee Onboarding Requirements"),
    p("Name: ", "{{full_name}}", ". Phone: ", "{{phone}}", "."),
    p("Current address: ", "{{address}}", "."),
    p("Date of birth: ", "{{date_of_birth}}", ". PAN number: ", "{{pan_number}}", "."),
    p("Bank: ", "{{bank_name}}", ", account ", "{{bank_account_number}}", " (", "{{type_of_account}}", ")."),
    p("Emergency contact: ", "{{emergency_name}}", " (", "{{emergency_relationship}}", "), ", "{{emergency_phone}}", "."),
    p("I confirm the information above is correct."),
    sig("employee"),
)
CA_ADMIN = doc(
    h("Confidentiality Agreement - Administration"),
    p("{{full_name}}", " will see employee records, payroll and vendor contracts. All of it stays confidential, "
      "during and after the engagement with ", "{{company_legal}}", "."),
    sig("company"), sig("employee"),
)
CA_IT = doc(
    h("Confidentiality Agreement - IT"),
    p("{{full_name}}", " will have administrator access to company systems and data. Credentials, data and "
      "system details stay confidential, during and after work with ", "{{company_legal}}", "."),
    sig("company"), sig("employee"),
)

TEMPLATES = [
    ("demo-offer-us-emp", "Offer Of Employment - US", "offer_letter", OFFER_US_EMP, [hr("probation_period", "Probation Period")]),
    ("demo-offer-us-con", "Independent Contractor Offer - US", "offer_letter", OFFER_US_CON, []),
    ("demo-offer-in-con", "Independent Contractor Offer - India", "offer_letter", OFFER_IN_CON, [hr("notice_period", "Notice Period")]),
    ("demo-doc-onboarding", "Employee Onboarding Requirements", "hr", ONBOARDING, [
        person("date_of_birth", "Date Of Birth", "date"),
        person("pan_number", "PAN Number", sensitive=True, required=False),
        person("bank_name", "Bank Name"),
        person("bank_account_number", "Bank Account Number", sensitive=True),
        person("type_of_account", "Type Of Account", "dropdown", options=["Savings", "Current", "Checking"]),
    ]),
    ("demo-doc-ca-admin", "Confidentiality Agreement - Administration", "hr", CA_ADMIN, []),
    ("demo-doc-ca-it", "Confidentiality Agreement - IT", "hr", CA_IT, []),
]
OFFER_FLOW = [{"key": "company", "role": "signatory", "action": "sign"},
              {"key": "employee", "role": "employee", "action": "sign"}]
HIRE_FLOW = [{"key": "company", "role": "hr", "action": "sign"},
             {"key": "employee", "role": "employee", "action": "sign"}]
OFFERS = [
    ("demo-offer-set-us-emp", "US Employee Offer", "employee", "US", ["demo-offer-us-emp"]),
    ("demo-offer-set-us-con", "US Contractor Offer", "contractor", "US", ["demo-offer-us-con"]),
    ("demo-offer-set-in-con", "India Contractor Offer", "contractor", "IN", ["demo-offer-in-con"]),
]
TEAM_DOCS = [{"match": "department", "value": "Administration", "templateIds": ["demo-doc-ca-admin"]},
             {"match": "department", "value": "IT", "templateIds": ["demo-doc-ca-it"]}]


def main():
    db = database.SessionLocal()
    try:
        ent = db.query(models.HrEntity).filter_by(id=CO).first()
        if not ent:
            raise SystemExit(f"Company {CO} is missing - run scripts_local_seed_hr_packets_demo.py first.")
        ent.country = ent.country or "US"
        ids = [t[0] for t in TEMPLATES]
        db.query(models.DocTemplateVersion).filter(models.DocTemplateVersion.template_id.in_(ids)).delete(
            synchronize_session=False)
        db.query(models.DocTemplate).filter(models.DocTemplate.id.in_(ids)).delete(synchronize_session=False)
        for tid, name, cat, content, defs in TEMPLATES:
            clean = _clean_field_defs(defs)
            meta = {"fieldDefs": clean, "signerRoles": [], "mergeOverrides": {}, "letterheadId": "",
                    "requiresLetterhead": False}
            db.add(models.DocTemplate(id=tid, name=name, category=cat, status="active", version=1, content=content,
                                      field_defs=clean, department="", created_by=ME, created_at=NOW, updated_by=ME,
                                      updated_at=NOW, published_version=1, published_meta=meta, published_by=ME,
                                      published_at=NOW))
            db.add(models.DocTemplateVersion(id=f"{tid}-v1", template_id=tid, version_no=1, content=content))

        for sid, name, wt, country, tids in OFFERS:
            row = db.query(models.HrPacketSetting).filter_by(id=sid).first() or models.HrPacketSetting(id=sid, created_at=NOW)
            db.add(row)
            row.entity_id, row.event, row.worker_type, row.country, row.role_ids = CO, "offer", wt, country, []
            row.engine, row.template_id, row.name, row.doc_template_ids = "documents", "", name, tids
            row.flow, row.subject_role, row.verify_role, row.verify_distinct = OFFER_FLOW, "employee", "hr", 0
            row.letterhead_id, row.pay_mode, row.extra_docs, row.details_form = "", "", [], []
            row.email_message = "We are delighted to offer you this role - please review and sign to accept."

        # The hiring packet after the offer: common documents + each team's CA.
        for sid in ("demo-packet-hire", "demo-packet-hire-remote"):
            row = db.query(models.HrPacketSetting).filter_by(id=sid).first()
            if row is None:
                continue
            base = ["demo-doc-onboarding", "demo-doc-add-equip"] + (["demo-doc-add-remote"] if sid.endswith("remote") else [])
            row.doc_template_ids, row.flow, row.extra_docs = base, HIRE_FLOW, TEAM_DOCS
            row.details_form = []
            row.worker_type = "contractor" if sid.endswith("remote") else "any"
            row.country = ""

        for cid, first, last, email, role, title, dept in (
                ("demo-cand-ravi", "Ravi", "Kumar", "ravi.kumar.demo@example.com", "demo-role-itsupport", "IT Support Associate", "IT"),
                ("demo-cand-arjun", "Arjun", "Mehta", "arjun.mehta.demo@example.com", "demo-role-adminassoc", "Admin Associate", "Administration")):
            c = db.query(models.HrCandidate).filter_by(id=cid).first()
            if c is None:
                c = models.HrCandidate(id=cid, created_by=ME, created_at=NOW)
                db.add(c)
            c.first_name, c.last_name, c.email, c.phone = first, last, email, "555-0100"
            c.company, c.role_id, c.role_title, c.department = CO, role, title, dept
            c.stage, c.employee_id, c.expected_start = "interview", "", (dt.date.today() + dt.timedelta(days=21)).isoformat()
            # A fresh start: no offer or packet left over from an earlier run.
            db.query(models.HrLifeEvent).filter_by(candidate_id=cid).delete(synchronize_session=False)
        db.commit()
        print("Seeded: 3 offer letters (US Employee, US Contractor, India Contractor), the onboarding packet with "
              "team CAs (Administration, IT), and Ravi Kumar + Arjun Mehta at Interview on Greens Demo Co.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
