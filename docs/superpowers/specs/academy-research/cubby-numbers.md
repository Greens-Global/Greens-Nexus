# Greens Numbers From Cubby (for the Greens Policies pages)

Pulled 11/04/2026 (Cubby tables "as of" 11/05/2026 5 AM UTC) through the Cubby reporting MCP, org "Greens Storage", READ-ONLY aggregate queries only. No tenant name, email, phone, address, unit-to-tenant link or payment detail was selected or recorded. Only category names, counts, amounts, percentiles and day offsets.

Cite on pages as: "From Greens' Cubby, 11/2026".

## Data window - read this first

Greens went live on Cubby in 09/2026: the first lease made in Cubby (not imported) started 09/14/2026, and every fee row seen is dated 09/15/2026 to 11/04/2026. So each number below is from about seven weeks of activity, and the monthly ones (late fee, overlock, lien steps) from one or two monthly cycles. Re-run the queries after a few more cycles before the course leaves draft.

## Facilities and billing

Query: `SELECT facility_name, lease_anniversary, jump_day, time_zone FROM facilities`.

| Facility | Billing | Jump day | Time zone |
|---|---|---|---|
| Escondido, Fairfield, Murrieta, Temecula, Valley Center | FIRST_OF_MONTH | 26 | America/Los_Angeles |

No Texas facility is in the Cubby org.

## Inventory by unit kind (active units)

Query: `units` where `is_active = 1`, grouped by facility and kind (MAILBOX = pricing group name contains "mail", else `unit_type`), count, leased, street rate (`rate_managed`) min / median / max.

| Facility | Kind | Units | Leased | Street rate min / median / max |
|---|---|---|---|---|
| Escondido | Mailbox | 77 | 28 | $5.00 / $5.00 / $7.00 |
| Escondido | Enclosed storage | 717 | 697 | $0.00 / $164.00 / $8,375.00 |
| Escondido | Parking | 90 | 80 | $159.00 / $279.00 / $379.00 |
| Fairfield | Enclosed storage | 4 | 1 | $119.00 / $119.00 / $169.00 |
| Fairfield | Parking | 303 | 211 | $94.00 / $104.00 / $154.00 |
| Murrieta | Enclosed storage | 8 | 6 | $39.50 / $39.50 / $1,900.00 |
| Murrieta | Parking | 161 | 150 | $134.00 / $184.00 / $300.00 |
| Temecula | Enclosed storage | 34 | 25 | $124.00 / $199.00 / $289.00 |
| Temecula | Parking | 481 | 333 | $69.00 / $164.00 / $319.00 |
| Valley Center | Mailbox | 279 | 43 | $5.00 / $5.00 / $11.75 |
| Valley Center | Enclosed storage | 568 | 465 | $0.01 / $129.00 / $799.00 |
| Valley Center | Parking | 3 | 3 | $149.00 / $289.00 / $289.00 |

## Named fees (one-time FEES charges)

Query: `book_entries`, `book = 'ACCOUNT_RECEIVABLE'`, `ar_entry_category = 'FEES'`, `type = 'DEBIT'`, last 365 days, grouped by facility, `explanation_text`, amount, count. (Free-text one-off corrections such as "Ledger Correction" and electricity rebills are left out of the pages.)

| Fee (as Cubby names it) | Amount | Where seen (count) |
|---|---|---|
| Administration Fee | $25.00 | all five sites (Escondido 53, Fairfield 10, Murrieta 7, Temecula 24, Valley Center 28) |
| Mailbox Administration Fee | $10.00 | Valley Center (2) |
| CA Preliminary Lien Notice | $25.00 | all five (130 total) |
| CA Lien Notice | $35.00 | all five (29 total) |
| Vehicle Lien Fee | $350.00 | Escondido 1, Fairfield 1, Murrieta 2, Temecula 2 |
| Advertising Fee | $120.00 (24 + 1), $95.00 (2) | Escondido, Valley Center |
| Auction Fee | $95.00 | Escondido 25, Valley Center 1 |
| Lien Processing Fee | $100.00 | all five (17 total) |
| Lock Removal/Inventory Fee | $75.00 | Escondido 27, Valley Center 2 |
| Background Check Fee | $35.00 | Escondido (3) |
| Mailbox Key | $20.00 | Escondido (1) |
| Non-Operational Vehicle Deposit | $350.00 | Murrieta (1) |
| Collection Fee - Unauthorized Use of Space | $83.00 | Temecula (1) |
| Commercial Water Fee (recurring) | $45.00 | Murrieta (6) |
| Business Class Package Fee (recurring, mailbox) | $15.00 (prorated amounts also seen) | Escondido, Valley Center, Fairfield |
| First Class Package Fee (recurring, mailbox) | $25.00 (prorated amounts also seen) | Escondido, Fairfield |

