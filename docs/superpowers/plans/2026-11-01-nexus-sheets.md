# Nexus Sheets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every desktop popup that is a record, a form or a workspace becomes a sheet that slides in from the right edge; questions stay centered; phones are untouched.

**Architecture:** One CSS block (style.css, after the motion vocabulary) carries the sheet keyframes and geometry. The two inline-styled shells (`tasks/components.jsx` Modal, `marketing/shared/Modal.jsx`) gain a `placement` prop and render `.nx-sheet-right`; the class-styled shells (`.modal-overlay > .modal-content.nx-popup`, credvault `.cv-modal.nx-popup`) become sheets through CSS alone, with `nx-center` as the opt-out for question boxes. The Workday 85% panels and the task drawer take the same class. A tiny `lib/sheetStack.js` marks every sheet under the newest one with `data-nx-under` so it recedes.

**Tech Stack:** React 19, inline styles + style.css, `lib/motion.js` (`useExit`), vitest.

**Spec:** Neil, 11/01/2026 ("watch how cleanly the popup slides in from the right ... implement this motion animation concept effectively through Nexus"). Mock of the rail motion for the shared vocabulary: https://claude.ai/artifact/S51aPZuRhF3DNJvywZbGDE.

## Global Constraints

- Motion is transform + opacity only; tokens `--dur-sm` 150 / `--dur-md` 220 / `--dur-lg` 320, `--ease-out` in, `--ease-in` out; exits ~70% of enters; `useExit` / `usePresence` are the only presence mechanisms; never key on animationend; enter animations carry no `forwards` fill (a `backwards` fill is allowed for a delayed cascade: it ends with the animation).
- Reduced motion zeroes every animation and transition here.
- Phones (`useIsMobile()`, the `@media (max-width: 640px)` sheet rules) keep the bottom sheet exactly as today; every new rule sits under `@media (min-width: 641px)`.
- The 60% rule's size stays (`max(60vw, width)`, the Workday 85vw); only the geometry moves to the right edge.
- Do not touch Visesh's files (InventoryManagement.jsx, Assignments.jsx, NotificationBell.jsx, NotificationToasts.jsx) or the rail-motion fork's files (Sidebar.jsx, NavTip.jsx, NavCount.jsx, MyProfileModal.jsx, BrandingPoliciesSettings.jsx, railMotion).
- American English, Title Case titles, no em dashes.

## Review Focus

1. A sheet opened over a sheet must slide in on top and the lower one recede, and when the top one closes (exit or unmount) the lower one must come back; three stacked sheets keep only the top one upright.
2. A generic `.modal-content.nx-popup` that is a question (UnsavedChangesPrompt) must stay centered: `nx-center`.
3. The Workday panels' nudge (a click outside) must still pulse the panel after it has slid in.
4. The task drawer's dirty guard (`asking`) must still run before the slide-out, and Escape / overlay click must play the exit.
5. Nothing changes under 641px: the phone tests (`modalMobile`, `sheets.phone`, `ProjectFollow`, `unscheduledPane`) stay green unchanged.

---

### Task 1: CSS block + sheet stack helper

**Files:**
- Modify: `frontend/src/style.css` (one block after `.nx-overlay.is-closing > .nx-modal-sheet`, ~line 1246)
- Create: `frontend/src/lib/sheetStack.js`, `frontend/src/lib/sheetStack.test.jsx`

**Interfaces (Produces):**
```js
// lib/sheetStack.js
export function useSheetStack(ref, active = true, closing = false)
// pushes ref.current while `active`; the newest sheet is upright, every other
// gets data-nx-under=""; `closing` releases the slot early so the one beneath
// comes back while the exit plays. Exported for tests: sheetStackSize().
```
CSS names: `@keyframes nx-slide-in` (from `translateX(100%)`), `nx-slide-out` (to `translateX(100%)`), `nx-cascade-in` (from `opacity: 0; transform: translateX(10px)`); rules `.nx-sheet-right` (enter), `.is-closing > .nx-sheet-right` (exit), `.nx-sheet-right .nx-cascade > *:nth-child(-n+8)` (220ms, delays 40 + 18(n-1) ms, `backwards`), `.nx-sheet-right[data-nx-under]` (recede: `translateX(-24px) scale(.985)`, opacity .86, transition `--dur-md` `--ease-out`), generic `@media (min-width: 641px) { .modal-overlay:has(> .modal-content.nx-popup:not(.nx-center)) {…} .modal-overlay > .modal-content.nx-popup:not(.nx-center) {…} .cv-modal-overlay:has(> .cv-modal.nx-popup) {…} .cv-modal-overlay > .cv-modal.nx-popup {…} }` inside `@supports selector(:has(a))`, and a reduced-motion reset.

- [ ] Write `sheetStack.test.jsx` (two mounts: first gets `data-nx-under`; unmount second: cleared; `closing` on the top releases early) → fail → implement → pass.
- [ ] Add the CSS block. Commit.

### Task 2: tasks `Modal` placement

**Files:**
- Modify: `frontend/src/tasks/components.jsx` (Modal), `frontend/src/tasks/modalMobile.test.jsx` (desktop assertions)
- Create: `frontend/src/tasks/components.sheet.test.jsx`

