"""The emails an HR life event sends (Pranshu, Oct 8: "there should be some
email ... and in that email our hiring packet, promotion should be linked by
which they click and sign").

Nexus Sign's generic invite says "Action needed: Please sign <title>" - fine
for a contract, cold for a new hire's first email from the company. A life
event's envelope (link_kind 'life_event') gets its own email instead, on the
same branded layout and with the same safety copy (who sent it, how to check,
the one-time code, the legal footer):

  hire        -> the new hire: welcome, the role and start date, the welcome
                 note HR set on the packet, the documents, "Review & Sign"
  promotion   -> the employee: congratulations, from -> to, effective date;
                 their manager, after them: "your approval is needed"
  separation  -> the person leaving: neutral and factual - last day, documents

Anyone else on the envelope (e.g. HR signing for the company) gets Nexus
Sign's own email. preview() renders any of them with sample data so HR can
see exactly what goes out before sending (Packets > Preview Email).
"""
from html import escape

from sqlalchemy.orm import Session

from models import HrEntity, HrLifeEvent, HrSignParty, HrSignRequest

BTN = {"hire": "Review &amp; Sign Your Offer", "promotion": "Review &amp; Sign Your Letter",
       "separation": "Review &amp; Sign Your Documents"}


def _long(iso: str) -> str:
    from hr_life_events import us_long_date
    return us_long_date(iso or "")


def _doc_list(req) -> list:
    names = [req.title] + [d.get("name", "") for d in (getattr(req, "documents", None) or [])]
    return [n for n in names if n]


def _company(db: Session, entity_id: str) -> str:
    e = db.query(HrEntity).filter(HrEntity.id == entity_id).first() if entity_id else None
    return (e.legal_name or e.name) if e else "Greens"


def _layout(*, header_title: str, header_sub: str, greeting: str, body_html: str, note: str,
            docs: list, button: str, link: str, sender: dict, party, req, closing: str) -> str:
    from routers import esign
    import email_theme
    th = email_theme.current()
    contact = []
    if sender.get("email"):
        contact.append(f'<a href="mailto:{escape(sender["email"])}" style="color:#15803d;text-decoration:none">'
                       f'{escape(sender["email"])}</a>')
    if sender.get("phone"):
        contact.append(escape(sender["phone"]))
    doc_rows = "".join(f'<tr><td style="padding:6px 0;font-size:13.5px;color:#111827">&#128196;&nbsp; {escape(d)}</td></tr>'
                       for d in docs)
    expires = getattr(req, "expires_on", "") or ""
    return f"""<div style="font-family:Inter,Segoe UI,Arial,sans-serif;background:#f3f4f6;padding:28px 12px">
  <table style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border-collapse:collapse;width:100%">
    <tr><td style="background:{th.color('#14532d')};padding:26px 36px">{esign._esign_logo(th)}
      <div style="color:#ffffff;font-size:21px;font-weight:800">{escape(header_title)}</div>
      <div style="color:#bbf7d0;font-size:13px;margin-top:4px">{escape(header_sub)}</div>
    </td></tr>
    <tr><td style="padding:28px 36px 6px">
      <p style="margin:0 0 14px;font-size:15px;color:#111827">{greeting}</p>
      <div style="font-size:14px;color:#374151;line-height:1.65">{body_html}</div>
      {f'<div style="margin:16px 0 0;padding:12px 16px;border-left:3px solid #15803d;background:#f0fdf4;font-size:13.5px;color:#14532d;line-height:1.6;white-space:pre-line">{escape(note)}</div>' if note else ''}
    </td></tr>
    <tr><td style="padding:18px 36px 0">
      <div style="font-size:10.5px;font-weight:700;color:#6b7280;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px">To review and sign</div>
      <table style="width:100%;border-collapse:collapse">{doc_rows}</table>
    </td></tr>
    <tr><td style="padding:20px 36px 6px">
      <a href="{link}" style="background:{th.color('#15803d')};color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 34px;border-radius:9px;display:inline-block">{button}</a>
      <p style="margin:14px 0 0;font-size:12.5px;color:#6b7280;line-height:1.6">
        How it works: open the link, confirm the one-time code we email you, then review and sign each document.
        It takes a few minutes and works on your phone.
        {('Please sign by ' + escape(_long(expires)) + '.') if expires else ''}</p>
    </td></tr>
    <tr><td style="padding:16px 36px 4px">
      <p style="margin:0;font-size:14px;color:#374151;line-height:1.6">{closing}</p>
    </td></tr>
    <tr><td style="padding:14px 36px 24px">
      <table style="width:100%;border-collapse:collapse;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px">
        <tr><td style="padding:12px 16px">
          <div style="font-size:10.5px;font-weight:700;color:#6b7280;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px">Questions? Contact</div>
          <div style="font-size:13.5px;font-weight:700;color:#111827">{escape(sender.get('name') or '')}</div>
          {f'<div style="font-size:12.5px;color:#6b7280;margin-top:2px">{escape(sender.get("title") or "")}</div>' if sender.get('title') else ''}
          {f'<div style="font-size:12.5px;color:#374151;margin-top:4px">{" &middot; ".join(contact)}</div>' if contact else ''}
          <div style="font-size:11.5px;color:#6b7280;margin-top:8px;line-height:1.5">Not expecting this? Contact them directly before opening the link. The link is unique to you.</div>
        </td></tr>
      </table>
    </td></tr>
    {esign._email_legal_footer(party, req, sender)}
  </table>
</div>"""


