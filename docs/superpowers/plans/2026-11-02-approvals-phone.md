# Approvals on the Phone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Approvals on a phone become a simple, actionable triage: one card per request, two big decision buttons, tap-tap-tap down the list with motion as each card goes, Undo kept, filtering and grouping kept behind one Filter sheet and a chip strip.

**Architecture:** `ApprovalsCenter.jsx` keeps every data path (load, `decide`, pending/Undo, `runsInline`, `APPROVAL_ACTIONS`, grouping, filters, History). Under 760px it renders a new `ApprovalsPhone` surface instead of the desktop rail + tools + rows. Nothing about which actions exist or what they call changes.

**Tech Stack:** React 19, `lib/motion.js` (`useExit`, `useFlip`, tokens), `components/StatusLabel.jsx`, the tasks `Modal` (phone full sheet), vitest.

**Spec:** Neil, 11/02/2026: "I don't like approvals on mobile it's too cluttered. It should be simple and actionable with all approvals as kind of a tap tap tap and move on. Add some motion animations when an action occurs and still allow the filtering and grouping but come up with a better UI and UX than the mess you have right now on mobile."

## Global Constraints

- No new approval paths: every button calls what `approvalActions.js` already calls; the Undo window (`UNDO_MS`) and `decide()` are reused as they are; nothing bulk-approves on a phone.
- Motion rules (CLAUDE.md): transform and opacity only, `--dur-*` / `--ease-out` tokens, exits about 70% of enters, reduced motion = instant, nothing loops.
- Soft `StatusLabel` tones; Title Case labels; sentence-case hints; no em dashes; MM/DD/YYYY; 16px inputs and 44px tap targets on phones; the Filter sheet is the phone full sheet (tasks `Modal`).
- Desktop (above 760px) is untouched.

## Review Focus

1. A card acted on must leave the list within the Undo window and come BACK in place (same position) when Undo is tapped - test.
2. A row whose action needs a note (reject / decline / send back on reimbursements, HR letters) opens the note sheet first and never fires without the note - test.
3. Grouping by person / type / department keeps section headers sticky and the kind chip counts equal the sum of the cards shown - test.
4. With reduced motion the card disappears instantly and nothing animates - test.
5. A row that cannot run inline (only "open") shows Review and Open, never a disabled Approve - test.

---

### Task 1: `ApprovalsPhone`

**Files:**
- Create: `frontend/src/approvals/ApprovalsPhone.jsx` (default export `ApprovalsPhone({ rows, ownRows, groupLabels, counts, kind, setKind, filters, setFilters, groupBy, setGroupBy, sortKey, setSortKey, onAct, onReview, hiddenKeys, toast, onUndo, loading, error, onRetry, empty })` - every prop comes from `ApprovalsCenter`'s existing state; no fetching inside), `frontend/src/approvals/ApprovalCard.jsx`, `frontend/src/approvals/FilterSheet.jsx`, `frontend/src/approvals/NoteSheet.jsx`, `frontend/src/approvals/approvalsPhone.css` (or the `.apv-ph-*` block in style.css)
- Modify: `frontend/src/approvals/ApprovalsCenter.jsx` (`phone` branch renders `<ApprovalsPhone .../>` in place of `list` + the tools; the `decide` / `commit` / `undo` / `say` machinery is passed down; `hidden` keys drive the exit animation), `frontend/src/style.css` (remove the 760px `.apv-row` / `.apv-tools` overrides that the new surface replaces, keep `.apv-facts` / `.apv-foot` for the Detail sheet)
- Test: `frontend/src/approvals/ApprovalsPhone.test.jsx`, `ApprovalCard.test.jsx`, `FilterSheet.test.jsx`

**The surface, top to bottom (375px):**
- Header row: "Approvals" and a count pill "12 Waiting" that bumps (scale 1 -> 1.08 -> 1, `--dur-sm`) when the number changes; a Waiting / History segmented control as today.
- Chip strip (`.scroll-tabs`, horizontal, no wrap): All 12 · Time Off 5 · Money 3 · Time 2 · ... built from `groupLabels` with counts; the active chip is brand-tinted. On the right end a "Filter" chip with a dot when any filter besides kind is active; tapping opens `FilterSheet`.
- `FilterSheet` (phone full sheet): Search (16px), Sort (Oldest / Newest / Priority / Person), Group By (None / Person / Type / Department), Priority (All / Urgent / High), Waiting (Any / 3+ days / 7+ days), Department and Company lists when the person sees more than one, "Clear Filters", Done. Saves on change (these are the same `useTableValue` keys as the desktop).
- Sections: when grouping, a sticky section label "Ana Diaz · 3" / "Time Off · 5" (12.5px, uppercase letter-spaced, surface-2 background) with the oldest-waiting chip as today.
- `ApprovalCard`: a rounded card (12px radius, card background, hairline border):
  - Row 1: `PersonMark` 36px, name (15px, 700), under it the title (13.5px) in one line, right-aligned the waited text ("3d", amber at 3+, red at 7+) and the `PrioritySignal`.
  - Row 2 (when present): detail one line (ellipsis) with `ForChip` and the `RecommendationChip`.
  - Row 3: the decision row - the row's inline actions as two big buttons, 48px tall, equal width: the positive one (Approve / Accept / Yes) green soft (`color-mix(in srgb, #16a34a 14%, var(--card))`, green text, check icon) and the negative one (Reject / Decline / Deny / No) red soft; a third inline action (Send Back, Changes) goes into the "..." sheet; a small round "..." button (44px) on the right opens Review (the existing `Detail` in the phone sheet, with every action and Open). A row with no inline action shows "Review" wide and "Open" (its module).
  - Tap a decision: the card flashes the action color at 12% for `--dur-xs`, then slides right 24px and fades (`--dur-md`, `--ease-out`) while its height collapses (grid-rows 1fr -> 0fr), the cards below move up (`useFlip` on the list), the count pill bumps down, and the existing Undo toast shows "Approved - Ana Diaz, Time Off" with Undo. Undo puts the card back where it was (the key's original index) with a fade in. A negative action that needs a note (`APPROVAL_ACTIONS` signature takes `note` and the backend requires it: reimbursement send_back / reject, hr_letter decline, salary_advance decline, shift_request decline, probation decline, time_off reject keeps the note optional) opens `NoteSheet` (a short phone sheet: one 16px textarea, "Why?" hint, the action button) first.
  - Swipe (touch only, optional extra): drag the card right past 40% of its width to fire the positive action, left for the negative one; the colored backdrop and a check / x glyph grow under the card as it moves; under 40% it springs back. Reduced motion: no swipe, buttons only.
- "Yours To Do" section: the same cards, label "Yours To Do · 2".
- Empty: a large soft green check that pops once (`--ease-spring`, `--dur-md`) with "All caught up" and "Nothing waiting on you." (filters: "No approvals match your filters" + Clear Filters).
- Loading: three skeleton cards; error: `AsyncSection`'s retry.

- [ ] **Step 1: Failing tests** for Review Focus 1-5 plus: chip counts, Filter dot, sticky headers, History tab still reachable, keyboard shortcuts panel hidden on phone.
- [ ] **Step 2-5:** implement, `npx vitest run src/approvals`, lint, build, commit `feat(approvals): phone triage - one card per request, two big decisions, motion on action, filters behind one sheet (Neil, 11/02/2026)`.

### Task 2: Docs
- [ ] CLAUDE.md one line under the Approvals rule: "On a phone Approvals is `approvals/ApprovalsPhone.jsx`: one card, two decisions, the Filter sheet; the desktop list is unchanged; no bulk approve on a phone (Neil, 11/02/2026)."