Admin fee coverage of new move-ins (leases not imported, started in the last 365 days): Escondido enclosed 43 of 50, Escondido parking 7 of 7, Fairfield parking 10 of 12, Murrieta parking 7 of 13, Temecula parking 18 of 25, Temecula enclosed 1 of 1, Valley Center enclosed 24 of 30, Valley Center mailbox 0 of 2 (both paid the $10 Mailbox Administration Fee instead).

No reservation fee, no failed payment / NSF fee and no cut-lock fee other than "Lock Removal/Inventory Fee" posted in the window. `payments` shows 3 `FAILURE` rows in 180 days and no matching fee.

## Late fees

Queries: (1) the same `book_entries` FEES rows with `explanation_text ILIKE '%late fee%'`, joined to `leases` (current rent) and `units` (kind), grouped by kind and rent band, with min / median / max fee and posting day; (2) a check of each "CA Late Fee" against the California cap computed on the lease's current rent ($10 if rent $60 or less; $15 if over $60 and under $100; the greater of $20 or 15% of rent if $100 or more); (3) `cubby_events` `LATE_FEE_CHARGED` by local `created_at` day and hour.

| Fee name | Unit kind | Rent band | Count | Fee min / median / max |
|---|---|---|---|---|
| CA Late Fee | Enclosed | under $100 | 17 | $10.00 / $15.00 / $15.00 |
| CA Late Fee | Enclosed | $100-$149 | 29 | $15.00 / $20.00 / $22.42 |
| CA Late Fee | Enclosed | $150-$199 | 27 | $22.57 / $26.92 / $29.92 |
| CA Late Fee | Enclosed | $200-$299 | 12 | $31.42 / $34.42 / $44.92 |
| CA Late Fee | Enclosed | $300 and up | 27 | $46.42 / $57.67 / $330.00 |
| CA Late Fee | Parking | under $100 | 4 | $15.00 |
| CA Late Fee | Parking | $100-$149 | 14 | $20.00 / $20.00 / $20.17 |
| CA Late Fee | Parking | $150-$199 | 9 | $24.67 / $27.67 / $29.17 |
| CA Late Fee | Parking | $200-$299 | 8 | $34.42 / $39.52 / $44.47 |
| CA Late Fee | Parking | $300 and up | 2 | $46.95 / $47.77 |
| Mailbox Late Fee | Mailbox | under $100 | 7 | $2.50 |
| Commercial Late Fee | Enclosed (commercial) | $300 and up | 1 | $220.00 (10% of rent) |

Cap check: 149 CA Late Fees; 148 equal the California maximum for the lease's current rent (within one cent), 0 are above it, 1 is below it. In plain words: Greens' CA Late Fee is set at the statutory maximum - $10 (rent $60 or less), $15 (over $60, under $100), the greater of $20 or 15% of monthly rent ($100 or more). Rent bands use today's rent, so a lease whose rent changed since its fee can land in a neighboring band.

Timing: `LATE_FEE_CHARGED` events: 155 of 155 at 12:00 AM local on the 11th. Rent is due on the 1st, so the fee posts after 10 full days unpaid. One fee row was dated the 29th (a manual or move-in case).

## Gate lockout

Query: `cubby_events` `ACCESS_CODE_CHANGED` with no manager (system made), by local day and hour, last 180 days; matched by contact and day to `LATE_FEE_CHARGED`.