def compose(kind: str, *, role: str, first_name: str, company: str, inputs: dict, note: str,
            docs: list, link: str, sender: dict, party, req, subject_name: str = "") -> tuple:
    """(subject, html) for one recipient of a life event."""
    d = inputs or {}
    first = escape(first_name or "there")
    if kind == "hire":
        title, start = d.get("job_title") or "your new role", _long(d.get("start_date"))
        return (f"Welcome to {company} - your offer and onboarding documents",
                _layout(header_title=f"Welcome to {company}", header_sub="Your offer and onboarding documents",
                        greeting=f"Hi {first},",
                        body_html=(f"We are delighted to offer you the position of <strong>{escape(title)}</strong> "
                                   f"at <strong>{escape(company)}</strong>"
                                   + (f", starting <strong>{escape(start)}</strong>" if start else "") + ". "
                                   "Your offer letter and onboarding documents are ready - signing them is how you "
                                   "accept the offer."),
                        note=note, docs=docs, button=BTN["hire"], link=link, sender=sender, party=party, req=req,
                        closing="We can't wait to have you on the team."))
    if kind == "promotion":
        is_role_change = d.get("change_type") == "role_change"
        new, old, eff = d.get("job_title") or "your new role", d.get("old_title") or "", _long(d.get("effective_date"))
        if role == "manager":
            return (f"Approval needed: {subject_name}'s {'role change' if is_role_change else 'promotion'} letter",
                    _layout(header_title="Your approval is needed",
                            header_sub=f"{subject_name} - {'role change' if is_role_change else 'promotion'} letter",
                            greeting=f"Hi {first},",
                            body_html=(f"<strong>{escape(subject_name)}</strong> has signed their letter: "
                                       + (f"{escape(old)} to " if old else "") + f"<strong>{escape(new)}</strong>"
                                       + (f", effective <strong>{escape(eff)}</strong>" if eff else "") + ". "
                                       "As their manager, please review and sign it to make it official."),
                            note="", docs=docs, button=BTN["promotion"], link=link, sender=sender, party=party,
                            req=req, closing="Thank you."))
        return ((f"Your role change to {new}" if is_role_change else f"Congratulations on your promotion to {new}"),
                _layout(header_title=("Your new role" if is_role_change else "Congratulations!"),
                        header_sub=f"{'Role change' if is_role_change else 'Promotion'} letter - {new}",
                        greeting=f"Hi {first},",
                        body_html=(("Thank you for your excellent work. " if not is_role_change else "")
                                   + "Your role is changing "
                                   + (f"from <strong>{escape(old)}</strong> " if old else "")
                                   + f"to <strong>{escape(new)}</strong>"
                                   + (f", effective <strong>{escape(eff)}</strong>" if eff else "") + ". "
                                   "Your letter sets out your new responsibilities"
                                   + (" and your new pay" if d.get("salary_text") or d.get("has_pay") else "")
                                   + ". Please review and sign it - your manager signs after you."),
                        note=note, docs=docs, button=BTN["promotion"], link=link, sender=sender, party=party,
                        req=req, closing="Congratulations again, and thank you."
                        if not is_role_change else "Thank you."))
    if kind == "separation":
        last = _long(d.get("last_day"))
        return (f"Your separation documents from {company}",
                _layout(header_title=company, header_sub="Separation documents",
                        greeting=f"Hi {first},",
                        body_html=("This confirms that your last day with "
                                   f"<strong>{escape(company)}</strong> "
                                   + (f"is <strong>{escape(last)}</strong>" if last else "has been set") + ". "
                                   "Please review and sign your separation documents. They include what happens "
                                   "next with your final pay, benefits and company property."),
                        note=note, docs=docs, button=BTN["separation"], link=link, sender=sender, party=party,
                        req=req, closing="If anything in them is unclear, reply to the contact below before signing."))
    return None


