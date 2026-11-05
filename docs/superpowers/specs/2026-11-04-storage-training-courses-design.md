# Greens Storage Academy: Five Foundation Courses - Design

Date: 11/04/2026. Requested by Neil. Status: draft for Neil's review.

## 1. Intent

Greens runs self-storage and RV / boat / vehicle storage. Today a new facility hire learns the job by shadowing whoever is on shift, so what they learn depends on who taught them. Neil wants five courses in the Nexus training module that teach the job properly. They should feel like a real program, run 2 to 4 hours each, and still be right years from now.

The five courses:

1. **Nexus Fundamentals**: the company's own system, where the rest of training lives.
2. **Self-Storage Fundamentals**: the industry, the product, how a site makes money, the rental agreement, delinquency and liens, running the site.
3. **Customer Service & Sales Fundamentals**: phones, walk-ins, tours, closing, existing tenants, collections conduct, difficult situations.
4. **RV & Boat Storage Fundamentals**: vehicle knowledge, space types, measuring and fit, paperwork, rules and risks, vehicle liens, the lot.
5. **Cubby Fundamentals**: the facility software. Leads, move-ins, payments, the tenant ledger, move-outs, delinquency, reports.

Together they are "Greens Storage Academy." That is a working name for the Training Plan and certificates, and Neil can rename it.

### Why this shape lasts

- **The industry courses do not mention Cubby screens.** Industry knowledge changes slowly. Software changes every release. Keeping Cubby in its own course means a Cubby update never forces a rewrite of Self-Storage or Customer Service.
- **Cubby click-steps are Knowledge Base pages.** The course links to them as page lessons. When Cubby moves a button, someone edits one page and every course that links it is current.
- **Greens' own numbers live in one place.** Fees, late-fee days, lien days, protection plan names, prices and waiver limits go on "Greens Policies" Knowledge Base pages, one per topic. Lessons teach the concept and point to the policy page. A fee change edits one page, not twelve lessons.
- **Law is taught at training level.** Lessons teach what staff must recognize and when to stop and escalate, not legal advice. Every legal lesson carries the same callout: "If anything here does not match your situation, stop and check with your manager." Counsel reviews those lessons before Publish.

## 2. Goals, Non-Goals, Anti-Goals

**Goals**
- A new hire with no storage background can answer a sales call, show a unit, rent it, explain the agreement, and recognize a lien or privacy problem before it becomes one.
- Every course runs 2 to 4 hours (Nexus Fundamentals can sit at the low end), split into lessons of 10 to 20 minutes so it fits between customers.
- Practice, not just reading. Each course has checkpoints after its hard lessons and scenarios drawn from real situations at storage sites.
- Measurable. Final quizzes with a pass mark, certificates, completion tracked in Compliance, and overdue training escalated to the manager.
- Easy to keep current. Each course has one owner, an annual review date, and a short list of "edit here" pages.

**Non-Goals**
- Not a legal manual. Statute details stay at "what to recognize, when to escalate."
- Not a Cubby admin course. Configuration, pricing groups, revenue management and workflow building are for a later manager course.
- Not manager training: hiring, scheduling, P&L. That is a possible next tier.
- No Spanish version in this pass. The structure allows it later; see Open Questions.
- No video production in this pass. Lessons have places marked for video that staff can fill later.

**Anti-Goals** (it would be a failure even if it "works")
- Lessons that hard-code a fee, a day count or a price that later goes stale. The quiz would then teach a wrong number with confidence.
- Legal content that tells staff to do something the law forbids, for example selling after a Declaration in Opposition arrives or telling a non-tenant about an account.
- Generic filler that could be about any company. Every course should sound like Greens: our sites, our mix of storage and vehicle parking, our systems.
- A quiz that can be passed by guessing. Use a question bank, draw from it, shuffle it, and allow 3 tries.
- AI-written content at runtime. AI is OFF in Nexus. All content is authored now and stored as ordinary course data.

## 3. Constraints (what the Nexus training module can do)

The design uses only what the module already has. No new features are needed.