109 system-made gate code changes, all at 12:00 AM on the 11th, at all five sites; 108 of 109 belong to a tenant whose late fee posted the same night. Reading: Cubby changes the delinquent tenant's gate code (likely a lockout) when the late fee posts, on the 11th. The event payload was not opened (it may hold codes), so "suspend" is inferred from the timing.

## Overlock

Query: `cubby_events` `OVERLOCK_NEEDED` / `OVERLOCK_APPLIED` by local day, last 365 days.

| Event | Main day (local) | Count |
|---|---|---|
| OVERLOCK_NEEDED | 20th, 12:00 AM | 83 of 90 (5 on the 11th, 2 other) |
| OVERLOCK_APPLIED | 21st (25), 20th (8), later days (6) | 39 |

So the overlock task fires on the 20th (19 days after the due date) and staff mostly apply it the next day.

## Collections task ladder (workflow tasks)

Query: `tasks` where `is_workflow_generated`, last 365 days, title, count, `due_date` day.

| Task title | Count | Due date (day of month) |
|---|---|---|
| 2nd - Call Failed Autopay Tenants | 2,152 | 1st |
| 2nd - Call Failed Autopay Mailbox Customer | 39 | 1st |
| 2nd - Call Failed Autopay Waste Dump User | 3 | 1st |
| 6th - Call Past Due Tenants | 428 | 5th |
| 6th - Call Past Due Mailbox Customer | 10 | 5th |
| 30th - Final Collection Call | 12 | 30th |
| 35th - CA Lien Notice | 11 | 3rd of the next month |
| 35th - Call Past Due Mailbox Customer | 1 | 4th of the next month |
| 61st - Vehicle Lien Filing/Tow Notice | 4 | 31st (second month) |
| 62nd - Publish 2nd Lien Sale Ad | 7 | 1st (third month) |
| Remind Tenant of POI Obligation | 61 | any day |
| Enroll Tenant in Protection Plan | 50 | any day |

The number in a task's title is its day in the delinquency count; the stored due date sits a day earlier (Cubby stores the date in UTC, created around 5 PM Pacific the evening before).

## Lien fee timing

Query: FEES rows by day and hour of `entry_date_time`, plus `cubby_events` `LEASE_LIEN_STATUS_CHANGED` by local day.

| Charge | When it posts |
|---|---|
| CA Preliminary Lien Notice $25 | the 15th (130 rows; 14 days unpaid) |
| LEASE_LIEN_STATUS_CHANGED | mostly the 15th at about 12 PM (42 of 55) |
| CA Lien Notice $35 | the 4th or 5th of the next month (about day 35) |
| Vehicle Lien Fee $350, Lien Processing Fee $100 | the 15th (one batch, 10/15/2026) |
| Advertising Fee, Auction Fee, Lock Removal/Inventory Fee | posted together, the 15th (21) or the 7th (3) |

Lease auctions (`lease_auctions`): Escondido 23 cancelled, 1 settled unsold, 1 waiting for auction; Murrieta 1 and Temecula 3 delivering lien.

## Tenant protection (coverage)

Query: `leases` where active, grouped by facility, `coverage_type`, `ins_coverage_level`, `ins_premium`, with a count of `storing_vehicle`.

| Facility | Plan $2,500 at $9 | $2,500 at $14 | $5,000 at $20 | $5,000 at $25 | Plan, no level or premium set | Own policy (PRIVATE_POLICY) | None |
|---|---|---|---|---|---|---|---|
| Escondido | 291 | 261 | 8 | 13 | 0 | 232 (79 vehicles) | 0 |
| Fairfield | 0 | 0 | 0 | 0 | 0 | 212 (207 vehicles) | 0 |
| Murrieta | 0 | 0 | 0 | 1 | 0 | 154 (149 vehicles) | 1 |
| Temecula | 15 | 4 | 0 | 0 | 0 | 339 (320 vehicles) | 0 |
| Valley Center | 213 | 148 | 6 | 0 | 1 | 141 (3 vehicles) | 2 |