`Modal({ ..., placement = 'sheet' })`: `const sheet = !isMobile && placement === 'sheet'`. Overlay: `alignItems: sheet ? 'stretch' : 'flex-start'`, `justifyContent: sheet ? 'flex-end' : 'center'`, `padding: 0` when sheet. Panel class `nx-sheet nx-sheet-right` (sheet) / `nx-sheet nx-panel` (center) / `nx-sheet nx-modal-sheet` (phone); sheet style `{ width: max(60vw, width), minWidth: 'min(420px, 100%)', maxWidth: '100%', height: '100%', maxHeight: '100%', borderRadius: '16px 0 0 16px' }` (no `minHeight`). Body div class `nx-scroll nx-cascade`. `useSheetStack(panelRef, sheet, closing)`. The inner "Save your changes?" card is unchanged.

- [ ] Tests: desktop → `.nx-sheet-right`, overlay `flex-end`, panel `height 100%`, radius `16px 0 0 16px`, body `.nx-cascade`; `placement="center"` → `.nx-panel`, radius `16px`; phone → `.nx-modal-sheet`; X with motion on → overlay `is-closing`; two Modals → first `data-nx-under`, unmount second → cleared. Update `modalMobile.test.jsx` "is unchanged on desktop" to the sheet geometry. Run `npx vitest run src/tasks`. Commit.

### Task 3: marketing Modal, generic question boxes

**Files:**
- Modify: `frontend/src/marketing/shared/Modal.jsx` (placement, `useIsMobile` from `../../lib/useIsMobile`, overlay flex-end on desktop sheet, panel `nx-sheet-right nx-popup`, body `nx-cascade`, `useSheetStack`), `frontend/src/components/UnsavedChangesPrompt.jsx` (`nx-center`), `frontend/src/components/accounting/AmaReclass.jsx` (drop the inline `minHeight` / `maxHeight` that would cap the sheet), any other generic `.nx-popup` found to be a question (audit below)
- Test: `components/UnsavedChangesPrompt` has `nx-center` (new or existing test), marketing Modal test if one exists.

Audit of `.modal-overlay > .modal-content` users (sheet unless noted): GeofencePunchModal (no `.nx-popup`, own 1400px width: unchanged), PriorityBar (sheet), UnsavedChangesPrompt (**center**), accounting AccessTab x3 (sheet), AmaReclass x2 (sheet, inline heights removed), EntryDetail (`acct-entry` box, not `.nx-popup`: unchanged), LeasingFromLedger, LeasingTab, LoanAmortization, LoanDialogs, LoanSetupDialog 102 (sheet; 180 no `.nx-popup`: unchanged), LoanStress, MreTab x2, PackagesTab, PfsAffiliated, PfsLock, PfsTab 1599/1739 (sheet; 1436 unchanged), SavedReportsManager (no `.nx-popup`: unchanged), SendReportDialog, StatementRules, recurringShared (unchanged), ConstructionDashboard, DailyLogCapture, dashboard/widgets x2, investor/lib/ui Modal, links/personalLinkModal, ExternalLinks 2271/2489/2917/3149 (sheet; `folder-panel` keeps its own animation: add `nx-center`-equivalent exclusion by its class; `links-manage-actions` / `links-manage-sheet` are not `.nx-popup`: unchanged). Visesh's files: none use `.modal-content` (verified by grep).

- [ ] Commit.

### Task 4: Workday 85% panels

**Files:** `frontend/src/views/MyHR.jsx` (Ask HR), `frontend/src/components/Reimbursements.jsx`, `frontend/src/components/PurchaseRequests.jsx` (both dialogs: the panel at ~512 and the form shell at ~103 if it is a workspace; a form over the panel is a sheet too).

Desktop: overlay `justifyContent: 'flex-end', alignItems: 'stretch', padding: 0`; panel class `${popupClass} nx-sheet-right`, style `{ width: '85vw', height: '100%', maxHeight: '100%', borderRadius: '16px 0 0 16px', ... }`. Phone branch unchanged. No exit (the open state lives in a parent that unmounts the panel) - enter only, noted. Nudge: the nudge classes replace `animation` on the panel; after the enter has finished that is harmless, so no wrapper is needed.

- [ ] Extend an existing test or add `components/Reimbursements.sheet.test.jsx`: desktop open → dialog has `nx-sheet-right`, width 85vw, radius `16px 0 0 16px`. Commit.

### Task 5: TaskDetailDrawer

**Files:** `frontend/src/tasks/TaskDetailDrawer.jsx`

`const [closing, exitNow] = useExit(onClose)`; every close that today calls `onClose()` from the drawer's own controls (requestClose, the discard path of `asking`) calls `exitNow()`; the overlay gets `is-closing` while closing; both `<aside>`s get class `nx-sheet-right` (the enter slide; the exit slide via `.is-closing > .nx-sheet-right`). Resize unchanged. `useSheetStack(asideRef, !isMobile, closing)`.

- [ ] Existing drawer tests stay green (motion is off under test, so onClose fires at once). Commit.

### Task 6: CLAUDE.md + full checks

- [ ] Rewrite the "Popups cover 60% of the screen" bullet: "**Popups are sheets from the right** (Neil, 11/01/2026) …" with geometry, the question exception (`placement="center"` / `nx-center` / DialogHost), the phone rule, the cascade, the Workday 85vw sheets, keeping Pranshu's 60% size and "content, not blank space" and Sagar's 85% facts.
- [ ] `cd frontend && npx vitest run && npm run lint && npm run build`. Commit.
