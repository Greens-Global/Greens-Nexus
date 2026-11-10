# Storage Academy content

Courses are authored here as Markdown + JSON and imported as DRAFTS.
`python -m pytest test_kb_academy_content.py` (in `backend/`) must pass.

Ten courses: the six new-hire courses the plan lists in order, then the manager
courses `07-property-and-vendor-management`, `08-fundamentals-of-accounting`,
`09-intacct-fundamentals` and `10-leading-with-nexus` (not on the plan; `plan.json`
may list any subsequence of `kb_academy.ORDER`). A course.json may carry
`teaches` (the Nexus modules it teaches, for Keeps Up and the Help panel) and
`departments` (the department it shelves under; the Academy's by default); a
lesson's front matter may carry `teaches:` too. A new course goes in
`kb_academy.ORDER`, `MIN_READING` and `EST_MINUTES` too. After an environment's
first import, a change here reaches it through `kb_academy_seed.apply_content_once`
(it runs whenever the package digest changes): new pages and courses are
created as drafts, and courses nobody has saved since the first run take the
package's lessons whole; a course somebody saved only takes figures into its
unedited lessons. Edits made in Nexus are never overwritten.

## Add or edit a lesson
1. Put `courses/<NN>-<slug>/lessons/<NN>-<name>.md` in place. Front matter:
   `title:` (Title Case) and `summary:`. The body starts at `##` (never `#`).
2. List it in that course's `course.json` `lessons` as `{"file": "<NN>-<name>.md"}`.
3. Supported Markdown: `##`/`###`, bold, italic, bullets, `1.` lists, `- [ ]`
   checklists, tables, `---`, and callouts on their own lines:
   `> [!TIP|NOTE|WARNING|SAFETY]` then `> text` lines.

## Add a figure (11/07/2026)
A diagram drawn from data, never an image. A fenced block in a lesson or page:

    ```figure
    {"kind": "steps", "title": "How It Goes", "items": [{"label": "First", "note": "what happens"}, {"label": "Then"}]}
    ```

Kinds and their keys (`kb_blocks.FIGURE_KINDS`, drawn by
`frontend/src/kb/components/Figure.jsx`): `steps` (items: label, note),
`timeline` (items: at, label, note, tone), `compare` (columns: name, note,
facts), `sizes` (unit, items: name, w, h, note - rectangles to scale), `bars`
(unit, max, items: label, value, low, text, tone), `stats` (items: value,
label, note), `layout` (cols, rows, regions: label, note, x, y, w, h, tone),
`cycle` (items: label, note), `drawing` (draw, label, note - one line drawing, large), `drawings` (items: draw, label, note - a gallery) and `screen` (a REALISTIC Nexus screen drawn from data, never a real screenshot: `device` computer | phone, `module`, `sub` (the back line), `tabs` + `tab`, `actions` (header buttons), `badge` (the bell count), `parts` in order - each `{kind, ...}` with kind tiles (items: label, value) | card (title, note, rows: label, value, tone; buttons) | clock (state in | out | break, label, value, tabs, buttons) | table (columns, rows of cells) | form (title, fields: label, value, hint, kind text | select | textarea | check; buttons) | list (items: label, note, badge, tone) | banner (tone, text, buttons) | dialog or sheet (title, text, fields, buttons) | bell (text, items, buttons) | toast (text, buttons) | text (text) - a button is a string or `{label, primary}`; any part, row, item or button may carry `n` to show a numbered badge, explained in `callouts` (n, text)). A `draw` names one of `kb_blocks.DRAWING_NAMES` (RVs, boats, spaces, measuring, locks, unit types, the site's parts - fence, gate, buildings, inside a unit, the roll-up door, the hasp, the cylinder core - and the shapes of space from above; drawn by `components/drawings.jsx`). `tone` is ok | live | warn | bad. Every
figure may carry a `title` and a `caption`. Put the figure right under the
heading it illustrates, and only where it says something the prose cannot
say as fast: a sequence, a ladder of days, things to scale, numbers side by
side. The content test checks a figure's words like any other copy.

## Add a shared page
`pages/<slug>.md` with front matter `title`, `summary`, `page_type`
(policy|how_to|reference), `tags` (comma separated). A course uses it with
`{"page": "<slug>", "title": "...", "summary": "..."}`. Tag `cubby-filled`
pages may not keep a fill-in placeholder (the bracketed marker `problems()` in kb_academy.py looks for). Anything still missing is a `> [!NOTE]` "Pending:" callout, listed on pages/academy-launch-checklist.md.

## Add a question
`{"type": "single|multi|tf|order|short", "q", "options", "answer": [indexes],
"explanation", "keywords"}`. `tf` options are `["True", "False"]`; `order`
options are in the RIGHT order; `short` needs keywords with no digits (numbers
are `single`). Limits: q 600, option 300, explanation 400 characters, 6
options. No `photo` questions. Checkpoints: 10 questions at most. Quiz bank:
45 or more, `drawCount` 15-40. The Hands-On Check (`delivery: in_person`) has no quiz.

Optional `"lesson"` on a checkpoint or quiz question names the lesson it
tests: the lesson's file name (`"06-punching.md"`), a page lesson's slug, or a
checkpoint's title. The loader gives every lesson a stable id
(`l_<course slug>_<NN>`, NN = its position) and turns `lesson` into the
question's `lessonId`, so a failed quiz's "Reread these" lists that lesson.
A `lesson` that names nothing in the course fails the content test.

## Copy rules
American English, Title Case titles, no em or en dashes, no ISO dates, say
"Time Sheet". A Greens number lives on the Greens by the Numbers page (`pages/greens-by-the-numbers.md`) with one dated source line; a lesson links there rather than repeating the number with a citation. Words go in `pages/academy-glossary.md`.
