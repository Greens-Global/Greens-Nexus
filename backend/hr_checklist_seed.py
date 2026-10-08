"""Default onboarding / offboarding / leave checklist templates (HR roadmap
Section C: "Onboarding checklist per hire").

These are the starting rows a company gets the first time anyone opens the
checklists; HR edits them afterward in People > Checklist Templates. Each row:

  key       stable id inside the template (ON-01, OFF-14, ...) - completion
            signals and history refer to it, so never reuse a key for a
            different step
  phase     group heading on the profile
  title     the step (Title Case); hint = one sentence of how-to (sentence case)
  owner     a ROLE, resolved per person when the checklist is created:
            hr (the company's HR contact), manager (reports-to), employee,
            it, payroll, equipment, finance (set per company in Checklist Owners)
  anchor    S (start date), X (exit date / leave start), created (the day the
            checklist was started), none (no due date - set by hand)
  offset    days from the anchor; bd=True counts business days (skips weekends
            and the company's holidays), otherwise a date landing on a weekend
            or holiday moves to the previous business day
  applies   who the row is for: types (full_time, part_time, intern,
            contractor, or "employee" = anything but contractor), countries
            (US, IN), exit_types (offboarding only). Empty = everyone.
  signal    optional - lets Nexus tick the row by itself (hr_checklists.SIGNALS)

Rows never ask for, or store, a full SSN, Aadhaar, PAN or bank number.
"""

EXIT_TYPES = (
    "resignation", "resignation_no_notice", "termination",
    "end_of_contract", "retirement", "death",
)

EMP = {"types": ["employee"]}
US_EMP = {"types": ["employee"], "countries": ["US"]}
IN_EMP = {"types": ["employee"], "countries": ["IN"]}
CONTRACTOR = {"types": ["contractor"]}
NOT_DEATH = {"exit_types": [t for t in EXIT_TYPES if t != "death"]}


def _row(key, phase, title, owner, anchor, offset=0, bd=False, applies=None,
         signal="", hint=""):
    return {"key": key, "phase": phase, "title": title, "hint": hint,
            "owner": owner, "anchor": anchor, "offset": offset, "bd": bd,
            "applies": applies or {}, "signal": signal}


P1, P2, P3, P4 = "Offer Accepted", "Account And Access", "Day 1", "First 90 Days"

