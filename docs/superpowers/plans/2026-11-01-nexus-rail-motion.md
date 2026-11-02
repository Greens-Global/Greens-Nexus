# Nexus Rail Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the left navigation the motion Neil picked from the reel (11/01/2026) without the glass: icon lift on hover, one gliding highlight, a flyout label on the folded rail, a cascade when the rail opens, an active tint that travels, a count that bumps - at a strength that is a setting (default Lively) and off under reduced motion.

**Architecture:** One pure resolver (`lib/railMotion.js`) decides the effective strength from the person's choice (profile prefs, `useTableValue('nav','motion')`), the company default (`navMotion` on the branding config) and reduced motion, and writes `data-rail-motion` + `--rail-lift` on `<html>`. `Sidebar.jsx` renders two pills behind the rows (translateY only) and marks the aside `data-motion` when motion is on; every visual lives in CSS scoped to that attribute, transform and opacity only, with the spring curve used on the icon lift and the one-time pop alone. `NavTip` keeps its timing and becomes a light card that slides from the icon.

**Tech Stack:** React 19, inline styles + style.css tokens (`--dur-*`, `--ease-out`, new `--ease-spring`), tasks/tableCols profile prefs, FastAPI branding router.

**Spec:** the clickable mock `scratchpad/nexus-rail-motion.html` (published https://claude.ai/artifact/S51aPZuRhF3DNJvywZbGDE); Neil's calls: flyout replaces the dark tooltip, strength is a setting, default Lively, "professional, not goofy".

## Global Constraints

- Transform and opacity only; nothing loops; nothing on touch (`@media (hover: hover)`, `pointerType !== 'touch'`); reduced motion and the Off setting render today's sidebar exactly.
- Overshoot (`--ease-spring: cubic-bezier(.34,1.56,.64,1)`) only on the icon lift (260ms) and the one-time pop (320ms). Pills, flyout and cascade use `--ease-out`. Bold is capped at 1.26.
- Cascade ≤ 14ms per row, each item 260ms. Fold is instant.
- The folded rail never peeks open on hover; the edge tab stays the collapse control (`.sidebar-collapse-btn` className unchanged).
- Nav counts stay the quiet gray number; red is the bell's.
- Phone drawer (≤ 900px) untouched: no pills, no data-motion on the aside.
- Title Case titles, sentence-case descriptions, no em dashes, American English.

## Review Focus

1. Reduced motion toggled while the page is open must drop to Off at once (reactive, not read once).
2. A company default saved in Settings must reach an open sidebar without a reload (`nexus:rail-motion`).
3. Hovering the row that is already active must not paint two tints (row background suppressed while motion is on).
4. A row ref wrapped by `NavTip` (folded rail) must still reach the pill code (NavTip chains `child.props.ref`).
5. Fold → unfold must snap the active pill to the new row geometry (no glide across the width change) and still cascade the labels.

---

### Task A: Preference model + backend whitelist

**Files:** Create `frontend/src/lib/railMotion.js`, `frontend/src/lib/railMotion.test.jsx`, `backend/test_branding_nav_motion.py`. Modify `backend/routers/branding.py`.

**Interfaces (Produces):**
```js
export const STRENGTHS = ['off', 'subtle', 'lively', 'bold'];
export const LIFT = { subtle: 1.10, lively: 1.18, bold: 1.26 };
export const DEFAULT_STRENGTH = 'lively';     // the company default when nothing is saved
export const FOLLOW_COMPANY = 'default';      // the personal value that means "use the company's"
export function isStrength(v) -> boolean
export function resolveStrength({ personal, company, reduced }) -> 'off' | 'subtle' | 'lively' | 'bold'
export function applyRailMotion(effective)    // data-rail-motion + --rail-lift on document.documentElement
export function useRailMotion() -> { personal, setPersonal, company, effective }
```
Backend: `navMotion` in `_clean_accent` (invalid → "lively"), in `BrandingIn`, validated in `update_config` (400), audited.

### Task B: The rail

**Files:** Modify `frontend/src/components/Sidebar.jsx`, `frontend/src/components/NavCount.jsx`, `frontend/src/style.css`. Create `frontend/src/components/Sidebar.motion.test.jsx`, `frontend/src/components/NavCount.test.jsx`.

Sidebar renders `<aside data-motion={on ? effective : undefined}>`; inside `.nav-list`: `<li class="nav-pill nav-pill--hover">` and `<li class="nav-pill nav-pill--active">` (aria-hidden, translateY(row.offsetTop)). Row refs via `rowProps` (`ref`, `onPointerEnter`). Active pill placed in a layout effect; snaps (transition none, height set) on mount and when `collapsed` changes. Pop: previous-render pattern sets `popView`, timer clears. Cascade: previous-render pattern sets `opening` for 700ms when collapsed → expanded; `--i` inline on each label / kicker / count. Edge tab: one ChevronLeft, rotated by CSS when collapsed. NavCount: `is-bump` for 320ms when `n` changes between renders.

### Task C: NavTip flyout

**Files:** Modify `frontend/src/components/NavTip.jsx` (no arrow var needed; `data-side` kept), `frontend/src/style.css` `.navtip`; extend `NavTip.test.jsx`.

### Task D: Settings

**Files:** Modify `frontend/src/components/MyProfileModal.jsx` (Appearance: "Navigation Motion" segmented Company Default / Off / Subtle / Lively / Bold, saves on change), `frontend/src/views/BrandingPoliciesSettings.jsx` (`BrandColorPanel`: "Navigation Motion" radiogroup saved with the accent, then `nexus:rail-motion`), tests in both test files, `CLAUDE.md` bullet.
