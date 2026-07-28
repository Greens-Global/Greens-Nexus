# Nexus design system — Work OS (light canon)

<!-- Committed Jul 28, 2026. Owner direction: white, professional, enterprise-grade,
     "just like monday.com" — the category standard executed at full fidelity.
     Supersedes the short-lived dark Operations Desk world (same day).
     Rollout: login + home + shell first; other modules migrate surface by surface. -->

## The world

Nexus is a premium mainstream work OS: white surfaces on a soft cool-gray canvas,
one confident brand accent, friendly-but-businesslike type, generous whitespace,
crisp 1px borders with soft shadows. Craft bar: monday.com. Never: dark-first chrome,
terminal/mono styling, neon, glassmorphism, heavy gradients.

## Tokens (`--wk-*` in style.css)

- Canvas `--wk-bg #f6f7fb` · card `--wk-card #ffffff`
- Ink `--wk-ink #323338` · secondary `--wk-dim #676879` · tertiary `--wk-faint #9699a6`
- Border `--wk-line #d0d4e4` · soft border/divider `--wk-line2 #e6e9f2` · hover fill `--wk-hover #f5f6f8`
- Brand `--wk-brand #2b45e1` (vibrant Stella cobalt — owner call, Jul 28; replaced the
  softer `#5b5fef`) · hover `#1f36c7` · tint `--wk-brand-tint #e8ecfd`
- Status (semantic only): `--wk-green #00a25b` (fills may use #00c875), `--wk-orange #fdab3d`,
  `--wk-red #e2445c`, `--wk-blue #579bfc`
- Radius `--wk-r 8px`; cards `1px solid var(--wk-line2)` + `--wk-shadow 0 4px 12px rgba(29,33,57,.05)`
- Hover depth: shadow deepens + border darkens; translateY(-1px) max.

## Type

- Desk surfaces: **Figtree** (400–800) — friendly geometric, professional.
- Legacy modules keep Inter until migrated.
- Greeting/H1 24–30px/700; card titles 15px/600; body 13–14px; labels 12px/500 `--wk-dim`
  (normal case — no uppercase tracking anywhere).
- Numerals: 28–34px/700, `tabular-nums`.

## Grammar

- **Cards on canvas**: white, radius 8, soft border + shadow; card header = title + optional
  count pill + right meta. No nested cards.
- **Colored icon chips**: 32–36px rounded squares, status-color tinted bg + colored icon —
  the monday-style accent system. Color is assigned by meaning, stays consistent per concept
  (tasks blue, items orange, equipment purple-brand, signatures green… defined once).
- **Status pills**: filled soft tints (`#eeeffd`-style) with colored text, radius 4–6, 11–12px/600.
- **Session language**: time clock renders as a friendly chip — green dot "Clocked in · 2:31:04",
  gray "Clocked out". NY/Mumbai times appear as quiet header meta (US ⇄ India ops).
- **Primary action**: brand-filled button, radius 6–8; secondary = white with border.
- Empty states: colored icon + warm headline + one explanatory line ("You're all caught up").

## Motion

- Entrance: cards fade/rise 6px, staggered 40ms, 300–400ms, `cubic-bezier(.16,1,.3,1)`, once.
- Numerals count up once. Hover transitions 150ms. No marquees, no blinking.
- All gated by `prefers-reduced-motion`.

## Theming

Light is the identity. The existing `data-theme="dark"` toggle keeps working app-wide
(legacy tokens), but new desk surfaces are designed light-first and must stay legible in dark.

Two selectable light worlds (profile menu → Theme, `data-wktheme` on `<html>`, Jul 28):
- **Cobalt** (default): the tokens above.
- **Warm sand** (Lisso-inspired): cream canvas `#f2ede3`, sand borders, near-black
  primary `#26241f`, amber wash tint `#f5ead0`. Same `--wk-*` contract — new surfaces
  must style through the tokens so both themes (and dark) come for free.

## Constraints

- WHITE-LABEL: no "Greens"/"Greens Global" anywhere user-visible.
- All existing behavior preserved (nav filtering, saved dashboard views + Customize grid,
  drawer/palette/zoom/theme, MSAL). Sentence-case labels; American English.
- Zero states designed, never blank; sample-data widgets labeled.