ONBOARDING = [
    _row("ON-01", P1, "Profile Complete And No Duplicate Record", "hr", "created", 0,
         signal="profile_complete",
         hint="Search People by name and personal email first. A rehire reuses the old record and stays Left until the day before the start date."),
    _row("ON-02", P1, "Offer Letter Or Contractor Agreement Signed", "hr", "created", 0,
         signal="envelope:offer,contractor_agreement",
         hint="Send it from Nexus Sign if it was not signed in the hiring pipeline."),
    _row("ON-03", P1, "Background Check (If The Offer Requires One)", "hr", "S", -14, applies=EMP,
         hint="Get the written consent first. Mark N/A when the role does not need one."),
    _row("ON-04", P1, "Pre-Boarding Packet Signed", "hr", "S", -10,
         signal="envelope:nda,handbook_ack",
         hint="One Nexus Sign envelope to the personal email: NDA, handbook or contractor policy, IT policy, new hire information form. No ID numbers in it."),
    _row("ON-05", P1, "Payroll Provider Onboarding (Tax Forms, Direct Deposit)", "payroll", "S", -10, applies=EMP,
         hint="W-4, state withholding, direct deposit and full tax IDs go into the payroll provider, never Nexus."),
    _row("ON-06", P1, "W-9 (US) Or PAN (India) Sent To Accounting", "finance", "S", -7, applies=CONTRACTOR),
    _row("ON-07", P1, "Contract End Date On The Profile", "hr", "S", -7, applies=CONTRACTOR,
         signal="contract_end", hint="Nexus reminds HR from this date."),
    _row("ON-08", P1, "Emergency Contact, Address And Date Of Birth On The Profile", "hr", "S", -7,
         signal="personal_details"),
    _row("ON-09", P1, "Equipment Picked And Set Aside", "manager", "S", -7,
         hint="Write the asset tags down. Item Management needs the work email, so the assignment is made after provisioning."),
    _row("ON-10", P1, "System Access List Agreed", "manager", "S", -7,
         hint="Nexus modules, accounting entities, shared mailboxes, vendor and bank portals."),
    _row("ON-11", P1, "Day 1 Schedule Booked", "manager", "S", -5),

    _row("ON-12", P2, "Microsoft 365 Account Provisioned", "it", "S", -3, signal="provisioned",
         hint="Check the work email domain for the hiring company and the usage location (IN for India) before pressing Provision. The temporary password is shown once."),
    _row("ON-13", P2, "Equipment Assigned In Item Management", "equipment", "S", -3, signal="item_assigned",
         hint="Remote hires: assign and ship by 5 days before the start date."),
    _row("ON-14", P2, "Nexus Access Granted", "manager", "S", -1),
    _row("ON-15", P2, "Time Clock And Leave Balances Set Up", "hr", "S", -1, applies=EMP),
    _row("ON-16", P2, "Teams, Distribution Lists And Shared Mailboxes", "it", "S", -1),

    _row("ON-17", P3, "Temporary Password Delivered And First Sign-In", "it", "S", 0,
         hint="By phone or in person, never in the same email as the username."),
    _row("ON-18", P3, "Form I-9 Section 1", "employee", "S", 0, applies=US_EMP,
         hint="Completed outside Nexus, by the end of the first day."),
    _row("ON-19", P3, "Equipment Accepted", "employee", "S", 0, signal="item_active"),
    _row("ON-20", P3, "HR Session (Handbook, Leave, Time Clock, Payroll Dates)", "hr", "S", 0),
    _row("ON-21", P3, "Team Intro, Buddy And First-Week Goals", "manager", "S", 0),
    # Ticked by hand on purpose: provisioning sets Active days before the start
    # date, so the status alone would close this row before anyone started.
    _row("ON-22", P3, "Start Confirmed And Status Active", "hr", "S", 0,
         hint="Provisioning already sets Active. Tick this once the person has actually started, signed in and done I-9 Section 1."),

    _row("ON-23", P4, "Form I-9 Section 2 (And E-Verify If Used)", "hr", "S", 3, bd=True, applies=US_EMP,
         hint="The employer examines the original documents within 3 business days of the start date."),
    _row("ON-24", P4, "Right-To-Work Recorded On The Compliance Tab", "hr", "S", 3, bd=True,
         hint="Dates only, no document numbers."),
    _row("ON-25", P4, "Benefits Notice And Enrollment", "hr", "S", 14, applies=US_EMP),
    _row("ON-26", P4, "PF And ESI Enrollment", "payroll", "none", applies=IN_EMP,
         hint="Before the first payroll. Only the last 4 digits of the UAN go in Nexus."),
    _row("ON-27", P4, "First Paystub Checked", "payroll", "none", applies=EMP),
    _row("ON-28", P4, "State New-Hire Report", "payroll", "S", 20, applies=US_EMP,
         hint="Many payroll providers file this automatically - confirm yours does."),
    _row("ON-29", P4, "30-Day Check-In", "manager", "S", 30),
    _row("ON-30", P4, "Required Training", "hr", "S", 30, applies=EMP,
         hint="Security awareness; California harassment prevention within 6 months."),
    _row("ON-31", P4, "60-Day Check-In", "manager", "S", 60),
    _row("ON-32", P4, "90-Day Check-In", "manager", "S", 90),
    _row("ON-33", P4, "Probation Confirmation Letter", "hr", "none", applies=EMP,
         hint="Only when the offer or appointment letter has a probation clause."),
]

Q1, Q2, Q3 = "Notice Period", "Last Day", "After The Last Day"