- **Lesson types:** `text` (rich blocks), `page` (a linked Knowledge Base page, shown live), `checkpoint` (practice questions, up to 10, which do not use up a quiz try). Up to 60 lessons per course.
- **Blocks in a text lesson:** headings, paragraphs, bullet and numbered lists, callouts (`warning`, `tip`, `note`, `safety`), tables, steps (with photos), checklists, video (YouTube, Vimeo, Loom, SharePoint / Microsoft), embedded Knowledge Base page.
- **Final quiz:** up to 200 questions. `passPct` (default 80), `drawCount` (draw N from the bank per attempt), `maxTries` (1 to 10, default 3), `shuffle`. Question types: `single`, `multi`, `tf`, `order` (put in order), `short` (keyword-graded short answer), `photo` (a person reviews it). Each question can carry an `explanation` shown when it is missed, and a `lessonId` so "Reread these" points to the right lesson.
- **Delivery:** `online`, or `in_person` (complete only when a trainer or the manager signs off). An in-person course is how hands-on checks are recorded.
- **Training Plans:** a bundle of courses and policies taken in order and tracked as one checklist in My Training. Due a set number of days from the start date, or by one fixed date.
- **Assignment rules:** an audience (company, department, job role), due mode (days from start date or a fixed date), `new_hires_only` for an onboarding track, `escalate_days` (the manager is told once, then weekly), `renew_months`.
- **Courses:** `recert_months` for retakes, `est_minutes`, `departments`, an `overview` list ("What you'll learn"). Course codes are assigned automatically (LRN-xxx). Everything is a draft until Publish. Every published version is kept, and certificates name the version.
- **House style:** American English, Title Case for titles, buttons and statuses, sentence case for body text. Dates MM/DD/YYYY, times 12-hour AM/PM. No em dashes (plain hyphens). Say "Time Sheet". Never "Global Admin" or "IT Admin".

## 4. Program Structure

### 4.1 The Training Plan

**"New Hire: Facility Team"** takes the courses in this order:

| # | Course | Why here | Est. |
|---|---|---|---|
| 1 | Nexus Fundamentals | They need Nexus to take everything else, punch in and get help | 2 h |
| 2 | Self-Storage Fundamentals | The vocabulary and rules everything else assumes | 3.5 h |
| 3 | RV & Boat Storage Fundamentals | About 38% of Greens' active spaces are vehicle parking (1,038 parking spaces vs 1,687 enclosed units in Cubby) | 3 h |
| 4 | Cubby Fundamentals | The software, once they know the product and the lot | 3 h |
| 5 | Customer Service & Sales Fundamentals | The daily work, built on the product, the lot and the software | 3.5 h |
| 6 | Hands-On Check (in person) | Proves they can do it, not just pass a quiz | sign-off |

