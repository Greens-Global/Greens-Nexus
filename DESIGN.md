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

## Live accent (Neil, 11/02/2026)

Mock: https://claude.ai/artifact/PwncxMck8YaSkFkQ8hmTHE. **Green stays the brand**
(primary buttons, the active nav item, links, the N tile, anything done). **Orange
means "in progress / now" and nothing else.**

- Tokens (style.css "Live accent" block, contrast ratios in its comment):
  `--wk-live` bars, outlines, icons, the now line (light `#ed631a` - the mock's `#ee6a24`
  one step darker so it clears 3:1 on the canvas too - dark `#ff7a33`,
  Warm sand `#d9581a`) · `--wk-live-ink` the only orange allowed for text (`#b8480f` /
  `#ff9a5c` / `#a8400c`) · `--wk-live-tint` a soft wash (`#fdeee5` /
  `rgba(255,122,51,.14)` / `#fbe4d5`) · `--wk-live-line` an outline around a tint ·
  `--wk-live-on` text on a solid `--wk-live-ink` fill (the Act As Exit chip only).
- Where it goes: a running shift, progress that is still moving, the current-time
  marker and today's column, a live mode the person switched on (Act As, a company
  picked in Settings > Applies To). Fills, outlines, bars and icons.
- Where it never goes: a button fill, a warning (warnings stay a yellow background +
  icon, and orange never sits on yellow), small body text (use `--wk-live-ink`), a
  count badge. The category tints (`--wk-orange`, `.dk-chip--orange`,
  `.dk-pill--orange`, `.card-orange`) are status colors, not the live accent.
- Brand collision: a company whose brand color is orange / red / pink (hue <= 45 or
  >= 330 with real saturation, `liveCollides` in `lib/brandAccent.js`) gets the live
  family in cobalt (`#2b45e1`, dark `#7086ff`), written by the brand stylesheet.
- `ui/ProgressTrack.jsx` is the one progress bar: solid fill (live orange, done
  green, overdue red, idle gray), dashed remainder, optional end labels, note and
  ringed now marker; the width moves only when motion is allowed.

## Type

**Font: Inter, everywhere (Neil, 11/12/2026)** - it holds up better than
Figtree at 11-13px in dense tables, and Nexus is mostly tables and lists. This
replaces "Figtree for desk surfaces". Moving `--wk-font` from Figtree to Inter is
its own release, checked against before / after screenshots (Inter sets wider
than Figtree at the same size, so tight spots - the rail, tabs, chips - can
wrap or cut off).

**The scale (Neil, 11/12/2026)** - the only text sizes. `FS` in
`frontend/src/lib/typeScale.js`, the same numbers as the `--fs-*` tokens in
style.css:

| Token | px | For |
|---|---|---|
| `meta` | 11 | timestamps, counts, fine print |
| `label` | 12 | labels, table cells, chips, status pills (500, `--wk-dim`) |
| `body` | 13 | body text, list rows, form fields, drawers |
| `read` | 14 | long reading only: KB pages, Notes, announcements |
| `title` | 15 | card titles (600) |
| `section` | 18 | section headings |
| `page` | 24 | page titles, greetings (700) |
| `figure` | 32 | big numbers (700, `tabular-nums`) |

Normal case - no uppercase tracking anywhere. The code had 43 sizes, half a
pixel apart in places; `scripts/check-type.mjs` (in `npm run lint`) fails a new
one off the scale, and older code is in its baseline and may only go down.
Screens move over ONE MODULE AT A TIME, each looked at by a person; `SNAP`
says where an old size lands (12.5 rounds UP to 13). A size that must stay off
the scale carries `type-ok: <why>` on its line - the 16px phone form fields
are the main one (iOS zooms the page on a field under 16px).

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
