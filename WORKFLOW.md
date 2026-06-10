# Daily Workflow

Run this top-to-bottom every working day. If using Claude Code, say
"follow WORKFLOW.md — start my day" and let it execute the steps.

## 1. Morning start

```
git checkout dev
git pull
git status        # must be clean — if not, deal with leftovers first
```

- If yesterday's branch was **merged**: delete it (`git branch -d feat/...`) and
  continue below.
- If yesterday's branch was **not merged yet**: continue working on it
  (`git checkout feat/...`) — but chase the PR today; branches must not age.

## 2. Start the task

```
git checkout -b feat/<short-task-name>     # ONE task, not one module
```

Start the dev servers:

```
# terminal 1
cd backend && uvicorn main:app --reload --port 8000
# terminal 2
cd frontend && npm run dev
```

## 3. While working

- Commit every coherent step: `git add -A && git commit -m "Module: what changed"`
- Follow CLAUDE.md: stay inside your owned files; shared files append-only;
  copy patterns from the reference implementations.
- Review every AI-generated diff before committing — you own it.

## 4. Ship (same day, or tomorrow at the latest)

1. `cd frontend && npm run build` — must pass.
2. Click through the feature locally one full time.
3. `git push -u origin feat/<short-task-name>`
4. Open a Pull Request into `dev` on GitHub. Write 2-3 lines: what + how to test.
5. **Message the team: "PR ready: <name>"** — do not merge to dev unannounced.
6. After the merge (~4 min deploy), open dev.nexus.greensglobal.com and verify
   the feature works there too.

## 5. End of day

- Work-in-progress? Commit and push the branch anyway (backup + visibility):
  `git push -u origin feat/<name>`
- Never leave uncommitted work overnight.
- If the branch can't realistically merge by tomorrow evening, split the task.

## Never

- Commit directly to `dev` or `main`
- Commit `.env` / `.env.local` files
- Reuse a branch after it merged — always branch fresh from `dev`
- Edit another developer's files (see CLAUDE.md ownership table)