(Order and the name "Hands-On Check" are Neil's, 11/04/2026. Lesson cross-references inside sections 5.x that point at a course by number follow this order.)

- **Due:** 30 days from the start date.
- **Rule:** `new_hires_only` for the onboarding track, `escalate_days` 7.
- **Existing staff:** everyone already employed takes the plan by ONE fixed date (`due_date` on the rule), set when the plan is switched on; anyone who joins after that date gets 30 days from their start (Neil, 11/04/2026).

**Hands-On Check** is a short in-person course (`delivery: in_person`). A manager or senior team member signs off three hands-on checks:
1. **A mock sales call**, scored with the call score sheet from Customer Service lesson 6.
2. **A guided site walk**, covering the lock check, vacant unit check and vehicle lot walk.
3. **A supervised move-in in Cubby** for a real or test tenant.

It has one text lesson (the checklist of what the trainer looks for) and no quiz. This is the "amazing" part: the program ends with proof of skill, not just a quiz score.

### 4.2 Audiences

- **Facility Team:** site managers, assistant managers, relief staff. Takes the whole plan.
- **Office and support staff** (accounting, HR, call support): Nexus Fundamentals is required. Self-Storage Fundamentals is recommended so the whole company speaks the same language.
- **Third-party-managed sites:** only if Neil wants them; see Open Questions.

### 4.3 Certificates, No Retakes (Neil, 11/04/2026)

Every course issues a certificate when it is passed, and that is the end of it: `recert_months` is 0 on all six, and no assignment rule renews them. A person can retake any course whenever they want a refresher. When a course is republished with a real change, people who already passed keep their certificate.

The "Greens Policies" pages are Read and Sign policies in the Library. A policy change triggers a re-sign, which is the cheapest way to get a new fee or rule in front of everyone.

### 4.4 The Knowledge Base pages the courses rely on

These are created as drafts with the courses, in a "Greens Storage Academy" collection. "Greens Policies" pages are fill-in templates (headings plus placeholders marked "[Greens to fill]"). They are never invented numbers.

**Greens Policies** (Read and Sign once filled in):
- **Fees and Charges:** admin fee, late fees (California tiers), lien notice fees, cut-lock, auction and lien processing fees, NSF.
- **Delinquency Timeline:** the day ladder (2nd, 6th, 30th, 35th, 61st, 62nd as Cubby automates today) and who does what.
- **Tenant Protection:** plan names, coverage amounts, required or optional, what is excluded (vehicles).
- **Waivers, Credits and Refunds:** who may waive, dollar limits, approvals.
- **Vehicle Storage Rules:** paperwork, operable-vehicle rule, propane, batteries, no living or repairs.
- **Privacy and Records Requests:** who may be told what, subpoenas, police, deceased tenants.
- **Site Hours and Access:** gate hours and office hours per site.

**Cubby How-To:** one page per task, so a Cubby change edits one page:
- Move-In, Take a Payment, Transfer, Move-Out, Waive or Credit, Overlock and Lockout, Gate Code, Notes, Reservation, Start Lien, Delinquency Exemption, Open and Close Reports.
- Each page is steps with screenshot slots. Screenshots come from Greens' own Cubby, because Cubby has no public help center.

**Site Profiles:** one page per site (Escondido, Fairfield, Murrieta, Temecula, Valley Center). Unit mix, parking types and clear heights, amenities (dump station, wash, power), gate notes, local parking rules. Filled in by each site manager.

## 5. The Courses

Lesson length targets 1,200 to 2,200 words, plus tables and callouts. Times below include reading, checkpoints and the final quiz.

### 5.1 Nexus Fundamentals (about 120 minutes)

- **Audience:** every new employee, facility and office.
- **What you'll learn:** sign in and set up your phone; punch in, take breaks and fix a missed punch; read and sign your Time Sheet; request time off and other HR requests; find people and get help; report problems with tickets and forms; take training and sign policies.

Lessons (14; source: research-nexus.md sections 1-25):

| # | Lesson | Covers |
|---|---|---|
| 1 | Welcome to Nexus | What Nexus is; tiers (Employee to Super Administrator) and why menus differ by person; job title under names, tier as a mark only |
| 2 | Signing In and Getting Around | Team Sign-In, the policy notice, the sidebar groups, header (search Ctrl/Cmd+K, +, bell, ?, profile), phone vs desktop table |
| 3 | Nexus on Your Phone | Install Nexus (Android, iPhone Share > Add to Home Screen), Push to This Device, Appearance |
| 4 | Your Dashboard and the Bell | Home tiles, Needs Your Attention, Customize, adding the Announcements widget, bell, yellow priority bar |
| 5 | Workday: Your Home Base | Overview tiles, Documents to Sign, My Schedule, My Documents, profile card (what changes go through Ask HR) |
| 6 | Punching In, Breaks and Punching Out | The four buttons, the message boxes (BOD, break, resume, EOD), location at punch, early clock-in, break allowance, long-shift banner, no-signal punches; California break statement and Report a Missed Break |
| 7 | Checkpoint: Time Clock | 8 questions |
| 8 | Your Time Sheet | Fixing a Missing punch, change requests, Review & Approve, only you sign, H:MM never decimals |
| 9 | Schedules and Time Off | Confirm your week, shift requests (off unless your company turned them on), Request Time Off, approved time off not auto-punched, hourly holidays unpaid |
| 10 | Ask HR, Reimbursements and Purchases | The three Workday panels, receipts by Ctrl+V or camera, Fix and Resubmit |
| 11 | Getting Help: Tickets, Report a Problem and Forms | Submit a Ticket, statuses, Mark Resolved / Confirm / Reopen, scanning a site QR tag, Fill a Form, offline "Saved on This Phone", photos as evidence |
| 12 | People, Equipment and Notes | Directory and Teams buttons (no in-app chat), Item Management My Stuff and Borrow (photo rules), Notes privacy |
| 13 | Training and Policies | My Training, checkpoints vs quiz tries, certificates, Read and Sign; how this academy works |
| 14 | Checkpoint: Putting It Together | 10 scenario questions ("You forgot to punch out yesterday. What do you do?") |

- **Final quiz:** bank of 45, draw 25, pass 80%, 3 tries, shuffle.
- **Photo question:** "Upload a screenshot of Nexus installed on your phone's home screen." A manager reviews it.

### 5.2 Self-Storage Fundamentals (about 210 minutes)

- **Audience:** facility team (required), office staff (recommended).
- **What you'll learn:** how the industry works and who our customers are; every unit type and size and what fits; how a storage site earns money; what the rental agreement says; how delinquency and the California lien process work and the lines you never cross; how to run the site from open to close safely; the privacy and compliance rules that protect tenants and Greens.

Lessons (16; source: research-self-storage.md sections 1-12, research-cubby.md section 0 for Greens facts):

| # | Lesson | Covers |
|---|---|---|
| 1 | Welcome to Self-Storage | History (Odessa TX 1964, Public Storage El Cajon 1972); industry size (cite one dated source, about 12.6% of U.S. households rent, SSA 2025); REITs vs independents vs third-party managers; where Greens fits (5 California sites in Cubby, storage plus vehicle parking plus mailboxes) |
| 2 | Why People Rent | The 4 Ds plus moves, remodels, deployment, business use, students; segments; average stay about 16 to 19 months |
| 3 | The Product: Units and Sizes | 5x5 to 10x30 with what fits (table); climate-controlled vs drive-up vs interior; parking; ground vs upper floor; mailboxes |
| 4 | Access, Locks and Security | Gate codes and keypads, hours, disc vs cylinder vs padlocks, overlocks, smart entry, cameras and access logs; tenant has exclusive control (no bailment) |
| 5 | Checkpoint: The Product | 8 questions |
| 6 | How a Storage Site Makes Money | Street vs in-place rate, rate increases on existing tenants, three kinds of occupancy with worked examples, concessions, fees, merchandise, a revenue management overview (no Cubby screens) |
| 7 | Tenant Protection and Insurance | Protection plan vs tenant insurance, why it matters to the tenant and to Greens, how to explain it without pressure; links the Tenant Protection policy page |
| 8 | The Rental Agreement | Month-to-month, key clauses, prohibited items and uses (hazmat, food, living in units, firearms and explosives); what the operator can and cannot do; California SB 709 disclosure on page one (promo rate and length, max rent in 12 months, agreements from 01/01/2026); California late-fee rules (none before day 10; caps by rent) |
| 9 | Checkpoint: Money and the Agreement | 10 questions |
| 10 | Delinquency and the Lien Process | General shape; California Self-Service Storage Facility Act step by step (preliminary lien notice at 14 days, both addresses, email only with consent and proof; lien attaches; Notice of Lien Sale; Declaration in Opposition stops the sale; advertising options incl. AB 542; commercially reasonable sale; excess proceeds held one year); vehicles and vessels follow a different path (pointer to the RV course); a "Texas sites" callout; links the Delinquency Timeline policy page |
| 11 | Lines You Never Cross | The never-do list (skip or back-date a notice, sell after a Declaration, bankruptcy or military notice, take or buy from a liened unit, let friends bid, discuss an account with a non-tenant); SCRA and the military flag; the "stop and escalate" rule |
| 12 | Checkpoint: Liens | 10 questions, including an `order` question to put the California steps in order |
| 13 | Running the Site: Open to Close | Opening routine, walk-throughs and lock checks, vacant unit prep, overlocks, cleanliness and curb appeal, pest control, abandoned items and dumping, key and code control, cash handling, closing routine (checklist blocks) |
| 14 | Safety and Emergencies | Working alone, never entering a unit with a stranger, wildfire and evacuation (California), floods, power loss, injuries, incident documentation via Nexus Forms |
| 15 | Privacy and Compliance | Who may be told what, police requests, subpoenas and warrants, deceased tenant, bankruptcy, ADA, fair treatment; links the Privacy policy page |
| 16 | Numbers That Matter and Words to Know | Occupancy, move-ins and move-outs, net rentals, delinquency %, conversion, length of stay; 54-term glossary as a table; 10 myths and common new-hire mistakes |

- **Final quiz:** bank of 80, draw 40, pass 80%, 3 tries, shuffle.
- **Question mix:** about 15 `order` and `multi` questions, the rest `single` and `tf`.
- **Every lien and privacy question carries an explanation.**

### 5.3 Customer Service & Sales Fundamentals (about 210 minutes)

- **Audience:** facility team, plus anyone who answers a Greens phone.
- **What you'll learn:** who our customers are and what they are going through; the nine parts of a storage sales call; recommending a size instead of asking for one; giving a tour that closes; following up with web and phone leads fast; handling objections honestly; talking with existing tenants about payments, rate increases and move-outs; handling difficult and unsafe situations calmly; answering reviews.

Lessons (16; source: research-customer-service.md sections 1-11):

| # | Lesson | Covers |
|---|---|---|
| 1 | Who Walks Through Our Door | Life transitions (move, divorce, death, downsizing, deployment); what they feel; what drives choice; 57 to 58% rent from the first site they call; RV and boat customers differ |
| 2 | The Greens Service Standard | LAST / HEARD-style recovery in Greens words; tone, appearance, the office; response-time targets table (web lead within 5 minutes, 30 at most, follow-up 24 to 48 hours, reviews within 48 hours, escalations promised within 24 hours) |
| 3 | Why the Phone Wins or Loses Rentals | Mystery-shop findings (92% friendly, only 25% asked for the rental); calls-to-rentals benchmark (old 35% figure plus newer data, dated); speed to answer |
| 4 | The Nine Parts of a Sales Call | Greeting, why they called, discovery (the four questions), recommend, build value, price, close, objections, capture and follow up; sample scripts in steps blocks |
| 5 | Recommending a Size | Never ask "what size do you need"; size guide table; climate-sensitive items; prohibited-item screening in discovery |
| 6 | The Call Score Sheet | The 22-item score sheet (pass 70%); how to self-review a recorded call; this sheet is reused in the Hands-On Check |
| 7 | Checkpoint: The Sales Call | 10 questions, including an `order` question for the nine parts |
| 8 | Walk-Ins and the Tour | The walk-in greeting, the tour route (before, gate, on the way, at the unit, close at the unit), safety callout (never enter a unit with a prospect) |
| 9 | Move-In Done Right | Completing the lease, explaining protection honestly, rules at move-in, the move-in orientation, the confirmation the day before |
| 10 | Online Renters and Digital Leads | Web reservations, email and text etiquette, contactless renters, chat; texting consent note |
| 11 | Objections, Honestly | Price, "just looking", cheaper competitor, "I'll think about it", fees, rate increases; table of objection, what is behind it, good response |
| 12 | Existing Tenants: Payments, Rate Increases and Move-Outs | Rate-increase conversations, save attempts within 24 hours of a move-out notice, protection claims path |
| 13 | Collections With Respect | Conduct rules (federal FDCPA mostly does not apply, California Rosenthal Act likely does, so train FDCPA-style conduct everywhere): call windows, no threats, no third-party disclosure, the wrong person answering; never "blame the system"; links the Delinquency Timeline policy page; counsel review flag |
| 14 | Difficult Situations | De-escalation steps; break-in report; damage (leak, pests, heat) without admitting fault; lockouts; access to another person's unit (default no); a family after a death; domestic disputes; suspected live-in (never approach alone); safety alone on site |
| 15 | Reviews and Reputation | Asking for reviews (no incentives, FTC 2024 rule), four reply templates, the "They sold my stuff" review |
| 16 | Practice: Twenty Scenarios | The 20 role-play prompts with what "great" looks like, as an exercise to do with a coworker; Spanish-speaking customers (language-access note, California Civil Code 1632 flagged for counsel) |

- **Checkpoints:** after lessons 7, 11 and 14 (10 each; the lesson 14 checkpoint is scenario-only).
- **Final quiz:** bank of 80, draw 40, pass 80%, 3 tries.
- **Short-answer questions:** a few `short` questions graded on keywords, for example "Write your opening line for a call" with keywords `Greens|property name` and `help`.

### 5.4 RV & Boat Storage Fundamentals (about 180 minutes)

- **Audience:** facility team.
- **What you'll learn:** why vehicle owners need us; how to tell RV classes and boat types apart and what they mean for fit; open, covered and enclosed spaces and their limits; how to measure a vehicle so it fits the first time; the paperwork every vehicle needs; the lot rules and the risks to watch; how vehicle liens differ; how to sell and keep vehicle tenants.

Lessons (14; source: research-rv-boat.md sections 1-11, research-cubby.md for Greens' mix):

| # | Lesson | Covers |
|---|---|---|
| 1 | Why Vehicle Storage Matters | Ownership numbers (8.1M RV households, 2025; about 11.8M boats, 2024; dated); HOA and city rules (Escondido, Murrieta examples, others via Site Profiles); customer profiles; seasonality; Greens' mix (759 of 2,042 active leases store a vehicle) |
| 2 | Know the Vehicles: RVs | Legal road limits (14 ft high, 102 in wide, 65 ft combined in California); Class A, B, C, fifth wheel, travel trailer, toy hauler, pop-up, with length and height table |
| 3 | Know the Vehicles: Boats and Everything Else | Bass, pontoon, ski and wake (towers), center console, sailboat (mast); why listed length leaves out the tongue, motor and swim platform; cars, work trailers, motorcycles, jet skis |
| 4 | Checkpoint: Vehicles | 8 questions |
| 5 | Our Spaces: Open, Covered and Enclosed | Comparison table; canopy posts and clearance; enclosed door limits (a "14 ft" door is about 13 ft 8 in); typical sizes 10x20 to 12x50; links Site Profiles for real clear heights |
| 6 | Measuring for the Right Fit | Overall length including tongue and ladders, height with AC and antennas, width with mirrors and awnings; the fit-check conversation; post the clear height at the door; steps block |
| 7 | Checkpoint: Fit | 8 questions, including `single` "which space fits" items with numbers |
| 8 | Paperwork and Move-In | ID, registration and insurance in the tenant's name, VIN or hull number matching on every document, lienholders, move-in photos, who may drive it out; links the Vehicle Storage Rules policy page |
| 9 | Lot Rules and Risks | No living or sleeping, no repairs, washing or fluid changes, propane, batteries, fuel, leaks, rodents, tires, abandoned vehicles; risk table |
| 10 | Walking the Lot | Site-walk checklist (checklist block), damage incidents and documentation (Nexus Forms with photos), weather (wind, heat; hail at Texas sites) |
| 11 | Vehicle and Boat Liens | California: B&P 21702.5 sends vehicles to Civil Code 3071 (DMV lien sale) and vessels to Harbors and Navigation Code 503; the 60-day charge limit; the tow alternative and its notice; Greens' "61st - Vehicle Lien Filing/Tow Notice" step; a Texas callout (Property Code 59.0445, towing option needs lease language); never-do list; counsel review flag |
| 12 | Selling Vehicle Storage | Discovery questions, RV and boat objections (price per foot, security, "the place down the road", "I'll park at home"), amenities that keep tenants |
| 13 | Waitlists and Upgrades | Covered and enclosed waitlists, moving a tenant from open to covered, keeping an unhappy vehicle tenant (they can leave in 15 minutes) |
| 14 | Words to Know | About 50-term glossary |

- **Final quiz:** bank of 60, draw 30, pass 80%, 3 tries.
- **Photo question (optional):** "Photograph a posted clear-height sign at your site." This also checks that sites post them.

### 5.5 Cubby Fundamentals (about 180 minutes)

- **Audience:** facility team, plus office staff who touch tenant accounts.
- **What you'll learn:** what Cubby does and where things live; how a lead becomes a reservation and a move-in; how a tenant ledger works (charges, payments, waives, credits, prepaid, paid-through date) with worked examples; taking payments and handling autopay failures; transfers and move-outs; the delinquency ladder Cubby runs for us; the reports to run at open and close.

This course mixes concept lessons (`text`, which last) with how-to lessons (`page`, the Cubby How-To pages, which change). Source: research-cubby.md sections 0-5.

| # | Lesson | Type | Covers |
|---|---|---|---|
| 1 | Meet Cubby | text | What Cubby is (cloud system, support through the CSM); product areas; Greens' five sites; first-of-month billing with jump day 26 |
| 2 | Finding Your Way Around | page | Home dashboard counts (tasks due, liens to initiate, overlocks needed), site map, lease page, tasks board |
| 3 | Leads and Reservations | page | Lead statuses and sources, reservation, follow-up tasks |
| 4 | The Move-In | page | The move-in (checkout) flow, coverage, documents, gate code, notes |
| 5 | Checkpoint: Getting a Tenant In | checkpoint | 8 questions |
| 6 | How a Ledger Works | text | Double entry in plain words; charge vs payment vs waive vs credit vs prepaid vs deposit vs write-off vs transfer; oldest charge paid first; paid-through date and days past due |
| 7 | Ledger Worked Examples | text | The eight worked examples (prorated move-in, jump-day move-in, anniversary billing for contrast, partial payment, prepayment, late fee and waiver, discount, aging buckets) as tables; proration formula marked "confirm against Cubby's Preview Charges" |
| 8 | Checkpoint: Read the Ledger | checkpoint | 10 numeric questions |
| 9 | Taking Payments and Autopay | page | Payment methods, autopay, failed autopay (the 2nd-of-month call), payment links, cash and check at the counter |
| 10 | Waives, Credits and Refunds | page | When each applies, the "Credits and Waives" permission, reasons; links the Waivers policy page |
| 11 | Transfers and Move-Outs | page | Unit-to-unit transfer, scheduling a move-out, balance at move-out, deposits |
| 12 | Delinquency in Cubby | page | The task ladder (2nd, 6th, 30th, 35th, 61st, 62nd), late fees, overlock and lockout, starting a lien, auction statuses, delinquency exemptions (bankruptcy, deceased, military, payment arrangement); ties back to Self-Storage lessons 10-11 |
| 13 | Gate Codes, Notes and Tasks | page | Gate code changes, pinned notes, completing tasks |
| 14 | Open and Close and Reports | page | The open and close routine; Rent Roll, Aged Receivables, General Ledger, Merchant Services Disbursements |

- **Final quiz:** bank of 60, draw 30, pass 80%, 3 tries.
- **Concept-heavy quiz:** about two-thirds ledger and delinquency concepts, one-third "which screen / which action." This keeps the quiz valid when buttons move.
- **The Cubby How-To pages ship as step lists with screenshot slots.** The course is usable from day one, and screenshots are added as staff capture them.

## 6. How Content Gets Into Nexus

**Recommendation: author the content as structured data in the repo. A one-time importer loads it into each environment as drafts.**

- **Content files:** `backend/kb_seed/academy/`. One JSON file per course (title, description, overview, est_minutes, recert_months, departments, delivery, lessons as Nexus block JSON, checkpoint questions, quiz bank). One file per Knowledge Base page (Greens Policies templates, Cubby How-To, Site Profiles). One file for the Training Plan.
  - Lessons are written with the same block shapes `kb_blocks.py` builds: heading, paragraph, lists, callout, table, steps, checklist.
  - Page lessons refer to a page by a stable seed key, which the importer resolves to the created page's id.
- **Importer:** `backend/kb_academy_seed.py`. Follows the `super_admins_seed.apply_once` pattern, with a `nexus_settings` mark such as `kb.academy_seed_2026_11`.
  - Called once at startup.
  - Creates the collection, pages and courses as **drafts** (status draft, `major` 0), the Training Plan **inactive**, and no assignment rules.
  - Never overwrites a row that exists: matched by title within the collection, so a manual edit is never lost. Writes one Audit Log row.
  - Goes through `routers/kb_training`'s own normalizers (`_norm_lessons`, `_norm_quiz`), so it cannot store a shape the UI would reject.
- **Result:** dev and prod get identical drafts. The training owners review in the course builder, fill in the Greens Policies pages, add screenshots, get counsel sign-off on the flagged lessons, then Publish and turn on the plan and its rule. Nothing reaches a learner until a person publishes it.
- **A validation test** (`test_kb_academy_seed.py`):
  - every course loads through the normalizers with no lesson dropped;
  - every quiz answer index is valid;
  - every page lesson resolves;
  - no text contains an em dash, an ISO date or a banned word;
  - est_minutes is 120 to 240;
  - running the importer twice changes nothing.
- **Why not author by hand in the UI:** about 75 lessons and 300+ questions typed into a browser, twice (dev and prod), with no review diff. The repo gives one reviewable source of truth and a PR Neil can read.
- **After import, the database is the live source.** Edits happen in Nexus, the repo files are not kept in sync, and the importer never runs again. Say this in the module docstring so nobody "fixes" a course by editing JSON.

No schema change, no new table, no new endpoint, no RLS work.

## 7. Ownership and Maintenance

| Item | Owner (proposed) | Review |
|---|---|---|
| Nexus Fundamentals | Neil (or a Nexus admin he names) | When a Nexus release changes a screen it teaches; What's New is the trigger |
| Self-Storage Fundamentals | Head of Operations | Annually each January, plus any law change |
| Customer Service & Sales | Head of Operations or a senior site manager | Annually |
| RV & Boat Storage | Senior site manager at a vehicle-heavy site | Annually |
| Cubby Fundamentals and Cubby How-To pages | The person who owns Cubby at Greens | When Cubby's release notes touch a covered task |
| Greens Policies pages | Neil or Operations (fees); HR (privacy) | When a policy changes; republish so people re-sign |
| Site Profiles | Each site manager | Annually or when the site changes |

Every course's last text lesson ends with "Something here is wrong or out of date? Send feedback," which uses the existing course feedback.

## 8. Left to the Builder

- Exact wording of every lesson, inside the outlines above and the house style.
- The question bank, at the sizes above, with an explanation on every legal, privacy or money question.
- Which facts get a callout vs a table vs a list.
- Where to put video placeholders (a `note` callout: "Video coming: ...").
- Splitting a lesson in two if it runs past 2,500 words.
- Matching each quiz question's `lessonId` so "Reread these" works.

Fixed:
- course names;
- lesson order and topics;
- the page-lesson split;
- the policies-in-one-place rule;
- legal content at training level, with the escalate callout;
- drafts only, no auto-publish;
- California first.

## 9. Neil's Answers (11/04/2026)

1. **Texas: yes.** Greens is taking over Texas sites soon. Every lesson that is state-specific teaches California AND Texas (Texas Property Code ch. 59 and its 2021 towing option, Texas vehicle and vessel paths, no Texas late-fee cap). The Greens Policies pages carry a California column and a Texas column; the Texas column is filled once the Texas sites are in Cubby. Site Profiles add the Texas sites when they come on.
2. **Review before Publish:** the Operations Manager, the Area Managers and/or a Super Administrator review every course, legal lessons included, together with a Claude review pass (a fact and law check against the research briefs and current statute text) before anything is published.
3. **Owners:** the Operations Manager and the Area Managers own the courses (the importer stamps the Operations Manager as owner; Area Managers are the collection's editors). The builder finds them in Nexus People by job title and asks Neil only if that is ambiguous.
4. **Who takes it:** everyone, by one fixed date, and every new hire (30 days from start).
5. **Name:** Greens Storage Academy.
6. **Fees and day counts come from Cubby.** The builder pulls the admin fee, late-fee rule, lien notice fees, vehicle lien fee, advertising, auction and lien-processing fees, and the day ladder (late fee day, overlock, preliminary lien notice, lien notice, vehicle tow notice, sale ad) from Greens' Cubby data with read-only aggregate queries, and fills the Greens Policies pages with them. Each number names its source ("from Cubby, 11/2026"). Still not in Cubby, and filled by the owners: protection plan exclusions, waiver limits.
7. **Still open, not blocking:** whether third-party-managed sites' staff take it; a Spanish version later.

The calls in "Builder check" below stand, except: owner = the Operations Manager (not Neil), and Texas content is IN.
## Builder check: calls made (Claude's, for Neil to check)

A reviewer read this design cold. Its questions, settled:

1. **Department.** The Academy collection, its pages and the five courses carry the **Operations** department (the department facility staff sit in on dev). Nexus Fundamentals also applies to every department, since every new hire uses Nexus.
2. **Owner.** The importer stamps **Neil** as owner of every imported row. Owners are reassigned in the UI once Neil names them (Open Question 5).
3. **Greens Policies pages.** They are imported as **drafts** and are not in the Training Plan. A policy goes into the plan only after it has been filled in with real numbers and published, so nobody signs an empty template.
4. **Prod.** The importer runs on every environment, prod included. Draft pages and courses are visible only to their author, reviewer, collection owner and Manage (`kb_access`), so nothing reaches staff until someone presses Publish after the counsel review. The plan and its assignment rules are imported **inactive**.
5. **Ledger questions.** These are `single` choice with numeric answers ("$45.00" against three near misses), never `short`, so "$45" and "45.00" can't grade differently.
6. **Photo questions.** None in any drawn quiz bank. Anything hands-on goes into the in-person Hands-On Check, where the trainer signs it off. No quiz can get stuck waiting for a reviewer.
7. **Texas.** Superseded: Texas is in (Neil's answer 1).
