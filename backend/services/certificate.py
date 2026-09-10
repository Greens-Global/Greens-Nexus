"""Certificate of Completion - snapshot + deterministic HTML renderer.

Two functions, and the split between them is the whole point:

    build_snapshot(...)   impure - reads ORM rows, takes the clock from its
                          caller, returns a plain JSON-able dict
    render_html(snapshot) PURE - no I/O, no clock, no randomness, no uuid

Same snapshot in, byte-identical HTML out, forever. That is what lets us say
the certificate attached to a filing was not hand-edited: regenerate it from
the archived snapshot and compare bytes. Anything non-deterministic in here -
a `datetime.now()`, a dict built from a set, a random id - destroys that
property silently, so keep this module boring.

Layout is TABLES, not grid or flexbox, and the sheet is a real 816x1056px
letter page. The certificate gets printed, faxed, photocopied and attached to
filings; table layout renders identically in every engine including old ones.

What this certificate does NOT claim: no PAdES/CAdES seal profile, no RFC 3161
timestamp, no HSM key custody, no AATL certificate, no WORM lock. Nexus does
none of those. Printing them would be a false statement inside a document
offered as evidence. See test_esign_certificate for the test that enforces it.

The full audit log is deliberately not printed (build note section 7): the
signer-level events are already in section 2, and a chain head plus an event
count that a verifier can check is a stronger claim than printed rows.
"""
from html import escape

_SHEET_W = 816       # 8.5in at 96dpi
_SHEET_H = 1056      # 11in at 96dpi
_MAX_SIGNERS_ONE_PAGE = 4

_FORMAT_LABELS = {
    "pdf_rendered_in_session": "PDF rendered in session",
    "html_rendered_in_session": "Document rendered in session",
}
# What the Sealing row says when no signer is configured. Defined once so the
# HTML certificate and the sealed PDF cannot disagree about what was applied.
_NO_SEAL_POLICY = (
    "The completed packet is hashed with SHA-256 and stored; the digest above detects any "
    "later change. The file carries no embedded PKI signature, so integrity is verified "
    "against this record, not from the file alone.")

_ROLE_LABELS = {
    "signer": "Signer", "countersigner": "Countersigner", "witness": "Witness",
    "approver": "Approver", "certified_delivery": "Certified delivery", "cc": "Copy",
}

_LAW_NAMES = {"CA": "California", "TX": "Texas", "NV": "Nevada", "AZ": "Arizona",
              "WA": "Washington", "OR": "Oregon", "NY": "New York", "FL": "Florida"}


# ── Snapshot ─────────────────────────────────────────────────────────────────

