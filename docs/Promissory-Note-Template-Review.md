# Unsecured Promissory Note template - review notes

Sep 29, 2026. The Documents module ships an "Unsecured Promissory Note" starter
(`backend/routers/documents.py`, `_promissory_note_content` and
`_PROMISSORY_NOTE_FIELDS`; pinned by `backend/test_documents_promissory_note.py`).
This file records why each clause is there, what was deliberately left out, and
the state and federal points counsel should confirm before the first real note
is generated. It is a review aid, not legal advice.

## What the note is

A simple unsecured, fixed-rate, installment note between one Lender and one or
more Borrowers, governed by the law of a US state the user picks. It is written
to be a negotiable instrument under UCC Article 3 (section 3-104): an
unconditional promise, a fixed sum with stated interest, payable "to the order
of" the Lender, at a definite time (the Maturity Date). Nothing in it makes the
promise conditional on another document.

Every deal term is a typed fill-form field, so the wizard validates money and
dates before anything is generated. The dollar sign is literal text in the note
because the fill form writes currency values without a symbol.

## Fields

| Field | Type | Notes |
|---|---|---|
| Date of Note | date | Interest runs from this date; the signature block refers back to it. |
| Borrower name and address | person, address | Full legal name. An entity signs through an authorized person (section 7). |
| Lender name and address | person, address | The payee "to the order of" whom the note is payable. |
| Principal Amount | currency | Figures only. Amount-in-words was left out on purpose (see below). |
| Interest Rate (% per year) | number, 0-100 | Simple interest, 365-day year. Must sit under the governing state's usury limit. |
| Payment Frequency | dropdown | monthly, quarterly, annual. |
| Installment Amount | currency | The note says the whole balance is due on the Maturity Date regardless, so a schedule that does not fully amortize still works (balloon). |
| First Payment Date, Maturity Date | date | |
| Late Charge Grace Period (days) | number, default 10 | |
| Late Charge (% of installment) | number, default 5 | Several states cap late charges; confirm for the governing state. |
| Cure Period After Notice (days) | number, default 10 | Applies to both payment and non-payment defaults. |
| Loan Purpose | dropdown | "business or commercial" or "personal, family or household". Drives the consumer-credit question below. |
| Governing Law State | text | Also used for venue. |

## Clause by clause

1. **Interest.** Simple interest, actual/365. Stated as a fixed annual rate so the
   sum is "fixed" for negotiability. No default-rate step-up: default interest is
   a penalty question in several states and was not needed for a simple note.
2. **Payment.** Order of application (late charges and costs, then interest, then
   principal) is stated so a partial payment cannot be argued either way. Weekend
   and holiday roll-forward avoids a technical default. Payment in US dollars.
3. **Prepayment.** Free prepayment at any time. Partial prepayments reduce
   principal but do not skip installments unless the Lender agrees.
4. **Late Charge.** Percentage of the overdue installment after a grace period,
   "to the extent permitted by applicable law", with a liquidated-damages recital
   (reasonable estimate of administrative cost) because several states test late
   charges as liquidated damages.
5. **Default and acceleration.** Non-payment and other breaches need written
   notice and a cure period before the Lender can accelerate. Insolvency,
   bankruptcy, death or dissolution, and a materially false representation are
   also events of default. Remedies are cumulative. Acceleration is at the
   Lender's option, not automatic, so a Lender who wants to keep the loan alive
   after a late payment can.
6. **Unsecured.** Says so expressly so nobody later argues a lien was intended.
7. **Purpose and authority.** The Borrower's representation of purpose is the
   customary basis for treating a loan as commercial and is what the Lender
   relies on for the consumer-credit analysis below. Signing-authority
   representation covers entity Borrowers.
8. **Costs of collection.** Attorneys' fees and costs, "to the extent permitted".
   Note that some states make a one-way fee clause reciprocal by statute
   (California Civil Code 1717 is the usual example), so a Borrower who wins can
   recover fees too.
9. **Waivers.** Presentment, demand, dishonor, protest: the standard UCC waivers
   that keep endorsers and guarantors liable after extensions and partial
   payments.
10. **Maximum lawful interest.** A usury savings clause: excess interest is
    applied to principal or refunded and the rate drops to the lawful maximum.
    This helps but does not cure a knowingly usurious rate in every state, so the
    rate still has to be set under the cap.
11. **Joint and several liability.** For co-borrowers.
12. **Assignment and successors.** Lender may assign freely (negotiability);
    Borrower may not without consent.
13. **Amendment and waiver.** Written amendments only; no waiver by conduct.
14. **Notices.** Hand, overnight courier or certified mail, with a deemed-delivery
    rule so the cure period in section 5 has a definite start.