Plan leases total 961 (Valley Center 368, including one ORGANISATION lease with no level or premium set, from the same query). INSURANCE charges in the last 120 days: $9.00 (1,048), $14.00 (803), $25.00 (29), $20.00 (28), plus prorated amounts. Plan names are not stored in the reporting data (only level and premium). Only one vehicle lease is on a Greens plan; vehicle tenants carry their own policy.

## Deposits

Query: DEPOSIT / OLD_SYSTEM_DEPOSIT debits by month, imported or not. All 176 deposit rows are dated 09/2026 and all belong to imported Fairfield leases (parking $70-$165, median $95). No new Cubby move-in has been charged a deposit. One "Non-Operational Vehicle Deposit" of $350 was charged as a fee at Murrieta.

## Waivers, credits, discounts, refunds (last 365 days)

Query: AR rows in WAIVED_*, DISCOUNTS, BAD_DEBT, credits categories, count and total; `payments` REFUND / FAILURE / DECLINED rows, last 180 days, by channel.

| Item | Count | Total | Median |
|---|---|---|---|
| WAIVED_FEES | 185 | $12,904.41 | $47.17 |
| WAIVED_RENT | 42 | $3,307.76 | $32.27 |
| DISCOUNTS (discount entries) | 712 | $16,660.34 | $9.98 |
| BAD_DEBT write-offs | 6 | $3,264.51 | $373.50 |
| Card refunds (payments) | 32 | - | - |
| Declined attempts (payments) | 402 (285 autopay) | - | - |

No CREDITS / GIVEN_CREDITS rows: the goodwill credit feature is not in use. The `discount_programs` table returned no active rows. Which fees the waivers cancelled could not be matched from the reporting data (the link column did not join).

## Gate access hours

Query: `access_log`, last 90 days, by facility, result, reason. Only Fairfield's gate reports to Cubby: 816 allowed, 56 master code, 138 unknown code, 10 "outside of hours" refusals (from 09/26/2026). Allowed entries span every hour of the day in the stored timestamps, so the access hours cannot be read from Cubby. Office and gate hours are owner-filled.

## For the owners to confirm

1. **Late fee at the legal maximum.** Greens' CA Late Fee equals the Bus. & Prof. Code 21713.5 maximum for every rent band. That is lawful only if the rental agreement states it and it posts no earlier than 10 days after the due date (it posts on the 11th). Confirm the agreement wording matches.
2. **Mailbox Late Fee $2.50 and Commercial Late Fee (10%).** Confirm whether mailboxes and commercial leases are under the Self-Service Storage Facility Act and that these are in their agreements.
3. **Gate lockout on the 11th.** Cubby changes the delinquent tenant's gate code at 12:00 AM on the 11th. The research brief notes California ties denial of access to the lien attaching (21705(a), after the preliminary lien notice period). Counsel should confirm that locking the gate on day 11 (before the 15th preliminary notice) is allowed by Greens' agreement, or move the lockout.
4. **Overlock on the 20th.** Same question as 3 for the physical overlock (5 days after the preliminary lien notice on the 15th, before the lien attaches).
5. **Vehicle Lien Fee $350 and Lien Processing Fee $100** posted on 10/15/2026 as a batch. Confirm when each is meant to post and that the amounts are in the agreement.
6. **Advertising Fee $95 vs $120.** Two amounts seen at Escondido; confirm the current one.
7. **Admin fee not on every move-in** (for example Murrieta parking 7 of 13). Confirm whether some move-ins are meant to skip it or it was waived.
8. **Deposits:** only imported Fairfield parking leases carry one. Confirm new move-ins take no deposit.
9. **Waiver limits** (who may waive what, up to how much): not in Cubby. Owners to fill.
10. **Protection plan exclusions and plan names** ($9 vs $14 for the same $2,500 level, $20 vs $25 for $5,000): not in Cubby. Owners to fill and explain the two prices.
11. **Office and gate hours per site**: not in Cubby. Owners to fill.
12. **Texas**: no Texas site is in Cubby yet. Every Texas value waits for them to join.

## Site Profiles: parking and unit mix (pulled 11/04/2026, Task 7)