def build_snapshot(*, req, parties, events, consents, doc_digests, content_sha,
                   entity_name, generated_at, system, chain) -> dict:
    """Everything the certificate states, frozen as plain data.

    `generated_at` is passed in, never read from a clock here - the caller owns
    the timestamp so a regeneration can reproduce the original exactly.
    """
    # Everyone the envelope waited on, in order - signers, countersigners,
    # witnesses, approvers and certified-delivery recipients alike. Section 2
    # states what each of them actually DID; an approver is never described as
    # having signed.
    acting = [p for p in parties if (p.party_role or "signer") != "cc"]
    signers = sorted(acting, key=lambda p: (p.ordinal or 0, p.id or ""))
    ccs = sorted([p for p in parties if (p.party_role or "signer") == "cc"],
                 key=lambda p: (p.ordinal or 0, p.id or ""))
    chain_head = ""
    for e in sorted(events, key=lambda x: (x.seq or 0), reverse=True):
        if e.event_hash:
            chain_head = e.event_hash
            break

    def signer_row(p):
        rec = (consents or {}).get(p.id)
        return {
            "name": p.name or "",
            "email": p.email or "",
            "kind": (p.kind or "").lower(),
            "ordinal": p.ordinal or 0,
            "status": p.status or "",
            "role": (p.party_role or "signer"),
            "role_label": _ROLE_LABELS.get(p.party_role or "signer", "Signer"),
            "signs": (p.party_role or "signer") in ("signer", "countersigner", "witness"),
            "acknowledged_at": getattr(p, "acknowledged_at", "") or "",
            "pages_viewed": int(getattr(p, "pages_viewed", 0) or 0),
            "pages_total": int(getattr(p, "pages_total", 0) or 0),
            "org": getattr(p, "org", "") or "",
            "title": getattr(p, "title", "") or "",
            "auth_method": _auth_method(p),
            "failed_auth_count": int(getattr(p, "failed_auth_count", 0) or 0),
            "consent": {
                "version": (rec.disclosure_version if rec else "") or p.consent_text_version or "",
                "digest": (rec.disclosure_digest if rec else "") or "",
                "accepted_at": (rec.accepted_at if rec else "") or p.consent_at or "",
                "format": _FORMAT_LABELS.get(rec.format_demonstrated, rec.format_demonstrated or "")
                          if rec else "",
                "standing_basis": (rec.standing_basis if rec else "") or "",
                "withdrawn_at": (rec.withdrawn_at if rec else "") or "",
            },
            # The moment this party did their part - signed, approved or
            # acknowledged. Reading signed_at for an approver would print a
            # blank where a real act happened.
            "executed_at": (p.signed_at or "") if (p.party_role or "signer") in
                           ("signer", "countersigner", "witness")
                           else (getattr(p, "acknowledged_at", "") or p.consent_at or ""),
            "ip": _strip_port(p.ip or ""),
            "client": _ua_summary(p.user_agent or ""),
            "signature_kind": p.signature_kind or "",
            # Prefer the digest frozen at signing; fall back to hashing the
            # stored signature only for envelopes sealed before it was stored.
            "signature_digest": (getattr(p, "signature_digest", "") or _sig_digest(p)),
            "signature_field": _signature_field(req, p),
            "decline_reason": p.decline_reason or "",
            "authenticated_at": getattr(p, "authenticated_at", "") or "",
        }

    law = (getattr(req, "governing_law", "") or "").upper()
    return {
        "generated_at": generated_at,
        "system": dict(system),
        "envelope": {
            "id": req.id,
            "short_code": _short_code(req.id),
            "name": req.title or "",
            "entity": entity_name or system.get("operator", ""),
            "initiated_by": req.created_by or "",
            "source": "Authored template" if req.source == "template" else "Uploaded PDF",
            "routing": (req.routing or "sequential").title(),
            "status": (req.status or "").title(),
            "sent_at": req.created_at or "",
            "completed_at": req.completed_at or "",
            "expires_on": req.expires_on or "",
            "document_class": getattr(req, "document_class", "") or "",
            "governing_law": law,
            "governing_law_label": _LAW_NAMES.get(law, law or ""),
            "eligibility_by": getattr(req, "excluded_ack_by", "") or "",
            "eligibility_at": getattr(req, "excluded_ack_at", "") or "",
        },
        "signers": [signer_row(p) for p in signers],
        "ccs": [{"name": p.name or "", "email": p.email or ""} for p in ccs],
        "documents": [{"name": n, "pages": pg, "digest_at_send": ds, "digest_at_completion": dc}
                      for n, pg, ds, dc in (doc_digests or [])],
        "integrity": {
            "content_digest": content_sha or "",
            "chain_head": chain_head,
            "event_count": chain.get("eventCount", 0),
            "chain_valid": chain.get("valid"),
            "chain_available": chain.get("chainAvailable", False),
        },
        "verify_url": system.get("verify_url", ""),
        "retention": system.get("retention", ""),
        # The certificate sits INSIDE the bytes being sealed, so it cannot
        # report the outcome of its own sealing. It states the policy in force;
        # the applied seal is on the envelope's seal row and in the PDF itself.
        "seal_policy": system.get("seal_policy") or _NO_SEAL_POLICY,
    }


def _signature_field(req, p) -> str:
    """'SIG_SUB_REP - p. 17' - the field this party's signature was bound to.
    Pages are 1-based here; they are stored 0-based."""
    fields = list(getattr(req, "fields", None) or [])
    for d in (getattr(req, "documents", None) or []):
        fields.extend(d.get("fields") or [])
    mine = [f for f in fields
            if isinstance(f, dict) and f.get("type") in ("sign", "initials")
            and (f.get("role") or "") == (p.role_key or "")]
    if not mine:
        return ""
    ids = ", ".join(str(f.get("id") or "-") for f in mine[:2])
    pages = sorted({int(f.get("page") or 0) + 1 for f in mine})
    return f"{ids} - p. {', '.join(str(n) for n in pages[:3])}"


