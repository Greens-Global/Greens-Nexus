# Greens Nexus

Internal company portal for Greens Global: items and assignments, tasks, time
clock, HR, e-signatures, accounting, property and operations in one place.

- `frontend/` - React 19 + Vite
- `backend/` - FastAPI + SQLAlchemy
- Supabase for Postgres, storage and realtime; Microsoft Entra ID (MSAL) for sign-in

## Run Locally

```
# backend (terminal 1) - uses its own SQLite unless DATABASE_URL is set in backend/.env
cd backend && uvicorn main:app --reload --port 8000

# frontend (terminal 2) - talks to localhost:8000 by default
cd frontend && npm run dev
```

The frontend needs Node 22 (`frontend/.nvmrc`). On Windows, `start.bat` opens both.

## Conventions

See [CLAUDE.md](CLAUDE.md) for conventions: local sign-in setup, the checks to
run before pushing, file ownership, and the backend, frontend and domain rules.

## Branches And Deploys

- `main` is production. `dev` is integration, and every merge to `dev` deploys by itself (frontend in about a minute, backend in about four).
- One branch per task, cut from fresh `dev`, merged by pull request within a day or two, then deleted.
- Never commit to `dev` or `main` directly, and never commit `.env` files.