def invite_email(db: Session, req: HrSignRequest, party: HrSignParty, sender: dict, link: str):
    """(subject, html) for this party of a life-event envelope, or None to use
    Nexus Sign's own email (HR signing for the company, anyone else)."""
    ev = db.query(HrLifeEvent).filter(HrLifeEvent.id == req.link_id).first() if req.link_id else None
    if not ev:
        return None
    is_subject = (party.email or "").lower() == (ev.subject_email or "").lower()
    role = "subject" if is_subject else (party.role_key or "")
    if not is_subject and not (ev.kind == "promotion" and role == "manager"):
        return None
    first = (party.name or "").split(" ")[0] if is_subject else (party.name or "").split(" ")[0]
    inputs = dict(ev.inputs or {})
    inputs["has_pay"] = bool(ev.pay)
    return compose(ev.kind, role=role, first_name=first, company=_company(db, ev.entity_id), inputs=inputs,
                   note=(req.message or "") if is_subject else "", docs=_doc_list(req), link=link,
                   sender=sender, party=party, req=req, subject_name=ev.subject_name)


SAMPLE = {
    "hire": {"job_title": "Senior Analyst", "start_date": "2026-11-02"},
    "promotion": {"job_title": "Senior Analyst II", "old_title": "Senior Analyst", "effective_date": "2026-11-01",
                  "change_type": "promotion", "has_pay": True},
    "separation": {"last_day": "2026-10-31"},
}


def preview(db: Session, user: dict, event: str, entity_id: str, template_name: str, note: str,
            documents: list, role: str = "subject") -> tuple:
    """What the email for `event` looks like - sample person, real company,
    real welcome note and document names."""
    from routers import esign
    company = _company(db, entity_id)
    # Real (never saved) records, so every helper finds every field it reads.
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    fake_req = HrSignRequest(id="preview", title=template_name or "Hiring Packet", source="template",
                             documents=[{"name": d} for d in documents], message=note, expires_on="",
                             entity_id=entity_id, created_by=user["email"], created_at=now, status="pending",
                             link_kind="life_event", link_id="", governing_law="CA", verify_token="")
    fake_party = HrSignParty(id="preview", request_id="preview",
                             name="Jane Doe" if role == "subject" else "Max Manager",
                             email="jane.doe@example.com", kind="external", role_key="employee", token="preview",
                             access_code="", phone="", org="", title="", ordinal=1, party_role="signer",
                             status="notified")
    try:
        sender = esign._sender_identity(db, fake_req)
    except Exception:
        sender = {"name": user["email"], "email": user["email"]}
    return compose(event, role=role, first_name="Jane" if role == "subject" else "Max", company=company,
                   inputs=SAMPLE.get(event, {}), note=note, docs=_doc_list(fake_req),
                   link="#", sender=sender, party=fake_party, req=fake_req, subject_name="Jane Doe")