def _sig_digest(p) -> str:
    import hashlib
    return hashlib.sha256((p.signature_data or "").encode()).hexdigest() if p.signature_data else ""


def _short_code(envelope_id: str) -> str:
    """A human-typeable code for the printed page. Derived from the envelope id
    (so it is stable and needs no storage) and never used as a credential - the
    QR and the API use the opaque verify token, because a guessable code would
    let anyone confirm which envelopes exist."""
    hexes = "".join(c for c in (envelope_id or "").upper() if c in "0123456789ABCDEF")
    hexes = (hexes + "0" * 12)[:12]
    return f"ENV-{hexes[0:4]}-{hexes[4:8]}-{hexes[8:12]}"


def _strip_port(addr: str) -> str:
    addr = (addr or "").strip()
    if addr.startswith("["):
        return addr.split("]")[0].lstrip("[")
    return addr.split(":")[0] if addr.count(":") == 1 else addr


_OS_PATTERNS = [("Windows NT 10.0", "Windows 10/11"), ("Windows NT 11", "Windows 11"),
                ("iPhone", "iOS"), ("iPad", "iPadOS"), ("Android", "Android"),
                ("Mac OS X", "macOS"), ("CrOS", "ChromeOS"), ("Linux", "Linux")]
_BROWSER_PATTERNS = [("Edg/", "Edge"), ("OPR/", "Opera"), ("Chrome/", "Chrome"),
                     ("Firefox/", "Firefox"), ("Safari/", "Safari")]


def _ua_summary(ua: str) -> str:
    ua = (ua or "").strip()
    if not ua:
        return ""
    os_name = next((l for t, l in _OS_PATTERNS if t in ua), "")
    browser = next((l for t, l in _BROWSER_PATTERNS if t in ua), "")
    if os_name and browser:
        return f"{os_name} - {browser}"
    return os_name or browser or "Unrecognized user agent"


_AUTH_LABELS = {
    "entra_sso": "Microsoft Entra ID single sign-on, authenticated Nexus session",
    "emailed_token": "Single-use emailed link, 43-character random token",
    "emailed_token+access_code": ("Single-use emailed link, 43-character random token, "
                                  "plus an out-of-band access code"),
}


def _auth_method(p) -> str:
    """The stored record of what authenticated this party, described in
    English. Falls back to deriving it for envelopes that predate the column -
    the derivation is the same rule that used to run at render time."""
    stored = (getattr(p, "auth_method", "") or "").strip()
    if stored:
        return _AUTH_LABELS.get(stored, stored)
    if (p.kind or "") == "internal":
        return "Microsoft Entra ID single sign-on, authenticated Nexus session"
    base = "Single-use emailed link, 43-character random token"
    if (getattr(p, "access_code", "") or "").strip():
        base += ", plus an out-of-band access code"
    return base


# ── QR, as an inline SVG path ────────────────────────────────────────────────

def qr_svg(payload: str, *, module_px: int = 3, border: int = 3) -> str:
    """A QR as one inline <path> - no runtime library, no external fetch.

    Error correction level Q (25% recovery) so it survives photocopying, and a
    3-module quiet zone. The build note specifies version 5; the version is
    left to the encoder because a verification URL with a 32-character token
    does not fit version 5 at level Q (42 bytes), and silently dropping to a
    lower correction level to make it fit would trade away the photocopy
    tolerance that is the reason for choosing Q.

    Deterministic: same payload, same bytes out.
    """
    import qrcode
    from qrcode.constants import ERROR_CORRECT_Q

    qr = qrcode.QRCode(error_correction=ERROR_CORRECT_Q, border=border, box_size=1)
    qr.add_data(payload)
    qr.make(fit=True)
    matrix = qr.get_matrix()
    n = len(matrix)
    size = n * module_px
    # One path, one rect per dark module. Runs of dark modules are merged along
    # each row so the path stays small enough to inline comfortably.
    parts = []
    for y, row in enumerate(matrix):
        x = 0
        while x < n:
            if row[x]:
                run = 1
                while x + run < n and row[x + run]:
                    run += 1
                parts.append(f"M{x * module_px} {y * module_px}"
                             f"h{run * module_px}v{module_px}h-{run * module_px}z")
                x += run
            else:
                x += 1
    d = "".join(parts)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
            f'viewBox="0 0 {size} {size}" shape-rendering="crispEdges" role="img" '
            f'aria-label="Verification QR code">'
            f'<rect width="{size}" height="{size}" fill="#ffffff"/>'
            f'<path d="{d}" fill="#111827"/></svg>')