15. **Governing law and venue.** The chosen state, plus consent to that state's
    courts. No jury-trial waiver (unenforceable in some states, including
    California, when pre-dispute) and no arbitration clause (would need
    per-state and consumer-specific language).
16. **Severability.**
17. **Entire agreement.**
18. **Time of the essence; headings.**
19. **Electronic signatures and counterparts.** Consistent with federal ESIGN
    (15 U.S.C. 7001) and the state UETA statutes; New York has its own
    Electronic Signatures and Records Act instead of UETA, to the same effect.

Signature blocks: Borrower, then "Accepted by Lender". A note is the Borrower's
instrument and is enforceable with only the Borrower's signature; the Lender
line documents acceptance of the terms and is the second signer role in Nexus
Sign. No witness or notary is required for a promissory note in the United
States as a general matter.

## Left out on purpose

- **Confession of judgment.** Void or heavily restricted in many states and
  banned for consumer credit by the FTC Credit Practices Rule.
- **Jury-trial waiver and arbitration.** See section 15 above.
- **Collateral, guaranty, personal guarantee of an entity Borrower.** This is
  the unsecured form. A guaranty is a separate instrument.
- **Amount in words.** Traditional, but a second manual transcription of the
  amount is a second place to get it wrong. UCC 3-114 only matters when the two
  disagree; with figures alone there is nothing to disagree.
- **Default interest rate, prepayment premium.** Not needed for a simple note
  and each is regulated in some states.
- **Automatic acceleration on termination of employment.** Deliberately not
  included. If a note is used for an employee loan and the company wants that,
  it is a clause counsel should draft with the state's wage laws in view.

## Checkpoints for counsel, by topic

**Consumer versus commercial (federal).** If the purpose is personal, family or
household, the loan is consumer credit. The federal Truth in Lending Act and
Regulation Z apply to a "creditor", meaning a lender that regularly extends
consumer credit (as a rule of thumb, more than 25 consumer loans a year, or
more than 5 secured by a dwelling) and charges a finance charge or allows more
than four installments. An occasional personal loan by the company would
usually fall outside that, but the count is the company's to keep. A TILA
disclosure is a separate document; this note does not attempt one. Loans for a
business purpose are outside TILA, and the purpose representation in section 7
is the usual evidence.

**Usury and rate caps (state).** Every state has its own cap, exemptions and
consequences, and they differ sharply between consumer and commercial loans and
between licensed and unlicensed lenders. California is the likely governing
state for Greens Global and is stricter than most: the constitutional limit is
10% a year for loans for personal, family or household purposes, and for other
loans the higher of 10% or 5 points over the Federal Reserve Bank of San
Francisco discount rate, unless an exemption applies (licensed lenders and
several others). Confirm the cap and the current exemption list for whatever
state is chosen before setting the rate. The savings clause in section 10 is a
backstop, not a license.

**Lender licensing (state).** Some states require a license to make loans at
all, or above a rate, or to consumers. California's Financing Law requires a
license for a business of making consumer or commercial loans, with narrow
exemptions (one commercial loan in a twelve-month period is the exemption
usually cited). Whether the company's lending is a "business" of lending is a
question for counsel.

**Late charges and fees (state).** Many states cap late charges for consumer
loans (a fixed dollar amount, a percentage, or both) and some require a minimum
grace period. The defaults of 5% after 10 days are common but not universal.

**Attorneys' fees (state).** Reciprocity statutes (California Civil Code 1717)
make the clause two-way. Some states limit fee recovery on consumer notes.

**Employee and related-party loans (federal tax).** A loan to an employee or
shareholder below the Applicable Federal Rate is a below-market loan under
Internal Revenue Code section 7872: the forgone interest is treated as
compensation (or a dividend) and as interest income to the lender. Aggregate
loans of $10,000 or less to an employee have a de minimis exception when tax
avoidance is not a principal purpose. Set the rate at or above the AFR for the
month and term of the loan unless payroll and tax have signed off. Wage
deductions to collect a loan need the employee's written authorization and, in
several states, are restricted or barred, so repayment by payroll deduction
should be a separate signed authorization, not a line in this note.

**Statute of limitations (state).** Actions on a written note run from three to
fifteen years depending on the state (California: four years for a written
contract; six under UCC 3-118 for a negotiable note). Relevant to how long
signed copies are retained.

**Electronic signing.** Nexus Sign already meets ESIGN and UETA consent and
record-retention requirements for the documents it handles. The note adds
nothing that changes that.

## Known gap in the module

Generated documents print date fields as ISO (2026-10-01). This is the
Documents fill form's behavior for every date field, not this template, and the
fix is in the shared field formatter plus the backend date validator. Until then
a generated note carries ISO dates; they are unambiguous but not the US format
Nexus uses elsewhere.