Cubby tables "as of" 11/05/2026 about 6:50 AM UTC. READ-ONLY aggregates over `units` (inventory) and `leases` (counts only). No tenant name, contact, plate, unit-to-tenant link or payment was selected. Cite as "From Greens' Cubby, 11/2026".

**Q1 parking by size:** `SELECT facility_name, unit_type, unit_width, unit_depth, count(*), sum(is_leased) FROM units WHERE is_active = 1 AND unit_type = 'RENT_PARKING_SPACE' GROUP BY 1,2,3,4`.

**Q2 parking by cover, surface, pull-through:** same rows, classified from `unit_features::text`: "Fully enclosed coverage" = Enclosed, "Overhang - partial coverage" = Covered, else Open; "Unpaved parking" = Gravel, else Paved; "Pull-Through" flag; count, leased, depth min / max, street rate (`rate_managed`) min / median (percentile_disc) / max.

| Facility | Cover | Surface | Pull-through | Spaces | Leased | Depth | Street rate min / median / max |
|---|---|---|---|---|---|---|---|
| Escondido | Open | Gravel | no | 80 | 70 | 15-50 ft | $159 / $279 / $379 |
| Escondido | Open | Paved | no | 10 | 10 | 20-45 ft | $169 / $239 / $349 |
| Fairfield | Open | Gravel | no | 303 | 211 | 20-48 ft | $94 / $104 / $154 |
| Murrieta | Open | Paved | no | 125 | 115 | 19-45 ft | $134 / $184 / $300 |
| Murrieta | Open | Paved | yes | 36 | 35 | 33-50 ft | $249 / $249 / $279 |
| Temecula | Covered | Gravel | no | 27 | 22 | 20-50 ft | $124 / $229 / $319 |
| Temecula | Open | Gravel | no | 280 | 181 | 15-45 ft | $69 / $164 / $289 |
| Temecula | Open | Gravel | yes | 1 | 1 | 30 ft | $194 |
| Temecula | Open | Paved | no | 146 | 114 | 15-45 ft | $74 / $124 / $214 |
| Temecula | Open | Paved | yes | 27 | 15 | 30-40 ft | $189 / $189 / $219 |
| Valley Center | Enclosed (roll-up door) | Paved | no | 2 | 2 | 38 ft | $289 |
| Valley Center | Open | Gravel | no | 1 | 1 | 35 ft | $149 |

Totals: 1,038 parking spaces; 27 covered (all Temecula), 2 enclosed vehicle spaces (Valley Center), 64 pull-through (Murrieta 36, Temecula 28). No unit has a height recorded (`unit_height` empty on every active unit), so clear heights are owner-filled.

**Q1 results, parking sizes (width x depth: spaces, leased):**
- Escondido: 10x20 1 (1), 10x25 2 (2), 10x30 1 (1), 10x35 1 (1), 12x15 1 (1), 12x16 2 (2), 12x17 1 (1), 12x20 5 (4), 12x22 1 (1), 12x25 11 (11), 12x27 2 (2), 12x28 2 (2), 12x30 3 (3), 12x32 2 (2), 12x35 11 (11), 12x38 25 (18), 12x40 9 (7), 12x42 2 (2), 12x45 3 (3), 12x50 2 (2), 13x30 1 (1), 13x35 2 (2).
- Fairfield: 12x20 11 (0), 12x22 6 (6), 12x26 142 (94), 12x32 114 (91), 12x48 30 (20).
- Murrieta: 10x20 16 (16), 10x24 42 (39), 10x30 33 (31), 10x35 2 (2), 12x19 1 (1), 12x30 24 (19), 12x33 20 (20; 18 of them pull-through), 12x45 2 (2), 12x50 18 (17; all pull-through), 13x36 1 (1), 14x45 2 (2).
- Temecula: 10x15 1 (1), 10x18 6 (5), 10x20 74 (55; 3 covered), 10x25 14 (12), 10x30 34 (21; 17 pull-through), 10x35 1 (1), 10x40 3 (3), 11x15 4 (2), 11x18 5 (5), 11x20 15 (11), 11x25 16 (15), 11x28 4 (4), 11x30 69 (65; 6 covered, 1 pull-through), 11x35 84 (50; 1 pull-through), 11x40 109 (49; 9 pull-through), 11x45 23 (16), 12x35 6 (5, covered), 12x40 4 (4, covered), 12x50 8 (8, covered), 26x34 1 (1).
- Valley Center: 11x35 1 (1), 12x38 2 (2, enclosed).

