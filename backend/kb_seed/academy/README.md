# Storage Academy content

Courses are authored here as Markdown + JSON and imported as DRAFTS.
`python -m pytest test_kb_academy_content.py` (in `backend/`) must pass.

## Add or edit a lesson
1. Put `courses/<NN>-<slug>/lessons/<NN>-<name>.md` in place. Front matter:
   `title:` (Title Case) and `summary:`. The body starts at `##` (never `#`).
2. List it in that course's `course.json` `lessons` as `{"file": "<NN>-<name>.md"}`.
3. Supported Markdown: `##`/`###`, bold, italic, bullets, `1.` lists, `- [ ]`
   checklists, tables, `---`, and callouts on their own lines:
   `> [!TIP|NOTE|WARNING|SAFETY]` then `> text` lines.

## Add a shared page
`pages/<slug>.md` with front matter `title`, `summary`, `page_type`
(policy|how_to|reference), `tags` (comma separated). A course uses it with
`{"page": "<slug>", "title": "...", "summary": "..."}`. Tag `cubby-filled`
pages may not keep a `[Greens to fill]` marker.

## Add a question
`{"type": "single|multi|tf|order|short", "q", "options", "answer": [indexes],
"explanation", "keywords"}`. `tf` options are `["True", "False"]`; `order`
options are in the RIGHT order; `short` needs keywords with no digits (numbers
are `single`). Limits: q 600, option 300, explanation 400 characters, 6
options. No `photo` questions. Checkpoints: 10 questions at most. Quiz bank:
45 or more, `drawCount` 25-40. The Hands-On Check (`delivery: in_person`) has no quiz.

Optional `"lesson"` on a checkpoint or quiz question names the lesson it
tests: the lesson's file name (`"06-punching.md"`), a page lesson's slug, or a
checkpoint's title. The loader gives every lesson a stable id
(`l_<course slug>_<NN>`, NN = its position) and turns `lesson` into the
question's `lessonId`, so a failed quiz's "Reread these" lists that lesson.
A `lesson` that names nothing in the course fails the content test.

## Copy rules
American English, Title Case titles, no em or en dashes, no ISO dates, say
"Time Sheet", name the source of every Greens number.