OFFBOARDING = [
    _row("OFF-01", Q1, "Resignation In Writing And Exit Details Recorded", "hr", "created", 0),
    _row("OFF-02", Q1, "Final Pay Date Confirmed For The Work State", "payroll", "created", 1, applies=EMP,
         hint="California: involuntary exits are paid on the last day. For a state you are not sure of, pay on the last day."),
    _row("OFF-03", Q1, "Separation Confirmation Letter Sent", "hr", "created", 2, applies={"types": ["employee"], **NOT_DEATH}),
    _row("OFF-04", Q1, "Knowledge Handover Plan", "manager", "X", -10, applies=NOT_DEATH),
    _row("OFF-05", Q1, "Mailbox, Auto-Reply, OneDrive And Task Handover Decided", "manager", "X", -7,
         hint="Anyone outsiders email gets a shared mailbox with an auto-reply. If an export is needed, test it now from the Documents tab."),
    _row("OFF-06", Q1, "Direct Reports And Company Roles Reassigned", "hr", "X", -5, signal="roles_clear",
         hint="Reports-to of their team, the company HR contact or manager, approver and allocator roles, accounting scopes."),
    _row("OFF-07", Q1, "Equipment Return Arranged", "equipment", "X", -5,
         hint="Remote staff get a prepaid return label and a box."),
    _row("OFF-08", Q1, "Open Nexus Sign Envelopes Re-Routed Or Voided", "hr", "X", -3),
    _row("OFF-09", Q1, "Exit Interview (Optional)", "hr", "X", -3,
         applies={"types": ["employee"], "exit_types": ["resignation", "retirement", "end_of_contract"]}),
    _row("OFF-10", Q1, "Paid Leave Balance For Payout", "payroll", "X", -2, applies=EMP),
    _row("OFF-11", Q1, "Separation Agreement (Only If Severance Is Offered)", "hr", "X", -1, applies=EMP,
         hint="Counsel drafts it. Mark N/A when no severance is offered."),
    _row("OFF-12", Q1, "Final Timesheet Submitted Before Lockout", "employee", "X", 0,
         applies={"types": ["employee"], **NOT_DEATH},
         hint="Mid-period leavers submit; the manager writes the final hours on the exit record and Payroll pays from them."),

    _row("OFF-13", Q2, "Equipment Collected", "equipment", "X", 0),
    _row("OFF-14", Q2, "Exit Acknowledgement Signed", "hr", "X", 0, applies=NOT_DEATH,
         hint="Send it to the personal email so it still works after the lockout."),
    _row("OFF-15", Q2, "Mailbox Exported, OneDrive Moved And Auto-Reply Set", "it", "X", 0,
         hint="All before Left - Left removes the license."),
    _row("OFF-16", Q2, "Status Set To Left", "hr", "X", 0, signal="status_left",
         hint="Left runs the moment you press Apply. Always pick the task handover person by name."),
    _row("OFF-17", Q2, "Sessions Revoked, MFA Reset, Group Licenses Removed", "it", "X", 0,
         hint="Entra admin center: Revoke Sessions. Critical for terminations."),
    _row("OFF-18", Q2, "Access Outside Microsoft 365 Removed", "finance", "X", 0,
         hint="Accounting, banking and vendor portals, company cards, building access, shared passwords."),
    _row("OFF-19", Q2, "Returned Items Recorded In Item Management", "equipment", "X", 2, signal="no_items"),
    _row("OFF-20", Q2, "License Removed After Shared Mailbox Conversion", "it", "X", 1,
         hint="Mark N/A when the mailbox was removed instead."),

    _row("OFF-21", Q3, "Final Pay Issued", "payroll", "X", 0, applies=EMP,
         hint="Per the work-state rule. Upload the final paystub to the profile."),
    _row("OFF-22", Q3, "Separation Notices (US)", "hr", "X", 0, applies=US_EMP,
         hint="California: For Your Benefit pamphlet and change-in-status notice. Never send benefit cancellation notices through Nexus Sign."),
    _row("OFF-23", Q3, "Full And Final Settlement", "payroll", "X", 2, bd=True, applies=IN_EMP),
    _row("OFF-24", Q3, "Relieving And Experience Letters", "hr", "X", 7, applies=IN_EMP),
    _row("OFF-25", Q3, "Contractor Final Invoice And Deliverables", "finance", "X", 30, applies=CONTRACTOR),
    _row("OFF-26", Q3, "Mailbox Export Stored And License State Checked", "it", "X", 2),
    _row("OFF-27", Q3, "Dated Documents Re-Filed Without Expiry", "hr", "X", 7,
         hint="Otherwise Nexus keeps sending document-expiry notices for a leaver."),
    _row("OFF-28", Q3, "Rehire Eligibility Noted", "hr", "X", 7, applies=NOT_DEATH),
    _row("OFF-29", Q3, "Shared Mailbox Access Reviewed", "manager", "X", 90),
]

R1, R2 = "Leave Starts", "Return"

INACTIVE = [
    _row("IN-01", R1, "Reason, Start And Expected Return Recorded", "hr", "X", 0),
    _row("IN-02", R1, "Access Decision Made", "manager", "X", 0,
         hint="Leave of absence: keep or block, in writing. Suspension or garden leave: block."),
    _row("IN-03", R1, "Status Set To Inactive", "hr", "X", 0, signal="status_inactive",
         hint="Inactive changes nothing in Microsoft 365 by itself."),
    _row("IN-04", R1, "Sign-In Blocked And Sessions Revoked (If Blocking)", "it", "X", 0,
         hint="Do not remove licenses - the mailbox would start the 30-day deletion countdown."),
    _row("IN-05", R1, "Trustee Mailbox Access Granted (If Needed)", "it", "X", 0),
    _row("IN-06", R1, "Access Outside Microsoft 365 Suspended (If Blocking)", "finance", "X", 0),
    _row("IN-07", R1, "Approvals And Envelopes Re-Routed", "hr", "X", 2),
    _row("IN-08", R1, "Return-Date And Compliance Reminders Set", "hr", "X", 0,
         hint="Compliance-tab reminders stop while a person is Inactive; upload a dated expiry record to the Documents tab."),
    _row("IN-09", R2, "Back: Status Active, Trustees Removed, Access Restored", "hr", "none",
         signal="status_active"),
]

DEFAULTS = {
    "onboarding": ("Onboarding", ONBOARDING),
    "offboarding": ("Offboarding", OFFBOARDING),
    "inactive": ("Leave Or Suspension", INACTIVE),
}
