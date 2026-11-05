# Cubby Fundamentals - Research Notes (not the course)

Researched 11/04/2026. Sources: Cubby's public site and blog, Cubby's public developer docs (Operator API reference), Greens Storage's own Cubby reporting database (via the Cubby MCP, read-only, aggregates and category names only - no tenant data recorded), plus general self-storage ledger references.

Confidence key: **[Confirmed]** = seen in Cubby docs or Greens' Cubby data. **[Inferred]** = strongly suggested by data/docs, not stated. **[General]** = industry practice from other software, may differ in Cubby. **[Unknown]** = needs Greens screenshots or a Cubby CSM answer.

---

## 0. Headline findings

1. **Cubby has no public help center.** No help.cubbystorage.com / docs knowledge base was found; cubbystorage.com links no support portal (support is via a dedicated CSM and support@cubbystorage.com, "5-min avg response time" claim on https://www.cubbystorage.com/). Step-by-step UI walkthroughs must come from Greens' own screenshots or Cubby's onboarding/training material (ask the CSM).
2. **The best public source is the Operator API docs**: https://cubbystorage.github.io/docs/api/ (plus https://cubbystorage.github.io/docs/ with Data Dictionary, Make.com webhooks, Storefront CSS). The API reference names every action a staff member can take (checkout, schedule move-out, waive charge, issue credit, start lien, settle auction, delinquency exemption...) and documents ledger rules (paid-through date, prepaid, credits vs waives). This is the most authoritative "how Cubby thinks" text.
3. **Greens' Cubby org covers 5 California facilities only**: Escondido, Fairfield, Murrieta, Temecula, Valley Center. **No Texas facility is in the Cubby org** [Confirmed from `facilities`]. Either Texas runs on another system or is not yet migrated - confirm before writing Texas content.
4. All 5 facilities bill **FIRST_OF_MONTH** with a **jump day of 26**, time zone America/Los_Angeles [Confirmed].
5. Greens is heavily RV/boat/vehicle parking: ~1,038 active parking spaces vs ~1,687 enclosed units (including ~340 mailboxes priced as "units"). 759 of 2,042 active leases flag `storing_vehicle` [Confirmed, aggregate].
6. Collections are driven by **workflow-generated tasks** with day-of-month names ("2nd - Call Failed Autopay Tenants", "6th - Call Past Due Tenants", "30th - Final Collection Call", "35th - CA Lien Notice", "61st - Vehicle Lien Filing/Tow Notice", "62nd - Publish 2nd Lien Sale Ad") [Confirmed from `tasks`].

---

## 1. Cubby product areas and features

Cubby markets itself as "the AI-native operating system for self-storage" (https://www.cubbystorage.com/, https://yespress.io/cubby). Raised $63M in Feb 2026 (https://www.alleywatch.com/2026/02/cubby-storage-self-storage-software-ai-facility-management-revenue-management-platform-operating-system-matt-engfer/). Staff log in at https://app.cubbystorage.com/signin. Note: **cubbytool.com is a different product** (small-operator tool) - do not cite it.

Product nav (from cubbystorage.com): Facility Operations, Tenant Management, E-Commerce, Revenue Management (RevMan), Calls, Comms AI, Reporting, Third Party Management.

### 1.1 Facility Operations - https://www.cubbystorage.com/products/facility-operations
- **Smart unit tracking** - "Know exactly what's occupied, vacant or needs attention".
- **Sitemap** - visual facility layout with availability ("View your facility layout visually").
- **Task management** - "one shared task list", from any device. Task statuses: `OPEN`, `COMPLETED`, `ARCHIVED` (archived = dismissed, not done). Completing a repeating task creates the next one. Completed/archived tasks can't be edited; reopen first [API docs].
- **Walkthroughs** - facility inspections from a phone, work offline, sync later. Units have a `walkthrough_order`; events `WALKTHROUGH_SPACE_CHECKED` / `UNCHECKED` [Confirmed in data].
- **Gate access** - "Connect your gate access provider to Cubby". Partners: SpiderDoor, DoorKing, PTI StorLogix Cloud, OpenTech Gates (https://www.cubbystorage.com/partners).
- **Locks management** - "Assign, update and manage lock codes". Lock statuses `AVAILABLE`, `OPERATOR_USE`, `TENANT_USE`, `DISABLED` (reason `DAMAGED`/`MISSING`); lock actions Register, Attach, Return, Transfer, Disable [API]. Smart locks: Nokē, Keep It Simple Storage / OneLock (https://www.insideselfstorage.com/suppliers-products/self-storage-software-cubby-integrates-with-onelock-technology-from-keep-it-simple-storage).
- **Permissions and roles** - by facility, role, portfolio. (Competitor Monument claims Cubby's portfolio access is "all or one" - https://monument.io/blog/cubby/ - competitor source, low weight.)
- **Shop and inventory** - sell locks, boxes, supplies with stock tracking (ledger category `RETAIL_SALES`; merchandise always taxed under retail rules).
- **Push notifications** (iOS/Android app), universal search, multi-facility dashboard.

### 1.2 Tenant Management - https://www.cubbystorage.com/products/tenant-management
- **Leads** ("Leads that convert") from website, calls, walk-ins. In the app/event log a lead is also called an **Interest** (`INTEREST_CREATED`, `INTEREST_CONVERTED`, `INTEREST_ARCHIVED`, `INTEREST_IN_PROGRESS`) [Confirmed event names - Inferred that UI says "Interest"].
- **Move-ins / move-outs**, **reservations** (`RESERVATION_CONVERTED`, `RESERVATION_CANCELLED`).
- **Payments**, **autopay enrollment**, **"magic payment links"** (texted/emailed link to pay).
- **Delinquency follow-up**, **lien tracking**, **auction management**.
- **Self-service tenant portal** with **passwordless login** - pay, view leases, manage account.
- **Documents and e-signatures** - leases, addendums, notices; templates by facility or unit type. Lease compliance types: `LEASE_AGREEMENT`, `COVERAGE`, `IDENTITY`, `VEHICLE`; statuses `NOT_REQUIRED`, `INCOMPLETE`, `PENDING_APPROVAL`, `SIGNATURE_NEEDED`, `REJECTED`, `APPROVED` [API].
- **Messaging** - email and SMS with templates.
- **Activity log / tenant timeline** - every account change with who and when.

### 1.3 E-Commerce - https://www.cubbystorage.com/products/e-commerce
Online checkout ("Storefront" web components embedded on the operator's site), recovered abandoned carts. Lead origins include `WEBSITE_CHECKOUT`, `RESERVED_CHECKOUT`, `ABANDONED_CHECKOUT`, `FAILED_CHECKOUT`, `RESERVATION_FORM`, `WAITLIST_FORM`, `CONTACT_FORM`. "Value pricing" tiers `LOWEST` / `MEDIUM` / `HIGHEST` let a web renter pick a price tier of unit [API].

### 1.4 Revenue Management (RevMan) - https://www.cubbystorage.com/products/revman
ML pricing recommendations, competitor tracking (`stor_track` table = "Tracked competitors" page), occupancy-based street-rate moves, and **ECRI** (existing customer rate increases). ECRI Management grid stages per lease: `READY` (due), `IN_REVIEW`, `SCHEDULED`, `SNOOZED`, `SET` (nothing pending) [Confirmed]. Rate types per pricing group: **standard rate (street rate)**, **web rate**, **walk-in rate**, optional **strikethrough ("was") rate**.

### 1.5 Calls and Comms AI - https://www.cubbystorage.com/products/calls, /products/comms-ai
Call routing, recording, transcription, AI call grading; missed-call-returned tracking. **AI Voice Agent** handles sales/service calls, can complete a rental (proration, discounts, coverage, first-of-month billing), take reservations, text lease/signing links, and charge a saved card mid-call (Fall '26 release). Lead source `AI_VOICE_AGENT` appears in Greens data (16 leads) [Confirmed].

### 1.6 Reporting - https://www.cubbystorage.com/products/reporting
On-demand or scheduled reports. API-exposed reports: **General Ledger Cash**, **General Ledger Accrual**, **Aged Receivables**, **Rent Roll**, **Merchant Services Disbursements** [API]. The data warehouse references a **Management Summary** and a **Home page** with counts such as "document issues" and "liens to initiate" [Confirmed via schema notes]. **Cubby Connector** (Fall '26) links Cubby to Claude/ChatGPT; **Canvas** builds custom pages from a description (early access).

### 1.7 Workflows (Fall '26 release) - https://www.cubbystorage.com/blog/cubby-fall-release-26
Trigger -> conditions -> actions (send SMS/email, create task, set delinquency exemption...). Runs tab shows in progress / failed / terminated / completed. Greens' collection tasks are workflow-generated (see section 2.9). Also **multiple lease configurations per facility** (storage vs parking vs commercial with their own fees, deposits, delinquency schedules, paperwork).

### 1.8 Insurance / tenant protection ("Coverage")
Cubby calls it **Coverage**. Per lease `coverage_type`: `ORGANISATION` (facility's plan, with premium + coverage level), `PRIVATE_POLICY` (tenant's own insurance - policy number + expiration date, "POI" = proof of insurance), `NONE` (waived) [Confirmed]. Enroll/unenroll can be **immediate** (prorated to next rent date, unused paid coverage credited) or **next rent date** [API]. Partners include Prestige Protection Plan, Protego, VaultGard, TPP, SBOA, SafeLease, Xercor, Deans & Homer.
Greens active leases: 1,078 PRIVATE_POLICY, 961 ORGANISATION, 3 NONE. Plans in use: $2,500 coverage at $9 or $14/month, $5,000 at $20 or $25/month [Confirmed aggregate]. Workflow tasks "Remind Tenant of POI Obligation" and "Enroll Tenant in Protection Plan" exist - so expired private policies drive enrollment work.

### 1.9 Integrations
Lien: Ai Lean, Late2Lien. Auction: Storage Treasures, LockerFox, Bid13. Accounting: Storage Unit Accounting, DualEntry. Call center: Zion, XPS, Moody, OpenTech. Payments processor: Stripe or Payabli (`paymentServiceProvider`). (https://www.cubbystorage.com/partners)

---

## 2. Core daily workflows

No public Cubby click-paths exist. Below is the flow as the API and data reveal it; the UI button names are **[Unknown]** unless noted and need screenshots.

### 2.1 New lead
1. Create the lead (Interest) with contact, facility, unit type (pricing group), target move-in date, source.
2. Lead **source** values seen at Greens: OTHER (54), WALK_IN (36), WEBSITE_CHECKOUT (27), CALL (21), REFERRAL (19), CONTACT_FORM (17), AI_VOICE_AGENT (16), ABANDONED_CHECKOUT (16), WEBSITE (13), SPAREFOOT (10), SEARCH_ENGINE (9), FAILED_CHECKOUT (2). "OTHER" being top suggests staff should be trained to pick a real source [Inferred].
3. **Lead statuses**: `NEW`, `IN_PROGRESS_HOT`, `IN_PROGRESS_COLD`, `ON_HOLD`, `RESERVATION`, `CONVERTED`, `UNQUALIFIED`, `DUPLICATE`. Staff can set NEW / ON_HOLD / HOT / COLD / UNQUALIFIED / DUPLICATE; RESERVATION and CONVERTED are set by the system when a reservation or lease is made [API]. Record the quoted rate (`rate_quoted`).
4. Abandoned web checkouts become leads automatically - follow-up call list.

### 2.2 Reservation
Holds a unit for a future move-in; converts to a lease (`RESERVATION_CONVERTED`) or cancels. Deposit/fee rules for reservations at Greens: **[Unknown]**.

### 2.3 Move-in (rental / "checkout")
API order: lead created -> lease created -> payment charged; **if payment is declined, the lease is rolled back but the lead survives** [API]. Steps:
1. Pick unit (pricing group, specific unit; value-pricing tier on web).
2. **Get Move-In Charges / Preview Charges** - first period prorated to the 1st (FOM facilities), admin fee, coverage premium, deposit if configured, merchandise, tax.
3. Choose coverage: facility plan, private policy (enter policy # + expiration), or waived (if allowed).
4. Apply discount program if any (section 3.9).
5. Collect payment: card, ACH, cash, check, offline card. Payment must equal the move-in total.
6. **Enable AutoPay** - a card is saved only after the charge succeeds.
7. Documents: lease agreement e-sign, ID, vehicle info (plate/state/type for parking: TRAILER, RV, BOAT, TRUCK, SUV, SEDAN, OTHER), proof of insurance.
8. Assign gate access code and lock (lock moves to `TENANT_USE`).
Greens data: 1,850 of 2,042 active leases show documents `INCOMPLETE` (largely imported leases), 28 `MISSING_SIGNATURE`, 20 `PENDING` [Confirmed] - a training point about finishing paperwork.
Move-in fee observed: **"Administration Fee" $25** at every facility [Confirmed].

### 2.4 Taking a payment
Channels at Greens (last 180 days, approved sales): AUTOPAY ~2,400, TENANT_PORTAL ~540, POINT_OF_SALE (counter) ~490 card + 81 cash + 39 check, WEBSITE, IVR (phone keypad). Autopay declines ~285 in the same window [Confirmed]. Payment statuses: `SUCCEEDED`/`APPROVED`, `DECLINED`, `FAILED`, `ERROR`, `PENDING`, `REFUNDED`, `DISPUTED`, `DIRECT_DEBIT_RETURN`. **PENDING = outcome unknown - do not retry (double-charge risk)** [API]. Card processing fees may be added at some facilities [API - Greens setting Unknown]. Payment links can cover several leases in one link.

### 2.5 Transfer (unit to unit)
Cubby ends the old lease and creates a new one (`transferred_to_lease_id`), recording a `TRANSFER` move rather than a move-out + move-in; the old lease's balance moves with ledger explanation `TRANSFER_BALANCE_BETWEEN_LEASES` [Confirmed]. Proration/credit of the old unit on transfer: **[Unknown]**.

### 2.6 Move-out
1. **Schedule move-out** (notice): date, notice-given date, reason, time window. Reasons: `NONE`, `CANT_AFFORD`, `NO_NEED`, `MOVING`, `CONSOLIDATING`, `BAD_EXPERIENCE`, `AUCTION`, `OTHER` (+custom). Times: MORNING, LUNCHTIME, AFTERNOON, EVENING, ANYTIME. One scheduled move-out per lease; can disable AutoPay at the same time [API].
2. On the day: verify unit empty/clean (walkthrough), complete move-out (`TENANT_MOVE_OUT`), remove lock/return lock to stock, disable gate code.
3. Settle balance: refund prepaid/deposit or carry a balance; leftover small balances leave via `MOVE_OUT_BALANCE_WITHDRAWN` (EXTERNAL_ACCOUNT) or are written off (BAD_DEBT, `WRITE_OFF_BALANCE`) [Confirmed explanations].
4. Unit becomes rentable or is flagged unrentable: `REPAIRS_REQUIRED`, `CLEANING_REQUIRED`, `UNDER_RENOVATION`, `USED_BY_FACILITY`, `OTHER`. At Greens 380 units are unrentable with reason OTHER (likely mostly mailboxes or retired spots - verify) [Confirmed count, Inferred cause].
Note: many manual tasks titled "Move TNT Out" - staff use tasks as move-out reminders [Confirmed].

### 2.7 Overlock / lockout
Cubby flags `is_needs_overlock` -> task/event `OVERLOCK_NEEDED`; staff physically overlock and mark `OVERLOCK_APPLIED`; on payment `OVERLOCK_REMOVE_NEEDED` -> `OVERLOCK_REMOVED` [Confirmed event names]. The gate code is typically locked out at the same stage (delinquency exemption docs mention "overlock and gate lockout"). 28 leases flagged needs-overlock at snapshot. The day number Greens overlocks on: **[Unknown]**. Fee "Lock Removal/Inventory Fee $75" exists [Confirmed].

### 2.8 Gate codes
Each lease carries an `access_code` and enabled flag; `ACCESS_CODE_CHANGED` is frequent (411 in 30 days). Access log results at Greens: `SUCCESS/ALLOWED`, `SUCCESS/MASTER_CODE`, `FAILURE/UNKNOWN_USER`, `FAILURE/OUTSIDE_OF_HOURS` [Confirmed]. **Only Fairfield ("Entrance" device) reports gate events into Cubby** - the other four sites' gates are either not integrated or use another system [Confirmed data, cause Unknown].

### 2.9 Delinquency ladder at Greens (as automated)
Rent is due on the 1st (FOM). Workflow task names give the schedule:
| Day | Action (task / fee) |
|---|---|
| 2nd | "Call Failed Autopay Tenants" (also mailbox and "Waste Dump User" variants) |
| 6th | "Call Past Due Tenants" |
| ~10th+ | "CA Late Fee" posts (amounts seen $10, $15, $20 and odd amounts like $22.42 / $28.27 / $34.42 - suggests tiered or percentage late fee) [timing Inferred] |
| ~15th? | "CA Preliminary Lien Notice" fee $25 [timing Unknown] |
| 30th | "Final Collection Call" |
| 35th | "CA Lien Notice" (fee $35) |
| 61st | "Vehicle Lien Filing/Tow Notice" (Vehicle Lien Fee $350) |
| 62nd | "Publish 2nd Lien Sale Ad" (Advertising Fee $95-$120) |
| sale | Auction Fee $95, Lien Processing Fee $100 |
Lease auction statuses at Greens: `DELIVERING_LIEN`, `WAITING_FOR_AUCTION`, `SETTLED_UNSOLD`, `CANCELLED` (most). API auction statuses: `LISTED`, `NO_BIDS`, `SOLD`, `PAYMENT_RECEIVED`, `COMPLETE`, `CANCELLED`. Settle outcome SOLD/UNSOLD; complete with cleaning deposit REFUND/RETAIN [API]. "Liens to initiate" on Home = active, owes, late past the facility's lien wait, not exempt, no lien started (20 leases at snapshot).
California law context (verify current text before teaching): B&P Code §21700-21716 - preliminary lien notice after 14 consecutive days unpaid (§21703), lien attaches 14 days after the termination date (§21705), late fee only after 10 days past due and must be in the rental agreement (§21713.5). Sources: https://law.justia.com/codes/california/2011/bpc/division-8/21700-21716/21703/ , .../21705/ , .../21713.5/ (2011 versions - current text on leginfo.ca.gov). Vehicles/boats have separate DMV lien rules (hence the "Vehicle Lien Filing/Tow Notice").
**Delinquency exemptions**: reasons `BANKRUPTCY`, `DECEASED`, `MILITARY_SERVICE`, `PAYMENT_ARRANGEMENT`, `OTHER`; pause any of late fees, overlock (lifts an existing one), lien eligibility, collections messages; one active per lease; needs an end date [API]. Military tenants matter (SCRA) - `is_military` flag exists.
Cubby blog on collections: https://www.cubbystorage.com/blog/self-storage-collections-delinquency-automation (example ladder: grace, late fee ~Day 5, overlock ~Day 15, lien ~Day 22 at another operator - not Greens).

### 2.10 Notes
Manager notes attach to a contact, lease, unit, lead, task or pricing group; one is attributed to its author. A contact can carry a **pinned note** (shown on the lease) [Confirmed schema].

### 2.11 Open / close reports (proposed, not documented by Cubby)
Cubby is cloud and automated - there is no documented "End of Day" close like SiteLink. Suggested open/close routine from industry practice [General]:
- Open: Home page counts (tasks due, document issues, liens to initiate, overlocks needed), today's task list, scheduled move-ins/move-outs, failed autopays, walkthrough/lock check against rent roll.
- Close: payments taken today vs cash/check drawer (POINT_OF_SALE cash/check), deposit slip, tasks completed, leads followed up.
- Weekly/monthly: Rent Roll, Aged Receivables, General Ledger (cash/accrual), occupancy, Management Summary.
Industry references: https://www.insideselfstorage.com/software/6-management-software-reports-every-self-storage-operator-should-understand-and-use , https://storagepug.com/blog/spotlight-reports-property-management-software . Greens' actual open/close checklist: **[Unknown]**.

---

## 3. How the ledger works

### 3.1 Structure in Cubby [Confirmed]
Cubby keeps a **double-entry ledger** (`book_entries`): every transaction posts two sides. From the tenant's view only the Accounts Receivable side matters. Ledger Search returns four entry types: **CHARGE**, **PAYMENT**, **TRANSFER**, **WRITE_OFF**, and four balances: **totalDue**, **deposit**, **prepaid**, **credit** [API].

Charge categories: RENT, COVERAGE (insurance), FEE, RETAIL_SALE, DISCOUNT, TAX_STATE, TAX_LOCAL, DAMAGE, AUCTION, PREPAID, CREDIT, DEPOSIT.
Payment methods: CREDIT_CARD, OFFLINE_CARD, CASH, CHECK, ACH, MONEY_ORDER, ZELLE, VENMO, PAYPAL, CASH_APP, ONLINE_BANKING, E_TRANSFER, EXTERNAL, and internal PREPAID / CREDIT / DEPOSIT (using held money).
GL accounts: ACCOUNT_RECEIVABLE, RENT, FEES, INSURANCE, DISCOUNTS, WAIVED_RENT, WAIVED_FEES, WAIVED_DAMAGE, TAX_STATE, TAX_LOCAL, PREPAID_RENT, DEPOSIT, CREDITS, USED_CREDITS, BAD_DEBT, EXTERNAL_ACCOUNT, OLD_SYSTEM, OLD_SYSTEM_DEPOSIT, RETAIL_SALES, AUCTION, *_PAYMENTS per instrument.

What actually posts at Greens (last 180 days, AR side, rounded): RENT debits ~4,100 rows / $805K; card payments ~3,500 / $711K; INSURANCE ~2,000 / $22K; FEES ~575 / $26K; DISCOUNTS ~710 / $17K; WAIVED_FEES ~185 / $13K; WAIVED_RENT 42 / $3.3K; PREPAID_RENT in/out; cash $24K, check $12K, ACH $9K; BAD_DEBT 6 / $3.3K [Confirmed aggregate]. Ledger "explanation" codes seen: RENT, PAYMENT, INSURANCE, DISCOUNT, FEE, WAIVE, REFUND, USE_PREPAID_FOR_RENT, OVERPAYMENT_TO_PREPAID_ACCOUNT, CREDIT_PREPAID, CREDIT_DEPOSIT, TRANSFER_BALANCE_BETWEEN_LEASES, TRANSFER_BALANCE_FROM_MOVED_OUT_LEASE, TRANSFER_OLD_SYSTEM_LEASE/DEPOSIT/PREPAID_BALANCE (migration), WRITE_OFF_BALANCE, PAYMENT_MARKED_AS_FAILED, MOVE_OUT_BALANCE_WITHDRAWN.

### 3.2 Charges vs payments vs credits vs waives (Cubby's own rules) [Confirmed, API]
- **Charge** (debit) increases what the tenant owes.
- **Payment** (credit) reduces it. Cubby applies cash **oldest charge first (FIFO)**; same-time charges in order prepaid, deposit, rent, state tax, local tax, insurance.
- **Waive** = cancel all or part of a specific charge *now* (contra entry WAIVED_RENT / WAIVED_FEES / WAIVED_DAMAGE, against that charge's period). Rent, fee, damage, coverage and deposit charges can be waived; tax is waived in proportion; taxes and waives themselves can't be waived. If a waive leaves the lease below zero, the excess becomes prepaid. Needs a reason.
- **Credit** = goodwill money held on the lease that does **not** reduce today's balance; it is used on the next recurring charges in order rent -> coverage -> automated fees (late fees). Not used on manually added charges. Must be enabled per facility.
- Waiving and crediting need the **"Credits and Waives"** permission (no approval step) [API roles].
- **Prepaid** = money paid ahead of charges ("overpayment to prepaid account"); applied automatically as each charge posts. Prepaid does **not** move the paid-through date until the charges it pays actually post.
- **Deposit** = held liability, returned (CREDIT_DEPOSIT) or retained (RETAINED_DEPOSIT) - 173 active leases carry one, mostly imported from the old system.
- **Write-off** = BAD_DEBT entry clearing uncollectable balance (with explanation).
- **Transfer** = balance moved between leases / from old system.

### 3.3 Paid-through date (PTD) [Confirmed]
`status_paid_through_date` = last day the lease is paid up to. Late since = PTD + 1. Days past due = today - PTD - 1 (one-day grace). Delinquency aging anchors on PTD. At FOM facilities a current tenant's PTD is the last day of the month.

### 3.4 Billing cycle and proration
- Facility setting `leaseAnniversary`: `FIRST_OF_MONTH` or `START_DATE` (anniversary). Greens = FIRST_OF_MONTH everywhere. `billingOption` FIXED/FLEXIBLE; cycles MONTHLY or DAYS_28 at facility level [API].
- "At a FIRST_OF_MONTH facility, the move-in period is prorated to the 1st against one month of rent" [API changelog]. Exact daily-rate formula (rent / days in month vs rent x 12 / 365) **[Unknown - verify with a Preview Charges screenshot]**.
- **Jump day = 26** at Greens [Confirmed setting]. Industry meaning [General/Inferred]: a move-in on or after the jump day is charged the prorated rest of this month **plus** the full next month at move-in, so the first bill isn't due days later.

**Worked example A - mid-month move-in (assume rent / days-in-month):**
10x10 Interior, street rate $129. Move-in 11/18 (November = 30 days). Days 11/18-11/30 = 13.
- Prorated rent: 129 x 13 / 30 = **$55.90**
- Administration Fee: **$25.00**
- Coverage $2,500 plan at $9/month, prorated the same way: 9 x 13/30 = **$3.90** (whether coverage prorates at move-in: Unknown)
- Due at move-in: **$84.80**. PTD = 11/30. 12/01 autopay charges $129 + $9 = $138.

**Worked example B - jump day:** Same unit, move-in 11/27 (on/after 26th). Prorated 4 days: 129 x 4/30 = $17.20, plus December $129, plus admin $25, plus coverage (9 x 4/30 = $1.20 + $9) = **$181.40**. PTD = 12/31. First autopay 01/01.

**Worked example C - anniversary billing (for contrast, not Greens):** move-in 11/18 pays a full $129, PTD 12/17, next bill 12/18.

### 3.5 Recurring monthly charge and autopay
On the 1st Cubby posts RENT (+ COVERAGE, + recurring fees such as "Commercial Water Fee $45", "Business Class Package Fee $15", "First Class Package Fee $25"; discounts post as a DISCOUNT credit). AutoPay charges the saved card/ACH on the charge date. 1,515 of 2,042 active leases (74%) are on autopay, almost all by card (10 ACH) [Confirmed]. A decline leaves the charge open -> "2nd - Call Failed Autopay" task; send a payment link; card expiration is visible on the lease.

### 3.6 Partial payments
FIFO: oldest charge first. **Example D:** Tenant owes December rent $129 + coverage $9 = $138 and pays $100. Cubby applies $100 to rent (rent ranks before insurance at same time). Rent shows $29 still open, coverage $9 open; balance $38. PTD stays 11/30 because December is not fully paid [General/Inferred - Cubby's rule for PTD on partial payment not documented; UnitTrac sets PTD by invoice items paid in full: https://unittrac.com/help/article/accounting-terms]. Late fee may still post.

### 3.7 Prepayment
**Example E:** On 11/15 tenant (current through 11/30, $129 + $9) pays $414 (3 months). Ledger: payment $414 -> no open charges -> `OVERPAYMENT_TO_PREPAID_ACCOUNT` prepaid balance $414. PTD still 11/30. On 12/01 charges $138 post and `USE_PREPAID_FOR_RENT` moves $138 from prepaid; PTD -> 12/31, prepaid $276. Same 01/01 and 02/01; PTD 02/28, prepaid $0. If rent goes up mid-prepay (ECRI), the prepaid runs out sooner. Cubby can quote multi-period prepay ("$61.00 (period rate) x 3 periods") [API].

### 3.8 Late fees
Posted automatically (`LATE_FEE_CHARGED`) as "CA Late Fee". Amounts seen: $10, $15, $20 and odd cents ($22.42, $24.67, $28.27, $34.42) -> probably a percentage of rent with a floor, or tiered by rent [Inferred]. Mailbox late fee $2.50. CA §21713.5 caps late fees and requires 10 days past due [verify current law]. Exact Greens schedule **[Unknown - get from lease configuration screen]**.
**Example F (illustrative, assumed $20 fee):** December $138 unpaid; fee posts $20 -> balance $158. Tenant calls; manager waives the fee (WAIVED_FEES $20, reason "first time late, goodwill") -> balance $138; tenant pays $138 -> balance $0, PTD 12/31. Greens waived ~$12.9K of fees in 6 months vs ~$25.8K charged [Confirmed] - waiver policy is a key training topic.

### 3.9 Discounts
Programs at Greens [Confirmed]: PERPETUAL percent off rent - 5% military/first responder, 5% senior 55+, 5% teacher, 20% employee; PERIODIC - "First Month 50% Off New Tenants Only", "First 2 Months 50% Off", "First 3 Months 60% Off", "First 4 Months 25% Off" (start NEXT_MONTH, i.e. after the prorated move-in period), "50% off 1 month", "25% off 3 months", "60% off 2 months" (start NOW), "$25.00 Referral" (one month). Discounts post as their own DISCOUNT line, not a lower rent.
**Example G:** "First 2 Months 50% Off", $129 rent, move-in 11/18: move-in proration full price (starts NEXT_MONTH); Dec rent $129 - DISCOUNT $64.50; Jan same; Feb full $129.

### 3.10 Refunds, reversals, NSF/chargebacks
- **Refund**: a REFUND transaction against a card payment (ledger explanation REFUND; payments table SALE row restamped REFUNDED + a REFUND row). Refunds put the money back on the lease as owed unless the charge is also waived/credited [General/Inferred]. Card/bank refunds may settle later.
- **Failed ACH / returned payment ("NSF")**: entry `PAYMENT_MARKED_AS_FAILED` re-opens the charges; `DIRECT_DEBIT_RETURN` status; `FAILURE` payment type records a failed-payment fee [Confirmed]. Whether Greens charges an NSF fee: **[Unknown]**.
- **Dispute / chargeback**: payment status `DISPUTED` [API]. Process for evidence: Unknown.
- Declined attempts post **nothing** to the ledger.

### 3.11 Aging buckets
Cubby Aged Receivables: 0-30, 30-60, 60-90, 90-120, 120+ (`RANGE_*`) per charge [API]. Collections views bucket the whole balance by days since late. **Example H:** PTD 9/30, today 11/04 -> days past due = 35-1 = 34 -> the 31-60 bucket for collections triage; on a per-charge aged receivable the October charge is 34 days old and the November charge 3 days old.
Greens snapshot: 342 of 2,042 active leases flagged not paid (Cubby's `is_lease_paid` is broader than balance > 0) [Confirmed].

### 3.12 Write-offs and move-out balances
Balance left after move-out or auction: try collections; otherwise write off (BAD_DEBT, "WRITE_OFF_BALANCE") - 6 write-offs, ~$3.3K in 6 months. Small residuals: MOVE_OUT_BALANCE_WITHDRAWN. Auction sale: SOLD charges the bid (+ sales tax) to the auction account; proceeds apply to the debt; surplus handling per CA law [General].

### 3.13 Taxes and pass-through
TAX_STATE / TAX_LOCAL are collected and owed onward - not revenue. Tax categories e.g. `RENT_ENCLOSED_STORAGE`, `FEE_NON_TAXABLE`. California generally does not tax storage rent; merchandise is taxed [General - confirm Greens tax setup]. Insurance premiums (COVERAGE/INSURANCE) are billed by the facility and largely passed to the coverage provider.

### 3.14 Migration artifacts
OLD_SYSTEM / OLD_SYSTEM_DEPOSIT / TRANSFER_OLD_SYSTEM_* entries and `lease_created_by = IMPORT` show Greens' leases came from a prior system (likely SiteLink or similar - Unknown). Teach staff that opening lines "Imported balance" are normal.

---

## 4. Cubby data-model vocabulary (reporting DB `public_analytics`)

| Table | Meaning / key values |
|---|---|
| facilities | 5 CA sites; `lease_anniversary` FIRST_OF_MONTH, `jump_day` 26 |
| units | one row per unit ("space"). `unit_type` RENT_ENCLOSED_STORAGE / RENT_PARKING_SPACE. Flags is_active, is_leased, is_rentable (independent), is_overlocked. Vacant = unleased AND rentable. `unit_unrentable_reason`. `unit_features` e.g. "Climate controlled", "Drive-up", "Roll-up door", "RV parking", "Boat parking", "Paved/Unpaved parking", "Pull-Through", "Open air - no coverage" |
| pricing_group | the "unit type" with standard (street) / web / walk-in / strikethrough rates. Greens names like "10' x 10' Storage - Interior, Lower", "12' x 32' Parking - Gravel, Drive-In", "0' x 3' mailbox" |
| leases / leases_historical | the rental. PTD, late since, is_lease_paid, balance_ar/deposit/prepaid, autopay, coverage_type, ins_premium, access_code, ecri_stage, documents_combined_status, is_lien_eligible, is_needs_overlock, is_in_auction, storing_vehicle + vehicle fields, `lease_created_by` (WEBSITE / IMPORT / staff name) |
| contacts | tenants and leads (one contact, many leases) |
| leads | statuses and sources (section 2.1) |
| book_entries | the ledger (section 3) |
| payments | gateway attempts. type SALE/REFUND/FAILURE; status APPROVED/DECLINED/APPROVING/REFUNDED/FAILED/ERROR/NEW; channel AUTOPAY/TENANT_PORTAL/POINT_OF_SALE/WEBSITE/IVR; method CREDIT_CARD/CASH/CHECK/ACH/OFFLINE_CARD |
| recurring_fees | per-lease monthly add-ons (water, mailbox packages) |
| discount_programs / discounts | PERIODIC vs PERPETUAL, PERCENT_DEDUCTED vs AMOUNT_DEDUCTED, start NOW / NEXT_MONTH |
| rate_changes | ECRI queue: SCHEDULED / CANCELLED (APPLIED in docs); realized changes are LEASE_RENT_CHANGED events |
| scheduled_move_outs | notices with reason |
| lease_auctions / auctions | lien status DELIVERING_LIEN, WAITING_FOR_AUCTION, SETTLED_UNSOLD, CANCELLED |
| tasks | OPEN / COMPLETED / ARCHIVED; is_workflow_generated |
| access_log | gate events, result/reason |
| door_locks | locks and combinations |
| manager_notes, walkthroughs, calls, sms, emails, product (retail), stor_track (competitors), unit_turnover (MOVE_IN / MOVE_OUT / TRANSFER), occupancy_daily |
| cubby_events | audit trail: LEASE_CREATED, TENANT_MOVE_OUT, UNIT_TRANSFERRED, AUTOPAY_CHANGED, ACCESS_CODE_CHANGED, LATE_FEE_CHARGED, MANUAL_CHARGE_ADDED, OVERLOCK_NEEDED/APPLIED/REMOVE_NEEDED/REMOVED, LEASE_LIEN_STATUS_CHANGED, DELINQUENCY_EXEMPTION_ADDED, PAYMENT_REQUEST_CREATED/APPROVED, LEASE_RENT_CHANGE_SCHEDULED/CANCELLED, LEASE_SNOOZED, CREDIT_BALANCE_CHANGED, LEASE_COVERAGE_CHANGED, MAIL_SUBMITTED/MAILED (certified lien mail), SPACE_AVAILABLE/UNAVAILABLE, RESERVATION_CONVERTED |

Note `PAYMENT_REQUEST_CREATED` / `APPROVED` (~187/30 days) suggests an approval step for some staff payment actions (refunds? manual charges?) [Unknown - ask].

Portfolio snapshot (aggregate, as of 11/05/2026 UTC):
| Facility | Enclosed units (leased) | Parking spaces (leased) |
|---|---|---|
| Escondido | 794 (725) | 90 (80) |
| Fairfield | 4 (1) | 303 (211) |
| Murrieta | 8 (6) | 161 (150) |
| Temecula | 34 (25) | 481 (333) |
| Valley Center | 847 (508) | 3 (3) |
Enclosed counts include mailboxes (~340 "mailbox" pricing groups) - Valley Center's low occupancy is likely mailbox inventory [Inferred].

---

## 5. Unknowns - need Greens screenshots / CSM answers

1. Every UI screen and button name: Home dashboard, unit map (Sitemap), Move-In wizard, lease page tabs, ledger view, Take Payment, Waive/Credit dialogs, Transfer, Move-Out, Overlock, task board, Reports menu.
2. Texas facilities - are any on Cubby? None in this org.
3. Late fee schedule (amount/percent, day), overlock day, preliminary lien notice day, gate lockout day - from the lease configuration(s) for storage vs parking vs mailbox.
4. Exact proration formula and whether coverage/fees prorate; jump-day behavior confirmation via a real Preview Charges.
5. Deposit policy (new move-ins vs imported), reservation fees, NSF/returned payment fee, card processing fee.
6. Who has "Credits and Waives" permission; Greens' waiver policy and limits; what PAYMENT_REQUEST approvals are.
7. Refund procedure (card vs cash/check), how refunds show on the ledger screen.
8. Gate integration at Escondido/Murrieta/Temecula/Valley Center (only Fairfield reports to Cubby).
9. Vehicle-specific rules: registration/insurance docs, DMV lien process, tow notices; mailbox service rules (package fees).
10. Daily open/close checklist and which reports Greens actually runs; cash drawer / deposit procedure.
11. Tenant portal and mobile app screenshots (tenant view).
12. ECRI process ownership (snooze/cancel decisions - 1,015 cancelled vs 403 scheduled).
13. Prior system name (for "old system" balances).

---

## 6. Source list
- Cubby home: https://www.cubbystorage.com/
- Facility Operations: https://www.cubbystorage.com/products/facility-operations
- Tenant Management: https://www.cubbystorage.com/products/tenant-management
- RevMan: https://www.cubbystorage.com/products/revman ; Calls: https://www.cubbystorage.com/products/calls ; E-commerce: https://www.cubbystorage.com/products/e-commerce
- Fall '26 release: https://www.cubbystorage.com/blog/cubby-fall-release-26
- Collections blog: https://www.cubbystorage.com/blog/self-storage-collections-delinquency-automation
- Partners: https://www.cubbystorage.com/partners ; Late2Lien: https://www.cubbystorage.com/blog/cubby-announces-integration-with-late2lien ; Ai Lean: https://www.cubbystorage.com/blog/cubby-to-partner-with-ai-lean
- Developer docs: https://cubbystorage.github.io/docs/ and API reference https://cubbystorage.github.io/docs/api/ (sections: Billing Cycles, Paid-through date and prepayments, Credits and Waives, Ledger Search, Aged Receivables, Auctions, Delinquency Exemptions, Tasks, Changelog)
- API profile: https://providers.apievangelist.com/providers/cubby/
- OneLock integration: https://www.insideselfstorage.com/suppliers-products/self-storage-software-cubby-integrates-with-onelock-technology-from-keep-it-simple-storage
- Competitor view (low weight): https://monument.io/blog/cubby/
- Ledger general: https://unittrac.com/help/article/accounting-terms ; QuikStor proration https://help.quikstor.com/en/articles/13905560-how-to-complete-a-move-in-using-a-pro-rated-paid-through-date
- Reports general: https://www.insideselfstorage.com/software/6-management-software-reports-every-self-storage-operator-should-understand-and-use
- CA lien law (2011 text, verify current): https://law.justia.com/codes/california/2011/bpc/division-8/21700-21716/21703/ , /21705/ , /21713.5/
- Greens' Cubby reporting DB via Cubby MCP (org "Greens Storage"), aggregates only.