# ── Renderer ─────────────────────────────────────────────────────────────────

def _dt(value: str) -> str:
    """'2026-08-24T09:21:03+00:00' -> '2026-08-24 09:21:03 UTC'. String work
    only - parsing to a datetime and reformatting would invite a timezone or a
    locale into a function that must stay deterministic."""
    v = (value or "").strip()
    if not v:
        return "-"
    return escape(v[:19].replace("T", " ")) + " UTC"


def _d(value: str) -> str:
    v = (value or "").strip()
    return escape(v[:10]) if v else "-"


def _hex(value: str, group: int = 32) -> str:
    v = escape((value or "").strip())
    if not v:
        return "-"
    return "<wbr>".join(v[i:i + group] for i in range(0, len(v), group))


def render_html(snapshot: dict) -> str:
    """Pure. Same snapshot in, byte-identical HTML out."""
    env = snapshot["envelope"]
    sysd = snapshot["system"]
    integ = snapshot["integrity"]
    signers = snapshot["signers"]
    two_page = len(signers) > _MAX_SIGNERS_ONE_PAGE

    chain_state = ("Verified" if integ["chain_valid"] else
                   "BROKEN" if integ["chain_valid"] is False else "Not available")
    declined = [s for s in signers if s["status"] == "declined"]
    # "Signatures" counts parties who actually sign - an approver is not a
    # missing signature, they are a different kind of participant.
    signing_parties = [s for s in signers if s.get("signs", True)]
    signed = [s for s in signers if s["status"] == "signed"]

    def status_strip():
        cells = [("Status", escape(env["status"] or "-")),
                 ("Signatures", f"{len(signed)} of {len(signing_parties)}"),
                 ("Declined", str(len(declined)) if declined else "None"),
                 ("Integrity", escape(chain_state)),
                 ("Governing law", escape(env["governing_law_label"] or "-")),
                 ("Issued", _d(env["completed_at"]))]
        head = "".join(f"<th>{escape(k)}</th>" for k, _ in cells)
        body = "".join(f"<td>{v}</td>" for _, v in cells)
        return f'<table class="grid strip"><tr>{head}</tr><tr>{body}</tr></table>'

    def facts(rows):
        return '<table class="grid facts">' + "".join(
            f'<tr><th>{escape(k)}</th><td>{v}</td></tr>' for k, v in rows) + "</table>"

    def signer_table():
        head = ("<tr><th>Signer</th><th>Authentication</th><th>Consent to transact</th>"
                "<th>Executed</th><th>Signature</th></tr>")
        rows = []
        for s in signers:
            capacity = " - ".join(x for x in (s.get("title"), s.get("org")) if x)
            who = (f'<b>{escape(s["name"] or "-")}</b>'
                   + (f'<br><span class="m">{escape(capacity)}</span>' if capacity else "")
                   + f'<br><span class="m">{escape(s["email"])}</span>'
                     f'<br><span class="m">{escape(s.get("role_label", "Signer"))}'
                     f' - {escape(s["kind"].title())} - order {s["ordinal"]}</span>')
            c = s["consent"]
            if c["accepted_at"]:
                # Page viewing rides with the demonstrated format - both answer
                # "what was this person actually shown". Only claimed when the
                # session really reported it; silence means not recorded, never
                # "did not happen".
                pv, pt = s.get("pages_viewed", 0), s.get("pages_total", 0)
                pages = (f"all {pt} pages viewed" if pt and pv >= pt
                         else f"{pv} of {pt} pages viewed" if pt else "")
                extra = " - ".join(x for x in (c["format"], pages, c["standing_basis"]) if x)
                cons = [f'v{escape(c["version"] or "-")} accepted {_dt(c["accepted_at"])}']
                if c["digest"]:
                    cons.append(f'<span class="hex">{_hex(c["digest"][:32])}</span>')
                if extra:
                    cons.append(f'<span class="m">{escape(extra)}</span>')
                cons.append('<span class="m">'
                            + (f'Withdrawn {_dt(c["withdrawn_at"])}' if c["withdrawn_at"]
                               else "No withdrawal recorded") + "</span>")
                consent_cell = "<br>".join(cons)
            else:
                consent_cell = '<span class="m">No consent recorded</span>'
            if s["status"] == "declined":
                exec_cell = (f'<b>Declined</b><br>{_dt(s["executed_at"])}'
                             f'<br><span class="m">{escape(s["decline_reason"])}</span>')
            else:
                exec_cell = (f'{_dt(s["executed_at"])}<br>{escape(s["ip"] or "IP not recorded")}'
                             f'<br><span class="m">{escape(s["client"])}</span>')
            if not s.get("signs", True):
                # Approvers and certified-delivery recipients never sign, and
                # the certificate must not imply a signature they did not give.
                sig = ('<span class="m">Approved - no signature</span>'
                       if s.get("role") == "approver"
                       else '<span class="m">Receipt acknowledged - no signature</span>')
            else:
                sig = escape((s["signature_kind"] or "-").title())
                if s.get("signature_field"):
                    sig += f'<br><span class="m">{escape(s["signature_field"])}</span>'
                if s["signature_digest"]:
                    sig += f'<br><span class="hex">{_hex(s["signature_digest"][:32])}</span>'
            auth = escape(s["auth_method"])
            # Disclosed failures make a log credible; hiding them makes it look
            # curated (build note section 7).
            if s.get("failed_auth_count"):
                n = s["failed_auth_count"]
                auth += (f'<br><span class="m">{n} failed access-code '
                         f'attempt{"s" if n != 1 else ""}</span>')
            else:
                auth += '<br><span class="m">No failed attempts</span>'
            rows.append(f'<tr><td>{who}</td><td>{auth}</td>'
                        f'<td>{consent_cell}</td><td>{exec_cell}</td><td>{sig}</td></tr>')
        return f'<table class="grid signers">{head}{"".join(rows)}</table>'

    def documents_table():
        if not snapshot["documents"]:
            return ""
        head = ("<tr><th>Document</th><th>Pages</th><th>Digest at send</th>"
                "<th>Digest at completion</th></tr>")
        rows = "".join(
            f'<tr><td>{escape(d["name"])}</td><td>{escape(str(d["pages"] or "-"))}</td>'
            f'<td class="hex">{_hex(d["digest_at_send"])}</td>'
            f'<td class="hex">{_hex(d["digest_at_completion"])}</td></tr>'
            for d in snapshot["documents"])
        return f'<table class="grid docs">{head}{rows}</table>'

    chain_note = {
        True: "Each entry commits to every entry before it; inserting, editing, deleting or "
              "reordering an entry is detectable. Replayed at generation: verified.",
        False: "REPLAY FAILED - the stored entries do not match their hash chain. Treat this "
               "record as suspect.",
        None: "This envelope predates the hash-chained log; its entries are still append-only.",
    }[integ["chain_valid"]]

    integrity_rows = [
        ("Composite digest", f'<span class="hex">{_hex(integ["content_digest"])}</span>'
                             '<br><span class="m">SHA-256 of the signed pages.</span>'),
        ("Audit chain head", f'<span class="hex">{_hex(integ["chain_head"])}</span>'),
        ("Audit log", f'{integ["event_count"]} entries, append-only - update and delete '
                      f'privileges withheld at the database level. {escape(chain_note)}'),
        ("Timestamps", "Recorded by the Nexus application clock in UTC at the moment of each act. "
                       "Not a third-party RFC 3161 timestamp."),
        ("Sealing", escape(snapshot.get("seal_policy") or _NO_SEAL_POLICY)),
        ("Retention", escape(snapshot["retention"] or "-")
                      + " Every party may retrieve the completed record from the verification "
                        "link for as long as it is retained (15 U.S.C. 7001(d))."),
    ]

    custodian = (
        "The record described above was generated by an electronic process and system that "
        "produces an accurate result. Each entry was recorded by the system at or near the time "
        "of the act, in the course of regularly conducted business activity, and it is the "
        "regular practice of that activity to make such records. Each document was hashed with "
        "SHA-256 on receipt; each audit entry was appended to a hash-linked, append-only store "
        "from which update and delete privileges are withheld at the database level; each signer "
        "was authenticated by the method stated in section 2 before any document was displayed; "
        "and each signature was bound to the identified field and to that authenticated session. "
        "The digests stated in sections 3 and 4 match those computed from the record as archived.")

    qr = qr_svg(snapshot["verify_url"]) if snapshot["verify_url"] else ""
    sheet_class = "sheet two-page" if two_page else "sheet"

    left_facts = facts([
        ("Name", escape(env["name"] or "-")),
        ("Sending entity", escape(env["entity"] or "-")),
        ("Document type", escape(env.get("document_class_label")
                                  or env["document_class"] or "Not classified")),
        ("Initiated by", escape(env["initiated_by"] or "-")),
    ])
    right_facts = facts([
        ("Routing", f'{escape(env["routing"])} - {len(signers)} signer(s)'),
        ("Sent", _dt(env["sent_at"])),
        ("Completed", _dt(env["completed_at"])),
        ("Eligibility", (f'Confirmed by {escape(env["eligibility_by"])}'
                         f'<br><span class="m">{_dt(env["eligibility_at"])}</span>')
                        if env["eligibility_at"] else "Not recorded"),
    ])

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Certificate of Completion - {escape(env["short_code"])}</title>
<style>
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; background: #e5e7eb; font-family: Arial, Helvetica, sans-serif;
         color: #111827; -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
  .sheet {{ width: {_SHEET_W}px; height: {_SHEET_H}px; margin: 0 auto; background: #fff;
            padding: 22px 30px; overflow: hidden; }}
  .sheet.two-page {{ height: auto; min-height: {_SHEET_H}px; }}
  table {{ border-collapse: collapse; width: 100%; }}
  .grid td, .grid th {{ border: 1px solid #e5e7eb; padding: 2px 4px; font-size: 7.5px;
                        line-height: 1.28; text-align: left; vertical-align: top; }}
  .grid th {{ background: #f6f7f9; font-weight: bold; }}
  .facts th {{ width: 30%; font-weight: normal; color: #6b7280; }}
  .strip td {{ font-weight: bold; }}
  .m {{ color: #6b7280; }}
  .hex {{ font-family: "Courier New", Courier, monospace; font-size: 6.4px;
          word-break: break-all; }}
  h1 {{ font-size: 18px; margin: 0 0 1px; }}
  h2 {{ font-size: 9.5px; margin: 7px 0 3px; }}
  h2 .n {{ color: #6b7280; margin-right: 6px; }}
  .head td {{ vertical-align: middle; padding: 0; }}
  .brand {{ font-size: 12.5px; font-weight: bold; }}
  .sub {{ font-size: 7.5px; color: #6b7280; }}
  .rule {{ border-top: 2px solid #111827; margin: 7px 0 8px; }}
  .split td {{ width: 50%; vertical-align: top; padding: 0; }}
  .split td:first-child {{ padding-right: 8px; }}
  .body {{ font-size: 7.4px; line-height: 1.4; }}
  .sig td {{ border-bottom: 1px solid #111827; height: 24px; padding: 0; }}
  .siglabel td {{ font-size: 6.6px; color: #6b7280; padding: 3px 0 0; border: 0; }}
  .foot {{ font-size: 6.4px; color: #6b7280; line-height: 1.35; margin-top: 5px; }}
</style></head>
<body><div class="{sheet_class}" id="certificate">
  <table class="head"><tr>
    <td><div class="brand">{escape(sysd["name"])}</div>
        <div class="sub">Electronic signature system of record</div>
        <div class="sub">Operated by {escape(sysd["operator"])}</div></td>
    <td style="width:76px;text-align:right">{qr}
        <div class="sub" style="text-align:center">{escape(env["short_code"])}</div></td>
  </tr></table>

  <div class="rule"></div>
  <h1>Certificate of Completion</h1>
  <div class="sub">Envelope {escape(env["id"])}</div>
  <div style="height:4px"></div>
  {status_strip()}

  <h2><span class="n">1</span>Envelope</h2>
  <table class="split"><tr><td>{left_facts}</td><td>{right_facts}</td></tr></table>

  <h2><span class="n">2</span>Signers, authentication and consent</h2>
  {signer_table()}
  {('<div class="sub" style="margin-top:4px">Copies to: '
    + escape(", ".join(f'{c["name"]} ({c["email"]})' for c in snapshot["ccs"]))
    + "</div>") if snapshot["ccs"] else ""}

  <h2><span class="n">3</span>Documents and digests</h2>
  {documents_table()}

  <h2><span class="n">4</span>Integrity, audit chain and retention</h2>
  {facts(integrity_rows)}

  <h2><span class="n">5</span>Certification of records custodian</h2>
  <div class="body">
    <p style="margin:0 0 5px">I certify that I am the custodian of records for
    {escape(sysd["name"])}, the electronic signature system of record operated by
    {escape(sysd["operator"])}, or another qualified person able to make this certification,
    and that the following is true:</p>
    <p style="margin:0 0 5px">{escape(custodian)}</p>
    <p style="margin:0">I declare under penalty of perjury under the laws of the United States of
    America{(", and of the State of " + escape(env["governing_law_label"]))
            if env["governing_law_label"] else ""}, that the foregoing is true and correct.</p>
  </div>
  <table class="sig"><tr><td></td><td style="border:0;width:14px"></td><td></td>
    <td style="border:0;width:14px"></td><td></td></tr></table>
  <table class="siglabel"><tr><td>Name and title of custodian</td><td style="width:14px"></td>
    <td>Signature</td><td style="width:14px"></td><td>Date and place of execution</td></tr></table>

  <div class="foot">
    <b>Verification.</b> Scan the code above, or open {escape(snapshot["verify_url"])}, to compare
    the digests and counts printed here against the stored record. Verification requires no account
    and discloses no signer identity or document content.
    <b>Authority.</b> Issued under the Electronic Signatures in Global and National Commerce Act,
    15 U.S.C. 7001-7031, and the Uniform Electronic Transactions Act as enacted in
    {escape(env["governing_law_label"] or "the governing state")}. An electronic signature may be
    attributed to a person if it was the act of that person, which may be shown in any manner,
    including by the efficacy of the security procedure described here. This certificate is not
    legal advice and is not itself the agreement between the parties.
    Generated {escape(snapshot["generated_at"][:19].replace("T", " "))} UTC.
  </div>
</div></body></html>"""


# ── Demo renderer for layout tests ───────────────────────────────────────────
# The one-page constraint and the QR can only be checked by really laying the
# page out, which needs a browser (build note section 10: "Do not eyeball the
# page count"). The Playwright test drives this entry point so it measures the
# REAL renderer rather than a fixture that can drift away from it.
#
#   python -m services.certificate <signer_count> [verify_url]

def demo_snapshot(signer_count: int, verify_url: str = "https://nexus.greensglobal.com/verify/8f2a1c9d4e7b3f60") -> dict:
    """A fully-populated snapshot with `signer_count` signers. Deliberately
    verbose values (long names, org strings, full digests) so the layout is
    measured at its realistic worst case, not on tidy short data."""
    names = ["Maria Ortiz", "Daniel Reyes", "Neil Kadakia", "Priya Raghunathan",
             "Christopher Whitfield", "Alexandra Fitzgerald", "Bartholomew Kensington"]
    signers = []
    for i in range(signer_count):
        signers.append({
            "name": names[i % len(names)],
            "org": "MCD Service Inc., DBA Aarav Construction" if i % 2 == 0 else "Coastline Concrete & Grading, Inc.",
            "title": "Vice President, Construction" if i % 2 == 0 else "President",
            "failed_auth_count": 1 if i == 1 else 0,
            "pages_viewed": 18, "pages_total": 18,
            "email": f"{names[i % len(names)].lower().replace(' ', '.')}@greensglobal.com",
            "kind": "internal" if i % 2 == 0 else "external",
            "ordinal": i + 1,
            "status": "signed",
            "auth_method": ("Microsoft Entra ID single sign-on, authenticated Nexus session"
                            if i % 2 == 0 else
                            "Single-use emailed link, 43-character random token, plus an "
                            "out-of-band access code"),
            "consent": {"version": "2.0-2026-09", "digest": "ab" * 32,
                        "accepted_at": "2026-08-24T09:22:41+00:00",
                        "format": "PDF rendered in session",
                        "standing_basis": "Employment agreement" if i % 2 == 0 else "",
                        "withdrawn_at": ""},
            "executed_at": "2026-08-24T09:31:18+00:00",
            "ip": "198.51.100.47",
            "client": "Windows 10/11 - Chrome",
            "signature_kind": "drawn",
            "signature_digest": "cd" * 32,
            "decline_reason": "",
            "authenticated_at": "2026-08-24T09:22:00+00:00",
        })
    return {
        "generated_at": "2026-08-27T16:41:57+00:00",
        "system": {"name": "Nexus Docs & Sign", "operator": "Greens Global",
                   "support": "it@greensglobal.com"},
        "envelope": {
            "id": "7F3A91C4-2B8E-4D06-9A15-C83BE7D40F21",
            "short_code": _short_code("7F3A91C4-2B8E-4D06-9A15-C83BE7D40F21"),
            "name": "Subcontract Agreement - Concrete and Sitework",
            "entity": "MCD Service Inc., DBA Aarav Construction",
            "initiated_by": "maria.ortiz@greensglobal.com",
            "source": "Uploaded PDF", "routing": "Sequential", "status": "Completed",
            "sent_at": "2026-08-24T09:21:03+00:00", "completed_at": "2026-08-27T16:41:52+00:00",
            "expires_on": "", "document_class": "subcontract",
            "document_class_label": "Subcontract or construction agreement",
            "governing_law": "CA",
            "governing_law_label": "California",
            "eligibility_by": "maria.ortiz@greensglobal.com",
            "eligibility_at": "2026-08-24T09:20:44+00:00",
        },
        "signers": signers,
        "ccs": [{"name": "Accounts Payable", "email": "ap@greensglobal.com"}],
        "documents": [
            {"name": "Subcontract Agreement - Concrete and Sitework.pdf", "pages": 18,
             "digest_at_send": "ef" * 32, "digest_at_completion": "12" * 32},
            {"name": "Exhibit A - Scope of Work.pdf", "pages": 4,
             "digest_at_send": "34" * 32, "digest_at_completion": "34" * 32},
            {"name": "Exhibit C - Insurance Requirements and COI.pdf", "pages": 3,
             "digest_at_send": "56" * 32, "digest_at_completion": "56" * 32},
        ],
        "integrity": {"content_digest": "78" * 32, "chain_head": "9a" * 32,
                      "event_count": 21, "chain_valid": True, "chain_available": True},
        "verify_url": verify_url,
        "retention": "10 years after substantial completion, in Nexus document storage with a "
                     "copy in the sending team's Egnyte folder.",
        "seal_policy": ("The completed packet is sealed with a PAdES B-B digital signature "
                        "(SHA-256 with RSA-3072) using a SELF-SIGNED DEVELOPMENT certificate "
                        "that is not publicly trusted - a PDF reader will report the signer as "
                        "unknown. The applied seal is recorded on this envelope's seal record."),
    }


if __name__ == "__main__":
    import sys
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    url = sys.argv[2] if len(sys.argv) > 2 else None
    snap = demo_snapshot(count, url) if url else demo_snapshot(count)
    sys.stdout.write(render_html(snap))