**Q1b parking by pricing group with features** (`SELECT facility_name, pricing_group, unit_features::text, count(*), sum(is_leased) FROM units WHERE is_active = 1 AND unit_type = 'RENT_PARKING_SPACE' GROUP BY 1,2,3`):
- Temecula covered ("Overhang - partial coverage") by size, spaces (leased): 10x20 3 (1), 11x30 6 (4), 12x35 6 (5), 12x40 4 (4), 12x50 8 (8).
- "Security camera" appears in the features of every Fairfield parking pricing group (all 303 spaces) and of no other site's parking.
- Surface comes from "Paved parking" / "Unpaved parking"; Greens' pricing group names say "Asphalt" or "Gravel". The course says "paved" and "gravel".

**Q3 parking by depth band:** spaces (leased): Escondido under 30 ft 28 (27), 30-39 ft 46 (39), 40 ft and up 16 (14); Fairfield 159 (100), 114 (91), 30 (20); Murrieta 59 (56), 80 (73), 22 (21); Temecula 139 (110), 195 (143), 147 (80); Valley Center 30-39 ft 3 (3).

**Q4 enclosed storage by size:** `units` active, `unit_type = 'RENT_ENCLOSED_STORAGE'`, pricing group not a mailbox, grouped by width x depth.
- Escondido (717): 10x10 202, 5x10 122, 10x15 120, 10x20 100, 5x5 87, 10x25 48, 15x40 19, 15x44 6, 15x45 5, 2 with no size recorded, one each 5x15, 10x11, 10x35, 10x8, 12x20, 60x45.
- Fairfield (4): 8x10 2 (0 leased), 8x20 2 (1 leased).
- Murrieta (8): 6 with no size recorded, 12x25 1, 25x25 1.
- Temecula (34): 8x20 12, 8x16 8, 8x40 6, 8x12 3, 8x10 3, 8x30 1, 8x45 1.
- Valley Center (568): 10x10 203, 5x10 91, 10x20 67, 8x10 49, 10x15 39, 12x35 30, 9x10 28, 12x25 26, 10x12 7, 5x5 7, 12x50 6, 4x10 3, 13x10 2, and 10 single units of other sizes.

**Q5 enclosed features** (`unit_features::text`): tagged "Climate controlled" / "Drive-up": Escondido 549 / 164; Fairfield 0 / 4; Murrieta 1 / 1; Temecula 0 / 34; Valley Center 0 / 207. No enclosed storage unit carries an RV or boat parking tag.

**Q6 vehicle leases by Cubby vehicle type:** `leases` active and `storing_vehicle`, grouped by facility and `vehicle_type` (count only), plus a count of rows whose `vehicle_state` is set and not CA.

| Facility | Vehicle leases | Type not set | Types set | Plate state other than CA |
|---|---|---|---|---|
| Escondido | 79 | 74 | 3 trailer, 2 truck | 10 |
| Fairfield | 207 | 203 | 2 trailer, 1 RV, 1 boat | 15 |
| Murrieta | 149 | 105 | 26 trailer, 14 RV, 3 other, 1 sedan | 8 |
| Temecula | 320 | 310 | 5 trailer, 1 RV, 1 SUV, 1 truck, 1 boat, 1 other | 27 |
| Valley Center | 4 | 4 | none | 0 |
| **Total** | **759** | **696** | 63 | 60 |

Reading: Cubby's vehicle type is blank on 696 of 759 vehicle leases, so the mix of RVs, boats and trailers cannot be read from Cubby yet; the course teaches staff to fill it at move-in.

## Re-check 11/05/2026

