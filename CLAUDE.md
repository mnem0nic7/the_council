# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install deps
npm install
pip install -e services/runtime[dev]          # inside .venv

# Dev
npm run dev          # web (Next.js :3000) + runtime (uvicorn :8000) concurrently
npm run dev:web      # web only

# Build
npm run build        # builds @the-council/contracts then apps/web

# Lint
npm run lint         # ESLint on apps/web

# Tests
npm run test:runtime          # pytest services/runtime/tests
npm run test:e2e              # Playwright browser suite
npm run test:ci               # test:build + test:runtime + test:e2e (CI sequence)

# Single pytest file/test
.venv/bin/pytest services/runtime/tests/test_runtime.py::test_name -q

# Playwright (one-time browser install)
npx playwright install chromium
.venv/bin/python -m playwright install chromium   # for Python E2E

# Docker full stack (Postgres+pgvector, Redis, MinIO)
docker compose up --build

# Blue/green deploy
deploy/scripts/bluegreen.sh deploy|status|smoke|rollback
```

Default dev account: `captain` / `bridge123`

If Next.js dev builds fail with a `/_document` error, clear `apps/web/.next` and rebuild.

## Architecture

### Monorepo layout

| Path | Stack | Purpose |
|------|-------|---------|
| `apps/web` | Next.js (App Router), Zustand, Tailwind | Cockpit UI ("bridge" shell) |
| `packages/contracts` | TypeScript | Shared types + exported JSON schemas |
| `services/runtime` | FastAPI, SQLAlchemy | Orchestration backend, agent executor, telemetry |

`@the-council/contracts` is a workspace package consumed by `apps/web`. It must be built (`npm run build --workspace @the-council/contracts`) before the web app can compile. JSON schema exports live in `packages/contracts/dist/schemas/`.

### Frontend (`apps/web`)

- **`app/`** – Next.js App Router pages and layouts. `bridge-app.tsx` is the top-level authenticated shell; `cockpit-scene.tsx` renders the station switcher.
- **`lib/store.ts`** – Single Zustand store (`useCouncilStore`) holding all runtime state: auth, selected mission/run, template agents/workflows, mission-scoped agents/workflow, runs, telemetry, and replay payload.
- **`lib/api.ts`** – All API calls to the runtime backend.
- **`lib/config.ts`** – Runtime URL config.
- **`components/`** – UI components split by station (`bridge-app.tsx`, `cockpit-scene.tsx`).

The five **stations** (`StationId`): `command`, `tactical`, `crew`, `engineering`, `archive`. Each station is mission-scoped:
- **Command** – launch/manage mission runs, view live telemetry.
- **Tactical** – edit the mission workflow (node/edge graph + raw JSON, kept in sync).
- **Engineering** – manage mission-local agents (import from global templates or forge new ones).
- **Crew** – active run view.
- **Archive** – historical run replay.

Both Command and Engineering panels have desktop-only resizable splits that persist width in `localStorage`.

### Backend (`services/runtime`)

Entry point: `app/main.py` — a single FastAPI app with all routes, JWT auth middleware, and startup lifecycle (`lifespan`).

Key modules:
- **`app/models.py`** – SQLAlchemy ORM: `User`, `Agent`, `Workflow`, `Mission`, `MissionAgent`, `MissionRun`, `MissionEvent`, `Artifact`, `MemoryRecord`, `OperatorAction`.
- **`app/schemas.py`** – Pydantic v2 request/response models mirroring the contracts package.
- **`app/executor.py`** – `MissionExecutor`: runs workflow nodes async (agent calls, tool calls, conditional routing). Launched per-run via `executor.start(run_id)`.
- **`app/telemetry.py`** – `TelemetryHub`: WebSocket fanout to connected clients. Upgrades to Redis pub/sub automatically when `REDIS_URL` is set.
- **`app/migrations.py`** – Runtime schema migrations (dialect-aware for SQLite + PostgreSQL). Called at startup via `ensure_runtime_schema()`.
- **`app/storage.py`** – `ArtifactStorage`: local filesystem default, S3-compatible object store when `OBJECT_STORE_*` env vars are present.
- **`app/providers.py`** – `ProviderService`: wraps LLM provider calls.
- **`app/tools.py`** – `ToolRunner` + `ToolPolicyError`: tool execution with policy enforcement.
- **`app/seed.py`** – Default data seeding at startup.
- **`app/core/`** – `config.py` (settings via `get_settings()`), `security.py` (JWT, password hashing).

### Data model

- **`Agent` / `Workflow`** – global templates only; never mutated by a run.
- **`MissionWorkspace` (DB: `Mission`)** – editable workspace owning a `workflow_definition` (stored inline as JSON), `active_run_id`, and `latest_run_id`.
- **`MissionAgent`** – mission-local copy of an `Agent` template, identified by `local_id` within a mission. Structural edits require no active run or a paused run.
- **`MissionRun`** – child execution record with immutable snapshots of the workflow (`workflow_snapshot`) and agents (`agent_snapshot`) taken at launch. Owns telemetry events, artifacts, and memory records.

One active run per mission (v1). Structural edits (agents, workflow) are blocked when a run is in `queued|running|awaiting_input` status; they are allowed when paused, and the paused run's snapshots are updated in place.

### Telemetry flow

1. Run launches → `executor.start(run_id)` runs async in background.
2. Executor emits events via `TelemetryHub.persist_event()` (persisted to DB) and `TelemetryHub.broadcast()` (fanned out to WebSocket subscribers).
3. Frontend subscribes to `ws://…/ws/runs/{run_id}?token=…`; receives full history on connect then live events.
4. Redis pub/sub replaces in-process fanout when `REDIS_URL` is reachable (multi-instance deployment).

## Revision Workflow

- Review changed code before closing a revision.
- Update `MEMORY.md` and any affected docs in the same change.
- Update existing tests and add new coverage for changed behavior.
- Run `npm run test:ci` and fix failures before commit.
- Commit, push, and redeploy with `deploy/scripts/bluegreen.sh deploy`.