Re-ran the queries above on 11/05/2026 (Cubby tables "as of" 11/05/2026 about 7:40 to 8:00 AM UTC), READ-ONLY aggregates only, same rules: no tenant name, contact, plate, unit-to-tenant link or payment detail selected. Note that no new monthly cycle has run since the first pull (the next late-fee night is 11/11/2026), so the monthly numbers could not move yet; re-run after the 11/11 and 11/20 events at the least.

Unchanged: facilities and billing; inventory by unit kind (every count, leased count and street rate); named fee counts and amounts (Administration Fee 122, CA Preliminary Lien Notice 130, CA Lien Notice 29, Lock Removal/Inventory Fee 29, Auction Fee 26, Advertising Fee 25 + 2, Lien Processing Fee 17, Vehicle Lien Fee 6); late fees (149 CA, 7 Mailbox, 1 Commercial, last posted 10/11/2026 and 10/21/2026); LATE_FEE_CHARGED 155, OVERLOCK_NEEDED 90, OVERLOCK_APPLIED 39, LEASE_LIEN_STATUS_CHANGED 55, same days; workflow task counts (every title the same); coverage by facility, level and premium (961 plan, 1,078 own policy, 3 none); deposits (176, all dated 09/14/2026); WAIVED_FEES 185 / $12,904.41 / median $47.17; WAIVED_RENT 42 / $3,307.76 / median $32.27; BAD_DEBT 6 / $3,264.51 / median $373.50; payments (32 refunds, 402 declined with 285 autopay, 3 failure records); access log (Fairfield only: 816 / 56 / 138 / 10); parking totals (1,038 spaces, 27 covered, 64 pull-through, 2 enclosed, no heights); vehicle leases (759, type blank on 696, 60 out of state).

Changed:

| Number | 11/04/2026 | 11/05/2026 | Used on a page? |
|---|---|---|---|
| DISCOUNTS entries, last 365 days | 712, $16,660.34 | 717, $16,763.84 (median $9.98 unchanged) | No |

New findings (not changes, read for the owner-filled items):

- **Protection plan price by lease age.** `leases` active, `coverage_type = 'ORGANISATION'`, grouped by level, premium and `is_imported`: leases made in Cubby since 09/14/2026 pay $14.00 (58) or $25.00 (2), with one at $9.00; the $9.00 (518) and $20.00 (14) prices are on imported leases only. greensstorage.com's FAQ offers the Protection Plan at $14 or $25 a month. So $14.00 / $25.00 is today's price and $9.00 / $20.00 are older leases' prices. Pages updated: Greens Tenant Protection, the Tenant Protection and Insurance lesson, Move-In Done Right, and one quiz explanation.
- **Murrieta dump station.** `units` active at Murrieta by `pricing_group`: the six enclosed units with no size are the pricing group "0' x 0' Dump Station Agreement" ($39.50 street rate, 4 leased), the Murrieta enclosed minimum of $39.50 above. FEES rows also show one "Waste Dump Admin Fee" of $10.00 at Murrieta, and the "2nd - Call Failed Autopay Waste Dump User" task matches. Page updated: Site Profile: Murrieta.
- **Murrieta electricity.** Three monthly "Electricity Usage" FEES rows (July, August, September) on Murrieta, about $80 to $118 each: at least one space is metered and rebilled. Page updated: Site Profile: Murrieta (power).
- Plan names are still not in the reporting data: INSURANCE rows carry no explanation text, only the amount.

Public sources read the same day for the owner-filled items (cited on the pages as "From greensstorage.com, 11/2026"): the five facility pages (/facility/greens-storage-<site>), /rules-regulations, /vehicle-storage-faqs, /faq and /privacy-policy on greensstorage.com. They give office hours (Monday to Saturday 8:30 AM to 5:30 PM, Murrieta Saturday to 4:00 PM, closed Sunday), gate hours (every day 6:00 AM to 10:00 PM, with a conflicting 7:00 PM in three sites' feature lists), addresses and phones, Escondido's air, propane, water fill, vacuum and EV charging, Valley Center's enclosed RV units with 12 ft and 14 ft doors and an air and water station, and the vehicle house rules. No public source names the protection plan's provider, so its exclusions stay Pending.
